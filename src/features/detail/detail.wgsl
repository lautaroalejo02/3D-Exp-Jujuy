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
// SEAM (height geomorphing, no lift, no dome): the base terrain discards
// its fragments inside this patch's FULL outer rect (terrain.wgsl
// patchRects), and the patch draws OPAQUE everywhere inside it. Across
// the outer edgeFade band the elevation geomorphs between the base
// surface and the patch DEM:
//   elevation = mix(baseMeshHeightAt(baseGridCoord), heightAt(patch), w)
//   w = smoothstep(0, edgeFade, edgeDistance(uv))  — 0 outer edge, 1 inner.
// baseMeshHeightAt is NOT the raw DEM bilinear: the base mesh is decimated,
// so the drawn base surface is the triangle interpolation of the four
// mesh vertices of the containing quad (the same corner pattern as
// terrain.wgsl: TL-TR-BL + BL-TR-BR). Reproducing that surface here from
// the SAME base heights storage buffer and mesh spacing makes the patch's
// outer edge coincide with the base surface pointwise — geometry is
// continuous along the seam, watertight, with no lift at all.
//
// Z-FIGHTING: only the boundary line itself is exactly coincident with
// the base (inside the rect the base is discarded); biasNdc nudges the
// patch's clip-space z toward the camera so it wins the reversed-Z
// "greater" test on that shared rasterized line instead of z-fighting
// (see detail-uniforms.ts for why this is not depthBias).
//
// OVERLAP (task A1): two drawn patches may cover the same base-grid
// pixels (tilcara touches siete-colores; humahuaca may touch hornocal).
// Ownership is a Voronoi split on the patch centers in base grid coords:
// the patch whose center is nearest owns the pixel and draws it; every
// other covering patch discards the fragment. The exact bisector goes to
// the lower slot index, so the decision is deterministic and exactly one
// patch claims each covered pixel. Within splitBand base cells of the
// seam the owner geomorphs back toward the base surface (same scheme as
// the patch's outer edge), and the loser morphs to the base surface too —
// both surfaces coincide with the base surface right at the split line,
// so they meet without cracks and never z-fight.

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
  biasNdc: f32,       // clip-z offset in units of clip w (toward the camera)
  edgeFade: f32,      // uv band at each border that geomorphs into the base
  // baseGridCoord = (patchGridCoord + 0.5) * patchToBaseK + patchToBaseC,
  // per axis — the linear zoom/offset map between the two grids.
  patchToBaseK: vec2f,
  patchToBaseC: vec2f,
  baseGridSize: vec2f,    // base height grid size in cells
  baseMeshToGrid: vec2f,  // base grid cells per base mesh vertex step
  // Voronoi overlap arbitration, all in base grid coords: patchRects and
  // patchCenters (.xy) list the patches the layer currently DRAWS —
  // patchCount of them; patchIndex is this draw's slot. Fixed literal
  // sizes — vgpu rejects symbolic array lengths; must match
  // MAX_DETAIL_PATCHES in src/terrain/detail-grids.ts.
  patchRects: array<vec4f, 16>,
  patchCenters: array<vec4f, 16>,
  patchCount: f32,
  patchIndex: f32,
  splitBand: f32,   // seam geomorph width in base grid cells
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var satelliteTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
// The base terrain's own heights buffer, shared — the geomorph target is
// the surface the base shader draws, read from the same data.
@group(0) @binding(4) var<storage, read> baseHeights: array<f32>;

// Same sun as the base terrain: azimuth 315 deg (NW), elevation 45 deg.
const SUN_DIR = vec3f(-0.5, 0.70710678, -0.5);

// Bilinear sample of a row-major heights buffer at fractional grid
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

