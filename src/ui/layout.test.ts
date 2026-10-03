import { describe, expect, it } from "vitest";

import { sheetLiftPx } from "./layout";

describe("sheetLiftPx", () => {
  it("returns 0 when no sheet is open", () => {
    expect(sheetLiftPx([])).toBe(0);
  });

  it("returns the tallest open sheet plus the gap", () => {
    expect(sheetLiftPx([120])).toBe(128);
    expect(sheetLiftPx([120, 260, 80])).toBe(268);
  });

  it("ignores zero-height entries", () => {
    expect(sheetLiftPx([0, 0])).toBe(0);
    expect(sheetLiftPx([0, 50])).toBe(58);
  });

  it("honors a custom gap", () => {
    expect(sheetLiftPx([100], 12)).toBe(112);
  });
});
