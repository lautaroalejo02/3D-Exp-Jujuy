import { describe, expect, it } from "vitest";

import { OrbitCamera, transformPoint } from "../camera/camera";
import type { GridSpec } from "../geo/grid";
import { gridToLonLat } from "../geo/grid";
import {
  elevationToWorldY,
  gridToWorld,
  metersPerGridCell,
} from "../geo/world";
import { Heightfield } from "../terrain/heightfield";
import { intersectHeightfield, intersectPlaneY, screenToRay } from "./ray";

/**
 * Synthetic grids that exercise the real lat/lon <-> grid <-> world mapping
 * chain: same zoom and origin as the real DEM crop, smaller cell counts.
 */
const SPEC: GridSpec = {
  zoom: 10,
  originPx: [82048, 147200],
  width: 128,
  height: 128,
  scale: 1,
};

function flatField(height: number, spec: GridSpec = SPEC): Heightfield {
  return new Heightfield(
    new Float32Array(spec.width * spec.height).fill(height),
    spec,
  );
}

function fieldFrom(
  fn: (i: number, j: number) => number,
  spec: GridSpec = SPEC,
): Heightfield {
  const data = new Float32Array(spec.width * spec.height);
  for (let j = 0; j < spec.height; j++) {
    for (let i = 0; i < spec.width; i++) {
      data[j * spec.width + i] = fn(i, j);
    }
  }
  return new Heightfield(data, spec);
}

describe("screenToRay", () => {
  it("aims the screen-center ray straight at the camera target", () => {
    const camera = new OrbitCamera({
      target: [10, 2, -5],
      distanceKm: 120,
      azimuthDeg: 30,
      elevationDeg: 45,
      aspect: 1.6,
    });
    const w = 1280;
    const h = 800;
    const ray = screenToRay(camera, w / 2, h / 2, w, h);
    const len = Math.hypot(...ray.direction);
    expect(len).toBeCloseTo(1, 12);
    // The target lies on the ray: distance from target to the ray line ~ 0.
    const toTarget = [
      10 - ray.origin[0],
      2 - ray.origin[1],
      -5 - ray.origin[2],
    ] as const;
    const t =
      toTarget[0] * ray.direction[0] +
      toTarget[1] * ray.direction[1] +
      toTarget[2] * ray.direction[2];
    const closest = [
      ray.origin[0] + ray.direction[0] * t,
      ray.origin[1] + ray.direction[1] * t,
      ray.origin[2] + ray.direction[2] * t,
    ] as const;
    expect(closest[0]).toBeCloseTo(10, 9);
    expect(closest[1]).toBeCloseTo(2, 9);
    expect(closest[2]).toBeCloseTo(-5, 9);
  });

  it("off-center rays diverge like the projection does", () => {
    const camera = new OrbitCamera({
      target: [0, 0, 0],
      distanceKm: 100,
      azimuthDeg: 0,
      elevationDeg: 60,
      aspect: 1,
    });
    const center = screenToRay(camera, 100, 100, 200, 200);
    const right = screenToRay(camera, 190, 100, 200, 200);
    const up = screenToRay(camera, 100, 10, 200, 200);
    expect(right.direction[0]).toBeGreaterThan(center.direction[0]);
    expect(up.direction[1]).toBeGreaterThan(center.direction[1]);
  });
});

