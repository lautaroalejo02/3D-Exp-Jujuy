// Shadow texture: one texel per footprint on the height grid, storing a
// soft sun-visibility factor in .r (0 = fully shadowed, 1 = fully lit).
// A compute pass marches from each texel toward the sun over the same
// heights storage buffer the terrain shader draws, at the same vertical
// exaggeration, so shadows line up with the rendered relief. The pass is
// re-dispatched only when the sun direction or the exaggeration changes
// (src/sun/shadow-engine.ts) — never per frame.
//
// Penumbra: the march keeps the minimum of `penumbra * clearance / t`
// over the ray — a blocker that only clips the ray shades partially and
// one that clears it blocks completely (the classic "min-angle" soft
// shadow for heightfields). Steps grow linearly (t += stepKm * (1 +
// growth * s)) so nearby occluders get dense samples while the ray still
// reaches across the whole block for sunset-long shadows.

struct Params {
  gridSize: vec2f,    // height grid size in cells
  virtualSize: vec2f, // march grid size; smaller than the texture = blocky write
  sunDir: vec3f,      // TO the sun, world space (X east, Y up, Z south)
  exaggeration: f32,
  cellKm: f32,      // ground km per height-grid cell
  stepKm: f32,      // first march step, in km of horizontal distance
  growth: f32,      // step growth per iteration (0 = uniform)
  steps: f32,       // max march iterations
  maxKm: f32,       // max horizontal march distance in km
  penumbra: f32,    // softness: clearance/t ratio for a full-lit edge
  biasKm: f32,      // vertical bias above the surface at march start
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var shadowTex: texture_storage_2d<rgba8unorm, write>;

// Bilinear sample of the row-major heights buffer at fractional grid
// coords, clamped to the borders — identical to terrain.wgsl so the
// marched surface is exactly the drawn one.
fn heightAt(i: f32, j: f32) -> f32 {
  let w = u32(params.gridSize.x);
  let h = u32(params.gridSize.y);
  let ci = clamp(i, 0.0, f32(w - 1u));
  let cj = clamp(j, 0.0, f32(h - 1u));
  let i0 = u32(floor(ci));
  let j0 = u32(floor(cj));
  let i1 = min(i0 + 1u, w - 1u);
  let j1 = min(j0 + 1u, h - 1u);
  let fx = ci - f32(i0);
  let fy = cj - f32(j0);
  let top = heights[j0 * w + i0] + (heights[j0 * w + i1] - heights[j0 * w + i0]) * fx;
  let bot = heights[j1 * w + i0] + (heights[j1 * w + i1] - heights[j1 * w + i0]) * fx;
  return top + (bot - top) * fy;
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(shadowTex);
  // The march grid may be coarser than the texture (interactive quality
  // while the sun is scrubbed): each thread then covers a block of
  // output texels — the cheap part of the pass is writing texels, the
  // expensive part is the march itself.
  let vx = u32(params.virtualSize.x);
  let vy = u32(params.virtualSize.y);
  if (id.x >= vx || id.y >= vy) {
    return;
  }

  // Height-grid coords of this march-cell's center.
  let gi = (f32(id.x) + 0.5) * params.gridSize.x / params.virtualSize.x - 0.5;
  let gj = (f32(id.y) + 0.5) * params.gridSize.y / params.virtualSize.y - 0.5;

  // Drawn height in world km (elevation/1000 * exaggeration), like the
  // terrain vertex displacement.
  let heightKm = heightAt(gi, gj) / 1000.0 * params.exaggeration;

  let flatLen = length(params.sunDir.xz);
  var visibility = 1.0;
  if (params.sunDir.y <= 0.0) {
    // Sun below the horizon: no direct light anywhere.
    visibility = 0.0;
  } else if (flatLen >= 1e-5) {
    let dirXz = params.sunDir.xz / flatLen;
    // World X east maps to +i, world Z south to +j — the horizontal ray
    // direction in grid cells per km.
    let cellsPerKm = dirXz / params.cellKm;
    // Ray rise per km of horizontal distance (drawn space).
    let slope = params.sunDir.y / flatLen;
    let y0 = heightKm + params.biasKm;

    var t = params.stepKm;
    var vis = 1.0;
    let maxI = params.gridSize.x - 0.5;
    let maxJ = params.gridSize.y - 0.5;
    for (var s = 0u; s < u32(params.steps); s++) {
      if (t > params.maxKm || vis <= 0.0) {
        break;
      }
      let pi = gi + cellsPerKm.x * t;
      let pj = gj + cellsPerKm.y * t;
      // The ray left the height grid: nothing else can occlude the sun.
      if (pi < -0.5 || pi > maxI || pj < -0.5 || pj > maxJ) {
        break;
      }
      let h = heightAt(pi, pj) / 1000.0 * params.exaggeration;
      let rayY = y0 + t * slope;
      vis = min(vis, params.penumbra * (rayY - h) / t);
      t += params.stepKm * (1.0 + params.growth * f32(s));
    }
    visibility = clamp(vis, 0.0, 1.0);
  }

  // Write the texel block this march cell covers (exactly one texel at
  // full resolution — the integer ranges never overlap and always tile
  // the whole texture).
  let x0 = id.x * dims.x / vx;
  let x1 = (id.x + 1u) * dims.x / vx;
  let y0 = id.y * dims.y / vy;
  let y1 = (id.y + 1u) * dims.y / vy;
  for (var y = y0; y < y1; y = y + 1u) {
    for (var x = x0; x < x1; x = x + 1u) {
      textureStore(
        shadowTex,
        vec2i(i32(x), i32(y)),
        vec4f(visibility, visibility, visibility, 1.0),
      );
    }
  }
}
