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
  /** Patch center in base grid coords (Voronoi arbitration point). */
  readonly center: readonly [number, number];
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

/** Rect contain test, same bounds convention as detail.wgsl. */
function contains(
  rect: readonly [number, number, number, number],
  bi: number,
  bj: number,
): boolean {
  return bi >= rect[0] && bi <= rect[2] && bj >= rect[1] && bj <= rect[3];
}

/**
 * CPU twin of splitMargin in detail.wgsl: the owning patch's signed
 * margin — distance to the nearest competing covering patch's center
 * minus its own, in base grid cells — or a negative value when a
 * competitor is nearer (the shader discards those fragments). The exact
 * bisector goes to the lower list index, applied symmetrically, so both
 * sides of the seam agree and ownership is deterministic.
 */
function splitMargin(
  patches: readonly DetailPickPatch[],
  self: number,
  bi: number,
  bj: number,
): number {
  const selfPatch = patches[self];
  if (selfPatch === undefined) return -Infinity; // unreachable by caller
  const dSelf = Math.hypot(
    bi - selfPatch.center[0],
    bj - selfPatch.center[1],
  );
  let margin = Infinity;
  for (let q = 0; q < patches.length; q++) {
    const other = patches[q];
    if (q === self || other === undefined) continue;
    if (!contains(other.rect, bi, bj)) continue;
    let m =
      Math.hypot(bi - other.center[0], bj - other.center[1]) - dSelf;
    if (Math.abs(m) <= 0.001) {
      m = q < self ? -0.001 : 0.001;
    }
    margin = Math.min(margin, m);
  }
  return margin;
}

/**
 * The elevation the user sees at base grid coords (bi, bj): inside a
 * covering patch's rect, the geomorphed blend of the base-mesh surface
 * and the patch DEM (w = smoothstep over the border band); everywhere
 * else, the base heightfield's bilinear sample — the same value the
 * unmodified pick path reports.
 *
 * Overlaps follow the shader's Voronoi split: among covering patches the
 * one whose center is nearest owns the point (lower index on the exact
 * bisector), and within `splitBand` base cells of the seam the owner
 * morphs back to the base surface — the drawn surface stays continuous.
 */
export function detailSurfaceElevation(
  base: BaseMeshSurface,
  patches: readonly DetailPickPatch[],
  bi: number,
  bj: number,
  splitBand: number,
): number {
  for (let p = 0; p < patches.length; p++) {
    const patch = patches[p];
    if (patch === undefined) continue;
    if (!contains(patch.rect, bi, bj)) continue;
    const margin = splitMargin(patches, p, bi, bj);
    if (margin < 0) continue; // a nearer patch owns this point
    const [gi, gj] = baseGridToPatchGrid(patch.gridMap, bi, bj);
    const spec = patch.heightfield.spec;
    const u = (gi + 0.5) / spec.width;
    const v = (gj + 0.5) / spec.height;
    const edge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
    const w =
      smoothstep(0, patch.edgeFade, edge) * smoothstep(0, splitBand, margin);
    const baseE = baseMeshElevation(base, bi, bj);
    return baseE + (patch.heightfield.heightAtGrid(gi, gj) - baseE) * w;
  }
  return base.heightfield.heightAtGrid(bi, bj);
}
