import { describe, expect, it } from "vitest";

import { chartModel, niceTicks } from "./chart-model";
import type { ProfilePoint } from "./profile";

const pt = (
  distanceMeters: number,
  elevationMeters: number | undefined,
): ProfilePoint => ({ i: 0, j: 0, distanceMeters, elevationMeters });

describe("niceTicks", () => {
  it("produces round steps for a 0-4000 m range", () => {
    const ticks = niceTicks(0, 4000, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    // Steps of 1000 m.
    expect(ticks).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("only returns ticks inside the range", () => {
    const ticks = niceTicks(1200, 3700, 3);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(1200);
      expect(t).toBeLessThanOrEqual(3700);
    }
    expect(ticks).toEqual([1500, 2000, 2500, 3000, 3500]);
  });

  it("handles a tiny range", () => {
    const ticks = niceTicks(99, 101, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(99);
      expect(t).toBeLessThanOrEqual(101);
    }
  });

  it("handles a degenerate range", () => {
    const ticks = niceTicks(100, 100, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("chartModel", () => {
  const samples: ProfilePoint[] = [
    pt(0, 1000),
    pt(50_000, 3000),
    pt(100_000, 2000),
  ];
  const stats = {
    distanceMeters: 100_000,
    minMeters: 1000,
    maxMeters: 3000,
    rangeMeters: 2000,
    ascentMeters: 2000,
    descentMeters: 1000,
    minIndex: 0,
    maxIndex: 1,
    definedCount: 3,
  };

  it("maps distance to x and elevation to inverted y", () => {
    const m = chartModel(samples, stats, 400, 200);
    // x grows with distance; y shrinks with height.
    expect(m.xFor(0)).toBeLessThan(m.xFor(100_000));
    expect(m.yFor(3000)).toBeLessThan(m.yFor(1000));
    // Plot stays inside the viewBox.
    expect(m.xFor(0)).toBeGreaterThanOrEqual(0);
    expect(m.xFor(100_000)).toBeLessThanOrEqual(400);
    expect(m.yFor(3000)).toBeGreaterThanOrEqual(0);
    expect(m.yFor(1000)).toBeLessThanOrEqual(200);
  });

  it("builds a line path through the defined samples", () => {
    const m = chartModel(samples, stats, 400, 200);
    expect(m.linePath.startsWith("M")).toBe(true);
    // Three points => two L segments.
    expect(m.linePath.split("L").length - 1).toBe(2);
    // The area path closes down to the baseline.
    expect(m.areaPath.endsWith("Z")).toBe(true);
  });

  it("breaks the path across off-grid gaps", () => {
    const withGap: ProfilePoint[] = [
      pt(0, 1000),
      pt(50_000, undefined),
      pt(100_000, 2000),
    ];
    const m = chartModel(withGap, stats, 400, 200);
    // Two separate M subpaths.
    expect(m.linePath.split("M").length - 1).toBe(2);
  });

  it("exposes the min and max points for labels", () => {
    const m = chartModel(samples, stats, 400, 200);
    expect(m.minPoint).toBeDefined();
    expect(m.maxPoint).toBeDefined();
    expect(m.maxPoint!.elevationMeters).toBe(3000);
    expect(m.minPoint!.elevationMeters).toBe(1000);
    expect(m.maxPoint!.distanceMeters).toBe(50_000);
  });

  it("produces x ticks in km and y ticks in meters", () => {
    const m = chartModel(samples, stats, 400, 200);
    expect(m.xTicks.length).toBeGreaterThanOrEqual(2);
    expect(m.yTicks.length).toBeGreaterThanOrEqual(2);
    for (const t of m.xTicks) {
      expect(t.value).toBeGreaterThanOrEqual(0);
      expect(t.value).toBeLessThanOrEqual(100);
    }
  });
});
