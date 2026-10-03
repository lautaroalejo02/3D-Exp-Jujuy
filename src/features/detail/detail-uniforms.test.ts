import { describe, expect, it } from "vitest";

import {
  buildPatchGridUniforms,
  DETAIL_DRAW_DISTANCE_FACTOR,
  detailDrawDistanceKm,
  patchGlobalPixelToWorld,
} from "./detail-uniforms";
import {
  globalPixelToGrid,
  gridToGlobalPixel,
  gridToWorld,
  type GridSpec,
} from "../../geo";
import { DEM_GRID } from "../../geo/jujuy";

/** Hornocal's patch grids, as derived by detailSiteGrids (z14/z12). */
const PATCH_HEIGHTS: GridSpec = {
  zoom: 12,
  originPx: [5224 * 64, 9277 * 64],
  width: 576,
  height: 576,
  scale: 1,
};
const MESH: readonly [number, number] = [577, 577];

describe("buildPatchGridUniforms", () => {
  it("maps patch grid coords into the base grid's world space", () => {
    const u = buildPatchGridUniforms(PATCH_HEIGHTS, DEM_GRID, MESH);
    const zoomFactor = 2 ** (PATCH_HEIGHTS.zoom - DEM_GRID.zoom);
    for (const [gi, gj] of [
      [0, 0],
      [287.5, 575.5],
      [575, 123.25],
    ] as const) {
      const [px, py] = gridToGlobalPixel(PATCH_HEIGHTS, gi, gj);
      const [x, z] = patchGlobalPixelToWorld(u, px, py);
      // Ground truth: the same point expressed on the base grid, mapped
      // through src/geo's world transform.
      const [bi, bj] = globalPixelToGrid(
        DEM_GRID,
        px / zoomFactor,
        py / zoomFactor,
      );
      const [wx, , wz] = gridToWorld(DEM_GRID, bi, bj);
      expect(x).toBeCloseTo(wx, 9);
      expect(z).toBeCloseTo(wz, 9);
    }
  });

  it("keeps the base grid's km-per-pixel at the patch zoom", () => {
    const u = buildPatchGridUniforms(PATCH_HEIGHTS, DEM_GRID, MESH);
    const zoomFactor = 2 ** (PATCH_HEIGHTS.zoom - DEM_GRID.zoom);
    expect(u.centerPx[0]).toBeCloseTo(
      (DEM_GRID.originPx[0] + DEM_GRID.width / 2) * zoomFactor,
      9,
    );
    // kmPerPx at z12 is a quarter of the base's z10 value.
    expect(u.kmPerPx).toBeCloseTo(
      (u.cellKm / PATCH_HEIGHTS.scale) as number,
      12,
    );
  });
});

describe("detailDrawDistanceKm", () => {
  it("scales with the patch's larger side", () => {
    expect(detailDrawDistanceKm([20, 25])).toBeCloseTo(
      25 * DETAIL_DRAW_DISTANCE_FACTOR,
      9,
    );
  });
});
