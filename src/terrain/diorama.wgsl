// Diorama surroundings — the "maqueta" look around the terrain block. One
// module, four entry-point pairs chosen per draw via `entry` (each draw
// only requires the bindings its entries statically use):
//
// 1. vs_sky/fs_sky: fullscreen sky backdrop drawn first with no depth —
//    deep blue at the top fading to a pale warm haze at the horizon and a
//    dark warm backdrop below it. The gradient follows the WORLD horizon,
//    not the screen: each pixel's view ray is pitched against the camera's
//    up basis, so orbiting tilts the sky correctly.
// 2. vs_wall/fs_wall: the context rim — a low wall hanging from the
//    FLATTENED terrain edge (the same `sdf < 0` flattening the terrain
//    vertex shader applies, see context-flatten.ts) down to the shared
//    base plane. Outside Jujuy the terrain sits on the context plain, so
//    this rim reads as a thin plinth, not a tall block wall.
// 3. vs_cutwall/fs_wall: THE province wall — one clean face per outline
//    segment. The outline (province-outline-*.bin, marching squares over
//    the same SDF the shaders sample) is a positive-area ring in grid
//    coords, so vec3(d.y, 0, -d.x) is the outward normal. The top edge is
//    the unflattened drawn height (cutWallTopKm twin: the boundary is
//    inside the flatten mask); the bottom edge is params.baseKm — the
//    same plane the rim and the slab share (the diorama test pins this).
// 4. vs_slab/fs_slab: the base slab, FLUSH with the terrain footprint
//    (slabMargin 1.0 — the previous 1.04 lip was the visible step at the
//    wall/slab junction), with a soft contact-shadow ring on top.
//
// All four draws are created once in src/terrain/diorama.ts; nothing is
// allocated per frame.

struct DioramaParams {
  viewProjection: mat4x4f,
  cameraPos: vec3f,
  originPx: vec2f,    // global px of the grid's north-west corner
  centerPx: vec2f,    // global px of the grid center (= world origin)
  gridSize: vec2f,    // height grid size in cells
  meshSize: vec2f,    // mesh size in vertices (wall resolution)
  meshToGrid: vec2f,  // gridCoord = edgeVertex * meshToGrid - 0.5
  cellScale: f32,     // global px per height-grid cell
  kmPerPx: f32,       // ground km per global pixel
  exaggeration: f32,
  baseKm: f32,        // world Y of the wall bottoms = slab top, in km
  slabKm: f32,        // slab thickness in km (slab bottom = baseKm - slabKm)
  slabMargin: f32,    // slab half-extents = block half-extents * slabMargin
  shadowKm: f32,      // contact-shadow ring width in km
  contextBaseKm: f32, // world Y of the flattened context plain
  outsideFlatten: f32,// relief fraction kept outside the province (0.2)
  hazeStart: f32,     // distance in km where the haze starts
  hazeEnd: f32,       // distance in km where the haze saturates
  sunColor: vec3f,    // direct light tint (same uniforms as terrain.wgsl)
  ambientColor: vec3f,
  sunDir: vec3f,      // TO the sun (X east, Y up, Z south)
  shadowStrength: f32, // 0 = shadows off, 1 = walls sample shadowTex
}

struct SkyParams {
  upView: vec3f,    // world up direction in view space (viewMatrix column 1)
  sunTint: vec3f,   // multiplicative tint on the whole gradient (day: 1)
  tanHalfFov: f32,  // tan(fovY / 2)
  aspect: f32,
}

@group(0) @binding(0) var<uniform> params: DioramaParams;
@group(0) @binding(1) var<uniform> sky: SkyParams;
@group(0) @binding(2) var<storage, read> heights: array<f32>;
@group(0) @binding(3) var shadowTex: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var provinceSdfTex: texture_2d<f32>;
// The province outline ring in height-grid coords (converted once on
// upload), closing point duplicated: segment s reads outline[s..s+1].
@group(0) @binding(6) var<storage, read> outline: array<vec2f>;

