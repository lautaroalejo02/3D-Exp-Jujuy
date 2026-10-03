import { describe, expect, it } from "vitest";

import {
  baseGridToPatchGrid,
  buildDetailPatchRects,
  detailPatchRectBaseGrid,
  detailSiteGrids,
  detailSiteSizeKm,
  MAX_DETAIL_PATCHES,
  patchBaseGridMap,
  patchGridToBaseGrid,
} from "./detail-grids";
import { gridExtentGlobalPixels, type GridSpec } from "../geo/grid";
import { assertSameGroundExtent } from "./validate";

const SAT = { zoom: 14, x: [5224, 5232], y: [9277, 9285] } as const;
const DEM = { zoom: 12, x: [1306, 1308], y: [2319, 2321] } as const;

describe("detailSiteGrids", () => {
  it("derives satellite, heights and DEM mosaic specs from tile ranges", () => {
    const g = detailSiteGrids("hornocal", SAT, DEM);
    expect(g.satelliteGrid).toEqual({
      zoom: 14,
      originPx: [5224 * 256, 9277 * 256],
      width: 9 * 256,
      height: 9 * 256,
      scale: 1,
    });
    expect(g.demMosaicGrid).toEqual({
      zoom: 12,
      originPx: [1306 * 256, 2319 * 256],
      width: 3 * 256,
      height: 3 * 256,
      scale: 1,
    });
    // The satellite extent in z12 px: every z14 px divides by 4.
    expect(g.heightsGrid).toEqual({
      zoom: 12,
      originPx: [5224 * 64, 9277 * 64],
      width: 9 * 64,
      height: 9 * 64,
      scale: 1,
    });
  });

  it("crops the DEM mosaic to the satellite extent", () => {
    const g = detailSiteGrids("hornocal", SAT, DEM);
    // Satellite left edge lands exactly on the DEM block's west edge;
    // the crop window must stay inside the 768x768 mosaic.
    expect(g.demCrop).toEqual({ x: 0, y: 64, width: 576, height: 576 });
    expect(g.demCrop.x + g.demCrop.width).toBeLessThanOrEqual(
      g.demMosaicGrid.width,
    );
    expect(g.demCrop.y + g.demCrop.height).toBeLessThanOrEqual(
      g.demMosaicGrid.height,
    );
  });

  it("heights and satellite grids cover the same ground extent", () => {
    const g = detailSiteGrids("hornocal", SAT, DEM);
    // assertSameGroundExtent compares extents at the finer zoom.
    expect(() =>
      assertSameGroundExtent(g.heightsGrid, g.satelliteGrid),
    ).not.toThrow();
    // And explicitly: heights extent * 4 == satellite extent.
    const h = gridExtentGlobalPixels(g.heightsGrid);
    const s = gridExtentGlobalPixels(g.satelliteGrid);
    for (let k = 0; k < 4; k++) {
      expect((h[k] ?? 0) * 4).toBe(s[k]);
    }
  });

  it("throws when the DEM block does not cover the satellite extent", () => {
    const shiftedDem = { zoom: 12, x: [1307, 1309], y: [2319, 2321] } as const;
    expect(() => detailSiteGrids("hornocal", SAT, shiftedDem)).toThrow(
      /not fully covered/,
    );
  });

  it("rejects inverted or fractional tile ranges", () => {
    const bad = { zoom: 14, x: [5232, 5224], y: [9277, 9285] } as const;
    expect(() => detailSiteGrids("x", bad, DEM)).toThrow(/invalid tile range/);
  });
});

describe("detailSiteSizeKm", () => {
  it("reports ground kilometers of the patch extent", () => {
    const g = detailSiteGrids("hornocal", SAT, DEM);
    const [x, z] = detailSiteSizeKm(g.heightsGrid);
    // ~35 m per z12 px near 24°S -> 576 cells ≈ 20 km.
    expect(x).toBeGreaterThan(15);
    expect(x).toBeLessThan(30);
    expect(z).toBeCloseTo(x, 6);
  });
});

// Base grid at z10 (like the real terrain) and a patch at z12: each patch
// pixel is a quarter of a base pixel, so the patch<->base map has k = 0.25.
const BASE_SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 64,
  height: 80,
  scale: 1,
};

