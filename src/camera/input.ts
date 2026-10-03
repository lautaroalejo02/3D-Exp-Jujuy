/**
 * DOM adapter between Pointer Events on the canvas and the pure gesture
 * reducer (gestures.ts). One code path covers mouse, touch and pen:
 *
 *   mouse left drag            -> orbit      touch 1-finger drag -> pan
 *   mouse right/middle drag    -> pan        touch 2-finger      -> pinch
 *   Shift/Ctrl + left drag     -> pan           (zoom to centroid, twist
 *   wheel                      -> zoom           rotates, parallel
 *                                to cursor        vertical drag tilts)
 *
 * The reducer emits screen-space deltas; this adapter turns them into
 * world-space camera moves. Pan and zoom are anchored with ray picking:
 * the pointer's ray is intersected with the ground plane through the
 * target (`y = camera.target[1]`), so the ground point under the finger,
 * the pinch centroid, or the wheel cursor stays fixed as faithfully as a
 * flat ground plane allows. When the ray misses the plane (cursor over
 * the sky above the horizon) it falls back to distance-scaled panning.
 *
 * Overlay UI elements are siblings of the canvas with their own
 * pointer-events, so canvas listeners never see their gestures.
 */
import { intersectPlaneY, screenToRay } from "../picking/ray";
import type { OrbitCamera } from "./camera";
import {
  createGestureState,
  reduceGesture,
  WHEEL_LINE_PX,
  type GestureInput,
  type GestureState,
} from "./gestures";

export interface CameraInputOptions {
  readonly camera: OrbitCamera;
  /** Tap in canvas CSS px (<8 px, <350 ms, single pointer). */
  readonly onTap?: (point: { readonly x: number; readonly y: number }) => void;
  /**
   * Fired after any input that produced camera deltas or a tap — the hook
   * render-on-demand uses to schedule a frame.
   */
  readonly onActivity?: () => void;
}

export interface CameraInput {
  dispose(): void;
}

/**
 * Drag intent locked at pointerdown. Touch always pans; for mouse and pen
 * the right/middle button or Shift/Ctrl+left pans and a plain left button
 * orbits.
 */
function isPanDrag(e: PointerEvent): boolean {
  if (e.pointerType === "touch") return true;
  return (
    e.button === 2 || // right button
    e.button === 1 || // middle button
    (e.button === 0 && (e.shiftKey || e.ctrlKey))
  );
}

/**
 * Only an unmodified primary press may become a tap: a touch or pen tap
 * (which pans) still counts, a mouse pan drag (right/middle/modified
 * left) does not.
 */
function canTap(e: PointerEvent): boolean {
  if (e.button !== 0) return false;
  return e.pointerType !== "mouse" || !(e.shiftKey || e.ctrlKey);
}

