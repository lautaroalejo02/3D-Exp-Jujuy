import { describe, expect, it } from "vitest";

import { signedDistanceField, squaredDistanceToZero } from "./sdf";

/** 1 marks inside the mask. */
function mask5x5(): Uint8Array {
  // 3x3 inside block centered in a 5x5 grid.
  const m = new Uint8Array(25);
  for (const j of [1, 2, 3]) {
    for (const i of [1, 2, 3]) m[j * 5 + i] = 1;
  }
  return m;
}

describe("squaredDistanceToZero", () => {
  it("gives exact squared distances to the nearest zero cell", () => {
    const d = squaredDistanceToZero(mask5x5(), 5, 5);
    // Center cell (2,2): nearest zero is 2 cells away.
    expect(d[2 * 5 + 2]).toBe(4);
    // Edge cell (1,2): adjacent to zeros.
    expect(d[2 * 5 + 1]).toBe(1);
    // Corner inside cell (1,1): nearest zero is (0,1) or (1,0) -> 1, not 2.
    expect(d[1 * 5 + 1]).toBe(1);
    // Zero cells get 0.
    expect(d[0]).toBe(0);
  });

  it("returns a huge value when there are no zero cells", () => {
    const d = squaredDistanceToZero(new Uint8Array(9).fill(1), 3, 3);
    expect(d[4]).toBeGreaterThan(1e10);
  });
});

describe("signedDistanceField", () => {
  it("is positive inside and negative outside", () => {
    const sdf = signedDistanceField(mask5x5(), 5, 5);
    // Center: 2 cells to the outside.
    expect(sdf[2 * 5 + 2]).toBe(2);
    // Inside cells adjacent to the boundary: +1.
    expect(sdf[2 * 5 + 1]).toBe(1);
    expect(sdf[1 * 5 + 1]).toBe(1);
    // Outside cells adjacent to the boundary: -1.
    expect(sdf[2 * 5 + 0]).toBe(-1);
    expect(sdf[0 * 5 + 2]).toBe(-1);
  });

  it("rounds diagonal distances", () => {
    const sdf = signedDistanceField(mask5x5(), 5, 5);
    // Corner cell (0,0): sqrt(2) ~ 1.41 to the nearest inside cell -> -1.
    expect(sdf[0]).toBe(-1);
    // Cell (0,4): sqrt(2) to inside cell (1,3) -> -1.
    expect(sdf[4 * 5 + 0]).toBe(-1);
  });

  it("keeps larger distances exact before clamping", () => {
    const m = new Uint8Array(9 * 9);
    for (let j = 2; j <= 6; j++) {
      for (let i = 2; i <= 6; i++) m[j * 9 + i] = 1;
    }
    const sdf = signedDistanceField(m, 9, 9);
    // Center (4,4): 3 cells to the outside.
    expect(sdf[4 * 9 + 4]).toBe(3);
    // Outside cell (4,0): 2 cells to the inside.
    expect(sdf[4 * 9 + 0]).toBe(-2);
    // Corner (0,0): sqrt(8) ~ 2.83 to inside cell (2,2) -> -3.
    expect(sdf[0]).toBe(-3);
  });

  it("clamps at +/-127", () => {
    const m = new Uint8Array(300).fill(1);
    const sdf = signedDistanceField(m, 300, 1);
    // All inside with no outside cell anywhere: distance is unbounded.
    expect(sdf[150]).toBe(127);
    expect(sdf[0]).toBe(127);

    const outside = signedDistanceField(new Uint8Array(300), 300, 1);
    expect(outside[150]).toBe(-127);
  });

  it("throws on a size mismatch", () => {
    expect(() => signedDistanceField(new Uint8Array(8), 3, 3)).toThrow(
      /length/,
    );
  });
});