// Sky palette: a soft blue at the top fading to a pale warm haze at the
// horizon, and a calm slate below it — the neutral backdrop the maqueta
// sits against. SKY_HORIZON doubles as the haze color — keep it in sync
// with the HAZE_COLOR constant in terrain.wgsl.
const SKY_ZENITH = vec3f(0.38, 0.55, 0.75);
const SKY_HORIZON = vec3f(0.91, 0.87, 0.78);
const SKY_FLOOR = vec3f(0.41, 0.44, 0.49);
const HAZE_MAX = 0.25;

// Stratified earth for the walls: warm topsoil fading into darker rock.
const WALL_TOP = vec3f(0.55, 0.41, 0.28);
const WALL_BASE = vec3f(0.30, 0.22, 0.16);
const WALL_BANDS = 7.0;

// Plinth colors: dark warm slab, a touch darker on its rim.
const SLAB_TOP = vec3f(0.23, 0.19, 0.16);
const SLAB_RIM = vec3f(0.16, 0.13, 0.11);
const SLAB_SHADOW = 0.38;

fn applyHaze(col: vec3f, world: vec3f) -> vec3f {
  let dist = distance(world, params.cameraPos);
  let haze = smoothstep(params.hazeStart, params.hazeEnd, dist) * HAZE_MAX;
  return mix(col, SKY_HORIZON, haze);
}

// Bilinear sample of the row-major heights buffer at fractional grid
// coords, clamped to the borders — identical to terrain.wgsl so the wall
// tops match the mesh they hang from.
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

// The DRAWN surface height at grid coords (i, j) — the twin of the
// terrain vertex shader's displacement: raw DEM inside the province,
// pulled toward the context plain outside (context-flatten.ts).
fn drawnHeightKm(gi: f32, gj: f32) -> f32 {
  var y = heightAt(gi, gj) / 1000.0 * params.exaggeration;
  let uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
  let sdf = textureSampleLevel(provinceSdfTex, linearSampler, uv, 0.0).r * 255.0 - 127.0;
  if (sdf < 0.0) {
    y = params.contextBaseKm + y * params.outsideFlatten;
  }
  return y;
}

fn worldX(gi: f32) -> f32 {
  let px = params.originPx.x + (gi + 0.5) * params.cellScale;
  return (px - params.centerPx.x) * params.kmPerPx;
}

fn worldZ(gj: f32) -> f32 {
  let px = params.originPx.y + (gj + 0.5) * params.cellScale;
  return (px - params.centerPx.y) * params.kmPerPx;
}

// ---------------------------------------------------------------- sky ---

struct SkyOut {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}

@vertex fn vs_sky(@builtin(vertex_index) vi: u32) -> SkyOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: SkyOut;
  out.position = vec4f(pos[vi], 0.5, 1.0);
  out.ndc = pos[vi];
  return out;
}

@fragment fn fs_sky(in: SkyOut) -> @location(0) vec4f {
  // View-space ray for this pixel, then its pitch against world up.
  let rd = normalize(vec3f(
    in.ndc.x * sky.tanHalfFov * sky.aspect,
    in.ndc.y * sky.tanHalfFov,
    -1.0,
  ));
  let pitch = dot(rd, sky.upView);
  var col = mix(SKY_FLOOR, SKY_HORIZON, smoothstep(-0.6, -0.04, pitch));
  col = mix(col, SKY_ZENITH, smoothstep(0.02, 0.55, pitch));
  // Sun tint: warm near the horizon at low sun, dark at night; neutral
  // (vec3(1)) for the default daytime look.
  return vec4f(col * sky.sunTint, 1.0);
}

// -------------------------------------------------------------- walls ---

struct WallOut {
  @builtin(position) position: vec4f,
  @location(0) depthFrac: f32,
  @location(1) world: vec3f,
  @location(2) @interpolate(flat) normal: vec3f,
  @location(3) uv: vec2f,
}

