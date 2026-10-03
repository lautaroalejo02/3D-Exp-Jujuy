import { describe, expect, it } from "vitest";

import {
  classifyLightboxGesture,
  type LightboxGesture,
} from "./lightbox-gestures";

/** A still, single-pointer tap on the backdrop. */
const TAP: LightboxGesture = {
  dx: 0,
  dy: 0,
  pointerCount: 1,
  zoomed: false,
  onBackdrop: true,
};

describe("classifyLightboxGesture", () => {
  it("closes on a tap without movement on the backdrop", () => {
    expect(classifyLightboxGesture(TAP)).toBe("close");
    expect(
      classifyLightboxGesture({ ...TAP, dx: 5, dy: -5 }),
    ).toBe("close");
  });

  it("does not close on a tap over the image itself", () => {
    expect(classifyLightboxGesture({ ...TAP, onBackdrop: false })).toBe(
      "none",
    );
  });

  it("never closes on the click that trails a swipe, pan or pinch", () => {
    expect(
      classifyLightboxGesture({ ...TAP, dx: -120, dy: 10 }),
    ).toBe("next");
    expect(classifyLightboxGesture({ ...TAP, dx: 30, dy: 5 })).toBe(
      "none",
    );
    expect(
      classifyLightboxGesture({ ...TAP, dx: -30, zoomed: true }),
    ).toBe("none");
    expect(
      classifyLightboxGesture({ ...TAP, dx: 2, pointerCount: 2 }),
    ).toBe("none");
  });

  it("navigates on a horizontal swipe, left or right", () => {
    expect(
      classifyLightboxGesture({ ...TAP, dx: -60, onBackdrop: false }),
    ).toBe("next");
    expect(
      classifyLightboxGesture({ ...TAP, dx: 60, onBackdrop: false }),
    ).toBe("prev");
  });

  it("requires the swipe to be horizontal-dominant", () => {
    expect(
      classifyLightboxGesture({ ...TAP, dx: -100, dy: 80 }),
    ).toBe("none");
    expect(
      classifyLightboxGesture({ ...TAP, dx: -100, dy: 60 }),
    ).toBe("next");
    expect(classifyLightboxGesture({ ...TAP, dy: 200 })).toBe("none");
  });

  it("does not navigate on a pan of the zoomed image", () => {
    expect(
      classifyLightboxGesture({
        ...TAP,
        dx: -100,
        zoomed: true,
        onBackdrop: false,
      }),
    ).toBe("none");
  });
});
