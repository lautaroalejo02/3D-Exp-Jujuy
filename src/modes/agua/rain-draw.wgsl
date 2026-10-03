// Rain droplet draw (Agua mode): one velocity-aligned screen-space quad
// per particle — head at the particle's flow-grid position, tail a few
// cells upstream — additive-blended over the terrain. The world mapping
// follows src/geo gridToWorld exactly (flow-grid coords -> global px ->
// km), and the surface height is bilinear-sampled from the terrain's own
// heights buffer in its grid coords, then exaggerated like the terrain.

struct Params {
  viewProjection: mat4x4f,
  originPx: vec2f,
  centerPx: vec2f,
  flowGridSize: vec2f,
  heightsGridSize: vec2f,
  viewportSize: vec2f,
  cellScale: f32,
  kmPerPx: f32,
  exaggeration: f32,
  invAccScale: f32,
  widthPx: f32,
  haloScale: f32,
  trailCells: f32,
  liftKm: f32,
  lifeSeconds: f32,
  alphaScale: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> particles: array<vec4f>;
@group(0) @binding(2) var<storage, read> heights: array<f32>;
@group(0) @binding(3) var flowDirTex: texture_2d<u32>;
@group(0) @binding(4) var flowAccTex: texture_2d<u32>;

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

// Bilinear sample of the heights buffer at FLOW-grid coords: the two
// grids share the same ground extent, so the normalized position inside
// the flow extent maps to heights-grid cell coords directly.
fn heightAtFlow(gi: f32, gj: f32) -> f32 {
  let hi = (gi + 0.5) * params.heightsGridSize.x / params.flowGridSize.x - 0.5;
  let hj = (gj + 0.5) * params.heightsGridSize.y / params.flowGridSize.y - 0.5;
  let w = u32(params.heightsGridSize.x);
  let h = u32(params.heightsGridSize.y);
  let ci = clamp(hi, 0.0, f32(w - 1u));
  let cj = clamp(hj, 0.0, f32(h - 1u));
  let i0 = u32(floor(ci));
  let j0 = u32(floor(cj));
  let i1 = min(i0 + 1u, w - 1u);
  let j1 = min(j0 + 1u, h - 1u);
  let fx = ci - f32(i0);
  let fy = cj - f32(j0);
  let top = heights[j0 * w + i0] +
    (heights[j0 * w + i1] - heights[j0 * w + i0]) * fx;
  let bot = heights[j1 * w + i0] +
    (heights[j1 * w + i1] - heights[j1 * w + i0]) * fx;
  return top + (bot - top) * fy;
}

fn clipAt(gpos: vec2f) -> vec4f {
  let px = params.originPx + (gpos + vec2f(0.5)) * params.cellScale;
  let elev = heightAtFlow(gpos.x, gpos.y);
  let world = vec3f(
    (px.x - params.centerPx.x) * params.kmPerPx,
    elev / 1000.0 * params.exaggeration + params.liftKm,
    (px.y - params.centerPx.y) * params.kmPerPx,
  );
  return params.viewProjection * vec4f(world, 1.0);
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) across: f32, // -1 .. 1 across the trail
  @location(1) along: f32,  // 0 at the head, 1 at the tail
  @location(2) fade: f32,
}

@vertex fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) inst: u32,
) -> VertexOut {
  let p = particles[inst];
  let ci = clamp(i32(floor(p.x)), 0, i32(params.flowGridSize.x) - 1);
  let cj = clamp(i32(floor(p.y)), 0, i32(params.flowGridSize.y) - 1);
  let dir = textureLoad(flowDirTex, vec2i(ci, cj), 0).r;
  let accLog =
    f32(textureLoad(flowAccTex, vec2i(ci, cj), 0).r) * params.invAccScale;
  let d = D8[min(dir, 8u)];

  let head = p.xy;
  let tail = p.xy - d * params.trailCells;
  let c0 = clipAt(head);
  let c1 = clipAt(tail);

  // 6 verts = 2 triangles: corner.x is across (-0.5..0.5), corner.y is
  // along (0 at head, 1 at tail).
  var quad = array<vec2f, 6>(
    vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(-0.5, 1.0),
    vec2f(0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0),
  );
  let corner = quad[vi];

  var out: VertexOut;
  // Behind the camera a projected segment is meaningless — collapse the
  // quad so it rasterizes nothing.
  if (c0.w <= 0.0 && c1.w <= 0.0) {
    out.position = vec4f(0.0, 0.0, -10.0, 1.0);
    out.across = 0.0;
    out.along = 1.0;
    out.fade = 0.0;
    return out;
  }
  let n0 = c0.xy / c0.w;
  let n1 = c1.xy / c1.w;
  var dirPx = (n1 - n0) * params.viewportSize * 0.5;
  // A zero-length projected trail is a droplet pooled at a sink (or
  // moving straight at the camera): draw a symmetric dot, not a streak.
  let pooled = dot(dirPx, dirPx) < 1e-6;
  if (pooled) {
    dirPx = vec2f(0.0, 1.0);
  }
  let dirn = normalize(dirPx);
  let perp = vec2f(-dirn.y, dirn.x);
  // The quad spans widthPx * haloScale: the fragment keeps a tight
  // bright core inside a soft halo, so the glow needs the extra room.
  let spanPx = params.widthPx * params.haloScale;
  var base: vec2f;
  var w: f32;
  var z: f32;
  var offset: vec2f;
  if (pooled) {
    base = n0;
    w = c0.w;
    z = c0.z;
    offset = (perp * corner.x + dirn * (corner.y - 0.5)) * spanPx /
      (params.viewportSize * 0.5);
  } else {
    base = mix(n0, n1, corner.y);
    w = mix(c0.w, c1.w, corner.y);
    z = mix(c0.z, c1.z, corner.y);
    offset = perp * corner.x * spanPx / (params.viewportSize * 0.5);
  }
  out.position = vec4f((base + offset) * w, z, w);

  // Fade in over the first seconds, out before the sim respawns it, and
  // brighter where the upstream accumulation is larger (rivers glow).
  let age = p.z;
  let fadeIn = smoothstep(0.0, 2.0, age);
  let fadeOut = 1.0 - smoothstep(
    params.lifeSeconds - 6.0,
    params.lifeSeconds,
    age,
  );
  let bright = 0.55 + 0.45 * clamp(accLog / 11.0, 0.0, 1.0);
  out.fade = fadeIn * fadeOut * bright * params.alphaScale;
  out.across = corner.x * 2.0;
  out.along = corner.y;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Bright core inside a soft halo: two gaussian lobes across the quad
  // (the quad is widthPx*haloScale wide, so the halo reads as a glow)
  // and a tail falloff toward the upstream end.
  let x2 = in.across * in.across;
  let core = exp(-x2 * 14.0);
  let halo = exp(-x2 * 3.0) * 0.45;
  let tailFade = 1.0 - in.along * in.along;
  let a = min(core + halo, 1.0) * tailFade * in.fade;
  let head = vec3f(0.82, 0.94, 1.0);
  let tail = vec3f(0.4, 0.65, 0.97);
  let rgb = mix(head, tail, in.along);
  return vec4f(rgb * a, a);
}
