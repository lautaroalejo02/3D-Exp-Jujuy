/**
 * DOM adapter between Pointer Events on the canvas and the pure gesture
 * reducer (gestures.ts). One code path covers mouse, touch and pen:
 *
 *   mouse left drag            -> orbit      touch 1-finger drag -> orbit
 *   mouse right/middle drag    -> pan        touch 2-finger      -> pinch
 *   Shift/Ctrl + left drag     -> pan           (centroid pan + pinch zoom
 *   wheel                      -> zoom           + twist rotate)
 *
 * The adapter owns no gesture logic: it normalizes DOM events into
 * `GestureInput`s (canvas CSS px, event.timeStamp ms, wheel deltaMode folded
 * into pixels) and applies the emitted `CameraDeltas` to the OrbitCamera.
 * Overlay UI elements are siblings of the canvas with their own
 * pointer-events, so canvas listeners never see their gestures.
 */
import type { OrbitCamera } from "./camera";
import {
  createGestureState,
  reduceGesture,
  WHEEL_LINE_PX,
  type GestureInput,
  type GestureState,
  type GestureView,
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

/** Drag intent is locked at pointerdown from button + modifiers. */
function isPanDrag(e: PointerEvent): boolean {
  if (e.pointerType === "touch") return false;
  return (
    e.button === 2 || // right button
    e.button === 1 || // middle button
    (e.button === 0 && (e.shiftKey || e.ctrlKey))
  );
}

export function attachCameraInput(
  canvas: HTMLCanvasElement,
  options: CameraInputOptions,
): CameraInput {
  const camera = options.camera;
  let state: GestureState = createGestureState();

  const view = (): GestureView => ({
    viewportHeightPx: canvas.clientHeight,
    distanceKm: camera.distanceKm,
    fovDeg: camera.fovDeg,
    elevationDeg: camera.elevationDeg,
  });

  /** Canvas-relative CSS px (correct even with capture retargeting). */
  const position = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const dispatch = (input: GestureInput): void => {
    const result = reduceGesture(state, input, view());
    state = result.state;
    const { deltas, tap } = result;
    if (deltas.orbit) {
      camera.orbit(deltas.orbit.dAzimuthDeg, deltas.orbit.dElevationDeg);
    }
    if (deltas.pan) camera.pan(deltas.pan.dxKm, deltas.pan.dyKm);
    if (deltas.zoom !== undefined) camera.zoom(deltas.zoom);
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
    dispatch({ type: "wheel", deltaPx: e.deltaY * unitPx });
  };

  // Right-drag is a pan gesture; the canvas never opens a context menu.
  const onContextMenu = (e: Event): void => e.preventDefault();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  return {
    dispose(): void {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      state = createGestureState();
    },
  };
}
