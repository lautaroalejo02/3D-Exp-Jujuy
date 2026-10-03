import { describe, expect, it } from "vitest";

import { gridToLonLat, type GridSpec } from "../../geo/grid";
import { Heightfield } from "../../terrain/heightfield";
import {
  buildProfileSamples,
  computeProfileStats,
  nearestOnPolyline,
  PROFILE_MAX_SAMPLES,
  PROFILE_MIN_SAMPLES,
  profileGroundDistanceMeters,
  profileSampleCount,
  sampleAtDistance,
  type ProfilePoint,
} from "./profile";

// 4x4 grid at zoom 10, origin 0/0, scale 64: large cells so a diagonal
// line stays inside. Heights climb west->east.
const SPEC: GridSpec = { zoom: 10, originPx: [0, 0], width: 4, height: 4, scale: 64 };
const heights = new Float32Array(16);
for (let j = 0; j < 4; j++) {
  for (let i = 0; i < 4; i++) heights[j * 4 + i] = i * 100;
}
const FIELD = new Heightfield(heights, SPEC);

const pt = (
  distanceMeters: number,
  elevationMeters: number | undefined,
  i = 0,
  j = 0,
): ProfilePoint => ({ i, j, distanceMeters, elevationMeters });

describe("profileSampleCount", () => {
  it("never goes below the minimum for short lines", () => {
    expect(profileSampleCount(0, 305)).toBe(PROFILE_MIN_SAMPLES);
    expect(profileSampleCount(100, 305)).toBe(PROFILE_MIN_SAMPLES);
  });

  it("aims for about two samples per grid cell", () => {
    // 200 km at ~305 m/cell: ~656 cells -> ~1312 samples.
    const n = profileSampleCount(200_000, 305);
    expect(n).toBeGreaterThanOrEqual(1300);
    expect(n).toBeLessThanOrEqual(1400);
  });

  it("caps the sample count for very long lines", () => {
    expect(profileSampleCount(4_000_000, 305)).toBe(PROFILE_MAX_SAMPLES);
  });

  it("never produces a non-positive or non-finite count", () => {
    expect(profileSampleCount(10_000, 0)).toBe(PROFILE_MIN_SAMPLES);
    expect(profileSampleCount(NaN, 305)).toBe(PROFILE_MIN_SAMPLES);
  });
});

describe("profileGroundDistanceMeters / buildProfileSamples", () => {
  // Transect inside the synthetic 4x4 grid, west -> east at j = 2.
  const A = gridToLonLat(SPEC, 0, 2);
  const B = gridToLonLat(SPEC, 3, 2);

  it("computes ground distance between two lon/lat points", () => {
    const d = profileGroundDistanceMeters(SPEC, A, B);
    expect(d).toBeGreaterThan(0);
  });

  it("samples elevations along the line with the DEM", () => {
    // i runs 0 -> 3, so the heights climb 0 -> 300 m.
    const samples = buildProfileSamples(FIELD, A, B, { samples: 8 });
    expect(samples).toHaveLength(8);
    const defined = samples.filter((s) => s.elevationMeters !== undefined);
    expect(defined.length).toBeGreaterThan(0);
    const first = defined[0]!;
    const last = defined[defined.length - 1]!;
    expect(last.elevationMeters!).toBeGreaterThan(first.elevationMeters!);
    // Distances are cumulative and non-decreasing.
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k]!.distanceMeters).toBeGreaterThanOrEqual(
        samples[k - 1]!.distanceMeters,
      );
    }
  });

  it("uses the caller's surface sampler when given", () => {
    const samples = buildProfileSamples(FIELD, A, B, {
      samples: 8,
      elevationAt: () => 4242,
    });
    for (const s of samples) {
      if (s.elevationMeters !== undefined) {
        expect(s.elevationMeters).toBe(4242);
      }
    }
  });
});

