// Basin overlay (Agua mode): a second displaced-mesh pass over the same
// surface as the terrain, alpha-blended on top with a small lift and no
// depth write. Each fragment reads the basin label raster (0 "otras",
// 1..8 main basins, 255 outside — outside is discarded) and the log-acc
// raster; cells over the river threshold get the bright river color.

struct Params {
  viewProjection: mat4x4f,
  originPx: vec2f,
  centerPx: vec2f,
  flowGridSize: vec2f,
  meshSize: vec2f,
  meshToGrid: vec2f,
  heightsGridSize: vec2f,
  cellScale: f32,
  kmPerPx: f32,
  exaggeration: f32,
  liftKm: f32,
  opacity: f32,
  riverLog: f32,
  invAccScale: f32,
  // [0] "otras" tint, 1..8 the main-basin colors (agua-config.ts). The
  // alpha slot carries the per-entry strength; outside cells discard.
  basinColors: array<vec4f, 9>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var basinsTex: texture_2d<u32>;
@group(0) @binding(3) var flowAccTex: texture_2d<u32>;

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

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) grid: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var cornerX = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var cornerY = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let quad = vi / 6u;
  let corner = vi % 6u;
  let cellsX = u32(params.meshSize.x) - 1u;
  let mi = f32(quad % cellsX + cornerX[corner]);
  let mj = f32(quad / cellsX + cornerY[corner]);

  let gi = mi * params.meshToGrid.x - 0.5;
  let gj = mj * params.meshToGrid.y - 0.5;

  let px = params.originPx + (vec2f(gi, gj) + vec2f(0.5)) * params.cellScale;
  let world = vec3f(
    (px.x - params.centerPx.x) * params.kmPerPx,
    heightAtFlow(gi, gj) / 1000.0 * params.exaggeration + params.liftKm,
    (px.y - params.centerPx.y) * params.kmPerPx,
  );
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.grid = vec2f(gi, gj);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let texel = vec2i(clamp(
    floor(in.grid),
    vec2f(0.0),
    params.flowGridSize - 1.0,
  ));
  let basin = textureLoad(basinsTex, texel, 0).r;
  if (basin == 255u) {
    discard;
  }
  let accLog =
    f32(textureLoad(flowAccTex, texel, 0).r) * params.invAccScale;
  if (accLog >= params.riverLog) {
    // The river network reads through the basin tint, in the same blue
    // as the droplets.
    return vec4f(0.31, 0.76, 0.97, 0.85);
  }
  let tint = params.basinColors[min(basin, 8u)];
  return vec4f(tint.rgb, tint.a * params.opacity);
}
