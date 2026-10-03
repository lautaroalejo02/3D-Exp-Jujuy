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
//
// PROVINCE MASK: `deptIndexTex` holds the department index per raster cell
// (0 = outside Jujuy, 1..16 = departments — it is what future regions map
// to) and `provinceSdfTex` holds the signed distance to the province
// boundary in cells (positive inside), both as r8unorm: the index is the
// raw byte (decode *255) and the SDF is biased by 127 (decode *255 - 127).
// The SDF drives the "outside Jujuy" dimming and a screen-space outline
// whose width stays ~constant in pixels via fwidth().

struct Params {
  viewProjection: mat4x4f,
  originPx: vec2f,   // global px of the grid's north-west corner
  centerPx: vec2f,   // global px of the grid center (= world origin)
  gridSize: vec2f,   // height grid size in cells
  meshSize: vec2f,   // mesh size in vertices
  meshToGrid: vec2f, // gridCoord = meshVertex * meshToGrid - 0.5
  deptGridSize: vec2f, // department index / SDF raster size in cells
  kmPerPx: f32,      // ground km per global pixel
  cellScale: f32,    // global px per height-grid cell
  cellKm: f32,       // ground km per height-grid cell
  exaggeration: f32,
  ambient: f32,
  lightStrength: f32,
  overlayOpacity: f32,
  dimStrength: f32,    // 0..1: how strongly outside terrain is dimmed
  outlinePx: f32,      // province outline width in physical pixels
  deptBorders: f32,    // 1 = thin department borders; 0 = off
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var satelliteTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var overlayTex: texture_2d<f32>;
@group(0) @binding(5) var deptIndexTex: texture_2d<f32>;
@group(0) @binding(6) var provinceSdfTex: texture_2d<f32>;

// Sun direction TO the sun in world space (X east, Y up, Z south).
// Cartographic convention: azimuth 315 deg (north-west), elevation 45 deg.
// east = sin(az)*cos(el) = -0.5, up = sin(el) ~= 0.7071, south = -cos(az)*cos(el) = -0.5.
const SUN_DIR = vec3f(-0.5, 0.70710678, -0.5);

// Outside-province dimming: how much color is pulled toward luminance and
// the extra darkening applied on top, before `dimStrength` scales the mix.
const OUTSIDE_DESATURATION = 0.6;
const OUTSIDE_DARKEN = 0.78;

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

  // Province mask. The SDF raster shares the grid's ground extent, so the
  // satellite UV samples it directly; bilinear sampling keeps the outline
  // smooth at any zoom. `px` is the SDF change per physical pixel, the
  // unit that makes the outline width resolution-independent.
  let sdf = textureSample(provinceSdfTex, linearSampler, in.uv).r * 255.0 - 127.0;
  let px = max(fwidth(sdf), 1e-4);
  // 1 inside Jujuy, 0 outside, ~1 px of transition at the boundary.
  let inside = smoothstep(-0.5 * px, 0.5 * px, sdf);

  // Outside the province: partially desaturate and mildly darken so the
  // terrain's hue and relief stay recognizable — places straddling the
  // boundary (Salinas Grandes) must still read in color.
  let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let outside = 1.0 - inside;
  let muted = mix(rgb, vec3f(luma), OUTSIDE_DESATURATION) * OUTSIDE_DARKEN;
  rgb = mix(rgb, muted, params.dimStrength * outside);

  // Department borders (off by default): the index raster changes value
  // across a departmental boundary. Limited to inside the province so the
  // outside edge stays owned by the outline.
  if (params.deptBorders > 0.001) {
    let texel = vec2i(clamp(
      floor(in.uv * params.deptGridSize),
      vec2f(0.0),
      params.deptGridSize - 1.0,
    ));
    let c = textureLoad(deptIndexTex, texel, 0).r;
    let border = c != textureLoad(deptIndexTex, texel + vec2i(1, 0), 0).r ||
      c != textureLoad(deptIndexTex, texel - vec2i(1, 0), 0).r ||
      c != textureLoad(deptIndexTex, texel + vec2i(0, 1), 0).r ||
      c != textureLoad(deptIndexTex, texel - vec2i(0, 1), 0).r;
    if (border) {
      rgb = mix(rgb, vec3f(1.0), 0.45 * inside);
    }
  }

  // Province outline: ~outlinePx physical pixels wide, anti-aliased over
  // ~1 px, on top of the dimming so it reads crisply at any zoom.
  let halfLine = params.outlinePx * 0.5 * px;
  let outline = 1.0 - smoothstep(
    halfLine - 0.5 * px,
    halfLine + 0.5 * px,
    abs(sdf),
  );
  rgb = mix(rgb, vec3f(0.95, 0.95, 0.9), outline);
  return vec4f(rgb, 1.0);
}
