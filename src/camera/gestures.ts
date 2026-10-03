/**
 * Pure gesture reducer for the orbit camera: state + normalized pointer
 * input -> new state + camera deltas (+ optional tap). No DOM types, no GPU —
 * fully unit-testable with synthetic events. The DOM adapter (input.ts)
 * translates Pointer Events into `GestureInput`s, normalizes wheel
 * `deltaMode` into pixels, and applies the emitted deltas to the
 * `OrbitCamera`.
 *
 * Screen-space deltas: `pan` carries the pointer path (CSS px) the ground
 * point should follow, and `zoom` carries a factor plus the anchor pixel —
 * the adapter turns both into world-space camera moves with ray/plane
 * picking, so the reducer stays free of camera internals.
 *
 * Conventions (the camera follows the pointer):
 * - Single-pointer orbit: drag right increases azimuth, drag up raises
 *   elevation (the view tilts towards top-down when dragging up).
 * - Single-pointer pan (touch, or mouse pan buttons/modifiers): the
 *   ground point under the pointer follows it.
 * - Two fingers share one move: pinch (finger-distance ratio >1 = zoom
 *   in) towards the centroid, twist (segment angle change) rotates the
 *   azimuth, and the centroid path pans.
 * - Two-finger parallel vertical drag tilts (elevation) instead: it is
 *   told apart from pinch/twist because both fingers move in the same
 *   vertical direction while the separation and angle barely change.
 * - A tap is a pointer eligible for taps that goes down and up with
 *   < TAP_MAX_PX of movement and < TAP_MAX_MS elapsed, with no other
 *   pointer involved.
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
      /**
       * Drag intent locked at pointerdown: true = the drag pans (touch,
       * right/middle button, Shift/Ctrl+left); false = it orbits.
       */
      readonly pan: boolean;
      /**
       * Whether this pointer may still emit a tap on release. Plain
       * taps only: pan drags (mouse right/middle, modified left) never
       * tap, but touch pans do.
       */
      readonly tap: boolean;
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
      /** Cursor position in canvas CSS px — the zoom anchor. */
      readonly x: number;
      readonly y: number;
    };

export interface CameraDeltas {
  readonly orbit?: {
    readonly dAzimuthDeg: number;
    readonly dElevationDeg: number;
  };
  /**
   * Pan in screen space: the ground point under `from` must end up under
   * `to` (canvas CSS px). The adapter converts it with ray/plane picking.
   */
  readonly pan?: {
    readonly fromX: number;
    readonly fromY: number;
    readonly toX: number;
    readonly toY: number;
  };
  /**
   * Zoom factor (>1 zooms in) around an anchor pixel in canvas CSS px —
   * the wheel cursor or the pinch centroid.
   */
  readonly zoom?: {
    readonly factor: number;
    readonly x: number;
    readonly y: number;
  };
}

export interface GestureResult {
  readonly state: GestureState;
  readonly deltas: CameraDeltas;
  readonly tap?: { readonly x: number; readonly y: number };
}

export interface GestureState {
  readonly pointers: readonly TrackedPointer[];
  /**
   * Finger positions when the pair formed (second finger down), aligned
   * with `pointers[0]`/`pointers[1]`. Pointer events move one finger at
   * a time, so tilt detection needs each finger's motion accumulated
   * from this anchor to tell a parallel drag from a pinch.
   */
  readonly pairAnchor?: readonly [PointerXY, PointerXY];
}

interface PointerXY {
  readonly x: number;
  readonly y: number;
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
   * Still eligible to emit a tap on release. Starts from the `tap` flag
   * of the down input (and only when the pointer is alone) and goes false
   * forever once the pointer leaves the slop radius or another pointer
   * joins.
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
/**
 * Two-finger drag counts as tilt when the shared vertical motion is at
 * least this many times larger than the separation and angle changes.
 */
export const TILT_DOMINANCE = 2;

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
    tapCandidate: input.tap && state.pointers.length === 0,
  };
  const pointers = [
    // Another pointer is now involved: existing pointers can no longer tap.
    ...state.pointers.map((p) => ({ ...p, tapCandidate: false })),
    pointer,
  ];
  // The pair forms now: anchor both fingers where they are so tilt
  // detection measures accumulated motion from this point.
  const pairAnchor =
    pointers.length === 2
      ? ([
          { x: pointers[0]!.x, y: pointers[0]!.y },
          { x: pointer.x, y: pointer.y },
        ] as const)
      : undefined;
  return { state: { pointers, pairAnchor }, deltas: {} };
}