describe("intersectHeightfield", () => {
  it("hits a flat grid at the analytic intersection point", () => {
    const field = flatField(500);
    const exaggeration = 2.5;
    const terrainY = elevationToWorldY(500, exaggeration); // 1.25 km
    // Vertical ray straight down through grid cell (40, 60).
    const [x, , z] = gridToWorld(SPEC, 40, 60);
    const hit = intersectHeightfield(
      { origin: [x, terrainY + 10, z], direction: [0, -1, 0] },
      field,
      exaggeration,
    );
    expect(hit).toBeDefined();
    expect(hit!.world[0]).toBeCloseTo(x, 9);
    expect(hit!.world[1]).toBeCloseTo(terrainY, 9);
    expect(hit!.world[2]).toBeCloseTo(z, 9);
    expect(hit!.grid[0]).toBeCloseTo(40, 9);
    expect(hit!.grid[1]).toBeCloseTo(60, 9);
    expect(hit!.elevationMeters).toBeCloseTo(500, 9);
    const [lon, lat] = gridToLonLat(SPEC, 40, 60);
    expect(hit!.lonLat[0]).toBeCloseTo(lon, 9);
    expect(hit!.lonLat[1]).toBeCloseTo(lat, 9);
  });

  it("hits a tilted plane on its slope, not at the entry height", () => {
    // Height grows 20 m per cell along i: a real tilted plane under
    // bilinear sampling (exact, no interpolation error between cells).
    const field = fieldFrom((i) => 1000 + 20 * i);
    const exaggeration = 1;
    // Steep diagonal ray; solve analytically: terrain under the ray is
    // 1000 + 20 * i(t) meters, i(t) from worldToGrid of the ray xz.
    const [x0, , z0] = gridToWorld(SPEC, 10, 64);
    const [x1, , z1] = gridToWorld(SPEC, 110, 64);
    const origin = [x0, 30, z0] as const; // 30 km up
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dy = -30;
    const len = Math.hypot(dx, dy, dz);
    const direction = [dx / len, dy / len, dz / len] as const;
    const hit = intersectHeightfield(
      { origin, direction },
      field,
      exaggeration,
    );
    expect(hit).toBeDefined();
    // Analytic check: y(t) = 30 + direction[1]*t must equal
    // (1000 + 20*i(x(t)))/1000 km. Solve in km along t.
    const cellKm = metersPerGridCell(SPEC) / 1000;
    const i0 = 10;
    // i(t) = i0 + t*direction[0]/cellKm and the plane in km is
    // y_terrain(i) = 1 + 0.02*i. Solving rayY(t) = y_terrain(i(t)):
    const t = (30 - 1 - 0.02 * i0) / (0.02 * direction[0] / cellKm - direction[1]);
    // 4 decimals = ~5 cm tolerance: bisection is bounded by 1 m on the
    // dominant axis and lands far under it in practice.
    expect(hit!.world[0]).toBeCloseTo(origin[0] + direction[0] * t, 4);
    expect(hit!.world[1]).toBeCloseTo(origin[1] + direction[1] * t, 4);
    expect(hit!.world[2]).toBeCloseTo(origin[2] + direction[2] * t, 4);
  });

  it("returns undefined for a ray that misses the terrain (sky)", () => {
    const field = flatField(3000);
    const [x, , z] = gridToWorld(SPEC, 64, 64);
    // Ray parallel to the ground far above the exaggerated terrain.
    const above = intersectHeightfield(
      { origin: [x, elevationToWorldY(3000, 2.5) + 1, z], direction: [1, 0, 0] },
      field,
      2.5,
    );
    expect(above).toBeUndefined();
    // Ray pointing up but outside the grid extent: the bounding box is
    // never entered, so it stays a sky tap.
    const [xOut, , zOut] = gridToWorld(SPEC, -50, -50);
    const up = intersectHeightfield(
      { origin: [xOut, 0.5, zOut], direction: [0, 1, 0] },
      field,
      2.5,
    );
    expect(up).toBeUndefined();
    // Horizontal ray below the terrain's lowest exaggerated height.
    const below = intersectHeightfield(
      { origin: [x, 0.1, z], direction: [1, 0, 0] },
      field,
      2.5,
    );
    expect(below).toBeUndefined();
    // Ray aimed away from the grid entirely.
    const away = intersectHeightfield(
      { origin: [x - 1000, 5, z], direction: [-1, 0, 0] },
      field,
      2.5,
    );
    expect(away).toBeUndefined();
  });

  it("a grazing ray hits the ridge, not the ground behind it", () => {
    // Flat 1000 m terrain with a 4000 m ridge at i = 64 (one cell wide ->
    // a two-cell-wide tent under bilinear sampling).
    const RIDGE_I = 64;
    const field = fieldFrom((i) => (i === RIDGE_I ? 4000 : 1000));
    const exaggeration = 1;
    // Horizontal ray at 2500 m (2.5 km) flying east over the flats.
    const [x0, , z] = gridToWorld(SPEC, 0, 32);
    const rayY = 2.5;
    const hit = intersectHeightfield(
      { origin: [x0 - 1, rayY, z], direction: [1, 0, 0] },
      field,
      exaggeration,
    );
    expect(hit).toBeDefined();
    // The tent rises from cell 63 to 64: the crossing sits in i in [63, 64].
    expect(hit!.grid[0]).toBeGreaterThan(RIDGE_I - 1.01);
    expect(hit!.grid[0]).toBeLessThan(RIDGE_I);
    // Elevation at the hit equals the ray height (unexaggerated).
    expect(hit!.elevationMeters).toBeCloseTo(rayY * 1000, 3);
    // And it is NOT the flat ground behind the ridge (i ~ width/2 edge).
    expect(hit!.grid[0]).toBeLessThan(SPEC.width / 2 + 20);
  });

  it("round-trips: a world point projected to screen picks the same lon/lat", () => {
    // Smooth synthetic relief through the real mapping chain.
    const field = fieldFrom(
      (i, j) => 1500 + 800 * Math.sin(i / 20) * Math.cos(j / 25),
    );
    const exaggeration = 2.5;
    const gi = 70.3;
    const gj = 45.7;
    const elevation = field.heightAtGrid(gi, gj);
    const world = gridToWorld(SPEC, gi, gj, {
      elevationMeters: elevation,
      verticalExaggeration: exaggeration,
    });
    const camera = new OrbitCamera({
      target: world,
      distanceKm: 80,
      azimuthDeg: 35,
      elevationDeg: 50,
      fovDeg: 45,
      aspect: 1.6,
      nearKm: 0.1,
      minDistanceKm: 5,
    });
    const w = 1280;
    const h = 800;
    // Project the point to screen; the target projects to the center.
    const ndc = transformPoint(camera.viewProjectionMatrix(), world);
    expect(ndc[0]).toBeCloseTo(0, 9);
    expect(ndc[1]).toBeCloseTo(0, 9);
    const sx = ((ndc[0] + 1) / 2) * w;
    const sy = ((1 - ndc[1]) / 2) * h;
    const ray = screenToRay(camera, sx, sy, w, h);
    const hit = intersectHeightfield(ray, field, exaggeration);
    expect(hit).toBeDefined();
    const [expectedLon, expectedLat] = gridToLonLat(SPEC, gi, gj);
    expect(hit!.lonLat[0]).toBeCloseTo(expectedLon, 4);
    expect(hit!.lonLat[1]).toBeCloseTo(expectedLat, 4);
    expect(hit!.grid[0]).toBeCloseTo(gi, 2);
    expect(hit!.grid[1]).toBeCloseTo(gj, 2);
    expect(hit!.elevationMeters).toBeCloseTo(elevation, 0);
  });

  it("lands on the surface at different exaggerations from the same pixel", () => {
    const field = fieldFrom(
      (i, j) => 500 + 2500 * Math.exp(-((i - 64) ** 2 + (j - 64) ** 2) / 300),
    );
    const [wx, , wz] = gridToWorld(SPEC, 64, 64);
    const camera = new OrbitCamera({
      target: [wx, 2, wz],
      distanceKm: 100,
      azimuthDeg: 20,
      elevationDeg: 55,
      fovDeg: 45,
      aspect: 1.6,
      nearKm: 0.1,
    });
    const w = 1280;
    const h = 800;
    const sx = w * 0.55;
    const sy = h * 0.45;
    const ray = screenToRay(camera, sx, sy, w, h);
    for (const exaggeration of [1, 2.5, 5]) {
      const hit = intersectHeightfield(ray, field, exaggeration);
      expect(hit).toBeDefined();
      // The hit lies on the exaggerated surface at that exaggeration.
      const surfaceY = elevationToWorldY(hit!.elevationMeters, exaggeration);
      expect(hit!.world[1]).toBeCloseTo(surfaceY, 6);
      // And on the ray: project the hit back onto the ray line and
      // compare the horizontal position (y is snapped to the surface,
      // which is the ray height at the crossing by construction).
      const toHit = [
        hit!.world[0] - ray.origin[0],
        hit!.world[1] - ray.origin[1],
        hit!.world[2] - ray.origin[2],
      ] as const;
      const t =
        toHit[0] * ray.direction[0] +
        toHit[1] * ray.direction[1] +
        toHit[2] * ray.direction[2];
      const rayX = ray.origin[0] + ray.direction[0] * t;
      const rayZ = ray.origin[2] + ray.direction[2] * t;
      expect(hit!.world[0]).toBeCloseTo(rayX, 3);
      expect(hit!.world[2]).toBeCloseTo(rayZ, 3);
    }
  });

  it("picked elevation matches heightAtLonLat at the hit", () => {
    const field = fieldFrom(
      (i, j) => 700 + 30 * i + 15 * j + 5 * Math.sin(i * j),
    );
    const [x, , z] = gridToWorld(SPEC, 30, 80);
    const hit = intersectHeightfield(
      { origin: [x, 20, z], direction: [0, -1, 0] },
      field,
      3,
    );
    expect(hit).toBeDefined();
    const atLonLat = field.heightAtLonLat(hit!.lonLat[0], hit!.lonLat[1]);
    expect(atLonLat).toBeDefined();
    expect(hit!.elevationMeters).toBeCloseTo(atLonLat!, 6);
  });

  it("returns the first hit when the ray would cross twice", () => {
    // Two towers; the ray must stop at the first (western) one.
    const field = fieldFrom((i) => (i === 40 || i === 90 ? 5000 : 500));
    const [, , z] = gridToWorld(SPEC, 0, 10);
    const [x0] = gridToWorld(SPEC, 0, 10);
    const hit = intersectHeightfield(
      { origin: [x0 - 1, 4, z], direction: [1, 0, 0] },
      field,
      1,
    );
    expect(hit).toBeDefined();
    expect(hit!.grid[0]).toBeLessThan(41);
  });
});

