import { describe, expect, it } from "vitest";

import {
  createGestureState,
  ORBIT_DEGREES_PER_PX,
  reduceGesture,
  type CameraDeltas,
  type GestureInput,
  type GestureResult,
  type GestureState,
  type GestureView,
} from "./gestures";

// One representative camera view for every test: 800 CSS px tall, 100 km
// from the target, 45° fov, 45° elevation.
const VIEW: GestureView = {
  viewportHeightPx: 800,
  distanceKm: 100,
  fovDeg: 45,
  elevationDeg: 45,
};

// km per CSS px at the target distance, perpendicular to the view axis.
const WORLD_PER_PX =
  (2 * VIEW.distanceKm * Math.tan((VIEW.fovDeg * Math.PI) / 360)) /
  VIEW.viewportHeightPx;

interface Harness {
  feed(input: GestureInput): GestureResult;
  readonly taps: readonly { x: number; y: number }[];
  state(): GestureState;
}

function harness(view: GestureView = VIEW): Harness {
  let state = createGestureState();
  const taps: { x: number; y: number }[] = [];
  return {
    feed(input) {
      const result = reduceGesture(state, input, view);
      state = result.state;
      if (result.tap) taps.push(result.tap);
      return result;
    },
    taps,
    state: () => state,
  };
}

const down = (
  id: number,
  x: number,
  y: number,
  timeMs = 0,
  pan = false,
): GestureInput => ({ type: "down", pointer: { id, x, y }, pan, timeMs });

const move = (id: number, x: number, y: number): GestureInput => ({
  type: "move",
  pointer: { id, x, y },
});

const up = (id: number, x: number, y: number, timeMs = 100): GestureInput => ({
  type: "up",
  pointer: { id, x, y },
  timeMs,
});

const cancel = (id: number): GestureInput => ({ type: "cancel", id });

function orbit(deltas: CameraDeltas): { dAzimuthDeg: number; dElevationDeg: number } {
  if (!deltas.orbit) throw new Error("expected an orbit delta");
  return deltas.orbit;
}

function pan(deltas: CameraDeltas): { dxKm: number; dyKm: number } {
  if (!deltas.pan) throw new Error("expected a pan delta");
  return deltas.pan;
}

describe("single-pointer orbit", () => {
  it("drag orbits: right drag increases azimuth, up drag increases elevation", () => {
    const h = harness();
    h.feed(down(1, 100, 100));
    const right = h.feed(move(1, 140, 100));
    expect(orbit(right.deltas).dAzimuthDeg).toBeGreaterThan(0);
    expect(orbit(right.deltas).dElevationDeg).toBeCloseTo(0, 9);

    const dragUp = h.feed(move(1, 140, 60));
    expect(orbit(dragUp.deltas).dElevationDeg).toBeGreaterThan(0);
    expect(orbit(dragUp.deltas).dAzimuthDeg).toBe(0);
  });

  it("orbit output is proportional to the pixels moved", () => {
    const h = harness();
    h.feed(down(1, 0, 0));
    const small = orbit(h.feed(move(1, 10, 0)).deltas).dAzimuthDeg;
    const h2 = harness();
    h2.feed(down(1, 0, 0));
    const big = orbit(h2.feed(move(1, 40, 0)).deltas).dAzimuthDeg;
    expect(big).toBeCloseTo(small * 4, 9);
  });

  it("moves from untracked pointers are ignored", () => {
    const h = harness();
    const result = h.feed(move(99, 10, 10));
    expect(result.deltas).toEqual({});
    expect(result.state.pointers).toHaveLength(0);
  });
});

