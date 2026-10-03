import type { PickHit } from "../app/layers";
import type { OrbitCamera, Vec3 } from "../camera/camera";
import { transformPoint } from "../camera/camera";
import {
  elevationToWorldY,
  gridToLonLat,
  gridToWorld,
  metersPerGridCell,
  worldToGrid,
} from "../geo";
import type { Heightfield } from "../terrain/heightfield";

/**
 * CPU picking: turns a screen tap into a world-space ray, then marches the
 * ray through the heightfield's bounding box looking for the first surface
 * crossing. Pure math — no DOM, no GPU — so it is fully unit-testable and
 * reusable from the headless snapshot renderer.
 *
 * World space is kilometers (src/geo/world.ts): +X east, +Y up, +Z south,
 * Y = elevationMeters / 1000 * verticalExaggeration. Heights always come
 * from Heightfield bilinear sampling in meters and are converted through
 * src/geo helpers — the world mapping is never re-derived here.
 */
export interface Ray {
  /** World-space point on the ray (the camera eye), in km. */
  readonly origin: Vec3;
  /** Normalized world-space direction. */
  readonly direction: Vec3;
}

export interface IntersectOptions {
  /**
   * March step as a fraction of one grid cell of horizontal travel.
   * Smaller steps catch narrower ridges; 0.5 keeps ~2 samples per cell.
   */
  readonly stepCells?: number;
  /** Horizontal bisection accuracy in meters. Default 1. */
  readonly refineMeters?: number;
  /** Safety cap on march steps before giving up. Default 20000. */
  readonly maxSteps?: number;
}

/**
 * Inverse of a column-major mat4 (adjugate method, same layout as
 * multiplyMat4/transformPoint in camera.ts). Undefined when singular.
 */
function invertMat4(m: readonly number[]): number[] | undefined {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return undefined;
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

/**
 * World-space pick ray through the pixel (x, y) of a viewport that is
 * `viewportCssW` x `viewportCssH` CSS pixels. Pixel (0,0) is top-left.
 *
 * The camera uses a reversed-Z projection with an infinite far plane: NDC
 * z = 1 is the near plane and z -> 0 is infinity, so the ray is unprojected
 * at two finite depths (z = 1 and z = 0.5) instead of near/far.
 */
export function screenToRay(
  camera: OrbitCamera,
  x: number,
  y: number,
  viewportCssW: number,
  viewportCssH: number,
): Ray {
  if (!(viewportCssW > 0) || !(viewportCssH > 0)) {
    throw new Error(
      `screenToRay needs a positive viewport, got ${viewportCssW}x${viewportCssH}`,
    );
  }
  const nx = (x / viewportCssW) * 2 - 1;
  const ny = 1 - (y / viewportCssH) * 2;
  const inv = invertMat4(camera.viewProjectionMatrix());
  if (!inv) throw new Error("camera view-projection is singular");
  // Near plane (z=1) and a mid-depth point; both unproject to finite
  // world positions because z stays > 0 (z = 0 is the plane at infinity).
  const a = transformPoint(inv, [nx, ny, 1]);
  const b = transformPoint(inv, [nx, ny, 0.5]);
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 0)) throw new Error("screenToRay produced a degenerate ray");
  return {
    origin: camera.eye(),
    direction: [d[0] / len, d[1] / len, d[2] / len],
  };
}

/**
 * XZ point where a ray crosses the horizontal plane `y = planeY`, or
 * `undefined` when the ray is parallel to the plane or crosses it behind
 * the camera. Camera input uses this to keep the ground point under the
 * pointer anchored during pan and zoom-toward-cursor gestures.
 */
export function intersectPlaneY(
  ray: Ray,
  planeY: number,
): readonly [number, number] | undefined {
  const dy = ray.direction[1];
  if (Math.abs(dy) < 1e-9) return undefined;
  const t = (planeY - ray.origin[1]) / dy;
  if (!(t > 0) || !Number.isFinite(t)) return undefined;
  return [ray.origin[0] + ray.direction[0] * t, ray.origin[2] + ray.direction[2] * t];
}

/** Entry/exit distances where a ray crosses an axis-aligned box; undefined on miss. */
function clipRayToBox(
  ray: Ray,
  min: Vec3,
  max: Vec3,
): readonly [number, number] | undefined {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = ray.origin[axis]!;
    const d = ray.direction[axis]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min[axis]! || o > max[axis]!) return undefined;
      continue;
    }
    const ta = (min[axis]! - o) / d;
    const tb = (max[axis]! - o) / d;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t1 < t0 || t1 < 0) return undefined;
  return [Math.max(t0, 0), t1];
}