describe("intersectPlaneY", () => {
  it("returns the XZ point where the ray crosses the plane", () => {
    // Straight-down ray from (3, 10, -7) hits the y=2 plane at (3, -7).
    const hit = intersectPlaneY(
      { origin: [3, 10, -7], direction: [0, -1, 0] },
      2,
    );
    expect(hit).toBeDefined();
    expect(hit![0]).toBeCloseTo(3, 12);
    expect(hit![1]).toBeCloseTo(-7, 12);
  });

  it("misses when the ray points up or runs parallel", () => {
    expect(
      intersectPlaneY(
        { origin: [0, 5, 0], direction: [0, 1, 0] },
        0,
      ),
    ).toBeUndefined();
    expect(
      intersectPlaneY(
        { origin: [0, 5, 0], direction: [1, 0, 0] },
        0,
      ),
    ).toBeUndefined();
  });

  it("keeps a screen point anchored: zoomTowardsPoint fixes the ground under the pixel", () => {
    const w = 1280;
    const h = 800;
    const camera = new OrbitCamera({
      target: [4, 3, -9],
      distanceKm: 150,
      azimuthDeg: 25,
      elevationDeg: 40,
      aspect: w / h,
    });
    // Ground point under an off-center pixel on the target's plane.
    const ray = screenToRay(camera, 900, 600, w, h);
    const anchor = intersectPlaneY(ray, camera.target[1]);
    expect(anchor).toBeDefined();
    const ndcBefore = transformPoint(camera.viewProjectionMatrix(), [
      anchor![0],
      camera.target[1],
      anchor![1],
    ]);
    camera.zoomTowardsPoint(2.5, anchor![0], anchor![1]);
    const ndcAfter = transformPoint(camera.viewProjectionMatrix(), [
      anchor![0],
      camera.target[1],
      anchor![1],
    ]);
    expect(camera.distanceKm).toBeCloseTo(60, 9);
    // The anchored ground point stays under the same pixel.
    expect(ndcAfter[0]).toBeCloseTo(ndcBefore[0], 9);
    expect(ndcAfter[1]).toBeCloseTo(ndcBefore[1], 9);
  });
});