describe("single-pointer pan", () => {
  it("pan-mode drag produces ground pan deltas instead of orbit", () => {
    const h = harness();
    h.feed(down(1, 100, 100, 0, /* pan */ true));
    const result = h.feed(move(1, 110, 110));
    expect(result.deltas.orbit).toBeUndefined();
    const { dxKm, dyKm } = pan(result.deltas);
    // Drag right/down => the target moves left (-right) and forward
    // (+dy, the ground-projected view direction), so content follows.
    expect(dxKm).toBeCloseTo(-10 * WORLD_PER_PX, 9);
    // Vertical screen motion is foreshortened by the view elevation.
    expect(dyKm).toBeCloseTo(
      (10 * WORLD_PER_PX) / Math.sin((45 * Math.PI) / 180),
      9,
    );
  });

  it("pan scale grows with distance and shrinks with viewport height", () => {
    const pan10 = (view: GestureView): number => {
      const h = harness(view);
      h.feed(down(1, 0, 0, 0, true));
      return pan(h.feed(move(1, 10, 0)).deltas).dxKm;
    };
    const base = pan10(VIEW);
    // 4x the distance => 4x the km covered per px.
    expect(pan10({ ...VIEW, distanceKm: 400 })).toBeCloseTo(base * 4, 9);
    // 2x the viewport height => half the km per px.
    expect(pan10({ ...VIEW, viewportHeightPx: 1600 })).toBeCloseTo(
      base / 2,
      9,
    );
  });
});

describe("two-pointer gestures", () => {
  function twoDown(h: Harness): void {
    h.feed(down(1, 100, 100));
    h.feed(down(2, 200, 100));
  }

  it("a second finger going down emits no camera delta", () => {
    const h = harness();
    h.feed(down(1, 100, 100));
    const result = h.feed(down(2, 200, 100));
    expect(result.deltas).toEqual({});
  });

  it("spreading fingers zooms in by the distance ratio", () => {
    const h = harness();
    twoDown(h);
    // Move finger 2 from x=200 to x=300: distance 100 -> 200.
    const result = h.feed(move(2, 300, 100));
    expect(result.deltas.zoom).toBeCloseTo(2, 9);
  });

  it("closing fingers zooms out", () => {
    const h = harness();
    twoDown(h);
    const result = h.feed(move(2, 150, 100));
    expect(result.deltas.zoom).toBeCloseTo(0.5, 9);
  });

  it("centroid motion pans", () => {
    const h = harness();
    twoDown(h);
    // Finger 2 moves +20 px right: centroid moves +10 px right.
    const result = h.feed(move(2, 220, 100));
    expect(pan(result.deltas).dxKm).toBeCloseTo(-10 * WORLD_PER_PX, 9);
    expect(pan(result.deltas).dyKm).toBeCloseTo(0, 9);
  });

  it("twisting fingers rotates the azimuth by the angle change", () => {
    const h = harness();
    twoDown(h);
    // Finger 2 from (200,100) to (200,200): segment rotates +45° in screen
    // coords (y down) = visually clockwise => azimuth increases.
    const result = h.feed(move(2, 200, 200));
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(45, 9);
  });

  it("twist and pinch compose in a single move", () => {
    const h = harness();
    twoDown(h);
    // (200,100) -> (150,200): segment vector (50,100), length ~111.8,
    // angle atan2(100,50) = ~63.4°.
    const result = h.feed(move(2, 150, 200));
    expect(result.deltas.zoom).toBeCloseTo(Math.hypot(50, 100) / 100, 9);
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(
      (Math.atan2(100, 50) * 180) / Math.PI,
      9,
    );
  });

  it("twist takes the short way across the ±180° angle wrap", () => {
    const h = harness();
    // Finger 2 sits at angle ~178.85° (segment points almost left, slightly
    // down-screen), then moves 4 px up to ~-178.85°. The real rotation is
    // ~+2.3° (clockwise); the raw atan2 difference would be ~-357.7°.
    h.feed(down(1, 0, 0));
    h.feed(down(2, -100, 2));
    const result = h.feed(move(2, -100, -2));
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(
      2 * ((180 / Math.PI) * Math.atan2(2, 100)),
      9,
    );
    expect(Math.abs(orbit(result.deltas).dAzimuthDeg)).toBeLessThan(10);
  });

  it("lifting back to one finger re-anchors orbit without a jump", () => {
    const h = harness();
    twoDown(h);
    h.feed(move(2, 250, 150)); // pinch a bit
    h.feed(up(2, 250, 150));
    // Finger 1 never moved; a tiny move now must yield a tiny orbit delta,
    // measured from its own last position (100,100), not the centroid.
    const result = h.feed(move(1, 104, 100));
    expect(result.deltas.pan).toBeUndefined();
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(
      4 * ORBIT_DEGREES_PER_PX,
      9,
    );
  });

  it("cancel during pinch re-anchors the remaining finger", () => {
    const h = harness();
    twoDown(h);
    h.feed(cancel(2));
    const result = h.feed(move(1, 120, 100));
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(
      20 * ORBIT_DEGREES_PER_PX,
      9,
    );
    expect(result.deltas.zoom).toBeUndefined();
  });

  it("a repeated pointerdown with the same id is ignored", () => {
    const h = harness();
    h.feed(down(1, 10, 10));
    // A second mouse button while the first is held re-fires pointerdown
    // with the same pointerId.
    h.feed(down(1, 50, 50));
    expect(h.state().pointers).toHaveLength(1);
    const result = h.feed(move(1, 60, 60));
    // Still single-pointer orbit, anchored at the original down position.
    expect(result.deltas.pan).toBeUndefined();
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(
      50 * ORBIT_DEGREES_PER_PX,
      9,
    );
  });

  it("a third pointer is ignored", () => {
    const h = harness();
    twoDown(h);
    const downResult = h.feed(down(3, 50, 50));
    expect(downResult.deltas).toEqual({});
    const moveResult = h.feed(move(3, 80, 80));
    expect(moveResult.deltas).toEqual({});
    expect(h.state().pointers.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("tap detection", () => {
  it("a quick down/up inside the slop emits a tap at the up position", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0));
    h.feed(up(1, 33, 44, 200));
    expect(h.taps).toEqual([{ x: 33, y: 44 }]);
  });

  it("a drag never emits a tap, even if the pointer returns to the start", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0));
    h.feed(move(1, 90, 40)); // leaves the slop radius
    h.feed(move(1, 30, 40)); // comes back before going up
    h.feed(up(1, 30, 40, 200));
    expect(h.taps).toHaveLength(0);
  });

  it("emits no tap when a second pointer joined the gesture", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0));
    h.feed(down(2, 200, 200, 20));
    h.feed(up(2, 200, 200, 50));
    h.feed(up(1, 30, 40, 80));
    expect(h.taps).toHaveLength(0);
  });

  it("a pan-mode pointer never emits a tap", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0, /* pan */ true));
    h.feed(up(1, 30, 40, 100));
    expect(h.taps).toHaveLength(0);
  });

  it("no tap if the press lasts 350 ms or more", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0));
    h.feed(up(1, 30, 40, 350));
    expect(h.taps).toHaveLength(0);
  });

  it("pointercancel emits no tap", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0));
    h.feed(cancel(1));
    expect(h.taps).toHaveLength(0);
    // And the cancelled pointer no longer tracks.
    const result = h.feed(move(1, 50, 50));
    expect(result.deltas).toEqual({});
  });
});

