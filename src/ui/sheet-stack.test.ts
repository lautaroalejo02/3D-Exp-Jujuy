import { describe, expect, it } from "vitest";

import {
  initialSheetStack,
  reduceSheetStack,
  type SheetStackState,
} from "./sheet-stack";

const stack = (over: Partial<SheetStackState>): SheetStackState => ({
  ...initialSheetStack,
  ...over,
});

describe("reduceSheetStack / open-detail", () => {
  it("folds the mode sheet to min and presents the detail at half", () => {
    const next = reduceSheetStack(
      stack({ modeSnap: "half" }),
      { type: "open-detail" },
    );
    expect(next).toEqual(
      stack({ modeSnap: "min", detailOpen: true, detailSnap: "half" }),
    );
  });

  it("remembers the mode snap it folded away from", () => {
    const next = reduceSheetStack(
      stack({ modeSnap: "full" }),
      { type: "open-detail" },
    );
    expect(next.resumeModeSnap).toBe("full");
  });

  it("re-presents a folded detail without touching the saved snap", () => {
    const open = stack({
      modeSnap: "half",
      detailOpen: true,
      detailSnap: "min",
      resumeModeSnap: "full",
    });
    const next = reduceSheetStack(open, { type: "open-detail" });
    expect(next.modeSnap).toBe("min");
    expect(next.detailSnap).toBe("half");
    expect(next.resumeModeSnap).toBe("full");
  });

  it("is a no-op when the detail already shows at half", () => {
    const open = stack({
      modeSnap: "min",
      detailOpen: true,
      detailSnap: "half",
    });
    expect(reduceSheetStack(open, { type: "open-detail" })).toBe(open);
  });
});

describe("reduceSheetStack / close-detail", () => {
  it("restores the mode snap the detail folded away from", () => {
    const open = reduceSheetStack(
      stack({ modeSnap: "full" }),
      { type: "open-detail" },
    );
    const next = reduceSheetStack(open, { type: "close-detail" });
    expect(next.detailOpen).toBe(false);
    expect(next.modeSnap).toBe("full");
  });

  it("restores the snap the user last expanded the mode sheet to", () => {
    let s = reduceSheetStack(stack({ modeSnap: "half" }), {
      type: "open-detail",
    });
    s = reduceSheetStack(s, { type: "mode-snap", snap: "full" });
    s = reduceSheetStack(s, { type: "close-detail" });
    expect(s.modeSnap).toBe("full");
  });

  it("is a no-op with no detail on screen", () => {
    const s = stack({ modeSnap: "half" });
    expect(reduceSheetStack(s, { type: "close-detail" })).toBe(s);
  });
});

describe("reduceSheetStack / user snaps", () => {
  it("tracks the mode snap while no detail is open", () => {
    const next = reduceSheetStack(stack({}), {
      type: "mode-snap",
      snap: "full",
    });
    expect(next.modeSnap).toBe("full");
    expect(next.detailOpen).toBe(false);
  });

  it("expanding the mode sheet folds the detail to its title row", () => {
    const open = stack({
      modeSnap: "min",
      detailOpen: true,
      detailSnap: "half",
      resumeModeSnap: "half",
    });
    const next = reduceSheetStack(open, { type: "mode-snap", snap: "full" });
    expect(next.modeSnap).toBe("full");
    expect(next.detailSnap).toBe("min");
    expect(next.detailOpen).toBe(true);
    expect(next.resumeModeSnap).toBe("full");
  });

  it("folding the detail brings the mode sheet back to its saved snap", () => {
    const open = stack({
      modeSnap: "min",
      detailOpen: true,
      detailSnap: "half",
      resumeModeSnap: "full",
    });
    const next = reduceSheetStack(open, { type: "detail-snap", snap: "min" });
    expect(next.detailSnap).toBe("min");
    expect(next.detailOpen).toBe(true);
    expect(next.modeSnap).toBe("full");
  });

  it("expanding the detail folds the mode sheet again", () => {
    const s = stack({
      modeSnap: "half",
      detailOpen: true,
      detailSnap: "min",
      resumeModeSnap: "half",
    });
    const next = reduceSheetStack(s, { type: "detail-snap", snap: "full" });
    expect(next.detailSnap).toBe("full");
    expect(next.modeSnap).toBe("min");
    expect(next.resumeModeSnap).toBe("half");
  });

  it("ignores detail snaps while the detail is closed", () => {
    const s = stack({ modeSnap: "half" });
    expect(reduceSheetStack(s, { type: "detail-snap", snap: "full" })).toBe(s);
  });
});

describe("reduceSheetStack / invariant", () => {
  it("never leaves both sheets expanded", () => {
    const events = [
      { type: "mode-snap", snap: "full" },
      { type: "open-detail" },
      { type: "detail-snap", snap: "full" },
      { type: "mode-snap", snap: "half" },
      { type: "detail-snap", snap: "half" },
      { type: "close-detail" },
    ] as const;
    let s = initialSheetStack;
    for (const e of events) {
      s = reduceSheetStack(s, e);
      const expanded = [s.modeSnap !== "min", s.detailOpen && s.detailSnap !== "min"];
      expect(expanded.filter(Boolean).length).toBeLessThanOrEqual(1);
    }
    // After the close: the mode sheet is back to the snap the user left.
    expect(s.modeSnap).toBe("half");
    expect(s.detailOpen).toBe(false);
  });
});