// The context rim: wall quads along the four rectangular grid borders.
// The top edge is the FLATTENED terrain height — the same drawnHeightKm
// the terrain mesh draws at those coords — so the rim butts against the
// context sheet with no gap and drops just ~contextLift + relief*0.2 to
// the shared base plane (a thin plinth, not a second tall wall).
@vertex fn vs_wall(@builtin(vertex_index) vi: u32) -> WallOut {
  // Mirrors dioramaVertexPlan() in diorama.ts: edges N, S run along X and
  // hold (meshW-1) quads each; W, E run along Z with (meshH-1) quads.
  let vertsX = (u32(params.meshSize.x) - 1u) * 6u;
  let vertsZ = (u32(params.meshSize.y) - 1u) * 6u;
  var edge = 0u;
  var local = vi;
  if (local >= vertsX) { local -= vertsX; edge = 1u; }
  if (edge == 1u && local >= vertsX) { local -= vertsX; edge = 2u; }
  if (edge == 2u && local >= vertsZ) { local -= vertsZ; edge = 3u; }

  // 6 vertices per quad: (0,0)(1,0)(0,1) and (0,1)(1,0)(1,1).
  var cornerX = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var cornerY = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let quad = local / 6u;
  let corner = local % 6u;
  let along = f32(quad + cornerX[corner]);
  let drop = cornerY[corner];

  var gi = -0.5;
  var gj = -0.5;
  if (edge == 0u || edge == 1u) {
    gi = along * params.meshToGrid.x - 0.5;
    gj = select(-0.5, params.gridSize.y - 0.5, edge == 1u);
  } else {
    gj = along * params.meshToGrid.y - 0.5;
    gi = select(-0.5, params.gridSize.x - 0.5, edge == 3u);
  }

  let topY = drawnHeightKm(gi, gj);
  let world = vec3f(worldX(gi), mix(topY, params.baseKm, f32(drop)), worldZ(gj));

  var normal = vec3f(0.0, 0.0, -1.0);
  if (edge == 1u) { normal = vec3f(0.0, 0.0, 1.0); }
  else if (edge == 2u) { normal = vec3f(-1.0, 0.0, 0.0); }
  else if (edge == 3u) { normal = vec3f(1.0, 0.0, 0.0); }

  var out: WallOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.depthFrac = f32(drop);
  out.world = world;
  out.normal = normal;
  // Grid UV of the wall's top edge — same mapping as terrain.wgsl's
  // satellite UV — so the fragment can sample the sun-shadow texture.
  out.uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
  return out;
}

// The province cut wall: one quad per outline segment. outline[s] and
// outline[s+1] are the segment's endpoints in height-grid coords (the
// ring is wound with positive signed area, so (d.y, 0, -d.x) is the
// outward normal). Top edge = the unflattened terrain height at the
// outline point (cutWallTopKm in context-flatten.ts); bottom = baseKm.
@vertex fn vs_cutwall(@builtin(vertex_index) vi: u32) -> WallOut {
  let seg = vi / 6u;
  var cornerX = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var cornerY = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let corner = vi % 6u;
  let a = outline[seg];
  let b = outline[seg + 1u];
  let p = select(a, b, cornerX[corner] == 1u);
  let gi = p.x;
  let gj = p.y;

  let topY = heightAt(gi, gj) / 1000.0 * params.exaggeration;
  let drop = cornerY[corner];
  let world = vec3f(worldX(gi), mix(topY, params.baseKm, f32(drop)), worldZ(gj));

  let d = b - a;
  var normal = vec3f(0.0, 0.0, -1.0);
  if (length(d) > 1e-6) {
    normal = normalize(vec3f(d.y, 0.0, -d.x));
  }

  var out: WallOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.depthFrac = f32(drop);
  out.world = world;
  out.normal = normal;
  out.uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
  return out;
}

