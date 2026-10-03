import {
  gridCenterGlobalPixel,
  groundMetersPerPixel,
  type GridSpec,
} from "../../geo";
import type { TerrainGridUniforms } from "../../terrain/terrain-uniforms";

/**
 * Uniform values for detail.wgsl: a small patch grid rendered inside the
 * BASE terrain's world space. The vertex math is identical to the base
 * terrain (src/geo gridToWorld: X east, Z south, Y up, km of ground
 * distance, Y = elevationMeters / 1000 * exaggeration) — the only
 * difference is that `centerPx` and `kmPerPx` belong to the base grid,
 * re-expressed at the patch zoom: global px counts scale by
 * 2^(patchZoom - baseZoom), so the base center is multiplied by that
 * factor and the base km-per-pixel divided by it.
 */

/**
 * UV band at each patch border over which the elevation geomorphs from
 * the base surface (weight 0 at the outer edge) to the patch DEM (weight
 * 1 at the inner rect). The geomorph — not an alpha fade — hides the
 * seam, so the patch can draw opaque over the discarded base.
 */
export const DETAIL_EDGE_FADE = 0.05;

/**
 * Width of the overlap Voronoi geomorph band, in BASE grid cells: within
 * this distance of the line equidistant to the runner-up drawn patch,
 * the owner morphs back toward the base surface so the two patch
 * surfaces coincide with the base at the split line (detail.wgsl; the
 * CPU twin is detail-pick.ts).
 */
export const DETAIL_SPLIT_BAND_CELLS = 8;

/**
 * Fraction of clip-space w added to the patch's clip z. With reversed-Z
 * (near -> 1, far -> 0, compare "greater") a positive nudge makes the
 * patch win over the coincident base surface instead of z-fighting. At a
 * typical viewing distance (~20 km, near 0.5 km) the offset equals ~1.6 m
 * of depth — far above f32 depth noise (~mm) and far below the relief.
 * Still needed with geomorphing: the patch's outer edge coincides with
 * the base surface exactly, and the shared rasterized line would
 * z-fight without it.
 *
 * Done in the shader rather than the pipeline's depthBias because the
 * units of depthBias on depth32float are implementation-dependent; a
 * clip-space offset is exact on every backend.
 */
export const DETAIL_DEPTH_BIAS_NDC = 2e-6;

/**
 * Draw a patch only while the camera is closer than this factor times the
 * patch's ground size — far enough that the patch's ~20 km extent still
 * reads as a wide vista, near enough that ~9 m/px imagery is an
 * improvement over the ~140 m/px base.
 */
export const DETAIL_DRAW_DISTANCE_FACTOR = 4;

/** Camera distance below which a patch is drawn, in km. */
export function detailDrawDistanceKm(
  sizeKm: readonly [number, number],
): number {
  return Math.max(sizeKm[0], sizeKm[1]) * DETAIL_DRAW_DISTANCE_FACTOR;
}

/**
 * Uniforms mapping the patch grid into the base terrain's world space.
 * `meshSize` is in vertices; mesh vertex (0, 0) sits on the patch's
 * north-west border (grid coord -0.5), like the base terrain mesh.
 */
export function buildPatchGridUniforms(
  spec: GridSpec,
  baseSpec: GridSpec,
  meshSize: readonly [number, number],
): TerrainGridUniforms {
  if (meshSize[0] < 2 || meshSize[1] < 2) {
    throw new Error(
      `detail mesh needs at least 2x2 vertices, got ${meshSize[0]}x${meshSize[1]}`,
    );
  }
  const zoomFactor = 2 ** (spec.zoom - baseSpec.zoom);
  const baseCenter = gridCenterGlobalPixel(baseSpec);
  const kmPerPx = groundMetersPerPixel(baseSpec) / 1000 / zoomFactor;
  return {
    originPx: [spec.originPx[0], spec.originPx[1]],
    centerPx: [baseCenter[0] * zoomFactor, baseCenter[1] * zoomFactor],
    gridSize: [spec.width, spec.height],
    meshSize: [meshSize[0], meshSize[1]],
    meshToGrid: [
      spec.width / (meshSize[0] - 1),
      spec.height / (meshSize[1] - 1),
    ],
    kmPerPx,
    cellScale: spec.scale,
    cellKm: kmPerPx * spec.scale,
  };
}

/**
 * World position (x east, z south, km, ground plane) of a global pixel at
 * the patch zoom, in the base grid's world space. Same formula the shader
 * applies; used for the camera-proximity check.
 */
export function patchGlobalPixelToWorld(
  u: Pick<TerrainGridUniforms, "centerPx" | "kmPerPx">,
  px: number,
  py: number,
): readonly [number, number] {
  return [(px - u.centerPx[0]) * u.kmPerPx, (py - u.centerPx[1]) * u.kmPerPx];
}
