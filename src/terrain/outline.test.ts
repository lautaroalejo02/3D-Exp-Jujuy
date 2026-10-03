import { describe, expect, it } from "vitest";

import {
  provinceOutlineRing,
  sdfOutlineRings,
  signedArea,
  simplifyRing,
} from "./outline";

/** SDF with a filled rectangle [x0..x1]x[y0..y1] of +d cells amid -d. */
function boxSdf(
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Int8Array {
  const sdf = new Int8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const inside = i >= x0 && i <= x1 && j >= y0 && j <= y1;
      sdf[j * width + i] = inside ? 4 : -4;
    }
  }
  return sdf;
}

describe("sdfOutlineRings", () => {
  it("extracts one closed ring around an inside block", () => {
    // +4 block at (1..3, 1..3) of a 6x6 raster: the iso-0 contour is the
    // chamfered square through the cell midpoints — 12 crossings (3 per
    // side), every one on a x=0.5/3.5 or j=0.5/3.5 line.
    const rings = sdfOutlineRings(boxSdf(6, 6, 1, 1, 3, 3), 6, 6);
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring.length / 2).toBe(12);
    // Wound with positive area (interior on the left of travel).
    expect(signedArea(ring)).toBeGreaterThan(0);
    for (let k = 0; k < ring.length / 2; k++) {
      const i = ring[k * 2]!;
      const j = ring[k * 2 + 1]!;
      expect(i >= 0.5 && i <= 3.5).toBe(true);
      expect(j >= 0.5 && j <= 3.5).toBe(true);
      expect(
        i === 0.5 || i === 3.5 || j === 0.5 || j === 3.5,
      ).toBe(true);
    }
  });

  it("returns no ring when the raster is uniformly inside or outside", () => {
    expect(sdfOutlineRings(new Int8Array(16).fill(3), 4, 4)).toHaveLength(0);
    expect(sdfOutlineRings(new Int8Array(16).fill(-3), 4, 4)).toHaveLength(0);
  });

  it("keeps two separate rings when two blocks exist", () => {
    const sdf = new Int8Array(64).fill(-4);
    sdf[1 * 8 + 1] = 4;
    sdf[5 * 8 + 6] = 4;
    const rings = sdfOutlineRings(sdf, 8, 8);
    expect(rings).toHaveLength(2);
  });

  it("drops contours that touch the raster border (open chains)", () => {
    // Inside region bleeds off the west edge: the contour hits the
    // raster border twice and never closes.
    const sdf = new Int8Array(36).fill(-4);
    for (let j = 1; j <= 3; j++) {
      for (let i = 0; i <= 2; i++) sdf[j * 6 + i] = 4;
    }
    expect(sdfOutlineRings(sdf, 6, 6)).toHaveLength(0);
  });
});

describe("simplifyRing", () => {
  it("collapses collinear points and keeps the corners", () => {
    // A 6-vertex ring with redundant midpoints on each edge.
    const ring = Float32Array.from([
      0, 0,
      5, 0,
      10, 0,
      10, 10,
      5, 10,
      0, 10,
    ]);
    const out = simplifyRing(ring, 0.4);
    expect(out.length / 2).toBe(4);
  });

  it("keeps vertices that deviate more than the tolerance", () => {
    const ring = Float32Array.from([
      0, 0,
      5, 0.8, // a bump worth keeping at tolerance 0.4
      10, 0,
      10, 10,
      0, 10,
    ]);
    const out = simplifyRing(ring, 0.4);
    expect(out.length / 2).toBe(5);
  });
});

describe("provinceOutlineRing", () => {
  it("returns the longest ring, simplified and wound positive", () => {
    // Small inside block + one large L-shaped province.
    const w = 20;
    const h = 16;
    const sdf = new Int8Array(w * h).fill(-4);
    for (let j = 2; j <= 12; j++) {
      for (let i = 2; i <= 16; i++) sdf[j * w + i] = 4;
    }
    for (let j = 10; j <= 14; j++) {
      for (let i = 10; i <= 18; i++) sdf[j * w + i] = 4;
    }
    sdf[3 * w + 6] = -4; // carve a notch -> the ring is not a rectangle
    const ring = provinceOutlineRing(sdf, w, h, 0.5);
    expect(ring).toBeDefined();
    expect(ring!.length / 2).toBeGreaterThanOrEqual(3);
    expect(signedArea(ring!)).toBeGreaterThan(0);
    // Every vertex sits inside the raster.
    for (let k = 0; k < ring!.length / 2; k++) {
      expect(ring![k * 2]!).toBeGreaterThanOrEqual(0);
      expect(ring![k * 2]!).toBeLessThanOrEqual(w - 1);
      expect(ring![k * 2 + 1]!).toBeGreaterThanOrEqual(0);
      expect(ring![k * 2 + 1]!).toBeLessThanOrEqual(h - 1);
    }
  });

  it("returns undefined on an empty mask", () => {
    expect(
      provinceOutlineRing(new Int8Array(16).fill(-1), 4, 4),
    ).toBeUndefined();
  });
});
