import { describe, expect, it } from "vitest";

import { elevationToWorldY } from "../geo/world";
import {
  basePlaneKm,
  CONTEXT_LIFT_KM,
  contextBaseKm,
  cutWallTopKm,
  drawnMetersAt,
  flattenMarginMeters,
  flattenedMeters,
  flattenedWorldY,
  heightGridToSdfGrid,
  OUTSIDE_FLATTEN,
  provinceInside,
  rimWallTopKm,
  slabTopKm,
  wallBottomKm,
  type ContextFlatten,
} from "./context-flatten";

const MIN_M = 1000;
const EXAG = 3;

describe("base plane contract", () => {
  it("basePlaneKm sits SKIRT_KM below the exaggerated minimum", () => {
    expect(basePlaneKm(MIN_M, EXAG)).toBeCloseTo((MIN_M / 1000) * EXAG - 10);
  });

  it("contextBaseKm floats CONTEXT_LIFT_KM above the base plane", () => {
    expect(contextBaseKm(MIN_M, EXAG)).toBeCloseTo(
      basePlaneKm(MIN_M, EXAG) + CONTEXT_LIFT_KM,
    );
  });

  it("wall bottom and slab top are the same plane, for both walls", () => {
    expect(wallBottomKm(MIN_M, EXAG)).toBe(slabTopKm(MIN_M, EXAG));
    expect(wallBottomKm(MIN_M, EXAG)).toBe(basePlaneKm(MIN_M, EXAG));
  });
});

describe("flattened surface", () => {
  it("keeps OUTSIDE_FLATTEN of the relief on the context plain", () => {
    const worldY = (4000 / 1000) * EXAG; // 12 km drawn
    expect(flattenedWorldY(worldY, MIN_M, EXAG)).toBeCloseTo(
      contextBaseKm(MIN_M, EXAG) + worldY * OUTSIDE_FLATTEN,
    );
  });

  it("flattenedMeters round-trips through elevationToWorldY", () => {
    const meters = 4000;
    const worldY = elevationToWorldY(meters, EXAG);
    expect(
      elevationToWorldY(flattenedMeters(meters, MIN_M, EXAG), EXAG),
    ).toBeCloseTo(flattenedWorldY(worldY, MIN_M, EXAG));
  });

  it("wall tops track the drawn surface on each side of the boundary", () => {
    // Cut wall: the boundary itself is not flattened.
    expect(cutWallTopKm(4000, EXAG)).toBeCloseTo(
      elevationToWorldY(4000, EXAG),
    );
    // Rim wall: the grid edge is outside, so it follows the flat plain.
    expect(rimWallTopKm(4000, MIN_M, EXAG)).toBeCloseTo(
      flattenedWorldY(elevationToWorldY(4000, EXAG), MIN_M, EXAG),
    );
    // Rim top stays above the shared base plane.
    expect(rimWallTopKm(4000, MIN_M, EXAG)).toBeGreaterThan(
      basePlaneKm(MIN_M, EXAG),
    );
  });

  it("margin covers the dip below the DEM minimum", () => {
    const margin = flattenMarginMeters(MIN_M, EXAG);
    expect(margin).toBeGreaterThan(0);
    // min - margin reaches the flattened minimum exactly.
    expect(MIN_M - margin).toBeCloseTo(
      flattenedMeters(MIN_M, MIN_M, EXAG),
    );
  });
});

describe("provinceInside", () => {
  // 4x4 SDF: a 2x2 inside block at cells (1..2, 1..2).
  const sdf = new Int8Array([
    -5, -5, -5, -5,
    -5, 3, 3, -5,
    -5, 3, 3, -5,
    -5, -5, -5, -5,
  ]);
  const ctx: ContextFlatten = {
    sdf,
    sdfWidth: 4,
    sdfHeight: 4,
    gridWidth: 4,
    gridHeight: 4,
    minElevationMeters: MIN_M,
    verticalExaggeration: () => EXAG,
  };

  it("maps height-grid coords into SDF coords (identity on equal dims)", () => {
    expect(heightGridToSdfGrid(0, 0, 4, 4, 4, 4)).toEqual([0, 0]);
    expect(heightGridToSdfGrid(2.5, 1.5, 4, 4, 4, 4)).toEqual([2.5, 1.5]);
    // A finer SDF raster rescales by cell-center convention.
    expect(heightGridToSdfGrid(0, 0, 4, 4, 8, 8)).toEqual([0.5, 0.5]);
  });

  it("is inside on positive cells and outside on negative ones", () => {
    expect(provinceInside(ctx, 1, 1)).toBe(true);
    expect(provinceInside(ctx, 2, 2)).toBe(true);
    expect(provinceInside(ctx, 0, 0)).toBe(false);
    expect(provinceInside(ctx, 3, 3)).toBe(false);
  });

  it("treats the bilinear zero-crossing as inside (sdf >= 0)", () => {
    // Between cell (0,0) = -5 and (1,0) = -5 all negative; at (1,1)=3
    // and (0,1)=-5 the midpoint is -1 -> outside.
    expect(provinceInside(ctx, 0.5, 0.5)).toBe(false);
    // Midpoint of (1,1)=3 and (1,2)=3 stays inside.
    expect(provinceInside(ctx, 1, 1.5)).toBe(true);
  });

  it("drawnMetersAt keeps inside heights and flattens outside ones", () => {
    expect(drawnMetersAt(ctx, 4000, 1.5, 1.5)).toBe(4000);
    expect(drawnMetersAt(ctx, 4000, 0, 0)).toBeCloseTo(
      flattenedMeters(4000, MIN_M, EXAG),
    );
  });
});