describe("wheel zoom", () => {
  it("zooms in on negative deltaPx and out on positive, smoothly", () => {
    const h = harness();
    const inResult = h.feed({ type: "wheel", deltaPx: -100 });
    const outResult = h.feed({ type: "wheel", deltaPx: 100 });
    const zoomIn = inResult.deltas.zoom;
    const zoomOut = outResult.deltas.zoom;
    if (zoomIn === undefined || zoomOut === undefined) {
      throw new Error("expected zoom deltas");
    }
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomOut).toBeLessThan(1);
    // Exponential mapping is symmetric: in and out are reciprocal.
    expect(zoomIn * zoomOut).toBeCloseTo(1, 9);
  });

  it("is proportional: double deltaPx squares the factor", () => {
    const h = harness();
    const a = h.feed({ type: "wheel", deltaPx: -50 }).deltas.zoom;
    const b = h.feed({ type: "wheel", deltaPx: -100 }).deltas.zoom;
    if (a === undefined || b === undefined) throw new Error("expected zoom");
    expect(b).toBeCloseTo(a * a, 9);
  });

  it("works while a pointer is down without disturbing the gesture", () => {
    const h = harness();
    h.feed(down(1, 10, 10));
    const wheel = h.feed({ type: "wheel", deltaPx: -100 });
    expect(wheel.deltas.zoom).toBeGreaterThan(1);
    const drag = h.feed(move(1, 20, 10));
    expect(drag.deltas.orbit).toBeDefined();
  });
});
