import { describe, expect, it } from "vitest";

import {
  createGestureState,
  ORBIT_DEGREES_PER_PX,
  reduceGesture,
  type CameraDeltas,
  type GestureInput,
  type GestureResult,
  type GestureState,
} from "./gestures";

interface Harness {
  feed(input: GestureInput): GestureResult;
  readonly taps: readonly { x: number; y: number }[];
  state(): GestureState;
}

function harness(): Harness {
  let state = createGestureState();
  const taps: { x: number; y: number }[] = [];
  return {
    feed(input) {
      const result = reduceGesture(state, input);
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
  opts: { pan?: boolean; tap?: boolean } = {},
): GestureInput => ({
  type: "down",
  pointer: { id, x, y },
  pan: opts.pan ?? false,
  tap: opts.tap ?? true,
  timeMs,
});

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

function pan(deltas: CameraDeltas): {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
} {
  if (!deltas.pan) throw new Error("expected a pan delta");
  return deltas.pan;
}

function zoom(deltas: CameraDeltas): { factor: number; x: number; y: number } {
  if (!deltas.zoom) throw new Error("expected a zoom delta");
  return deltas.zoom;
}

describe("single-pointer orbit (mouse left drag)", () => {
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

describe("single-pointer pan (one finger / pan drag)", () => {
  it("pan-mode drag emits the pointer path, not an orbit", () => {
    const h = harness();
    h.feed(down(1, 100, 100, 0, { pan: true }));
    const result = h.feed(move(1, 110, 130));
    expect(result.deltas.orbit).toBeUndefined();
    expect(result.deltas.zoom).toBeUndefined();
    // The ground point under the pointer follows it: the adapter turns
    // the (100,100) -> (110,130) path into a world-space pan.
    expect(pan(result.deltas)).toEqual({
      fromX: 100,
      fromY: 100,
      toX: 110,
      toY: 130,
    });
  });

  it("the path is incremental: each move re-anchors to the last position", () => {
    const h = harness();
    h.feed(down(1, 50, 50, 0, { pan: true }));
    h.feed(move(1, 60, 50));
    const result = h.feed(move(1, 80, 70));
    expect(pan(result.deltas)).toEqual({
      fromX: 60,
      fromY: 50,
      toX: 80,
      toY: 70,
    });
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

  it("spreading fingers zooms in by the distance ratio, anchored at the centroid", () => {
    const h = harness();
    twoDown(h);
    // Move finger 2 from x=200 to x=300: distance 100 -> 200.
    const result = h.feed(move(2, 300, 100));
    const z = zoom(result.deltas);
    expect(z.factor).toBeCloseTo(2, 9);
    // Centroid moved from (150,100) to (200,100): the zoom anchors there.
    expect(z.x).toBeCloseTo(200, 9);
    expect(z.y).toBeCloseTo(100, 9);
  });

  it("closing fingers zooms out", () => {
    const h = harness();
    twoDown(h);
    const result = h.feed(move(2, 150, 100));
    expect(zoom(result.deltas).factor).toBeCloseTo(0.5, 9);
  });

  it("centroid motion pans: the path is the centroid's move", () => {
    const h = harness();
    twoDown(h);
    // Finger 2 moves +20 px right: centroid moves +10 px right.
    const result = h.feed(move(2, 220, 100));
    expect(pan(result.deltas)).toEqual({
      fromX: 150,
      fromY: 100,
      toX: 160,
      toY: 100,
    });
  });

  it("twisting fingers rotates the azimuth by the angle change", () => {
    const h = harness();
    twoDown(h);
    // Finger 2 from (200,100) to (200,200): segment rotates +45° in screen
    // coords (y down) = visually clockwise => azimuth increases.
    const result = h.feed(move(2, 200, 200));
    expect(orbit(result.deltas).dAzimuthDeg).toBeCloseTo(45, 9);
    expect(orbit(result.deltas).dElevationDeg).toBe(0);
  });

  it("twist and pinch compose in a single move", () => {
    const h = harness();
    twoDown(h);
    // (200,100) -> (150,200): segment vector (50,100), length ~111.8,
    // angle atan2(100,50) = ~63.4°.
    const result = h.feed(move(2, 150, 200));
    expect(zoom(result.deltas).factor).toBeCloseTo(Math.hypot(50, 100) / 100, 9);
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

  it("parallel vertical two-finger drag tilts the elevation", () => {
    const h = harness();
    twoDown(h);
    // Events move one finger at a time. After finger 1 alone moved down
    // 40 px the gesture still looks like a pinch/twist; once finger 2
    // shows the same accumulated vertical motion it classifies as tilt.
    h.feed(move(1, 100, 140));
    const tilt = h.feed(move(2, 200, 140));
    // The tilt delta is the pair's mean vertical motion of this move:
    // finger 2 slid 40 px, finger 1 stayed put.
    expect(orbit(tilt.deltas).dElevationDeg).toBeCloseTo(
      -(40 / 2) * ORBIT_DEGREES_PER_PX,
      9,
    );
    expect(orbit(tilt.deltas).dAzimuthDeg).toBe(0);
    expect(tilt.deltas.zoom).toBeUndefined();
    expect(tilt.deltas.pan).toBeUndefined();
  });

  it("dragging both fingers up together raises the elevation", () => {
    const h = harness();
    h.feed(down(1, 100, 200));
    h.feed(down(2, 200, 200));
    h.feed(move(1, 100, 170));
    const result = h.feed(move(2, 200, 170));
    expect(orbit(result.deltas).dElevationDeg).toBeCloseTo(
      (30 / 2) * ORBIT_DEGREES_PER_PX,
      9,
    );
    expect(result.deltas.zoom).toBeUndefined();
  });

  it("one finger moving vertically is a pinch, not a tilt", () => {
    const h = harness();
    twoDown(h);
    // Finger 2 alone moves toward finger 1: separation halves — this is
    // pinch zoom even though the motion is vertical.
    const result = h.feed(move(2, 200, 150));
    expect(zoom(result.deltas).factor).toBeCloseTo(
      Math.hypot(100, 50) / 100,
      9,
    );
    expect(orbit(result.deltas).dElevationDeg).toBe(0);
  });

  it("a parallel diagonal drag pans and zooms, not tilts", () => {
    const h = harness();
    twoDown(h);
    // Both fingers move (+30, +10): mostly horizontal translation — the
    // segment's rotation keeps this from classifying as tilt.
    h.feed(move(1, 130, 110));
    const result = h.feed(move(2, 230, 110));
    expect(result.deltas.orbit?.dElevationDeg ?? 0).toBe(0);
    // Per-event pan: the centroid went from (165,105) — mid-way, after
    // finger 1's move — to (180,110).
    expect(pan(result.deltas)).toEqual({
      fromX: 165,
      fromY: 105,
      toX: 180,
      toY: 110,
    });
    // Per-event zoom: the segment went from (70,-10) — after finger 1's
    // move — to (100,0).
    expect(zoom(result.deltas).factor).toBeCloseTo(
      100 / Math.hypot(70, 10),
      9,
    );
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

  it("lifting back to one pan-mode finger re-anchors pan without a jump", () => {
    const h = harness();
    h.feed(down(1, 100, 100, 0, { pan: true }));
    h.feed(down(2, 200, 100));
    h.feed(move(2, 250, 150));
    h.feed(up(2, 250, 150));
    const result = h.feed(move(1, 104, 100));
    // The remaining finger still pans, anchored at its own last position.
    expect(result.deltas.orbit).toBeUndefined();
    expect(pan(result.deltas)).toEqual({
      fromX: 100,
      fromY: 100,
      toX: 104,
      toY: 100,
    });
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

  it("a touch pan pointer still taps when it does not move", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0, { pan: true }));
    h.feed(up(1, 30, 40, 200));
    expect(h.taps).toEqual([{ x: 30, y: 40 }]);
  });

  it("a pointer that is not tap-eligible never emits a tap", () => {
    const h = harness();
    h.feed(down(1, 30, 40, 0, { pan: true, tap: false }));
    h.feed(up(1, 30, 40, 100));
    expect(h.taps).toHaveLength(0);
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
  it("zooms in on negative deltaPx and out on positive, anchored at the cursor", () => {
    const h = harness();
    const inResult = h.feed({ type: "wheel", deltaPx: -100, x: 200, y: 300 });
    const outResult = h.feed({ type: "wheel", deltaPx: 100, x: 200, y: 300 });
    const zoomIn = zoom(inResult.deltas);
    const zoomOut = zoom(outResult.deltas);
    expect(zoomIn.factor).toBeGreaterThan(1);
    expect(zoomOut.factor).toBeLessThan(1);
    // Exponential mapping is symmetric: in and out are reciprocal.
    expect(zoomIn.factor * zoomOut.factor).toBeCloseTo(1, 9);
    expect(zoomIn.x).toBe(200);
    expect(zoomIn.y).toBe(300);
  });

  it("is proportional: double deltaPx squares the factor", () => {
    const h = harness();
    const a = zoom(h.feed({ type: "wheel", deltaPx: -50, x: 0, y: 0 }).deltas).factor;
    const b = zoom(h.feed({ type: "wheel", deltaPx: -100, x: 0, y: 0 }).deltas).factor;
    expect(b).toBeCloseTo(a * a, 9);
  });

  it("works while a pointer is down without disturbing the gesture", () => {
    const h = harness();
    h.feed(down(1, 10, 10));
    const wheel = h.feed({ type: "wheel", deltaPx: -100, x: 10, y: 10 });
    expect(zoom(wheel.deltas).factor).toBeGreaterThan(1);
    const drag = h.feed(move(1, 20, 10));
    expect(drag.deltas.orbit).toBeDefined();
  });
});
