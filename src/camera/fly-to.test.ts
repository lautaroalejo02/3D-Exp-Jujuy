import { describe, expect, it } from "vitest";

import { OrbitCamera } from "./camera";
import {
  cameraPoseOf,
  easeInOutCubic,
  flyTo,
  interpolatePose,
  lerpAngleDeg,
  type CameraPose,
} from "./fly-to";

describe("easeInOutCubic", () => {
  it("passes through the endpoints", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it("is symmetric around the midpoint", () => {
    expect(easeInOutCubic(0.5)).toBe(0.5);
    for (const t of [0.1, 0.25, 0.4, 0.7, 0.9]) {
      expect(easeInOutCubic(1 - t)).toBeCloseTo(1 - easeInOutCubic(t), 12);
    }
  });

  it("is monotonically non-decreasing", () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("lerpAngleDeg", () => {
  it("takes the shortest path across the 0/360 seam", () => {
    // 350° -> 10° is +20°, not -340°.
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(360, 10);
    expect(lerpAngleDeg(10, 350, 0.5)).toBeCloseTo(0, 10);
  });

  it("interpolates linearly when no wrap is needed", () => {
    expect(lerpAngleDeg(10, 90, 0.5)).toBeCloseTo(50, 10);
    expect(lerpAngleDeg(10, 90, 0)).toBeCloseTo(10, 10);
    expect(lerpAngleDeg(10, 90, 1)).toBeCloseTo(90, 10);
  });
});

describe("interpolatePose", () => {
  const from: CameraPose = {
    target: [0, 0, 0],
    distanceKm: 200,
    azimuthDeg: 0,
    elevationDeg: 30,
  };
  const to: CameraPose = {
    target: [10, 5, -20],
    distanceKm: 60,
    azimuthDeg: 90,
    elevationDeg: 55,
  };

  it("returns the endpoints at t=0 and t=1", () => {
    expect(interpolatePose(from, to, 0)).toEqual(from);
    expect(interpolatePose(from, to, 1)).toEqual(to);
  });

  it("interpolates every field at the midpoint", () => {
    const mid = interpolatePose(from, to, 0.5);
    expect(mid.target).toEqual([5, 2.5, -10]);
    expect(mid.distanceKm).toBeCloseTo(130, 10);
    expect(mid.azimuthDeg).toBeCloseTo(45, 10);
    expect(mid.elevationDeg).toBeCloseTo(42.5, 10);
  });
});

describe("cameraPoseOf", () => {
  it("reads the live orbit state", () => {
    const camera = new OrbitCamera({
      target: [1, 2, 3],
      distanceKm: 120,
      azimuthDeg: 45,
      elevationDeg: 40,
    });
    expect(cameraPoseOf(camera)).toEqual({
      target: [1, 2, 3],
      distanceKm: 120,
      azimuthDeg: 45,
      elevationDeg: 40,
    });
  });
});

describe("flyTo", () => {
  const makeRig = () => {
    const camera = new OrbitCamera({
      target: [0, 0, 0],
      distanceKm: 200,
      azimuthDeg: 0,
      elevationDeg: 30,
    });
    let now = 0;
    const scheduled: (() => void)[] = [];
    let frames = 0;
    const handle = flyTo(
      camera,
      {
        target: [10, 5, -20],
        distanceKm: 60,
        azimuthDeg: 90,
        elevationDeg: 55,
      },
      {
        durationMs: 1000,
        requestFrame: () => {
          frames += 1;
        },
        now: () => now,
        schedule: (cb) => {
          scheduled.push(cb);
        },
      },
    );
    return {
      camera,
      handle,
      scheduled,
      advance(ms: number) {
        now += ms;
        const cb = scheduled.shift();
        cb?.();
      },
      get frames() {
        return frames;
      },
    };
  };

  it("schedules a first step without moving the camera yet", () => {
    const rig = makeRig();
    expect(rig.scheduled).toHaveLength(1);
    expect(rig.camera.distanceKm).toBe(200);
  });

  it("lands exactly on the destination pose at the end", () => {
    const rig = makeRig();
    rig.advance(1000);
    expect(cameraPoseOf(rig.camera)).toEqual({
      target: [10, 5, -20],
      distanceKm: 60,
      azimuthDeg: 90,
      elevationDeg: 55,
    });
    // No further steps are scheduled once the pose is reached.
    expect(rig.scheduled).toHaveLength(0);
  });

  it("eases through intermediate poses and requests a frame per step", () => {
    const rig = makeRig();
    rig.advance(500);
    // easeInOutCubic(0.5) = 0.5 — the camera is halfway there.
    expect(rig.camera.distanceKm).toBeCloseTo(130, 10);
    expect(rig.camera.elevationDeg).toBeCloseTo(42.5, 10);
    expect(rig.frames).toBe(1);
    rig.advance(500);
    expect(rig.frames).toBe(2);
  });

  it("cancel() stops the animation where it is", () => {
    const rig = makeRig();
    rig.advance(500);
    const mid = rig.camera.distanceKm;
    rig.handle.cancel();
    rig.advance(500);
    expect(rig.camera.distanceKm).toBe(mid);
  });
});