@fragment fn fs_wall(in: WallOut) -> @location(0) vec4f {
  // The wall shares its edge cell's cast-shadow visibility with the
  // terrain surface it hangs from (shadowStrength fades the term like
  // in the terrain shader).
  let visibility = mix(
    1.0,
    textureSample(shadowTex, linearSampler, in.uv).r,
    params.shadowStrength,
  );
  let diffuse = max(dot(in.normal, params.sunDir), 0.0);
  let light = params.ambientColor + params.sunColor * diffuse * visibility;

  // Alternating strata: every other band carries a slightly different
  // tone, with a thin darker seam between them.
  var col = mix(WALL_TOP, WALL_BASE, in.depthFrac);
  let u = fract(in.depthFrac * WALL_BANDS);
  let bandTone = 1.0 - 0.07 * (floor(in.depthFrac * WALL_BANDS) % 2.0);
  let seam = 0.82 + 0.18 * smoothstep(0.0, 0.09, u);
  col = col * bandTone * seam * light;

  return vec4f(applyHaze(col, in.world), 1.0);
}

// --------------------------------------------------------------- slab ---

struct SlabOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) rim: u32, // 0 = top face, 1..4 = rim edges
}

@vertex fn vs_slab(@builtin(vertex_index) vi: u32) -> SlabOut {
  // The block footprint is centered on the world origin; the slab edge is
  // flush with it (slabMargin 1.0) so no lip protrudes past the rim wall.
  // 6 vertices for the top face, then one quad (6 vertices) per rim edge
  // N, S, W, E = 30 vertices total.
  let hx = 0.5 * params.gridSize.x * params.cellScale * params.kmPerPx;
  let hz = 0.5 * params.gridSize.y * params.cellScale * params.kmPerPx;
  let mx = hx * params.slabMargin;
  let mz = hz * params.slabMargin;

  var cornerX = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var cornerY = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  var world = vec3f(0.0);
  var rim = 0u;
  if (vi < 6u) {
    let x = select(-mx, mx, cornerX[vi] == 1u);
    let z = select(-mz, mz, cornerY[vi] == 1u);
    world = vec3f(x, params.baseKm, z);
  } else {
    let rimVi = vi - 6u;
    let edge = rimVi / 6u; // 0 = N, 1 = S, 2 = W, 3 = E
    rim = edge + 1u;
    let corner = rimVi % 6u;
    let along = cornerX[corner];
    let drop = cornerY[corner];
    let y = select(params.baseKm, params.baseKm - params.slabKm, drop == 1u);
    var x = select(-mx, mx, along == 1u);
    var z = select(-mz, mz, along == 1u);
    if (edge < 2u) {
      z = select(-mz, mz, edge == 1u);
    } else {
      x = select(-mx, mx, edge == 3u);
    }
    world = vec3f(x, y, z);
  }

  var out: SlabOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.rim = rim;
  return out;
}

@fragment fn fs_slab(in: SlabOut) -> @location(0) vec4f {
  var col = SLAB_TOP;
  if (in.rim > 0u) {
    // Same lighting convention as the walls: N rim is edge 1, S is 2,
    // W is 3, E is 4 in the rim index space.
    var normal = vec3f(0.0, 0.0, -1.0);
    if (in.rim == 2u) { normal = vec3f(0.0, 0.0, 1.0); }
    else if (in.rim == 3u) { normal = vec3f(-1.0, 0.0, 0.0); }
    else if (in.rim == 4u) { normal = vec3f(1.0, 0.0, 0.0); }
    let diffuse = max(dot(normal, params.sunDir), 0.0);
    let light = params.ambientColor + params.sunColor * diffuse;
    col = SLAB_RIM * light;
  } else {
    // Contact shadow: darken the slab where it sits under the block,
    // softening outward over params.shadowKm of world distance.
    let hx = 0.5 * params.gridSize.x * params.cellScale * params.kmPerPx;
    let hz = 0.5 * params.gridSize.y * params.cellScale * params.kmPerPx;
    let d = abs(in.world.xz) - vec2f(hx, hz);
    let sd = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
    let shadow = (1.0 - smoothstep(0.0, params.shadowKm, sd)) * SLAB_SHADOW;
    col = SLAB_TOP * (1.0 - shadow);
  }
  return vec4f(applyHaze(col, in.world), 1.0);
}
