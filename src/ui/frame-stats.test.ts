import { describe, expect, it } from "vitest";

import { createFrameStats } from "./frame-stats";

describe("createFrameStats", () => {
  it("starts idle with no measurements", () => {
    const stats = createFrameStats();
    const snap = stats.snapshot(0);
    expect(snap.idle).toBe(true);
    expect(snap.fps).toBeUndefined();
    expect(snap.cpuMs).toBeUndefined();
  });

  it("measures fps from the interval between consecutive rendered frames", () => {
    const stats = createFrameStats();
    stats.tick(0, 2);
    stats.tick(16.7, 2);
    stats.tick(33.4, 2);
    stats.tick(50.1, 2);
    expect(stats.snapshot(50.1).fps).toBeCloseTo(1000 / 16.7, 1);
  });

  it("averages the CPU encode time of rendered frames separately", () => {
    const stats = createFrameStats();
    stats.tick(0, 2);
    stats.tick(16, 4);
    stats.tick(32, 6);
    expect(stats.snapshot(32).cpuMs).toBeCloseTo(4);
  });

  it("ignores clean ticks — they draw nothing", () => {
    const stats = createFrameStats();
    stats.tick(0, 2);
    stats.tick(16); // clean
    stats.tick(32); // clean
    expect(stats.snapshot(32).fps).toBeUndefined();
  });

  it("excludes idle gaps: a clean tick breaks the run of rendered frames", () => {
    const stats = createFrameStats();
    stats.tick(0, 2);
    stats.tick(16, 2); // run: one 16 ms sample
    // Idle stretch — the loop ticks but nothing renders for a second.
    stats.tick(1032);
    stats.tick(1048);
    stats.tick(1064, 2); // first frame back: clean ticks broke the run
    stats.tick(1080, 2); // run restarts: another 16 ms sample
    // The ~1016 ms gap must not count as a slow frame.
    expect(stats.snapshot(1080).fps).toBeCloseTo(1000 / 16, 1);
  });

  it("rejects a long gap even between consecutive ticks (loop was paused)", () => {
    const stats = createFrameStats();
    stats.tick(0, 2);
    stats.tick(10_000, 2); // no ticks in between — still not a real interval
    expect(stats.snapshot(10_000).fps).toBeUndefined();
  });

  it("reports a single rendered frame as not-idle but without fps yet", () => {
    const stats = createFrameStats();
    stats.tick(0, 3);
    const snap = stats.snapshot(100);
    expect(snap.idle).toBe(false);
    expect(snap.fps).toBeUndefined();
    expect(snap.cpuMs).toBe(3);
  });

  it("marks the stats idle once nothing rendered for idleMs", () => {
    const stats = createFrameStats({ idleMs: 500 });
    stats.tick(0, 2);
    stats.tick(16, 2);
    expect(stats.snapshot(516).idle).toBe(false);
    expect(stats.snapshot(517).idle).toBe(true);
  });

  it("rolls the window: old samples stop counting", () => {
    const stats = createFrameStats({ window: 3 });
    // A 100 fps run produces the first samples.
    for (let i = 0; i <= 4; i += 1) stats.tick(i * 10, 1);
    // Then the pace drops to 20 fps; the last 3 intervals dominate.
    for (let i = 1; i <= 4; i += 1) stats.tick(40 + i * 50, 1);
    expect(stats.snapshot(240).fps).toBeCloseTo(20, 1);
  });

  it("rolls the cpu window too", () => {
    const stats = createFrameStats({ window: 2 });
    stats.tick(0, 1);
    stats.tick(16, 3);
    stats.tick(32, 5);
    expect(stats.snapshot(32).cpuMs).toBeCloseTo(4);
  });
});
