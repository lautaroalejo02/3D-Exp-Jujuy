// Terrain draw: the mesh is generated in the vertex shader from
// vertex_index (no vertex buffers) and displaced by heights read from a
// read-only storage buffer (f32 meters, row-major). World mapping follows
// src/geo gridToWorld: X east, Z south, Y up, km of ground distance,
// Y = elevation / 1000 * exaggeration.
//
// OVERLAY SLOT: `overlayTex` + `params.overlayOpacity` tint the terrain.
// The regions layer binds an RGBA raster on the department-index grid:
// region color with alpha>0 inside Jujuy, fully transparent outside, so
// `mix(lit, overlay.rgb * light, overlay.a * overlayOpacity)` recolors
// the terrain inside the province only, and `params.regionBorders` draws
// thin lines where neighboring inside texels change color. The default
// binding is a 1x1 transparent texture (the mix is a no-op).
//
// PROVINCE MASK: `deptIndexTex` holds the department index per raster cell
// (0 = outside Jujuy, 1..16 = departments — what the regions overlay is
// baked from) and `provinceSdfTex` holds the signed distance to the province
// boundary in cells (positive inside), both as r8unorm: the index is the
// raw byte (decode *255) and the SDF is biased by 127 (decode *255 - 127).
// The SDF drives the "outside Jujuy" dimming and a screen-space outline
// whose width stays ~constant in pixels via fwidth().
//
// DETAIL PATCHES: `patchRects` holds the FULL outer extent (in grid
// coords) of every detail patch that is loaded AND inside its draw
// distance — the app maintains it via setDetailPatchMask. Fragments
// inside a live rect are discarded: the patch renders there at its true
// height and geomorphs onto this surface at the border (detail.wgsl), so
// the base would only poke through it otherwise. A site that is merely
// in range but still loading has no rect — the base keeps showing.
//
// SUN + SHADOWS: the light comes from uniforms (params.sunDir TO the sun
// in world space, params.sunColor/ambientColor) and `shadowTex` holds a
// per-footprint soft visibility factor from the compute march in
// src/sun/shadow.wgsl — same UV space as the satellite image. direct =
// sunColor * max(dot(N,L),0) * visibility. `shadowStrength` fades the
// sampled visibility in (0 = ignore the texture, the sun-less default
// look). The default uniforms reproduce the old cartographic light:
// sunDir NW 45 deg, grey sunColor, grey ambient — nothing changes
// visually until the sun mode drives them.

