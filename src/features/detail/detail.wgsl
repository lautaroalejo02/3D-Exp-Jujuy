// Detail patch: a small high-resolution mesh drawn over the base terrain.
// Same structure as terrain.wgsl — the mesh is generated in the vertex
// shader from vertex_index and displaced by heights read from a read-only
// storage buffer — but mapped into the BASE grid's world space: originPx
// is the patch's own grid origin while centerPx/kmPerPx are the base
// grid's, re-expressed at the patch zoom (global px scale by
// 2^(patchZoom - baseZoom)). World mapping is otherwise unchanged: X east,
// Z south, Y up, km of ground distance, Y = elevation/1000*exaggeration.
//
// NO OUTSIDE-PROVINCE DIMMING: unlike the base shader, patches do not
// sample the province SDF — a patch can straddle the Jujuy/Salta border
// (Salinas Grandes does), so dimming the "outside" half would erase detail
// the patch exists to show.
//
// SEAM AND Z-FIGHTING: two mechanisms keep the overlay invisible.
//   1. liftMeters raises the patch surface (in elevation units, tapered to
//      zero across the outer edgeFade uv band) so it sits above the
//      coincident base surface everywhere the patch is opaque; the taper
//      meets the base surface where the alpha fade ends, so there is no
//      step at the border.
//   2. biasNdc nudges clip-space z toward the camera so the patch wins
//      the reversed-Z "greater" test at near-coincident depths instead of
//      z-fighting (see detail-uniforms.ts for why this is not depthBias).
// Fragments blend with alpha: edgeFade fades the outer ~5% to zero.

struct Params {
  viewProjection: mat4x4f,
  originPx: vec2f,    // global px of the patch grid's north-west corner (patch zoom)
  centerPx: vec2f,    // BASE grid center, re-expressed at the patch zoom
  gridSize: vec2f,    // patch height grid size in cells
  meshSize: vec2f,    // mesh size in vertices
  meshToGrid: vec2f,  // gridCoord = meshVertex * meshToGrid - 0.5
  kmPerPx: f32,       // ground km per global px at the patch zoom (base latitude factor)
  cellScale: f32,     // global px per height-grid cell
  cellKm: f32,        // ground km per height-grid cell
  exaggeration: f32,
  ambient: f32,
  lightStrength: f32,
  liftMeters: f32,    // uniform elevation lift, tapered to 0 at the border
  biasNdc: f32,       // clip-z offset in units of clip w (toward the camera)
  edgeFade: f32,      // uv band at each border that fades alpha to 0
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var satelliteTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;

// Same sun as the base terrain: azimuth 315 deg (NW), elevation 45 deg.
const SUN_DIR = vec3f(-0.5, 0.70710678, -0.5);

// Bilinear sample of the row-major heights buffer at fractional grid
// coords, clamped to the borders (same convention as raster.bilinearSample).
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

// Distance to the nearest patch border, in uv units [0, 0.5].
fn edgeDistance(uv: vec2f) -> f32 {
  return min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) grid: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  // 6 vertices per quad: (0,0)(1,0)(0,1) and (0,1)(1,0)(1,1).
  var cornerX = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var cornerY = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let quad = vi / 6u;
  let corner = vi % 6u;
  let cellsX = u32(params.meshSize.x) - 1u;
  let mi = f32(quad % cellsX + cornerX[corner]);
  let mj = f32(quad / cellsX + cornerY[corner]);

  // Grid coords of this mesh vertex; the mesh spans [-0.5, size-0.5].
  let gi = mi * params.meshToGrid.x - 0.5;
  let gj = mj * params.meshToGrid.y - 0.5;
  let uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;

  // Lift tapers with the same band the alpha fades over, so the lifted
  // surface blends into the base terrain before it becomes visible.
  let liftFactor = smoothstep(0.0, params.edgeFade, edgeDistance(uv));
  let elevation = heightAt(gi, gj) + params.liftMeters * liftFactor;
  let px = params.originPx + (vec2f(gi, gj) + vec2f(0.5)) * params.cellScale;
  let world = vec3f(
    (px.x - params.centerPx.x) * params.kmPerPx,
    elevation / 1000.0 * params.exaggeration,
    (px.y - params.centerPx.y) * params.kmPerPx,
  );

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  // Depth bias toward the camera: reversed-Z stores near at 1 and the test
  // is "greater", so a positive nudge makes the patch win over the
  // coincident base surface. Scaled by w it is a constant NDC offset.
  out.position.z += params.biasNdc * out.position.w;
  out.grid = vec2f(gi, gj);
  out.uv = uv;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Normal from central finite differences of the RAW height grid — the
  // lift is a display trick, not relief, and its taper would add fake
  // slopes along the border. Sample spacing is 2 cells of real ground.
  let cellMeters = params.cellKm * 1000.0;
  let dhx = heightAt(in.grid.x + 1.0, in.grid.y) - heightAt(in.grid.x - 1.0, in.grid.y);
  let dhz = heightAt(in.grid.x, in.grid.y + 1.0) - heightAt(in.grid.x, in.grid.y - 1.0);
  let sx = dhx * params.exaggeration / (2.0 * cellMeters);
  let sz = dhz * params.exaggeration / (2.0 * cellMeters);
  let normal = normalize(vec3f(-sx, 1.0, -sz));

  let diffuse = max(dot(normal, SUN_DIR), 0.0);
  let light = params.ambient + params.lightStrength * diffuse;
  let rgb = textureSample(satelliteTex, linearSampler, in.uv).rgb * light;

  // Fade the outer edgeFade uv band to transparent so the border blends
  // into the base terrain instead of showing a hard seam.
  let alpha = smoothstep(0.0, params.edgeFade, edgeDistance(in.uv));
  return vec4f(rgb, alpha);
}
