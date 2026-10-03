import { describe, expect, it } from "vitest";

import { downsampleGrid, type GridSpec } from "../geo/grid";
import { DEM_GRID, SATELLITE_GRID } from "../geo/jujuy";
import { assertSameGroundExtent, GridExtentMismatchError } from "./validate";

describe("assertSameGroundExtent", () => {
  it("accepts the real high-quality grids", () => {
    expect(() => assertSameGroundExtent(DEM_GRID, SATELLITE_GRID)).not.toThrow();
  });

  it("accepts the real default (downsampled) grids", () => {
    expect(() =>
      assertSameGroundExtent(
        downsampleGrid(DEM_GRID, 2),
        downsampleGrid(SATELLITE_GRID, 2),
      ),
    ).not.toThrow();
  });

  it("rejects a shifted satellite origin", () => {
    const shifted: GridSpec = {
      ...SATELLITE_GRID,
      originPx: [SATELLITE_GRID.originPx[0] + 1, SATELLITE_GRID.originPx[1]],
    };
    expect(() => assertSameGroundExtent(DEM_GRID, shifted)).toThrow(
      GridExtentMismatchError,
    );
  });

  it("rejects a shifted height origin", () => {
    const shifted: GridSpec = {
      ...DEM_GRID,
      originPx: [DEM_GRID.originPx[0], DEM_GRID.originPx[1] + 1],
    };
    expect(() => assertSameGroundExtent(shifted, SATELLITE_GRID)).toThrow(
      GridExtentMismatchError,
    );
  });

  it("rejects a wrong zoom", () => {
    const wrongZoom: GridSpec = { ...SATELLITE_GRID, zoom: 10 };
    expect(() => assertSameGroundExtent(DEM_GRID, wrongZoom)).toThrow(
      GridExtentMismatchError,
    );
  });

  it("carries both extents in the error message", () => {
    const shifted: GridSpec = {
      ...SATELLITE_GRID,
      originPx: [SATELLITE_GRID.originPx[0] + 4, SATELLITE_GRID.originPx[1]],
    };
    let error: unknown;
    try {
      assertSameGroundExtent(DEM_GRID, shifted);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GridExtentMismatchError);
    const message = (error as Error).message;
    // DEM extent at z11 and the shifted satellite extent, both in the message.
    expect(message).toContain("164096");
    expect(message).toContain("164100");
  });
});
