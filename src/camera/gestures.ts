/**
 * Pure gesture reducer for the orbit camera: state + normalized pointer
 * input -> new state + camera deltas (+ optional tap). No DOM types, no GPU —
 * fully unit-testable with synthetic events. The DOM adapter (input.ts)
 * translates Pointer Events into `GestureInput`s, normalizes wheel
 * `deltaMode` into pixels, and applies the emitted deltas to the
 * `OrbitCamera`.
 *
 * Conventions (the camera follows the pointer):
 * - Single-pointer orbit: drag right increases azimuth, drag up raises
 *   elevation (the view tilts towards top-down when dragging up).
 * - Single-pointer pan and two-finger centroid pan move the target on the
 *   ground plane so the ground under the pointer roughly follows it:
 *   screen-right maps to -camera-right, screen-down maps to +camera-forward
 *   (the camera advances, so ground content slides down-screen).
 * - Pinch zoom is the new/old finger distance ratio (>1 = zoom in).
 * - Twist rotates azimuth by the finger angle change; elevation untouched.
 * - A tap is a non-pan pointer that goes down and up with < TAP_MAX_PX of
 *   movement and < TAP_MAX_MS elapsed, with no other pointer involved.
 * - Pointers beyond MAX_POINTERS are ignored until they lift: they never
 *   enter `state.pointers`, so all their inputs are no-ops.
 */

