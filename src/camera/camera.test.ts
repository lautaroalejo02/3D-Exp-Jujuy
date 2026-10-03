import { describe, expect, it } from "vitest";

import {
  MAX_ELEVATION_DEG,
  MIN_ELEVATION_DEG,
  multiplyMat4,
  OrbitCamera,
  transformPoint,
} from "./camera";

describe("OrbitCamera orbit state", () => {
  it("azimuth 0 puts the camera south of the target, looking north", () => {
    const cam = new OrbitCamera({
      target: [10, 2, -5],
      distanceKm: 100,
      azimuthDeg: 0,
      elevationDeg: 45,
    });
    const [x, y, z] = cam.eye();
    const r = 100 * Math.cos(Math.PI / 4);
    expect(x).toBeCloseTo(10, 9); // east offset 0
    expect(y).toBeCloseTo(2 + 100 * Math.sin(Math.PI / 4), 9);
    expect(z).toBeCloseTo(-5 + r, 9); // +Z = south
  });

  it("south-east means azimuth 45 under the north-clockwise convention", () => {
    const cam = new OrbitCamera({
      distanceKm: 100,
      azimuthDeg: 45,
      elevationDeg: 45,
    });
    const [x, y, z] = cam.eye();
    expect(x).toBeGreaterThan(0); // east
    expect(z).toBeGreaterThan(0); // south
    expect(y).toBeGreaterThan(0); // above horizon
  });
});

describe("OrbitCamera controls", () => {
  it("clamps elevation to [5, 89]", () => {
    const cam = new OrbitCamera({ elevationDeg: 45 });
    cam.orbit(0, 1000);
    expect(cam.elevationDeg).toBe(MAX_ELEVATION_DEG);
    cam.orbit(0, -1000);
    expect(cam.elevationDeg).toBe(MIN_ELEVATION_DEG);
  });

  it("orbit accumulates azimuth without clamping", () => {
    const cam = new OrbitCamera({ azimuthDeg: 10 });
    cam.orbit(30, 0);
    expect(cam.azimuthDeg).toBeCloseTo(40, 12);
    cam.orbit(-400, 0);
    expect(cam.azimuthDeg).toBeCloseTo(-360, 12);
  });

  it("zoom(2) halves the distance and clamps at min/max", () => {
    const cam = new OrbitCamera({
      distanceKm: 100,
      minDistanceKm: 20,
      maxDistanceKm: 400,
    });
    cam.zoom(2);
    expect(cam.distanceKm).toBeCloseTo(50, 12);
    cam.zoom(0.1); // zoom out x10 -> 500, clamped to 400
    expect(cam.distanceKm).toBe(400);
    cam.zoom(0.001);
    expect(cam.distanceKm).toBe(400);
    cam.zoom(100); // -> 4, clamped to 20
    expect(cam.distanceKm).toBe(20);
  });

  it("rejects non-finite or non-positive zoom factors", () => {
    const cam = new OrbitCamera({ distanceKm: 100 });
    cam.zoom(0);
    cam.zoom(-3);
    cam.zoom(Number.NaN);
    expect(cam.distanceKm).toBe(100);
  });

  it("pan moves the target along ground-projected right and forward", () => {
    // azimuth 0: camera due south looking north -> right is +X (east),
    // ground-forward is -Z (north).
    const cam = new OrbitCamera({ azimuthDeg: 0 });
    cam.pan(10, 5);
    expect(cam.target[0]).toBeCloseTo(10, 12);
    expect(cam.target[1]).toBe(0);
    expect(cam.target[2]).toBeCloseTo(-5, 12);
  });

  it("pan directions rotate with the azimuth", () => {
    // azimuth 90: camera due east looking west -> ground-forward is -X
    // and camera-right is cross((-X),(+Y)) = -Z (north).
    const cam = new OrbitCamera({ azimuthDeg: 90 });
    cam.pan(10, 5);
    expect(cam.target[0]).toBeCloseTo(-5, 12); // forward -X (west)
    expect(cam.target[2]).toBeCloseTo(-10, 12); // right -Z (north)
  });
});

describe("OrbitCamera matrices", () => {
  it("view matrix moves the target to (0,0,-distance) in view space", () => {
    const cam = new OrbitCamera({
      target: [3, 1, -2],
      distanceKm: 80,
      azimuthDeg: 33,
      elevationDeg: 41,
    });
    const v = cam.viewMatrix();
    const [x, y, z] = transformPoint(v, [3, 1, -2]);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(-80, 9);
  });

  it("projection maps the near plane to z=1 and far away points to z->0", () => {
    const cam = new OrbitCamera({ nearKm: 0.5, fovDeg: 45, aspect: 2 });
    const p = cam.projectionMatrix();
    // view-space point straight ahead at exactly the near distance
    const near = transformPoint(p, [0, 0, -0.5]);
    expect(near[2]).toBeCloseTo(1, 12);
    const far = transformPoint(p, [0, 0, -5000]);
    expect(far[2]).toBeCloseTo(0.5 / 5000, 9);
    expect(far[2]).toBeGreaterThan(0);
    // x/y NDC: point at view (1, 0, -d) -> x = f*d' / aspect / d
    const off = transformPoint(p, [1, 0, -1]);
    const f = 1 / Math.tan((45 * Math.PI) / 360);
    expect(off[0]).toBeCloseTo(f / 2, 9);
  });

  it("viewProjection projects the target to the center of the frame", () => {
    const cam = new OrbitCamera({
      target: [12, 4, -30],
      distanceKm: 200,
      azimuthDeg: 45,
      elevationDeg: 45,
      aspect: 16 / 9,
    });
    const ndc = transformPoint(cam.viewProjectionMatrix(), [12, 4, -30]);
    expect(ndc[0]).toBeCloseTo(0, 9);
    expect(ndc[1]).toBeCloseTo(0, 9);
    expect(ndc[2]).toBeGreaterThan(0);
    expect(ndc[2]).toBeLessThan(1);
  });

  it("viewOffset moves the target's NDC to the shifted principal point", () => {
    const cam = new OrbitCamera({
      target: [12, 4, -30],
      distanceKm: 200,
      azimuthDeg: 45,
      elevationDeg: 45,
      aspect: 16 / 9,
    });
    cam.setViewOffset(0.25, -0.4);
    const ndc = transformPoint(cam.viewProjectionMatrix(), [12, 4, -30]);
    expect(ndc[0]).toBeCloseTo(0.25, 9);
    expect(ndc[1]).toBeCloseTo(-0.4, 9);
    // Depth is unaffected by the offset.
    expect(ndc[2]).toBeGreaterThan(0);
    expect(ndc[2]).toBeLessThan(1);
  });

  it("setViewOffset ignores non-finite values", () => {
    const cam = new OrbitCamera({ viewOffset: { x: 0.1, y: -0.1 } });
    cam.setViewOffset(Number.NaN, 0.5);
    expect(cam.viewOffsetX).toBe(0.1);
    expect(cam.viewOffsetY).toBe(-0.1);
  });

  it("multiplyMat4 agrees with identity and composition", () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const cam = new OrbitCamera({ distanceKm: 10, aspect: 1 });
    const vp = multiplyMat4(id, cam.viewProjectionMatrix());
    expect(vp).toEqual(cam.viewProjectionMatrix());
  });
});