struct Params {
  viewProjection: mat4x4f,
  cameraPos: vec3f,  // camera eye in world km, drives the distance haze
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
  sunColor: vec3f,
  ambientColor: vec3f,
  sunDir: vec3f,
  shadowStrength: f32, // 0 = shadows off (default), 1 = sample shadowTex
  overlayOpacity: f32,
  dimStrength: f32,    // 0..1: how strongly outside terrain is dimmed
  outlinePx: f32,      // province outline width in physical pixels
  deptBorders: f32,    // 1 = thin department borders; 0 = off
  regionBorders: f32,  // 1 = thin region borders; 0 = off
  hazeStart: f32,      // km: distance where the atmospheric haze starts
  hazeEnd: f32,        // km: distance where the haze saturates
  // Full outer extent [i0, j0, i1, j1] of each live detail patch, in grid
  // coords; only the first patchRectCount slots are valid. Fixed literal
  // size — vgpu rejects symbolic array lengths. Must match
  // MAX_DETAIL_PATCHES in src/terrain/detail-grids.ts.
  patchRects: array<vec4f, 16>,
  patchRectCount: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var satelliteTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var overlayTex: texture_2d<f32>;
@group(0) @binding(5) var deptIndexTex: texture_2d<f32>;
@group(0) @binding(6) var provinceSdfTex: texture_2d<f32>;
@group(0) @binding(7) var shadowTex: texture_2d<f32>;

// Outside-province dimming: how much color is pulled toward luminance and
// the extra darkening applied on top, before `dimStrength` scales the mix.
const OUTSIDE_DESATURATION = 0.6;
const OUTSIDE_DARKEN = 0.78;

// Atmospheric perspective: a subtle far-edge softening toward the sky's
// horizon color (the hazeStart/hazeEnd uniforms keep it off the block at
// the default framing). Keep in sync with SKY_HORIZON in diorama.wgsl.
const HAZE_COLOR = vec3f(0.91, 0.87, 0.78);
const HAZE_MAX = 0.25;

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
  @location(2) world: vec3f,
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
  out.world = world;
  out.grid = vec2f(gi, gj);
  // The satellite image covers exactly the grid extent, so normalized UV
  // follows straight from grid coords (cell centers at +0.5).
  out.uv = (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Detail patches own the surface inside their full extent: discard the
  // base fragments there so nothing of the coarser mesh pokes through
  // the patch or z-fights with it.
  for (var p = 0u; p < u32(params.patchRectCount); p++) {
    let r = params.patchRects[p];
    if (
      in.grid.x >= r.x && in.grid.x <= r.z &&
      in.grid.y >= r.y && in.grid.y <= r.w
    ) {
      discard;
    }
  }

  // Normal from central finite differences of the height grid. The sample
  // spacing is 2 cells of real ground distance; elevation is exaggerated
  // like the vertex displacement so slopes stay truthful to the render.
  let cellMeters = params.cellKm * 1000.0;
  let dhx = heightAt(in.grid.x + 1.0, in.grid.y) - heightAt(in.grid.x - 1.0, in.grid.y);
  let dhz = heightAt(in.grid.x, in.grid.y + 1.0) - heightAt(in.grid.x, in.grid.y - 1.0);
  let sx = dhx * params.exaggeration / (2.0 * cellMeters);
  let sz = dhz * params.exaggeration / (2.0 * cellMeters);
  let normal = normalize(vec3f(-sx, 1.0, -sz));

  // Cast shadows: soft visibility computed toward the sun, sampled in the
  // same UV space as the satellite image. shadowStrength fades the term
  // in so the default (sun-less) look is untouched.
  let visibility = mix(
    1.0,
    textureSample(shadowTex, linearSampler, in.uv).r,
    params.shadowStrength,
  );

  let diffuse = max(dot(normal, params.sunDir), 0.0);
  let light = params.ambientColor + params.sunColor * diffuse * visibility;
  let base = textureSample(satelliteTex, linearSampler, in.uv).rgb;
  var rgb = base * light;

  // Overlay slot: tints the terrain while keeping the relief shading.
  // The raster holds one region color per department-grid cell, so it is
  // read with textureLoad (nearest texel): a filtering sampler would
  // blend two regions into a third color along their shared edge. The
  // same texel indexes the department index raster in the border passes.
  let deptTexel = vec2i(clamp(
    floor(in.uv * params.deptGridSize),
    vec2f(0.0),
    params.deptGridSize - 1.0,
  ));
  let overlay = textureLoad(overlayTex, deptTexel, 0);
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
    let c = textureLoad(deptIndexTex, deptTexel, 0).r;
    let border = c != textureLoad(deptIndexTex, deptTexel + vec2i(1, 0), 0).r ||
      c != textureLoad(deptIndexTex, deptTexel - vec2i(1, 0), 0).r ||
      c != textureLoad(deptIndexTex, deptTexel + vec2i(0, 1), 0).r ||
      c != textureLoad(deptIndexTex, deptTexel - vec2i(0, 1), 0).r;
    if (border) {
      rgb = mix(rgb, vec3f(1.0), 0.45 * inside);
    }
  }

  // Region borders (off by default): the overlay holds one color per
  // region with alpha>0 only inside Jujuy, so a texel whose inside
  // neighbors differ in color sits on a region boundary. Transparent
  // neighbors are outside the province — that edge belongs to the
  // outline, so no border is drawn there.
  if (params.regionBorders > 0.001) {
    let c = overlay;
    if (c.a > 0.0) {
      let e = textureLoad(overlayTex, deptTexel + vec2i(1, 0), 0);
      let w = textureLoad(overlayTex, deptTexel - vec2i(1, 0), 0);
      let s = textureLoad(overlayTex, deptTexel + vec2i(0, 1), 0);
      let n = textureLoad(overlayTex, deptTexel - vec2i(0, 1), 0);
      let border =
        (e.a > 0.0 && any(e.rgb != c.rgb)) ||
        (w.a > 0.0 && any(w.rgb != c.rgb)) ||
        (s.a > 0.0 && any(s.rgb != c.rgb)) ||
        (n.a > 0.0 && any(n.rgb != c.rgb));
      if (border) {
        rgb = mix(rgb, vec3f(0.12, 0.11, 0.13), 0.8);
      }
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

  // Atmospheric haze last: near terrain stays untouched, the far edge
  // softens into the sky's horizon color.
  let dist = distance(in.world, params.cameraPos);
  let haze = smoothstep(params.hazeStart, params.hazeEnd, dist) * HAZE_MAX;
  rgb = mix(rgb, HAZE_COLOR, haze);
  return vec4f(rgb, 1.0);
}