fn baseHeightAt(i: f32, j: f32) -> f32 {
  let w = u32(params.baseGridSize.x);
  let h = u32(params.baseGridSize.y);
  let ci = clamp(i, 0.0, f32(w - 1u));
  let cj = clamp(j, 0.0, f32(h - 1u));
  let i0 = u32(floor(ci));
  let j0 = u32(floor(cj));
  let i1 = min(i0 + 1u, w - 1u);
  let j1 = min(j0 + 1u, h - 1u);
  let fx = ci - f32(i0);
  let fy = cj - f32(j0);
  let top = baseHeights[j0 * w + i0] + (baseHeights[j0 * w + i1] - baseHeights[j0 * w + i0]) * fx;
  let bot = baseHeights[j1 * w + i0] + (baseHeights[j1 * w + i1] - baseHeights[j1 * w + i0]) * fx;
  return top + (bot - top) * fy;
}

// The base terrain's DRAWN surface at base grid coords (bi, bj): the base
// mesh vertex (mi, mj) samples the base DEM at grid coord
// (mi * meshToGrid - 0.5, mj * meshToGrid - 0.5), and inside each quad the
// rasterized surface is the plane of the containing triangle. terrain.wgsl
// emits quads as TL-TR-BL + BL-TR-BR, so the diagonal is TR-BL and
// fx + fy <= 1 selects the first triangle.
fn baseMeshHeightAt(bi: f32, bj: f32) -> f32 {
  let mi = (bi + 0.5) / params.baseMeshToGrid.x;
  let mj = (bj + 0.5) / params.baseMeshToGrid.y;
  let quadsX = params.baseGridSize.x / params.baseMeshToGrid.x - 1.0;
  let quadsY = params.baseGridSize.y / params.baseMeshToGrid.y - 1.0;
  let qi = clamp(floor(mi), 0.0, quadsX);
  let qj = clamp(floor(mj), 0.0, quadsY);
  let fx = mi - qi;
  let fy = mj - qj;
  let m = params.baseMeshToGrid;
  let h00 = baseHeightAt(qi * m.x - 0.5, qj * m.y - 0.5);
  let h10 = baseHeightAt((qi + 1.0) * m.x - 0.5, qj * m.y - 0.5);
  let h01 = baseHeightAt(qi * m.x - 0.5, (qj + 1.0) * m.y - 0.5);
  let h11 = baseHeightAt((qi + 1.0) * m.x - 0.5, (qj + 1.0) * m.y - 0.5);
  if (fx + fy <= 1.0) {
    return h00 + (h10 - h00) * fx + (h01 - h00) * fy;
  }
  return h11 + (h10 - h11) * (1.0 - fy) + (h01 - h11) * (1.0 - fx);
}

// Distance to the nearest patch border, in uv units [0, 0.5].
fn edgeDistance(uv: vec2f) -> f32 {
  return min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
}

fn patchUv(gi: f32, gj: f32) -> vec2f {
  return (vec2f(gi, gj) + vec2f(0.5)) / params.gridSize;
}

// Geomorph weight: 0 at the outer edge (pure base surface), 1 inside the
// inner rect (pure patch DEM), a smoothstep ramp across the band.
fn morphWeight(gi: f32, gj: f32) -> f32 {
  return smoothstep(0.0, params.edgeFade, edgeDistance(patchUv(gi, gj)));
}

fn rectContains(r: vec4f, bi: f32, bj: f32) -> bool {
  return bi >= r.x && bi <= r.z && bj >= r.y && bj <= r.w;
}

// Signed ownership margin at base grid coords (bi, bj), in base grid
// cells: the distance to the nearest competing drawn patch's center
// minus the distance to this patch's own center, minimized over every
// drawn patch whose rect also covers the point. Positive = this patch
// owns the pixel; negative = a competitor is nearer and this patch must
// discard the fragment. On the exact bisector (|margin| below a hair)
// the lower slot index wins, applied symmetrically by both patches so
// ownership stays deterministic.
fn splitMargin(bi: f32, bj: f32) -> f32 {
  let selfIdx = i32(params.patchIndex);
  let dSelf = distance(vec2f(bi, bj), params.patchCenters[selfIdx].xy);
  var margin = 1e9;
  let n = i32(params.patchCount);
  for (var q = 0; q < n; q++) {
    if (q == selfIdx) { continue; }
    if (!rectContains(params.patchRects[q], bi, bj)) { continue; }
    let dQ = distance(vec2f(bi, bj), params.patchCenters[q].xy);
    var m = dQ - dSelf;
    if (abs(m) <= 0.001) {
      m = select(0.001, -0.001, q < selfIdx);
    }
    margin = min(margin, m);
  }
  return margin;
}

