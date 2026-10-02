import { describe, expect, it } from "vitest";

import {
  EARTH_CIRCUMFERENCE,
  MERCATOR_RADIUS,
  lonLatToMercator,
  mercatorGroundScale,
  mercatorToLonLat,
} from "./mercator";
import {
  TILE_SIZE,
  globalPixelCount,
  globalPixelToLonLat,
  globalPixelToMercator,
  lonLatToGlobalPixel,
  mercatorMetersPerPixel,
  mercatorToGlobalPixel,
} from "./slippy";

const RAD = 180 / Math.PI;

describe("lonLatToMercator / mercatorToLonLat", () => {
  it("maps the origin to (0, 0)", () => {
    const [x, y] = lonLatToMercator(0, 0);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(0, 6);
  });

  it("maps lon 180 to half the circumference", () => {
    const [x] = lonLatToMercator(180, 0);
    expect(x).toBeCloseTo(Math.PI * MERCATOR_RADIUS, 6);
  });

  it("round-trips lon/lat within 1e-9 degrees", () => {
    const samples: readonly (readonly [number, number])[] = [
      [-65.35, -23.205],
      [-65.7, -22.72],
      [0, 0],
      [12.5, 41.9],
      [-120.3, -33.3],
    ];
    for (const [lon, lat] of samples) {
      const [x, y] = lonLatToMercator(lon, lat);
      const [lon2, lat2] = mercatorToLonLat(x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });
});

describe("mercatorGroundScale", () => {
  it("is 1 at the equator and shrinks toward the poles", () => {
    expect(mercatorGroundScale(0)).toBeCloseTo(1, 12);
    expect(mercatorGroundScale(60)).toBeCloseTo(0.5, 12);
  });
});

describe("slippy global pixels", () => {
  it("covers 256 * 2^z pixels per axis", () => {
    expect(globalPixelCount(0)).toBe(256);
    expect(globalPixelCount(10)).toBe(256 * 1024);
  });

  it("maps the top-left world corner to pixel (0, 0)", () => {
    const [px, py] = lonLatToGlobalPixel(-180, 85.05112878, 0);
    expect(px).toBeCloseTo(0, 6);
    expect(py).toBeCloseTo(0, 6);
  });

  it("maps the bottom-right world corner to the last pixel", () => {
    const [px, py] = lonLatToGlobalPixel(180, -85.05112878, 0);
    expect(px).toBeCloseTo(256, 4);
    expect(py).toBeCloseTo(256, 4);
  });

  it("globalPixelToLonLat matches the standard slippy formula", () => {
    const zoom = 10;
    const tiles = Math.pow(2, zoom);
    // Tile x=320 west edge: lon = x/2^z * 360 - 180.
    expect(globalPixelToLonLat(320 * TILE_SIZE, 0, zoom)[0]).toBeCloseTo(
      (320 / tiles) * 360 - 180,
      12,
    );
    // lat = atan(sinh(pi * (1 - 2y/2^z))) in degrees, y in tile units.
    const y = 575 * TILE_SIZE;
    const yTiles = y / TILE_SIZE;
    const expectedLat =
      Math.atan(Math.sinh(Math.PI * (1 - (2 * yTiles) / tiles))) * RAD;
    expect(globalPixelToLonLat(0, y, zoom)[1]).toBeCloseTo(expectedLat, 12);
  });

  it("round-trips lon/lat through global pixels", () => {
    const zoom = 11;
    for (const [lon, lat] of [
      [-65.35, -23.205],
      [-64.0, -24.0],
    ] as const) {
      const [px, py] = lonLatToGlobalPixel(lon, lat, zoom);
      const [lon2, lat2] = globalPixelToLonLat(px, py, zoom);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });

  it("converts between global pixels and mercator meters consistently", () => {
    const zoom = 10;
    const [px, py] = [82048.5, 147200.25];
    const [x, y] = globalPixelToMercator(px, py, zoom);
    const [px2, py2] = mercatorToGlobalPixel(x, y, zoom);
    expect(px2).toBeCloseTo(px, 9);
    expect(py2).toBeCloseTo(py, 9);
  });

  it("mercatorMetersPerPixel covers the whole circumference at z0", () => {
    expect(mercatorMetersPerPixel(0)).toBeCloseTo(EARTH_CIRCUMFERENCE / TILE_SIZE, 6);
  });
});
