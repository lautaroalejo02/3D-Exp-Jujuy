/**
 * Orbit camera for the 3D scene. Pure math module — no DOM, no GPU — so it
 * is unit-testable and reusable from the headless snapshot renderer.
 *
 * World space (src/geo/world.ts): right-handed, +X east, +Y up, +Z south,
 * units are kilometers.
 *
 * Orbit state: a target point the camera looks at, a distance in km, an
 * azimuth and an elevation. Azimuth is measured like on a map: it is the
 * direction FROM the target TO the camera, clockwise from north — so
 * azimuth 0° puts the camera due south of the target looking north, 90°
 * puts it due west looking east, and 135° puts it south-east looking
 * north-west. Elevation is the angle of the camera above the horizon of
 * the target.
 *
 * Projection uses reversed-Z with an infinite far plane (column-major,
 * WebGPU NDC z in [0, 1]): near maps to z = 1 and the far plane sits at
 * infinity mapping to z = 0. Draws must use depth compare "greater" and
 * passes must clear depth to 0. Reversed-Z concentrates float precision
 * near the camera, avoiding z-fighting over the ~400 km scene span.
 */

export type Vec3 = readonly [number, number, number];

const DEG = Math.PI / 180;

export const MIN_ELEVATION_DEG = 10;
export const MAX_ELEVATION_DEG = 89;

export interface OrbitCameraOptions {
  /** Look-at point in world km. */
  readonly target?: Vec3;
  /** Camera distance from target, km. */
  readonly distanceKm?: number;
  /** Degrees, clockwise from north, direction target -> camera. */
  readonly azimuthDeg?: number;
  /** Degrees above the horizon, clamped to [10, 89]. */
  readonly elevationDeg?: number;
  /** Vertical field of view in degrees. */
  readonly fovDeg?: number;
  /** Viewport width / height. */
  readonly aspect?: number;
  /** Near plane distance in km (reversed-Z still needs a near plane). */
  readonly nearKm?: number;
  readonly minDistanceKm?: number;
  readonly maxDistanceKm?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) throw new Error("cannot normalize a zero-length vector");
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Column-major mat4 multiply: out = a * b. */
export function multiplyMat4(
  a: readonly number[],
  b: readonly number[],
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Transform a point by a column-major mat4 (w divide included). */
export function transformPoint(
  m: readonly number[],
  p: Vec3,
): readonly [number, number, number] {
  const x = (m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0);
  const y = (m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0);
  const z = (m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[14] ?? 0);
  const w = (m[3] ?? 0) * p[0] + (m[7] ?? 0) * p[1] + (m[11] ?? 0) * p[2] + (m[15] ?? 0);
  return [x / w, y / w, z / w];
}

export class OrbitCamera {
  target: Vec3;
  distanceKm: number;
  azimuthDeg: number;
  elevationDeg: number;
  fovDeg: number;
  aspect: number;
  nearKm: number;
  readonly minDistanceKm: number;
  readonly maxDistanceKm: number;

  constructor(options: OrbitCameraOptions = {}) {
    this.target = options.target ? [...options.target] : [0, 0, 0];
    this.distanceKm = options.distanceKm ?? 500;
    this.azimuthDeg = options.azimuthDeg ?? 0;
    this.elevationDeg = clamp(
      options.elevationDeg ?? 45,
      MIN_ELEVATION_DEG,
      MAX_ELEVATION_DEG,
    );
    this.fovDeg = options.fovDeg ?? 45;
    this.aspect = options.aspect ?? 1;
    this.nearKm = options.nearKm ?? 0.5;
    this.minDistanceKm = options.minDistanceKm ?? 10;
    this.maxDistanceKm = options.maxDistanceKm ?? 1500;
    this.distanceKm = clamp(
      this.distanceKm,
      this.minDistanceKm,
      this.maxDistanceKm,
    );
  }

  /** Camera position in world km, derived from the orbit state. */
  eye(): Vec3 {
    const az = this.azimuthDeg * DEG;
    const el = this.elevationDeg * DEG;
    const d = this.distanceKm;
    const t = this.target;
    return [
      t[0] + d * Math.cos(el) * Math.sin(az),
      t[1] + d * Math.sin(el),
      t[2] + d * Math.cos(el) * Math.cos(az),
    ];
  }

  /** Rotate around the target. Elevation stays within [10°, 89°]. */
  orbit(dAzimuthDeg: number, dElevationDeg: number): void {
    this.azimuthDeg = this.azimuthDeg + dAzimuthDeg;
    this.elevationDeg = clamp(
      this.elevationDeg + dElevationDeg,
      MIN_ELEVATION_DEG,
      MAX_ELEVATION_DEG,
    );
  }

  /**
   * Move the target on the ground plane: `dxKm` along camera-right and
   * `dyKm` along the camera's ground-projected forward (positive dy pans
   * the view "up-screen"). The eye follows, keeping the same orbit angles.
   */
  pan(dxKm: number, dyKm: number): void {
    const az = this.azimuthDeg * DEG;
    // Ground-projected forward: from the eye towards the target, flattened.
    const forward: Vec3 = normalize3([-Math.sin(az), 0, -Math.cos(az)]);
    const right = cross3(forward, [0, 1, 0]);
    this.target = [
      this.target[0] + right[0] * dxKm + forward[0] * dyKm,
      this.target[1],
      this.target[2] + right[2] * dxKm + forward[2] * dyKm,
    ];
  }

  /** Multiply the view size by `factor`: >1 zooms in, <1 zooms out. */
  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.distanceKm = clamp(
      this.distanceKm / factor,
      this.minDistanceKm,
      this.maxDistanceKm,
    );
  }

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
  }

  /** Column-major lookAt view matrix (world -> view, camera looks -Z). */
  viewMatrix(): number[] {
    const e = this.eye();
    const forward = normalize3([
      this.target[0] - e[0],
      this.target[1] - e[1],
      this.target[2] - e[2],
    ]);
    const right = normalize3(cross3(forward, [0, 1, 0]));
    const up = cross3(right, forward);
    return [
      right[0], up[0], -forward[0], 0,
      right[1], up[1], -forward[1], 0,
      right[2], up[2], -forward[2], 0,
      -dot3(right, e), -dot3(up, e), dot3(forward, e), 1,
    ];
  }

  /**
   * Reversed-Z perspective projection with an infinite far plane:
   * clip = (fx, fy, near, -z_view), so ndc z = near / -z_view. A point at
   * the near plane maps to z = 1, infinity maps to z = 0. Pair with depth
   * compare "greater" and clearDepth 0.
   */
  projectionMatrix(): number[] {
    const f = 1 / Math.tan((this.fovDeg * DEG) / 2);
    return [
      f / this.aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, 0, -1,
      0, 0, this.nearKm, 0,
    ];
  }

  /** Column-major view * projection ready for a `mat4x4f` uniform. */
  viewProjectionMatrix(): number[] {
    return multiplyMat4(this.projectionMatrix(), this.viewMatrix());
  }
}
