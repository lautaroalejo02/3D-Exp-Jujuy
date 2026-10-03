/**
 * Smooth camera fly-to for "tap a place in the list". The easing and
 * interpolation are pure (unit tested); `flyTo` is the thin driver that
 * steps the camera once per animation frame and asks the dirty tracker
 * for a repaint — render-on-demand stays on demand: frames are only
 * requested while the animation is alive.
 */
import type { OrbitCamera, Vec3 } from "./camera";

/** A snapshot of everything fly-to animates. */
export interface CameraPose {
  readonly target: Vec3;
  readonly distanceKm: number;
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
}

/** Classic ease-in-out cubic: slow start, fast middle, soft landing. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Angle lerp along the SHORTEST arc: 350° -> 10° goes +20°, not -340°.
 * The result may pass through 360/0 mid-flight — OrbitCamera accepts
 * any azimuth value.
 */
export function lerpAngleDeg(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Component-wise pose interpolation; azimuth takes the shortest arc. */
export function interpolatePose(
  from: CameraPose,
  to: CameraPose,
  t: number,
): CameraPose {
  return {
    target: [
      lerp(from.target[0], to.target[0], t),
      lerp(from.target[1], to.target[1], t),
      lerp(from.target[2], to.target[2], t),
    ],
    distanceKm: lerp(from.distanceKm, to.distanceKm, t),
    azimuthDeg: lerpAngleDeg(from.azimuthDeg, to.azimuthDeg, t),
    elevationDeg: lerp(from.elevationDeg, to.elevationDeg, t),
  };
}

/** The camera's current orbit state as a pose. */
export function cameraPoseOf(camera: OrbitCamera): CameraPose {
  return {
    target: [...camera.target],
    distanceKm: camera.distanceKm,
    azimuthDeg: camera.azimuthDeg,
    elevationDeg: camera.elevationDeg,
  };
}

function applyPose(camera: OrbitCamera, pose: CameraPose): void {
  camera.target = [...pose.target];
  camera.distanceKm = pose.distanceKm;
  camera.azimuthDeg = pose.azimuthDeg;
  camera.elevationDeg = pose.elevationDeg;
}

export interface FlyToOptions {
  /** Animation length in ms; default 1200. */
  readonly durationMs?: number;
  /** Dirty-tracker poke — called once per animated step. */
  readonly requestFrame: () => void;
  /** Clock override (default performance.now) — used by tests. */
  readonly now?: () => number;
  /** Scheduler override (default requestAnimationFrame) — used by tests. */
  readonly schedule?: (cb: () => void) => void;
}

export interface FlyToHandle {
  /** Stop the animation where it is; later steps become no-ops. */
  cancel(): void;
}

/**
 * Animate `camera` from its current pose to `to`. One handle is enough —
 * the caller cancels a previous flight before starting the next, and user
 * input cancels through the same handle.
 */
export function flyTo(
  camera: OrbitCamera,
  to: CameraPose,
  opts: FlyToOptions,
): FlyToHandle {
  const from = cameraPoseOf(camera);
  const duration = Math.max(1, opts.durationMs ?? 1200);
  const now = opts.now ?? (() => performance.now());
  const schedule =
    opts.schedule ??
    ((cb: () => void) => {
      requestAnimationFrame(cb);
    });
  const startMs = now();
  let cancelled = false;

  const step = (): void => {
    if (cancelled) return;
    const t = Math.min(1, (now() - startMs) / duration);
    applyPose(camera, interpolatePose(from, to, easeInOutCubic(t)));
    opts.requestFrame();
    if (t < 1) schedule(step);
  };
  schedule(step);

  return {
    cancel() {
      cancelled = true;
    },
  };
}
