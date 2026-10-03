import {
  baseGridToPatchGrid,
  type PatchBaseGridMap,
} from "../terrain/detail-grids";
import type { Heightfield } from "../terrain/heightfield";

/**
 * CPU twin of the detail patch's drawn surface (detail.wgsl): while a
 * patch covers — loaded AND in draw distance — the visible elevation
 * inside its full rect is NOT the base DEM but the geomorphed blend
 *   mix(baseMeshElevation, patchHeight, w)
 * with w = smoothstep over the border fade band. Pure functions over
 * plain data (same contract as ray.ts): the caller keeps the patch list
 * in sync with what the detail layer actually draws, so no GPU or layer
 * state leaks in.
 */

/** The base terrain's drawn surface, as the detail shader reproduces it. */
export interface BaseMeshSurface {
  readonly heightfield: Heightfield;
  /**
   * Base grid cells per mesh vertex step — the terrain layer's
   * `gridUniforms.meshToGrid`. The drawn base surface is piecewise-planar
   * over mesh quads, not the raw DEM's bilinear field.
   */
  readonly meshToGrid: readonly [number, number];
}

/** One site's pick data: its discard rect plus the decoded fine DEM. */
export interface DetailPickPatch {
  readonly id: string;
  /** Full outer extent in base grid coords: [i0, j0, i1, j1]. */
  readonly rect: readonly [number, number, number, number];
  /** Patch<->base grid coord map (from patchBaseGridMap). */
  readonly gridMap: PatchBaseGridMap;
  /** Patch heights (the finer DEM the visible surface comes from). */
  readonly heightfield: Heightfield;
  /** Geomorph band width in patch-uv units (DETAIL_EDGE_FADE). */
  readonly edgeFade: number;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of `baseMeshHeightAt` in detail.wgsl: the base terrain's DRAWN
 * surface at base grid coords (bi, bj). The base mesh triangulates each
 * quad as TL-TR-BL + BL-TR-BR, so between mesh vertices the surface is
 * the containing triangle's plane — not the DEM's bilinear field.
 */
export function baseMeshElevation(
  base: BaseMeshSurface,
  bi: number,
  bj: number,
): number {
  const { heightfield, meshToGrid } = base;
  const spec = heightfield.spec;
  const mi = (bi + 0.5) / meshToGrid[0];
  const mj = (bj + 0.5) / meshToGrid[1];
  const quadsX = spec.width / meshToGrid[0] - 1;
  const quadsY = spec.height / meshToGrid[1] - 1;
  const qi = Math.min(Math.max(Math.floor(mi), 0), quadsX);
  const qj = Math.min(Math.max(Math.floor(mj), 0), quadsY);
  const fx = mi - qi;
  const fy = mj - qj;
  const at = (qI: number, qJ: number): number =>
    heightfield.heightAtGrid(
      qI * meshToGrid[0] - 0.5,
      qJ * meshToGrid[1] - 0.5,
    );
  const h00 = at(qi, qj);
  const h10 = at(qi + 1, qj);
  const h01 = at(qi, qj + 1);
  const h11 = at(qi + 1, qj + 1);
  if (fx + fy <= 1) {
    return h00 + (h10 - h00) * fx + (h01 - h00) * fy;
  }
  return h11 + (h10 - h11) * (1 - fy) + (h01 - h11) * (1 - fx);
}

/**
 * The elevation the user sees at base grid coords (bi, bj): inside a
 * covering patch's rect, the geomorphed blend of the base-mesh surface
 * and the patch DEM (w = smoothstep over the border band); everywhere
 * else, the base heightfield's bilinear sample — the same value the
 * unmodified pick path reports.
 */
export function detailSurfaceElevation(
  base: BaseMeshSurface,
  patches: readonly DetailPickPatch[],
  bi: number,
  bj: number,
): number {
  for (const patch of patches) {
    const [i0, j0, i1, j1] = patch.rect;
    if (bi < i0 || bi > i1 || bj < j0 || bj > j1) continue;
    const [gi, gj] = baseGridToPatchGrid(patch.gridMap, bi, bj);
    const spec = patch.heightfield.spec;
    const u = (gi + 0.5) / spec.width;
    const v = (gj + 0.5) / spec.height;
    const edge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
    const w = smoothstep(0, patch.edgeFade, edge);
    const baseE = baseMeshElevation(base, bi, bj);
    return baseE + (patch.heightfield.heightAtGrid(gi, gj) - baseE) * w;
  }
  return base.heightfield.heightAtGrid(bi, bj);
}