// Patch whose outer edge lands on clean base grid coords: z12 origin
// 40 z12-px right + 80 z12-px down of the base origin → base coords
// i0 = 10 - 0.5 = 9.5, j0 = 20 - 0.5 = 19.5.
const PATCH_SPEC: GridSpec = {
  zoom: 12,
  originPx: [4 * 82048 + 40, 4 * 147200 + 80],
  width: 128,
  height: 64,
  scale: 1,
};

describe("patchBaseGridMap", () => {
  it("is affine in patch-pixel units and inverts", () => {
    const map = patchBaseGridMap(PATCH_SPEC, BASE_SPEC);
    // k = 2^(10-12) = 0.25: one base cell is 4 patch cells.
    expect(map.k).toEqual([0.25, 0.25]);
    expect(map.c).toEqual([9.5, 19.5]);
    for (const [gi, gj] of [
      [0, 0],
      [3.5, 10.25],
      [127, 63],
    ] as const) {
      const [bi, bj] = patchGridToBaseGrid(map, gi, gj);
      const [ri, rj] = baseGridToPatchGrid(map, bi, bj);
      expect(ri).toBeCloseTo(gi, 10);
      expect(rj).toBeCloseTo(gj, 10);
    }
  });

  it("maps a spec onto itself identically", () => {
    const map = patchBaseGridMap(BASE_SPEC, BASE_SPEC);
    expect(map.k).toEqual([1, 1]);
    expect(map.c).toEqual([-0.5, -0.5]);
    expect(patchGridToBaseGrid(map, 10.5, 20.25)).toEqual([10.5, 20.25]);
  });
});

describe("detailPatchRectBaseGrid", () => {
  it("covers the patch's FULL outer edge in base grid coords", () => {
    const rect = detailPatchRectBaseGrid(PATCH_SPEC, BASE_SPEC);
    // Patch spans z12 px [4*82048+40, +128] = base px [82058, 82090]:
    // base grid coords 9.5 .. 41.5. Same for j: 19.5 .. 35.5.
    expect(rect).toEqual([9.5, 19.5, 41.5, 35.5]);
  });

  it("rect edges equal the patch edge lines, not cell centers", () => {
    const rect = detailPatchRectBaseGrid(PATCH_SPEC, BASE_SPEC);
    const map = patchBaseGridMap(PATCH_SPEC, BASE_SPEC);
    const [i0] = patchGridToBaseGrid(map, -0.5, 0);
    const [i1] = patchGridToBaseGrid(map, PATCH_SPEC.width - 0.5, 0);
    const [, j0] = patchGridToBaseGrid(map, 0, -0.5);
    const [, j1] = patchGridToBaseGrid(map, 0, PATCH_SPEC.height - 0.5);
    expect(rect[0]).toBeCloseTo(i0, 9);
    expect(rect[1]).toBeCloseTo(j0, 9);
    expect(rect[2]).toBeCloseTo(i1, 9);
    expect(rect[3]).toBeCloseTo(j1, 9);
  });
});

describe("buildDetailPatchRects", () => {
  it("keeps every site — the shader cap applies to drawn patches only", () => {
    // The registry is per-site, not per-frame: 29 sites exceed
    // MAX_DETAIL_PATCHES (the simultaneously-drawn limit) and all of
    // them still need a rect so the mask can find them by id.
    const sites = Array.from({ length: MAX_DETAIL_PATCHES + 1 }, (_, n) => ({
      id: `s${n}`,
      spec: PATCH_SPEC,
    }));
    const rects = buildDetailPatchRects(sites, BASE_SPEC);
    expect(rects).toHaveLength(sites.length);
    expect(rects.map((r) => r.id)).toEqual(sites.map((s) => s.id));
  });

  it("keeps site order", () => {
    const rects = buildDetailPatchRects(
      [
        { id: "a", spec: PATCH_SPEC },
        { id: "b", spec: BASE_SPEC },
      ],
      BASE_SPEC,
    );
    expect(rects.map((r) => r.id)).toEqual(["a", "b"]);
    // Identity map: the base-spec rect is the spec's own grid extent.
    expect(rects[1]!.rect).toEqual([
      -0.5,
      -0.5,
      BASE_SPEC.width - 0.5,
      BASE_SPEC.height - 0.5,
    ]);
  });
});
