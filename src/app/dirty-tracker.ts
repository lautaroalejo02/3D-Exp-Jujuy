/**
 * Pure dirty-frame tracker for render-on-demand. The app renders only when
 * something visible changed — camera input, exaggeration, pick state, a
 * resize — instead of encoding GPU work every animation frame.
 *
 * `request(n)` asks for n rendered frames: the common case is n=1 (state
 * changed once), and n>1 reserves frames for work that settles over several
 * ticks (smoothing, animations). Repeated requests take the maximum pending
 * count rather than summing — ten pointer events in one tick still need one
 * repaint, not ten.
 */
export interface DirtyTracker {
  /** Request at least `frames` more rendered frames (default 1). */
  request(frames?: number): void;
  /** True while at least one requested frame is still owed. */
  isDirty(): boolean;
  /** Frames still owed to pending requests. */
  readonly pendingFrames: number;
  /** Call once per frame that was actually submitted to the GPU. */
  frameRendered(): void;
}

export function createDirtyTracker(): DirtyTracker {
  let pending = 0;
  return {
    request(frames = 1) {
      if (!Number.isFinite(frames) || frames < 1) return;
      pending = Math.max(pending, Math.floor(frames));
    },
    isDirty: () => pending > 0,
    get pendingFrames() {
      return pending;
    },
    frameRendered() {
      if (pending > 0) pending -= 1;
    },
  };
}
