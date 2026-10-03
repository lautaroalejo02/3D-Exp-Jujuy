/**
 * Rolling frame statistics for the ?debug=1 overlay. Pure timestamp math —
 * no DOM, no GPU — so unit tests can exercise it.
 *
 * With render-on-demand the rAF loop keeps ticking but clean ticks draw
 * nothing; counting their elapsed time would report idle seconds as slow
 * frames. A frame-to-frame interval only counts when both ticks were
 * consecutive AND both rendered — a clean tick (or a gap longer than
 * `idleMs`, e.g. the loop paused while the tab was hidden) breaks the run.
 */
export interface FrameStatsOptions {
  /** Consecutive-frame intervals kept for the rolling mean. Default 60. */
  readonly window?: number;
  /**
   * Milliseconds without a rendered frame after which the stats read as
   * idle ("en reposo"). An interval longer than this never counts as a
   * frame-to-frame sample either — it cannot be a real frame rate.
   * Default 500.
   */
  readonly idleMs?: number;
}

export interface FrameStatsSnapshot {
  /**
   * Rendered frames per second across the rolling window, or undefined
   * when fewer than two consecutive rendered frames were seen.
   */
  readonly fps?: number;
  /** Mean CPU-side encode time of the rendered frames in the window. */
  readonly cpuMs?: number;
  /** True when no frame was rendered in the last `idleMs`. */
  readonly idle: boolean;
}

export interface FrameStats {
  /**
   * Record one animation tick at `nowMs` (the rAF-clock timestamp).
   * `cpuMs` marks a rendered frame — its CPU-side encode time in
   * milliseconds; omit it for a clean tick that drew nothing.
   */
  tick(nowMs: number, cpuMs?: number): void;
  /** Current stats; `nowMs` is the same clock `tick` receives. */
  snapshot(nowMs: number): FrameStatsSnapshot;
}

export function createFrameStats(options: FrameStatsOptions = {}): FrameStats {
  const windowSize = options.window ?? 60;
  const idleMs = options.idleMs ?? 500;
  const intervals: number[] = [];
  const cpuTimes: number[] = [];
  let lastRenderedAt: number | undefined;
  let prevTickRendered = false;

  return {
    tick(nowMs, cpuMs) {
      const rendered = cpuMs !== undefined;
      if (rendered) {
        if (prevTickRendered && lastRenderedAt !== undefined) {
          const interval = nowMs - lastRenderedAt;
          if (interval > 0 && interval <= idleMs) {
            intervals.push(interval);
            if (intervals.length > windowSize) intervals.shift();
          }
        }
        cpuTimes.push(cpuMs);
        if (cpuTimes.length > windowSize) cpuTimes.shift();
        lastRenderedAt = nowMs;
      }
      prevTickRendered = rendered;
    },
    snapshot(nowMs) {
      let fps: number | undefined;
      if (intervals.length > 0) {
        const total = intervals.reduce((a, b) => a + b, 0);
        if (total > 0) fps = (intervals.length * 1000) / total;
      }
      return {
        fps,
        cpuMs:
          cpuTimes.length > 0
            ? cpuTimes.reduce((a, b) => a + b, 0) / cpuTimes.length
            : undefined,
        idle: lastRenderedAt === undefined || nowMs - lastRenderedAt > idleMs,
      };
    },
  };
}