// The DRAWN surface height at patch grid coords: base-mesh surface near
// the border, patch DEM in the interior, geomorph across the band. Also
// defined just outside the patch (w = 0 there), which keeps the fragment
// normal's finite differences well-formed at the outer edge. The
// Voronoi seam gets the same treatment: the owner morphs back to the
// base surface across splitBand base cells and the loser (discarded)
// morphs to the base surface on its side, so the two patch surfaces
// coincide with the base surface at the split line — no crack, no
// coincident geometry.
fn surfaceElevation(gi: f32, gj: f32) -> f32 {
  let bg = vec2f(
    (gi + 0.5) * params.patchToBaseK.x + params.patchToBaseC.x,
    (gj + 0.5) * params.patchToBaseK.y + params.patchToBaseC.y,
  );
  let w = morphWeight(gi, gj) *
    smoothstep(0.0, params.splitBand, splitMargin(bg.x, bg.y));
  return mix(baseMeshHeightAt(bg.x, bg.y), heightAt(gi, gj), w);
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

  let elevation = surfaceElevation(gi, gj);
  let px = params.originPx + (vec2f(gi, gj) + vec2f(0.5)) * params.cellScale;
  let world = vec3f(
    (px.x - params.centerPx.x) * params.kmPerPx,
    elevation / 1000.0 * params.exaggeration,
    (px.y - params.centerPx.y) * params.kmPerPx,
  );

  var out: VertexOut;
  out.position = params.viewProjection * vec4f(world, 1.0);
  // Depth bias toward the camera: reversed-Z stores near at 1 and the test
  // is "greater", so a positive nudge makes the patch win on the shared
  // border line where both surfaces coincide. Scaled by w it is a
  // constant NDC offset.
  out.position.z += params.biasNdc * out.position.w;
  out.grid = vec2f(gi, gj);
  out.uv = patchUv(gi, gj);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // Voronoi ownership: a fragment covered by several drawn patches is
  // drawn by the nearest-center patch only — the loser discards, so no
  // pixel ever receives two coincident patch surfaces.
  let bg = vec2f(
    (in.grid.x + 0.5) * params.patchToBaseK.x + params.patchToBaseC.x,
    (in.grid.y + 0.5) * params.patchToBaseK.y + params.patchToBaseC.y,
  );
  if (splitMargin(bg.x, bg.y) < 0.0) {
    discard;
  }

  // Normal from central finite differences of the DRAWN (geomorphed)
  // surface — the same field the vertex shader displaces — so the border
  // keeps the base surface's shading and the transition hides inside the
  // band instead of showing a crease. Sample spacing is 2 patch cells of
  // real ground distance; the elevation is exaggerated like the vertex
  // displacement so slopes stay truthful to the render.
  let cellMeters = params.cellKm * 1000.0;
  let dhx = surfaceElevation(in.grid.x + 1.0, in.grid.y) - surfaceElevation(in.grid.x - 1.0, in.grid.y);
  let dhz = surfaceElevation(in.grid.x, in.grid.y + 1.0) - surfaceElevation(in.grid.x, in.grid.y - 1.0);
  let sx = dhx * params.exaggeration / (2.0 * cellMeters);
  let sz = dhz * params.exaggeration / (2.0 * cellMeters);
  let normal = normalize(vec3f(-sx, 1.0, -sz));

  let diffuse = max(dot(normal, SUN_DIR), 0.0);
  let light = params.ambient + params.lightStrength * diffuse;
  let rgb = textureSample(satelliteTex, linearSampler, in.uv).rgb * light;

  // Opaque: the base is discarded under the whole patch, so there is no
  // surface underneath to blend with — the border continuity is carried
  // by the geomorph, not by alpha.
  return vec4f(rgb, 1.0);
}