/**
 * First intersection of a world-space ray with the heightfield surface, or
 * `undefined` when the ray misses (sky, under the terrain, past the cap).
 *
 * The ray is clipped to the grid's world bounding box (x/z extent plus the
 * exaggerated min/max heights), then marched in steps of about half a grid
 * cell of horizontal travel. A sign change of (rayY - terrainY) brackets a
 * crossing; bisection refines it to under `refineMeters` on the ray's
 * dominant axis.
 */
export function intersectHeightfield(
  ray: Ray,
  heightfield: Heightfield,
  verticalExaggeration: number,
  opts: IntersectOptions = {},
): PickHit | undefined {
  const spec = heightfield.spec;
  const stepCells = opts.stepCells ?? 0.5;
  const refineKm = (opts.refineMeters ?? 1) / 1000;
  const maxSteps = opts.maxSteps ?? 20000;
  if (!(verticalExaggeration > 0) || !(stepCells > 0)) {
    throw new Error(
      `intersectHeightfield needs positive exaggeration and step, got ${verticalExaggeration} / ${stepCells}`,
    );
  }

  const cellKm = metersPerGridCell(spec) / 1000;
  const [x0, , z0] = gridToWorld(spec, -0.5, -0.5);
  const [x1, , z1] = gridToWorld(spec, spec.width - 0.5, spec.height - 0.5);
  const clip = clipRayToBox(
    ray,
    [x0, elevationToWorldY(heightfield.min, verticalExaggeration), z0],
    [x1, elevationToWorldY(heightfield.max, verticalExaggeration), z1],
  );
  if (!clip) return undefined;
  const [tEnter, tExit] = clip;

  /** Signed distance above the exaggerated surface at parameter t (km). */
  const aboveSurface = (t: number): number => {
    const x = ray.origin[0] + ray.direction[0] * t;
    const y = ray.origin[1] + ray.direction[1] * t;
    const z = ray.origin[2] + ray.direction[2] * t;
    const [i, j] = worldToGrid(spec, x, z);
    const meters = heightfield.heightAtGrid(i, j);
    return y - elevationToWorldY(meters, verticalExaggeration);
  };

  const horizontalLen = Math.hypot(ray.direction[0], ray.direction[2]);
  // Horizontal travel per step must stay under ~half a cell so no ridge or
  // valley is skipped. For a (near-)vertical ray horizontal travel is ~0
  // regardless of step, so the whole span is a safe single step.
  const stepT =
    horizontalLen > 1e-9
      ? (cellKm * stepCells) / horizontalLen
      : tExit - tEnter;
  // Bisection stops when the bracket is under refineKm on the dominant
  // axis: horizontal for grazing rays, vertical for steep ones.
  const dominantAxis = Math.max(horizontalLen, Math.abs(ray.direction[1]));

  const hitAt = (t: number): PickHit => {
    const x = ray.origin[0] + ray.direction[0] * t;
    const z = ray.origin[2] + ray.direction[2] * t;
    const [i, j] = worldToGrid(spec, x, z);
    const elevationMeters = heightfield.heightAtGrid(i, j);
    return {
      world: [x, elevationToWorldY(elevationMeters, verticalExaggeration), z],
      grid: [i, j],
      lonLat: gridToLonLat(spec, i, j),
      elevationMeters,
    };
  };

  let prevT = tEnter;
  let prevF = aboveSurface(tEnter);
  if (prevF === 0) return hitAt(tEnter);
  for (let steps = 1; steps <= maxSteps; steps++) {
    const t = Math.min(tEnter + steps * stepT, tExit);
    const f = aboveSurface(t);
    const crossed = (prevF > 0 && f <= 0) || (prevF < 0 && f >= 0);
    if (f === 0) return hitAt(t);
    if (crossed) {
      let lo = prevT;
      let hi = t;
      let flo = prevF;
      for (let iter = 0; iter < 64; iter++) {
        if ((hi - lo) * dominantAxis <= refineKm) break;
        const mid = (lo + hi) / 2;
        const fm = aboveSurface(mid);
        if (fm === 0) {
          lo = hi = mid;
          break;
        }
        if (fm > 0 === flo > 0) {
          lo = mid;
          flo = fm;
        } else {
          hi = mid;
        }
      }
      return hitAt((lo + hi) / 2);
    }
    if (t >= tExit) return undefined;
    prevT = t;
    prevF = f;
  }
  return undefined;
}
