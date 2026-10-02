import { describe, expect, it } from "vitest";

import { gridToLonLat, lonLatToGrid } from "./grid";
import { DEM_GRID } from "./jujuy";
import {
  elevationToWorldY,
  gridToWorld,
  groundMetersPerPixel,
  lonLatToWorld,
  metersPerGridCell,
  worldToGrid,
  worldToLonLat,
} from "./world";

describe("world space", () => {
  it("puts the origin at the grid center", () => {
    // The geometric center lies between the two middle cells.
    const [i, j] = worldToGrid(DEM_GRID, 0, 0);
    expect(i).toBeCloseTo(DEM_GRID.width / 2 - 0.5, 9);
    expect(j).toBeCloseTo(DEM_GRID.height / 2 - 0.5, 9);
    const [x, y, z] = gridToWorld(DEM_GRID, i, j);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBe(0);
    expect(z).toBeCloseTo(0, 9);
  });

  it("grows +X eastward and +Z southward", () => {
    const east = gridToWorld(DEM_GRID, DEM_GRID.width - 1, 0);
    const west = gridToWorld(DEM_GRID, 0, 0);
    expect(east[0]).toBeGreaterThan(west[0]);
    const south = gridToWorld(DEM_GRID, 0, DEM_GRID.height - 1);
    const north = gridToWorld(DEM_GRID, 0, 0);
    expect(south[2]).toBeGreaterThan(north[2]);
  });

  it("round-trips grid -> world -> grid", () => {
    for (const [i, j] of [
      [0, 0],
      [1215.5, 1279.5],
      [2431, 2559],
    ] as const) {
      const [x, , z] = gridToWorld(DEM_GRID, i, j);
      const [i2, j2] = worldToGrid(DEM_GRID, x, z);
      expect(i2).toBeCloseTo(i, 9);
      expect(j2).toBeCloseTo(j, 9);
    }
  });

  it("round-trips lon/lat -> world -> lon/lat", () => {
    for (const [lon, lat] of [
      [-65.35, -23.205],
      [-65.7, -22.72],
    ] as const) {
      const [x, , z] = lonLatToWorld(DEM_GRID, lon, lat);
      const [lon2, lat2] = worldToLonLat(DEM_GRID, x, z);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });

  it("uses ground kilometers: world width matches metersPerGridCell * cells", () => {
    const westX = gridToWorld(DEM_GRID, -0.5, 0)[0];
    const eastX = gridToWorld(DEM_GRID, DEM_GRID.width - 0.5, 0)[0];
    const km = eastX - westX;
    expect(km).toBeCloseTo((metersPerGridCell(DEM_GRID) * DEM_GRID.width) / 1000, 9);
    // Sanity: the Jujuy crop is ~340 km wide on the ground.
    expect(km).toBeGreaterThan(300);
    expect(km).toBeLessThan(390);
  });

  it("scales Y linearly with elevation and vertical exaggeration", () => {
    expect(elevationToWorldY(1000, 1)).toBeCloseTo(1, 12);
    expect(elevationToWorldY(1000, 2.5)).toBeCloseTo(2.5, 12);
    const a = gridToWorld(DEM_GRID, 10, 10, { elevationMeters: 4000, verticalExaggeration: 1 });
    const b = gridToWorld(DEM_GRID, 10, 10, { elevationMeters: 4000, verticalExaggeration: 2.5 });
    expect(b[1]).toBeCloseTo(a[1] * 2.5, 12);
    expect(b[0]).toBeCloseTo(a[0], 12);
  });

  it("metersPerGridCell accounts for the downsample scale", () => {
    // z10 pixel covers ~152.87 mercator meters; ground is that * cos(lat).
    expect(groundMetersPerPixel(DEM_GRID)).toBeGreaterThan(130);
    expect(groundMetersPerPixel(DEM_GRID)).toBeLessThan(152.87);
    expect(metersPerGridCell(DEM_GRID)).toBeCloseTo(groundMetersPerPixel(DEM_GRID), 12);
  });
});

describe("world/lonLat consistency with grid", () => {
  it("lonLatToWorld agrees with gridToWorld(lonLatToGrid)", () => {
    const [i, j] = lonLatToGrid(DEM_GRID, -65.35, -23.205);
    const viaGrid = gridToWorld(DEM_GRID, i, j);
    const direct = lonLatToWorld(DEM_GRID, -65.35, -23.205);
    expect(direct[0]).toBeCloseTo(viaGrid[0], 9);
    expect(direct[2]).toBeCloseTo(viaGrid[2], 9);
  });

  it("worldToLonLat agrees with gridToLonLat(worldToGrid)", () => {
    const [i, j] = worldToGrid(DEM_GRID, 40, -60);
    const viaGrid = gridToLonLat(DEM_GRID, i, j);
    const direct = worldToLonLat(DEM_GRID, 40, -60);
    expect(direct[0]).toBeCloseTo(viaGrid[0], 9);
    expect(direct[1]).toBeCloseTo(viaGrid[1], 9);
  });
});
