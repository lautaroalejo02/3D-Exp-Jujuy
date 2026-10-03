import { describe, expect, it } from "vitest";

import { createDirtyTracker } from "./dirty-tracker";

describe("createDirtyTracker", () => {
  it("starts clean — nothing renders until requested", () => {
    const tracker = createDirtyTracker();
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.pendingFrames).toBe(0);
  });

  it("one request schedules exactly one frame", () => {
    const tracker = createDirtyTracker();
    tracker.request();
    expect(tracker.isDirty()).toBe(true);
    expect(tracker.pendingFrames).toBe(1);
    tracker.frameRendered();
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.pendingFrames).toBe(0);
  });

  it("request(n) keeps n frames pending (for smoothing work)", () => {
    const tracker = createDirtyTracker();
    tracker.request(3);
    tracker.frameRendered();
    tracker.frameRendered();
    expect(tracker.isDirty()).toBe(true);
    tracker.frameRendered();
    expect(tracker.isDirty()).toBe(false);
  });

  it("repeated requests take the maximum, not the sum", () => {
    const tracker = createDirtyTracker();
    tracker.request(5);
    tracker.request(2);
    expect(tracker.pendingFrames).toBe(5);
    tracker.request();
    expect(tracker.pendingFrames).toBe(5);
  });

  it("a request during pending frames extends to the new count", () => {
    const tracker = createDirtyTracker();
    tracker.request(2);
    tracker.frameRendered();
    tracker.request(4);
    expect(tracker.pendingFrames).toBe(4);
  });

  it("ignores non-positive and non-finite requests", () => {
    const tracker = createDirtyTracker();
    tracker.request(0);
    tracker.request(-3);
    tracker.request(Number.NaN);
    expect(tracker.isDirty()).toBe(false);
  });

  it("frameRendered on a clean tracker is a no-op", () => {
    const tracker = createDirtyTracker();
    tracker.frameRendered();
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.pendingFrames).toBe(0);
  });
});
