import { describe, expect, it } from "vitest";

import { elevationStats, percentile, reconstructionError } from "./stats";

describe("percentile", () => {
  const sorted = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("returns exact values at the extremes", () => {
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 1)).toBe(100);
  });

  it("interpolates linearly between sorted ranks", () => {
    // rank = q * (n - 1): q=0.5 -> 5 -> 50; q=0.25 -> 2.5 -> 25.
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.25)).toBe(25);
    expect(percentile(sorted, 0.999)).toBeCloseTo(99.9, 9);
  });

  it("does not depend on input order", () => {
    expect(percentile([40, 0, 100, 20], 0.5)).toBe(30);
  });

  it("rejects empty input and out-of-range q", () => {
    expect(() => percentile([], 0.5)).toThrow();
    expect(() => percentile([1], -0.1)).toThrow();
    expect(() => percentile([1], 1.1)).toThrow();
  });
});

describe("elevationStats", () => {
  it("reports min, max, mean and robust percentiles", () => {
    const stats = elevationStats([10, 20, 30, 40]);
    expect(stats).toEqual({
      minMeters: 10,
      maxMeters: 40,
      meanMeters: 25,
      // rank = 0.001 * 3 = 0.003 -> 10 + 10*0.003; 0.999*3 -> 30 + 10*0.997.
      p001Meters: 10.03,
      p999Meters: 39.97,
    });
  });

  it("keeps extreme source values in min/max but not in the percentiles", () => {
    // 1000 cells at ~300 m plus a single 26 m pit (the real-DEM case).
    const heights = new Float32Array(1001).fill(300);
    heights[0] = 26;
    const stats = elevationStats(heights);
    expect(stats.minMeters).toBe(26);
    expect(stats.p001Meters).toBeGreaterThan(100);
    expect(stats.p999Meters).toBe(300);
  });
});

describe("reconstructionError", () => {
  // 4x4 full-res / 2x2 half-res, factor 2. Half sample (i, j) is the center
  // of full pixels 2i..2i+1, so full cell center i+0.5 maps to half coord
  // (i+0.5)/2 - 0.5 = i/2 - 0.25, clamped to [0, 1].
  const half = new Float32Array([0, 40, 80, 120]); // h = 40i + 80j (planar)

  it("measures per-full-cell error, not just resampling of half cells", () => {
    // Bilinear of `half` reconstructs R = 40*hi' + 80*hj' (hi' clamped):
    const reconstructed = [
      0, 10, 30, 40,
      20, 30, 50, 60,
      60, 70, 90, 100,
      80, 90, 110, 120,
    ];
    // Full-res equals the reconstruction except cell (2, 2) = 190 (error 100).
    const full = Float32Array.from(reconstructed);
    full[2 * 4 + 2] = 190;
    const e = reconstructionError(full, 4, 4, half, 2, 2, 2);
    // 15 zeros and one 100: mean 100/16, p99 at rank 14.85 -> 85.
    expect(e.maxAbsErrorMeters).toBe(100);
    expect(e.meanAbsErrorMeters).toBe(6.25);
    expect(e.p99AbsErrorMeters).toBe(85);
    expect(e.fractionOver20Meters).toBe(0.0625);
  });

  it("is exact for a planar full-res grid away from the borders", () => {
    // full(i,j) = 40i + 20j; box-averaged half = [30, 110, 70, 150].
    const full = new Float32Array(16);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) full[j * 4 + i] = 40 * i + 20 * j;
    const planarHalf = new Float32Array([30, 110, 70, 150]);
    const e = reconstructionError(full, 4, 4, planarHalf, 2, 2, 2);
    // Errors: rows [30,10,10,10] [20,0,0,20] [20,0,0,20] [10,10,10,30].
    expect(e.maxAbsErrorMeters).toBe(30);
    expect(e.meanAbsErrorMeters).toBe(12.5);
    expect(e.p99AbsErrorMeters).toBe(30);
    expect(e.fractionOver20Meters).toBe(0.125);
  });

  it("throws when grid lengths do not match the declared dimensions", () => {
    expect(() =>
      reconstructionError(new Float32Array(3), 4, 4, half, 2, 2, 2),
    ).toThrow();
    expect(() =>
      reconstructionError(new Float32Array(16), 4, 4, half, 3, 2, 2),
    ).toThrow();
  });
});