function applyMove(
  state: GestureState,
  input: Extract<GestureInput, { type: "move" }>,
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
      // The ground point under the finger follows it: the adapter
      // intersects both pointer positions with the ground plane and
      // moves the target by the difference.
      deltas.pan = {
        fromX: prev.x,
        fromY: prev.y,
        toX: curr.x,
        toY: curr.y,
      };
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
    const prevA = state.pointers[0]!;
    const prevB = state.pointers[1]!;
    const currA = pointers[0]!;
    const currB = pointers[1]!;
    const prev = pairGeometry(prevA, prevB);
    const next = pairGeometry(currA, currB);
    const dDist = next.distancePx - prev.distancePx;
    const dAngle = wrapPi(next.angleRad - prev.angleRad);
    const dAy = currA.y - prevA.y;
    const dBy = currB.y - prevB.y;

    // Tilt or pinch+twist? Events move one finger at a time, so classify
    // on the motion accumulated since the pair formed: a parallel
    // vertical drag has both fingers' accumulated dy pointing the same
    // way and dominating the shared horizontal motion (a pan), the
    // vertical difference (a vertical pinch), the separation change (a
    // pinch) and the angle change (a twist).
    const anchor = state.pairAnchor;
    const anchorGeom = anchor
      ? {
          distancePx: Math.hypot(
            anchor[1].x - anchor[0].x,
            anchor[1].y - anchor[0].y,
          ),
          angleRad: Math.atan2(
            anchor[1].y - anchor[0].y,
            anchor[1].x - anchor[0].x,
          ),
        }
      : prev;
    const aDy = currA.y - (anchor?.[0].y ?? prevA.y);
    const bDy = currB.y - (anchor?.[1].y ?? prevB.y);
    const aDx = currA.x - (anchor?.[0].x ?? prevA.x);
    const bDx = currB.x - (anchor?.[1].x ?? prevB.x);
    const sumDy = Math.abs(aDy + bDy);
    const tiltBeat =
      Math.abs(aDx + bDx) +
      Math.abs(bDy - aDy) +
      Math.abs(next.distancePx - anchorGeom.distancePx) +
      Math.abs(wrapPi(next.angleRad - anchorGeom.angleRad)) *
        anchorGeom.distancePx;
    if (sumDy > 0 && sumDy >= TILT_DOMINANCE * tiltBeat) {
      deltas.orbit = {
        dAzimuthDeg: 0,
        dElevationDeg: -((dAy + dBy) / 2) * ORBIT_DEGREES_PER_PX,
      };
    } else {
      // The centroid path pans, the distance ratio pinches towards the
      // centroid, and the angle change twists the azimuth.
      deltas.pan = {
        fromX: prev.centroidX,
        fromY: prev.centroidY,
        toX: next.centroidX,
        toY: next.centroidY,
      };
      deltas.zoom = {
        factor: prev.distancePx > 0 ? next.distancePx / prev.distancePx : 1,
        x: next.centroidX,
        y: next.centroidY,
      };
      deltas.orbit = {
        dAzimuthDeg: dAngle * DEG_PER_RAD,
        dElevationDeg: 0,
      };
    }
  }

  return { state: { pointers, pairAnchor: state.pairAnchor }, deltas };
}

function applyUp(
  state: GestureState,
  input: Extract<GestureInput, { type: "up" }>,
): GestureResult {
  const pointer = state.pointers.find((p) => p.id === input.pointer.id);
  if (!pointer) return { state, deltas: {} };
  const next: GestureState = {
    pointers: state.pointers.filter((p) => p.id !== input.pointer.id),
    // The pair broke: the next pair (if any) anchors fresh.
    pairAnchor: undefined,
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
    state: {
      pointers: state.pointers.filter((p) => p.id !== input.id),
      pairAnchor: undefined,
    },
    deltas: {},
  };
}

export function reduceGesture(
  state: GestureState,
  input: GestureInput,
): GestureResult {
  switch (input.type) {
    case "down":
      return applyDown(state, input);
    case "move":
      return applyMove(state, input);
    case "up":
      return applyUp(state, input);
    case "cancel":
      return applyCancel(state, input);
    case "wheel":
      // Exponential mapping: zoom is smooth and proportional to the scroll
      // amount (deltaPx is already normalized by the DOM adapter). The
      // cursor pixel anchors the zoom.
      return {
        state,
        deltas: {
          zoom: {
            factor: Math.exp(-input.deltaPx * WHEEL_ZOOM_PER_PX),
            x: input.x,
            y: input.y,
          },
        },
      };
  }
}
