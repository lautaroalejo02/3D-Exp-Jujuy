import { describe, expect, it } from "vitest";

import {
  nearestSnapIndex,
  SHEET_FULL_FRACTION,
  SHEET_HALF_FRACTION,
  SHEET_MIN_VISIBLE_PX,
  sheetSnapHeightsPx,
  snapSheetIndex,
} from "./sheet";

describe("sheetSnapHeightsPx", () => {
  it("returns min/half/full heights for a phone viewport", () => {
    const [min, half, full] = sheetSnapHeightsPx(844, 742.72);
    expect(min).toBe(SHEET_MIN_VISIBLE_PX);
    expect(half).toBeCloseTo(844 * SHEET_HALF_FRACTION, 5);
    expect(full).toBeCloseTo(844 * SHEET_FULL_FRACTION, 5);
  });

  it("caps the full snap at the sheet's own height", () => {
    // A sheet capped by CSS max-height can be shorter than 88% of the
    // viewport; the full snap must not exceed it.
    const [, , full] = sheetSnapHeightsPx(844, 500);
    expect(full).toBe(500);
  });

  it("never lets a lower snap exceed a higher one", () => {
    const [min, half, full] = sheetSnapHeightsPx(120, 100);
    expect(min).toBeLessThanOrEqual(half);
    expect(half).toBeLessThanOrEqual(full);
  });
});

describe("nearestSnapIndex", () => {
  const snaps = [64, 380, 743];

  it("picks the closest snap height", () => {
    expect(nearestSnapIndex(64, snaps)).toBe(0);
    expect(nearestSnapIndex(100, snaps)).toBe(0);
    expect(nearestSnapIndex(400, snaps)).toBe(1);
    expect(nearestSnapIndex(600, snaps)).toBe(2);
    expect(nearestSnapIndex(743, snaps)).toBe(2);
  });

  it("clamps positions outside the snap range", () => {
    expect(nearestSnapIndex(0, snaps)).toBe(0);
    expect(nearestSnapIndex(9999, snaps)).toBe(2);
  });
});

describe("snapSheetIndex", () => {
  const snaps = [64, 380, 743];
  // Positive velocity = the sheet is growing (finger moving up).

  it("snaps to the nearest height on a slow release", () => {
    expect(snapSheetIndex(100, 0, snaps)).toBe(0);
    expect(snapSheetIndex(400, 0.1, snaps)).toBe(1);
    expect(snapSheetIndex(600, -0.1, snaps)).toBe(2);
  });

  it("a fast upward flick opens the next snap above the position", () => {
    expect(snapSheetIndex(100, 1, snaps)).toBe(1);
    expect(snapSheetIndex(400, 1, snaps)).toBe(2);
    expect(snapSheetIndex(700, 1, snaps)).toBe(2);
  });

  it("a fast downward flick drops to the next snap below", () => {
    expect(snapSheetIndex(700, -1, snaps)).toBe(1);
    expect(snapSheetIndex(400, -1, snaps)).toBe(1);
    expect(snapSheetIndex(100, -1, snaps)).toBe(0);
  });

  it("clamps a flick at the extremes", () => {
    expect(snapSheetIndex(743, 5, snaps)).toBe(2);
    expect(snapSheetIndex(64, -5, snaps)).toBe(0);
    expect(snapSheetIndex(10, -5, snaps)).toBe(0);
  });
});
