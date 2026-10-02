// Terrain draw: the mesh is generated in the vertex shader from
// vertex_index (no vertex buffers) and displaced by heights read from a
// read-only storage buffer (f32 meters, row-major). World mapping follows
// src/geo gridToWorld: X east, Z south, Y up, km of ground distance,
// Y = elevation / 1000 * exaggeration.
//
// OVERLAY SLOT: `overlayTex` + `params.overlayOpacity` are reserved for
// future feature layers (e.g. regions tinting the terrain). The default
// binding is a 1x1 transparent texture; fragments do
// `mix(lit, overlay.rgb * light, overlay.a * overlayOpacity)` so an
// overlay can recolor terrain without changing this shader's structure.

struct Params {
  viewProjection: mat4x4f,
  originPx: vec2f,   // global px of the grid's north-west corner
  centerPx: vec2f,   // global px of the grid center (= world origin)
  gridSize: vec2f,   // height grid size in cells
  meshSize: vec2f,   // mesh size in vertices
  meshToGrid: vec2f, // gridCoord = meshVertex * meshToGrid - 0.5
  kmPerPx: f32,      // ground km per global pixel
  cellScale: f32,    // global px per height-grid cell
  cellKm: f32,       // ground km per height-grid cell
  exaggeration: f32,
  ambient: f32,
  lightStrength: f32,
  overlayOpacity: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var satelliteTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var overlayTex: texture_2d<f32>;

// Sun direction TO the sun in world space (X east, Y up, Z south).
// Cartographic convention: azimuth 315 deg (north-west), elevation 45 deg.
// east = sin(az)*cos(el) = -0.5, up = sin(el) ~= 0.7071, south = -cos(az)*cos(el) = -0.5.
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

  let elevation = heightAt(gi, gj);
  let px = params.originPx + (vec2f(gi, gj) + vec2f(0.5)) * params.cellScale;
  let world = vec3f(
    (px.x - params.centerPx.x) * params.kmPerPx,
    elevation / 1000.0 * params.exaggeration,
    (px.y - params.centerPx.y) * params.kmPerPx,
  );

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  out.grid = vec2f(gi, gj);
  // The satellite image covers exactly the grid extent, so normalized UV
  // follows straight from grid coords (cell centers at +0.5).
  out.uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Normal from central finite differences of the height grid. The sample
  // spacing is 2 cells of real ground distance; elevation is exaggerated
  // like the vertex displacement so slopes stay truthful to the render.
  let cellMeters = params.cellKm * 1000.0;
  let dhx = heightAt(in.grid.x + 1.0, in.grid.y) - heightAt(in.grid.x - 1.0, in.grid.y);
  let dhz = heightAt(in.grid.x, in.grid.y + 1.0) - heightAt(in.grid.x, in.grid.y - 1.0);
  let sx = dhx * params.exaggeration / (2.0 * cellMeters);
  let sz = dhz * params.exaggeration / (2.0 * cellMeters);
  let normal = normalize(vec3f(-sx, 1.0, -sz));

  let diffuse = max(dot(normal, SUN_DIR), 0.0);
  let light = params.ambient + params.lightStrength * diffuse;
  let base = textureSample(satelliteTex, linearSampler, in.uv).rgb;
  var rgb = base * light;

  // Overlay slot: tints the terrain while keeping the relief shading.
  let overlay = textureSample(overlayTex, linearSampler, in.uv);
  rgb = mix(rgb, overlay.rgb * light, overlay.a * params.overlayOpacity);
  return vec4f(rgb, 1.0);
}