export interface PointerInfo {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export type GestureInput =
  | {
      readonly type: "down";
      readonly pointer: PointerInfo;
      /** Pan drag (right/middle button, Shift/Ctrl+left); false = orbit. */
      readonly pan: boolean;
      readonly timeMs: number;
    }
  | { readonly type: "move"; readonly pointer: PointerInfo }
  | {
      readonly type: "up";
      readonly pointer: PointerInfo;
      readonly timeMs: number;
    }
  | { readonly type: "cancel"; readonly id: number }
  | {
      readonly type: "wheel";
      /** Scroll amount already normalized to CSS px (deltaMode applied). */
      readonly deltaPx: number;
    };

export interface GestureView {
  /** Viewport height in CSS px (same unit space as pointer coordinates). */
  readonly viewportHeightPx: number;
  readonly distanceKm: number;
  readonly fovDeg: number;
  readonly elevationDeg: number;
}

export interface CameraDeltas {
  readonly orbit?: {
    readonly dAzimuthDeg: number;
    readonly dElevationDeg: number;
  };
  readonly pan?: { readonly dxKm: number; readonly dyKm: number };
  /** Zoom factor: >1 zooms in, <1 zooms out (OrbitCamera.zoom argument). */
  readonly zoom?: number;
}

export interface GestureResult {
  readonly state: GestureState;
  readonly deltas: CameraDeltas;
  readonly tap?: { readonly x: number; readonly y: number };
}

export interface GestureState {
  readonly pointers: readonly TrackedPointer[];
}

export interface TrackedPointer {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly downX: number;
  readonly downY: number;
  readonly downTimeMs: number;
  readonly pan: boolean;
  /**
   * Still eligible to emit a tap on release. Starts true (except for pan
   * pointers and pointers joining an active gesture) and goes false forever
   * once the pointer leaves the slop radius or another pointer joins.
   */
  readonly tapCandidate: boolean;
}

/** Tuning knobs — all sensitivity lives here. */
export const ORBIT_DEGREES_PER_PX = 0.25;
export const WHEEL_ZOOM_PER_PX = 0.002;
/** Pixel equivalent of one wheel "line" (deltaMode 1); pages use the view height. */
export const WHEEL_LINE_PX = 16;
export const TAP_MAX_PX = 8;
export const TAP_MAX_MS = 350;
export const MAX_POINTERS = 2;

const DEG_PER_RAD = 180 / Math.PI;
const TAU = 2 * Math.PI;

/** Wrap a radian delta into (-PI, PI] so twists always take the short way
 * (a finger segment crossing the +-180 deg branch cut rotates ~2 deg, not
 * ~-358 deg). */
function wrapPi(rad: number): number {
  let r = rad % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

export function createGestureState(): GestureState {
  return { pointers: [] };
}

/**
 * Ground-plane km per CSS px of pointer motion at the target. `kx` uses the
 * viewport height subtended at the target distance; `ky` divides by
 * sin(elevation) because the ground plane is tilted relative to the view
 * ray — the ground under the pointer roughly follows it.
 */
function kmPerPx(view: GestureView): { kx: number; ky: number } {
  if (view.viewportHeightPx <= 0) return { kx: 0, ky: 0 };
  const kx =
    (2 * view.distanceKm * Math.tan((view.fovDeg * Math.PI) / 360)) /
    view.viewportHeightPx;
  return { kx, ky: kx / Math.sin((view.elevationDeg * Math.PI) / 180) };
}

interface PairGeometry {
  readonly distancePx: number;
  readonly angleRad: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

function pairGeometry(a: TrackedPointer, b: TrackedPointer): PairGeometry {
  return {
    distancePx: Math.hypot(b.x - a.x, b.y - a.y),
    angleRad: Math.atan2(b.y - a.y, b.x - a.x),
    centroidX: (a.x + b.x) / 2,
    centroidY: (a.y + b.y) / 2,
  };
}

function applyDown(
  state: GestureState,
  input: Extract<GestureInput, { type: "down" }>,
): GestureResult {
  if (state.pointers.length >= MAX_POINTERS) {
    // Extra pointers are ignored entirely; the two tracked ones already lost
    // tap eligibility when they stopped being alone.
    return { state, deltas: {} };
  }
  // A mouse fires pointerdown for each button pressed while others are held,
  // all with the same pointerId — tracking it twice would corrupt the pair
  // math, so an already-tracked id is ignored.
  if (state.pointers.some((p) => p.id === input.pointer.id)) {
    return { state, deltas: {} };
  }
  const pointer: TrackedPointer = {
    id: input.pointer.id,
    x: input.pointer.x,
    y: input.pointer.y,
    downX: input.pointer.x,
    downY: input.pointer.y,
    downTimeMs: input.timeMs,
    pan: input.pan,
    tapCandidate: !input.pan && state.pointers.length === 0,
  };
  const pointers = [
    // Another pointer is now involved: existing pointers can no longer tap.
    ...state.pointers.map((p) => ({ ...p, tapCandidate: false })),
    pointer,
  ];
  return { state: { pointers }, deltas: {} };
}

function applyMove(
  state: GestureState,
  input: Extract<GestureInput, { type: "move" }>,
  view: GestureView,
): GestureResult {
  const index = state.pointers.findIndex((p) => p.id === input.pointer.id);
  if (index === -1) return { state, deltas: {} };

  const pointers = state.pointers.map((p) =>
    p.id === input.pointer.id
      ? {
          ...p,
          x: input.pointer.x,
          y: input.pointer.y,
          tapCandidate:
            p.tapCandidate &&
            Math.hypot(input.pointer.x - p.downX, input.pointer.y - p.downY) <
              TAP_MAX_PX,
        }
      : p,
  );

  const deltas: { -readonly [K in keyof CameraDeltas]?: CameraDeltas[K] } = {};

  if (pointers.length === 1) {
    const prev = state.pointers[0]!;
    const curr = pointers[0]!;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    if (curr.pan) {
      const { kx, ky } = kmPerPx(view);
      deltas.pan = { dxKm: -dx * kx, dyKm: dy * ky };
    } else {
      deltas.orbit = {
        dAzimuthDeg: dx * ORBIT_DEGREES_PER_PX,
        dElevationDeg: -dy * ORBIT_DEGREES_PER_PX,
      };
    }
  } else {
    // Pair deltas are measured between the stored geometry (all moves seen
    // so far) and the new geometry — every move re-anchors implicitly, so
    // adding or lifting a finger can never produce a jump.
    const prev = pairGeometry(state.pointers[0]!, state.pointers[1]!);
    const next = pairGeometry(pointers[0]!, pointers[1]!);
    const { kx, ky } = kmPerPx(view);
    deltas.pan = {
      dxKm: -(next.centroidX - prev.centroidX) * kx,
      dyKm: (next.centroidY - prev.centroidY) * ky,
    };
    deltas.zoom = prev.distancePx > 0 ? next.distancePx / prev.distancePx : 1;
    deltas.orbit = {
      dAzimuthDeg: wrapPi(next.angleRad - prev.angleRad) * DEG_PER_RAD,
      dElevationDeg: 0,
    };
  }

  return { state: { pointers }, deltas };
}

function applyUp(
  state: GestureState,
  input: Extract<GestureInput, { type: "up" }>,
): GestureResult {
  const pointer = state.pointers.find((p) => p.id === input.pointer.id);
  if (!pointer) return { state, deltas: {} };
  const next: GestureState = {
    pointers: state.pointers.filter((p) => p.id !== input.pointer.id),
  };
  const tap =
    pointer.tapCandidate &&
    input.timeMs - pointer.downTimeMs < TAP_MAX_MS &&
    Math.hypot(input.pointer.x - pointer.downX, input.pointer.y - pointer.downY) <
      TAP_MAX_PX
      ? { x: input.pointer.x, y: input.pointer.y }
      : undefined;
  return { state: next, deltas: {}, tap };
}

function applyCancel(
  state: GestureState,
  input: Extract<GestureInput, { type: "cancel" }>,
): GestureResult {
  if (!state.pointers.some((p) => p.id === input.id)) {
    return { state, deltas: {} };
  }
  return {
    state: { pointers: state.pointers.filter((p) => p.id !== input.id) },
    deltas: {},
  };
}

export function reduceGesture(
  state: GestureState,
  input: GestureInput,
  view: GestureView,
): GestureResult {
  switch (input.type) {
    case "down":
      return applyDown(state, input);
    case "move":
      return applyMove(state, input, view);
    case "up":
      return applyUp(state, input);
    case "cancel":
      return applyCancel(state, input);
    case "wheel":
      // Exponential mapping: zoom is smooth and proportional to the scroll
      // amount (deltaPx is already normalized by the DOM adapter).
      return {
        state,
        deltas: { zoom: Math.exp(-input.deltaPx * WHEEL_ZOOM_PER_PX) },
      };
  }
}
