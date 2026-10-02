import { describe, expect, it } from "vitest";

import {
  downsampleGrid,
  globalPixelToGrid,
  gridContains,
  gridExtentGlobalPixels,
  gridExtentLonLat,
  gridToGlobalPixel,
  gridToLonLat,
  lonLatToGrid,
  type GridSpec,
} from "./grid";
import { DEM_GRID, DEM_MOSAIC_GRID, SATELLITE_GRID } from "./jujuy";
import { globalPixelToMercator } from "./slippy";

describe("gridToGlobalPixel", () => {
  it("places sample (i, j) at the center of its pixel", () => {
    const spec: GridSpec = { zoom: 10, originPx: [100, 200], width: 4, height: 4, scale: 1 };
    expect(gridToGlobalPixel(spec, 0, 0)).toEqual([100.5, 200.5]);
    expect(gridToGlobalPixel(spec, 3, 2)).toEqual([103.5, 202.5]);
  });

  it("uses a `scale`-sized block center when downsampled", () => {
    const spec: GridSpec = { zoom: 10, originPx: [100, 200], width: 4, height: 4, scale: 2 };
    expect(gridToGlobalPixel(spec, 0, 0)).toEqual([101, 201]);
    expect(gridToGlobalPixel(spec, 1, 0)).toEqual([103, 201]);
  });
});

describe("lonLatToGrid / gridToLonLat", () => {
  it("round-trips within 1e-9 grid cells", () => {
    const spec = DEM_GRID;
    for (const [lon, lat] of [
      [-65.35, -23.205],
      [-64.5, -24.0],
    ] as const) {
      const [i, j] = lonLatToGrid(spec, lon, lat);
      const [lon2, lat2] = gridToLonLat(spec, i, j);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });

  it("maps the grid corner to a fractional cell position", () => {
    const spec: GridSpec = { zoom: 10, originPx: [100, 200], width: 4, height: 4, scale: 1 };
    // The corner itself is half a cell outside sample (0, 0).
    const [i, j] = globalPixelToGrid(spec, 100, 200);
    expect(i).toBeCloseTo(-0.5, 12);
    expect(j).toBeCloseTo(-0.5, 12);
  });
});

describe("downsampleGrid", () => {
  it("halves resolution at factor 2 keeping zoom and originPx", () => {
    const half = downsampleGrid(DEM_GRID, 2);
    expect(half.zoom).toBe(DEM_GRID.zoom);
    expect(half.originPx).toEqual(DEM_GRID.originPx);
    expect(half.scale).toBe(2);
    expect(half.width).toBe(1216);
    expect(half.height).toBe(1280);
  });

  it("keeps the same extent in global pixels", () => {
    const half = downsampleGrid(DEM_GRID, 2);
    expect(gridExtentGlobalPixels(half)).toEqual(gridExtentGlobalPixels(DEM_GRID));
  });

  it("cell (0,0) of the half grid samples the center of a 2x2 block", () => {
    const half = downsampleGrid(DEM_GRID, 2);
    const [px, py] = gridToGlobalPixel(half, 0, 0);
    expect(px).toBeCloseTo(DEM_GRID.originPx[0] + 1, 12);
    expect(py).toBeCloseTo(DEM_GRID.originPx[1] + 1, 12);
  });
});

describe("project grids", () => {
  it("DEM mosaic spans tiles x 320..329, y 575..584 at z10", () => {
    expect(DEM_MOSAIC_GRID.zoom).toBe(10);
    expect(gridExtentGlobalPixels(DEM_MOSAIC_GRID)).toEqual([
      320 * 256,
      575 * 256,
      330 * 256,
      585 * 256,
    ]);
  });

  it("cropped DEM extent equals the satellite extent exactly (in mercator)", () => {
    const dem = gridExtentGlobalPixels(DEM_GRID);
    const sat = gridExtentGlobalPixels(SATELLITE_GRID);
    // Compare in mercator meters — zoom-independent.
    const demMin = globalPixelToMercator(dem[0], dem[1], DEM_GRID.zoom);
    const demMax = globalPixelToMercator(dem[2], dem[3], DEM_GRID.zoom);
    const satMin = globalPixelToMercator(sat[0], sat[1], SATELLITE_GRID.zoom);
    const satMax = globalPixelToMercator(sat[2], sat[3], SATELLITE_GRID.zoom);
    for (let k = 0; k < 2; k++) {
      expect(satMin[k]).toBeCloseTo(demMin[k] ?? 0, 6);
      expect(satMax[k]).toBeCloseTo(demMax[k] ?? 0, 6);
    }
  });

  it("satellite extent also matches in degrees", () => {
    expect(gridExtentLonLat(SATELLITE_GRID)).toEqual(gridExtentLonLat(DEM_GRID));
  });

  it("contains Humahuaca and Abra Pampa (bounds check only)", () => {
    for (const [lon, lat] of [
      [-65.35, -23.205], // Humahuaca
      [-65.7, -22.72], // Abra Pampa
    ] as const) {
      const [i, j] = lonLatToGrid(DEM_GRID, lon, lat);
      expect(gridContains(DEM_GRID, i, j)).toBe(true);
    }
  });
});
