/**
 * Pure gesture classifier for the photo lightbox: what a finished
 * pointer gesture means, decided from numbers alone — no DOM, no
 * PointerEvent — so the tap/swipe/pinch rules are unit-testable in
 * Node. photo-lightbox.ts feeds it the gesture tracked since the
 * first pointerdown.
 */

/** Release displacement under which a press still counts as a tap, px. */
export const LIGHTBOX_TAP_PX = 8;
/** Horizontal drag distance that counts as a swipe, px. */
export const LIGHTBOX_SWIPE_PX = 60;
/** A swipe must be this much more horizontal than vertical. */
const SWIPE_AXIS_RATIO = 1.5;

export interface LightboxGesture {
  /** Pointer displacement between pointerdown and release, px. */
  readonly dx: number;
  readonly dy: number;
  /** Peak simultaneous pointers during the gesture (2+ means a pinch). */
  readonly pointerCount: number;
  /**
   * True when the image was zoomed — a drag pans it instead of
   * swiping — or when the gesture pinched.
   */
  readonly zoomed: boolean;
  /** True when the release/click happened over the backdrop. */
  readonly onBackdrop: boolean;
}

export type LightboxGestureAction = "close" | "prev" | "next" | "none";

export function classifyLightboxGesture(
  gesture: LightboxGesture,
): LightboxGestureAction {
  if (gesture.pointerCount !== 1) return "none";
  if (Math.hypot(gesture.dx, gesture.dy) < LIGHTBOX_TAP_PX) {
    // Only a clean single-pointer tap on the backdrop itself closes;
    // the click trailing a swipe, pan or pinch never reaches this.
    return gesture.onBackdrop ? "close" : "none";
  }
  if (
    !gesture.zoomed &&
    Math.abs(gesture.dx) >= LIGHTBOX_SWIPE_PX &&
    Math.abs(gesture.dx) > Math.abs(gesture.dy) * SWIPE_AXIS_RATIO
  ) {
    return gesture.dx < 0 ? "next" : "prev";
  }
  return "none";
}
