// Rain particle advection (Agua mode): one thread per particle over the
// flow grid computed by scripts/build-flow.ts. Particles spawn uniformly
// over the in-province spawn list (one entry per cell = area-weighted),
// move cell to cell following the D8 direction, faster where the upstream
// accumulation is larger, and respawn when they leave the grid or outlive
// their lifetime. A cell with no outflow is a sink — a grid-edge outlet
// or a retained endorheic depression (the Puna's lagunas/salares) — so a
// particle reaching one stops and fades out in place, never teleporting.
//
// Particle state, one vec4f per particle:
//   xy = position in flow-grid coords (cell centers at integers)
//   z  = age in seconds
//   w  = respawn seed (advanced on every respawn)

struct Params {
  gridSize: vec2f,
  dt: f32,
  frame: f32,
  activeCount: u32,
  spawnCount: u32,
  speedBase: f32,
  speedGain: f32,
  lifeSeconds: f32,
  invAccScale: f32,
  sinkFadeSeconds: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<vec4f>;
@group(0) @binding(2) var<storage, read> spawnCells: array<u32>;
@group(0) @binding(3) var flowDirTex: texture_2d<u32>;
@group(0) @binding(4) var flowAccTex: texture_2d<u32>;

// D8 direction vectors, matching D8_DI/D8_DJ in src/modes/agua/flow.ts:
// 1=E 2=SE 3=S 4=SW 5=W 6=NW 7=N 8=NE (index 0 = no outflow). Diagonals
// carry 1/sqrt(2) so the step length is cell-distance constant.
const D8 = array<vec2f, 9>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.7071067811865476, 0.7071067811865476),
  vec2f(0.0, 1.0),
  vec2f(-0.7071067811865476, 0.7071067811865476),
  vec2f(-1.0, 0.0),
  vec2f(-0.7071067811865476, -0.7071067811865476),
  vec2f(0.0, -1.0),
  vec2f(0.7071067811865476, -0.7071067811865476),
);

fn hashU(x: u32) -> u32 {
  var h = x * 747796405u + 2891336453u;
  let word = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand(seed: u32) -> f32 {
  return f32(hashU(seed)) * (1.0 / 4294967295.0);
}

fn respawn(idx: u32, seed: f32) -> vec4f {
  let s = hashU(idx) ^ hashU(u32(abs(seed) * 65536.0)) ^
    hashU(u32(params.frame * 61.0));
  let pick = u32(rand(s) * f32(params.spawnCount)) % params.spawnCount;
  let cell = spawnCells[pick];
  let w = u32(params.gridSize.x);
  return vec4f(
    f32(cell % w) + rand(s + 1u),
    f32(cell / w) + rand(s + 2u),
    0.0,
    seed + 1.0,
  );
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.activeCount) {
    return;
  }
  var p = particles[idx];

  let ci = clamp(i32(floor(p.x)), 0, i32(params.gridSize.x) - 1);
  let cj = clamp(i32(floor(p.y)), 0, i32(params.gridSize.y) - 1);
  let dir = textureLoad(flowDirTex, vec2i(ci, cj), 0).r;
  let accLog =
    f32(textureLoad(flowAccTex, vec2i(ci, cj), 0).r) * params.invAccScale;

  let speed = params.speedBase * (1.0 + params.speedGain * accLog);
  let d = D8[min(dir, 8u)];
  p.x += d.x * speed * params.dt;
  p.y += d.y * speed * params.dt;
  p.z += params.dt;

  let off = p.x < 0.0 || p.y < 0.0 || p.x >= params.gridSize.x - 1.0 ||
    p.y >= params.gridSize.y - 1.0;
  if (dir == 0u && !off) {
    // Pooled at a sink: the droplet stays put (d = 0 above) and jumps
    // into the draw shader's fade-out window, so it dims in place over
    // sinkFadeSeconds before the lifetime check respawns it.
    p.z = max(p.z, params.lifeSeconds - params.sinkFadeSeconds);
  }
  if (off || p.z >= params.lifeSeconds) {
    p = respawn(idx, p.w);
  }
  particles[idx] = p;
}