export function attachCameraInput(
  canvas: HTMLCanvasElement,
  options: CameraInputOptions,
): CameraInput {
  const camera = options.camera;
  let state: GestureState = createGestureState();

  /** Canvas-relative CSS px (correct even with capture retargeting). */
  const position = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /**
   * Ground point (world km, XZ) under the canvas pixel (x, y): the pick
   * ray intersected with the plane through the target. Undefined when the
   * ray points at the sky.
   */
  const groundAt = (
    x: number,
    y: number,
  ): readonly [number, number] | undefined => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!(w > 0) || !(h > 0)) return undefined;
    return intersectPlaneY(
      screenToRay(camera, x, y, w, h),
      camera.target[1],
    );
  };

  /**
   * Distance-scaled pan for rays that miss the ground plane: the target's
   * km-per-px at the viewport height, with vertical motion foreshortened
   * by the view elevation.
   */
  const panFallback = (dxPx: number, dyPx: number): void => {
    const h = canvas.clientHeight;
    if (!(h > 0)) return;
    const kx =
      (2 * camera.distanceKm * Math.tan((camera.fovDeg * Math.PI) / 360)) / h;
    const ky = kx / Math.sin((camera.elevationDeg * Math.PI) / 180);
    camera.pan(-dxPx * kx, dyPx * ky);
  };

  /** Ground under the pointer follows it: target += ground(from) - ground(to). */
  const applyPan = (p: {
    readonly fromX: number;
    readonly fromY: number;
    readonly toX: number;
    readonly toY: number;
  }): void => {
    const from = groundAt(p.fromX, p.fromY);
    const to = groundAt(p.toX, p.toY);
    if (from && to) {
      camera.target = [
        camera.target[0] + from[0] - to[0],
        camera.target[1],
        camera.target[2] + from[1] - to[1],
      ];
      return;
    }
    panFallback(p.toX - p.fromX, p.toY - p.fromY);
  };

  /** Zoom keeping the ground point under the anchor pixel fixed. */
  const applyZoom = (z: {
    readonly factor: number;
    readonly x: number;
    readonly y: number;
  }): void => {
    const anchor = groundAt(z.x, z.y);
    if (anchor) {
      camera.zoomTowardsPoint(z.factor, anchor[0], anchor[1]);
    } else {
      camera.zoom(z.factor);
    }
  };

  const dispatch = (input: GestureInput): void => {
    const result = reduceGesture(state, input);
    state = result.state;
    const { deltas, tap } = result;
    if (deltas.orbit) {
      camera.orbit(deltas.orbit.dAzimuthDeg, deltas.orbit.dElevationDeg);
    }
    if (deltas.pan) applyPan(deltas.pan);
    if (deltas.zoom) applyZoom(deltas.zoom);
    if (tap) options.onTap?.(tap);
    if (deltas.orbit || deltas.pan || deltas.zoom !== undefined || tap) {
      options.onActivity?.();
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault(); // no native drags or legacy mouse-event emulation
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = position(e);
    dispatch({
      type: "down",
      pointer: { id: e.pointerId, x, y },
      pan: isPanDrag(e),
      tap: canTap(e),
      timeMs: e.timeStamp,
    });
  };

  const onPointerMove = (e: PointerEvent): void => {
    // Recovery: pointer capture should always deliver the eventual
    // pointerup/pointercancel, but if a mouse move arrives with no buttons
    // pressed the gesture already ended — cancel is a no-op for pointers
    // the reducer is not tracking, so this can never leave a stuck drag.
    if (e.pointerType === "mouse" && e.buttons === 0) {
      dispatch({ type: "cancel", id: e.pointerId });
      return;
    }
    const { x, y } = position(e);
    dispatch({ type: "move", pointer: { id: e.pointerId, x, y } });
  };

  const onPointerUp = (e: PointerEvent): void => {
    const { x, y } = position(e);
    dispatch({
      type: "up",
      pointer: { id: e.pointerId, x, y },
      timeMs: e.timeStamp,
    });
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };

  const onPointerCancel = (e: PointerEvent): void => {
    dispatch({ type: "cancel", id: e.pointerId });
  };

  // Browsers fire lostpointercapture after every pointerup (auto-release) —
  // cancel is a no-op for pointers the reducer already dropped, so this is
  // a safe catch-all that can never leave a stuck gesture.
  const onLostPointerCapture = (e: PointerEvent): void => {
    dispatch({ type: "cancel", id: e.pointerId });
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // stop page zoom/scroll; listener is non-passive
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages (WheelEvent constants).
    const unitPx =
      e.deltaMode === 1
        ? WHEEL_LINE_PX
        : e.deltaMode === 2
          ? canvas.clientHeight
          : 1;
    const rect = canvas.getBoundingClientRect();
    dispatch({
      type: "wheel",
      deltaPx: e.deltaY * unitPx,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  // Right-drag is a pan gesture; the canvas never opens a context menu.
  const onContextMenu = (e: Event): void => e.preventDefault();

  // iOS Safari pinch: touch-action: none on the canvas/app is not enough —
  // it still fires page-zoom gesture events for pinches over the map.
  // Canceling them here (canvas only, so scrollable cards keep their
  // native behavior) keeps every pinch as a map zoom.
  const onGesture = (e: Event): void => e.preventDefault();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("gesturestart", onGesture);
  canvas.addEventListener("gesturechange", onGesture);
  canvas.addEventListener("gestureend", onGesture);

  return {
    dispose(): void {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("gesturestart", onGesture);
      canvas.removeEventListener("gesturechange", onGesture);
      canvas.removeEventListener("gestureend", onGesture);
      state = createGestureState();
    },
  };
}
