import { describe, expect, it } from "vitest";

import {
  detailLiftMeters,
  detailSiteGrids,
  detailSiteSizeKm,
} from "./detail-grids";
import { gridExtentGlobalPixels } from "../geo/grid";
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

describe("detailLiftMeters", () => {
  it("returns the floor margin on flat terrain", () => {
    const flat = new Float32Array(64 * 64).fill(3000);
    const { maxDiffMeters, liftMeters } = detailLiftMeters(flat, 64, 64);
    expect(maxDiffMeters).toBe(0);
    expect(liftMeters).toBe(25);
  });

  it("covers the worst coarse-vs-fine difference plus margin", () => {
    // A narrow ridge one cell wide: downsampling averages it down, so the
    // coarse reconstruction sits well below the fine peak near the crest
    // and above it in the flanks.
    const w = 64;
    const h = 64;
    const heights = new Float32Array(w * h).fill(3000);
    for (let j = 0; j < h; j++) heights[j * w + 32] = 3400;
    const { maxDiffMeters, liftMeters } = detailLiftMeters(
      heights,
      w,
      h,
      8,
    );
    expect(maxDiffMeters).toBeGreaterThan(50);
    expect(liftMeters).toBeGreaterThanOrEqual(
      Math.ceil(maxDiffMeters * 1.2 + 25) - 1,
    );
  });
});
