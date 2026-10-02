import { describe, expect, it } from "vitest";

import {
  boxDownsample,
  boxDownsampleRgba,
  cropGrid,
  decodeTerrarium,
  decodeTerrariumHeight,
  hillshade,
} from "./raster";

describe("decodeTerrariumHeight", () => {
  it("decodes (128, 0, 0) as 0 m", () => {
    expect(decodeTerrariumHeight(128, 0, 0)).toBe(0);
  });

  it("decodes (131, 232, 0) as 1000 m", () => {
    // 131*256 + 232 = 33768; 33768 - 32768 = 1000.
    expect(decodeTerrariumHeight(131, 232, 0)).toBe(1000);
  });

  it("keeps the blue channel's 1/256 m fraction", () => {
    expect(decodeTerrariumHeight(128, 0, 128)).toBeCloseTo(0.5, 9);
  });
});

describe("decodeTerrarium", () => {
  it("decodes a small RGBA image to float heights", () => {
    // 2x1 pixels: (128,0,0) -> 0 m and (131,232,0) -> 1000 m.
    const rgba = new Uint8Array([128, 0, 0, 255, 131, 232, 0, 255]);
    expect(Array.from(decodeTerrarium(rgba, 2, 1))).toEqual([0, 1000]);
  });

  it("throws when the buffer size does not match dimensions", () => {
    expect(() => decodeTerrarium(new Uint8Array(8), 2, 2)).toThrow();
  });
});

describe("cropGrid", () => {
  const src = new Float32Array([
    0, 1, 2, 3,
    10, 11, 12, 13,
    20, 21, 22, 23,
    30, 31, 32, 33,
  ]);

  it("extracts the requested window", () => {
    expect(Array.from(cropGrid(src, 4, 4, 1, 1, 2, 2))).toEqual([11, 12, 21, 22]);
  });

  it("supports a zero-height offset crop (the DEM mosaic case)", () => {
    expect(Array.from(cropGrid(src, 4, 4, 2, 0, 2, 4))).toEqual([
      2, 3, 12, 13, 22, 23, 32, 33,
    ]);
  });

  it("throws when the window leaves the source", () => {
    expect(() => cropGrid(src, 4, 4, 3, 0, 2, 1)).toThrow();
  });
});

describe("boxDownsample", () => {
  it("averages each 2x2 block", () => {
    const src = new Float32Array([
      0, 2, 4, 6,
      8, 10, 12, 14,
    ]);
    const { data, width, height } = boxDownsample(src, 4, 2, 2);
    expect(width).toBe(2);
    expect(height).toBe(1);
    expect(Array.from(data)).toEqual([5, 9]);
  });

  it("handles partial blocks on odd dimensions", () => {
    const src = new Float32Array([
      0, 0, 8,
      0, 0, 8,
      4, 4, 8,
    ]);
    const { data, width, height } = boxDownsample(src, 3, 3, 2);
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(Array.from(data)).toEqual([0, 8, 4, 8]);
  });
});

describe("boxDownsampleRgba", () => {
  it("averages and rounds each channel of a 2x2 block", () => {
    const src = new Uint8Array([
      10, 20, 30, 255, 20, 40, 60, 255,
      30, 60, 90, 255, 40, 80, 120, 255,
    ]);
    const { data, width, height } = boxDownsampleRgba(src, 2, 2, 2);
    expect(width).toBe(1);
    expect(height).toBe(1);
    expect(Array.from(data)).toEqual([25, 50, 75, 255]);
  });
});

describe("hillshade", () => {
  it("lights a flat surface uniformly", () => {
    const flat = new Float32Array(25).fill(1000);
    const shade = hillshade(flat, 5, 5, 100, 315, 45);
    const expected = Math.round(Math.sin(Math.PI / 4) * 255);
    for (const v of shade) expect(v).toBe(expected);
  });

  it("brightens slopes facing the light and darkens those facing away", () => {
    // Heights rising eastward: the surface tilts up to the east, so it faces
    // west, toward the default NW (315 deg) light.
    const risingEast = new Float32Array(25);
    const risingWest = new Float32Array(25);
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        risingEast[j * 5 + i] = i * 100;
        risingWest[j * 5 + i] = (4 - i) * 100;
      }
    }
    const cell = 100;
    const facing = hillshade(risingEast, 5, 5, cell)[2 * 5 + 2] ?? 0;
    const flat = hillshade(new Float32Array(25), 5, 5, cell)[12] ?? 0;
    const away = hillshade(risingWest, 5, 5, cell)[12] ?? 0;
    expect(facing).toBeGreaterThan(flat);
    expect(away).toBeLessThan(flat);
  });
});