describe("computeProfileStats", () => {
  it("returns undefined with fewer than two defined samples", () => {
    expect(computeProfileStats([])).toBeUndefined();
    expect(computeProfileStats([pt(0, 100)])).toBeUndefined();
    expect(
      computeProfileStats([pt(0, undefined), pt(100, undefined)]),
    ).toBeUndefined();
  });

  it("computes a flat profile", () => {
    const stats = computeProfileStats([pt(0, 1000), pt(5000, 1000)]);
    expect(stats).toBeDefined();
    expect(stats!.distanceMeters).toBe(5000);
    expect(stats!.minMeters).toBe(1000);
    expect(stats!.maxMeters).toBe(1000);
    expect(stats!.rangeMeters).toBe(0);
    expect(stats!.ascentMeters).toBe(0);
    expect(stats!.descentMeters).toBe(0);
  });

  it("computes a monotonic climb", () => {
    const stats = computeProfileStats([
      pt(0, 1000),
      pt(1000, 1500),
      pt(2000, 2000),
    ]);
    expect(stats!.minMeters).toBe(1000);
    expect(stats!.maxMeters).toBe(2000);
    expect(stats!.rangeMeters).toBe(1000);
    expect(stats!.ascentMeters).toBe(1000);
    expect(stats!.descentMeters).toBe(0);
    expect(stats!.minIndex).toBe(0);
    expect(stats!.maxIndex).toBe(2);
  });

  it("accumulates ascent and descent over a wavy line", () => {
    // 100 -> 300 -> 200 -> 400: up 200, down 100, up 200.
    const stats = computeProfileStats([
      pt(0, 100),
      pt(100, 300),
      pt(200, 200),
      pt(300, 400),
    ]);
    expect(stats!.ascentMeters).toBe(400);
    expect(stats!.descentMeters).toBe(100);
    expect(stats!.rangeMeters).toBe(300);
  });

  it("skips off-grid samples but keeps their distance", () => {
    const stats = computeProfileStats([
      pt(0, 100),
      pt(100, undefined),
      pt(200, 300),
    ]);
    // The gap between the two defined samples counts as one climb.
    expect(stats!.ascentMeters).toBe(200);
    expect(stats!.distanceMeters).toBe(200);
    expect(stats!.definedCount).toBe(2);
  });

  it("reports the total distance of the last sample", () => {
    const stats = computeProfileStats([
      pt(0, 100),
      pt(12345, undefined),
      pt(20000, 300),
    ]);
    expect(stats!.distanceMeters).toBe(20000);
  });
});

describe("sampleAtDistance", () => {
  const line: ProfilePoint[] = [
    { i: 0, j: 0, distanceMeters: 0, elevationMeters: 100 },
    { i: 10, j: 0, distanceMeters: 1000, elevationMeters: 300 },
    { i: 20, j: 0, distanceMeters: 2000, elevationMeters: 200 },
  ];

  it("interpolates grid position and elevation between samples", () => {
    const s = sampleAtDistance(line, 500);
    expect(s.i).toBeCloseTo(5);
    expect(s.j).toBeCloseTo(0);
    expect(s.elevationMeters).toBeCloseTo(200);
  });

  it("clamps to the ends", () => {
    expect(sampleAtDistance(line, -50).i).toBe(0);
    expect(sampleAtDistance(line, 99999).i).toBe(20);
    expect(sampleAtDistance(line, 0).elevationMeters).toBe(100);
  });

  it("returns undefined elevation when a bracketing sample is off-grid", () => {
    const withGap: ProfilePoint[] = [
      { i: 0, j: 0, distanceMeters: 0, elevationMeters: 100 },
      { i: 10, j: 0, distanceMeters: 1000, elevationMeters: undefined },
      { i: 20, j: 0, distanceMeters: 2000, elevationMeters: 200 },
    ];
    expect(sampleAtDistance(withGap, 500).elevationMeters).toBeUndefined();
    // i/j still interpolate across the gap.
    expect(sampleAtDistance(withGap, 500).i).toBeCloseTo(5);
  });

  it("handles a single sample", () => {
    const one = sampleAtDistance(line.slice(0, 1), 500);
    expect(one.i).toBe(0);
  });
});

describe("nearestOnPolyline", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];

  it("projects onto the closest segment and returns a fractional index", () => {
    const hit = nearestOnPolyline(line, { x: 150, y: 10 });
    expect(hit).toBeDefined();
    expect(hit!.index).toBeCloseTo(1.5);
    expect(hit!.distPx).toBeCloseTo(10);
  });

  it("clamps to the endpoints", () => {
    const hit = nearestOnPolyline(line, { x: -40, y: 3 });
    expect(hit!.index).toBe(0);
    expect(hit!.distPx).toBeCloseTo(Math.hypot(40, 3));
  });

  it("returns undefined for empty or degenerate input", () => {
    expect(nearestOnPolyline([], { x: 0, y: 0 })).toBeUndefined();
  });
});

describe("ascent/descent hysteresis", () => {
  it("ignores DEM noise smaller than the threshold", () => {
    const noisy = [1000, 1010, 1000, 1012, 1001, 1009, 1000].map((e, k) => pt(k * 100, e));
    const stats = computeProfileStats(noisy);
    expect(stats!.ascentMeters).toBe(0);
    expect(stats!.descentMeters).toBe(0);
  });
});
