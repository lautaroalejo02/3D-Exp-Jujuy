import type { Vec3 } from "../../camera/camera";
import { intersectHeightfield } from "../../picking/ray";
import type { Heightfield } from "../../terrain/heightfield";

/**
 * Pure math for the DOM place markers: world -> screen projection,
 * approximate terrain occlusion and label decluttering. No DOM, no GPU —
 * the same functions run in the browser layer and in the headless
 * snapshot (scripts/render-snapshot.ts), so both agree on which markers
 * are visible.
 *
 * World space is kilometers (src/geo/world.ts); screen space is whatever
 * units the caller passes as the viewport (CSS px in the app, physical px
 * in the snapshot).
 */

/**
 * Extra anchor height over the surface, in meters (unexaggerated): keeps
 * the marker from z-fighting the slope it sits on and gives the occlusion
 * test a consistent target.
 */
export const MARKER_LIFT_METERS = 60;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Project a world-space point through the camera's view-projection
 * matrix into screen coordinates. Undefined when the point is behind the
 * camera (clip w <= 0); points in front are projected even when they
 * land outside the viewport — the caller bounds-checks.
 */
export function projectToScreen(
  viewProjection: readonly number[],
  world: Vec3,
  viewport: readonly [number, number],
): ScreenPoint | undefined {
  const [x, y, z] = world;
  const cx =
    (viewProjection[0] ?? 0) * x +
    (viewProjection[4] ?? 0) * y +
    (viewProjection[8] ?? 0) * z +
    (viewProjection[12] ?? 0);
  const cy =
    (viewProjection[1] ?? 0) * x +
    (viewProjection[5] ?? 0) * y +
    (viewProjection[9] ?? 0) * z +
    (viewProjection[13] ?? 0);
  const cw =
    (viewProjection[3] ?? 0) * x +
    (viewProjection[7] ?? 0) * y +
    (viewProjection[11] ?? 0) * z +
    (viewProjection[15] ?? 0);
  if (!(cw > 0)) return undefined;
  return {
    x: ((cx / cw + 1) / 2) * viewport[0],
    y: ((1 - cy / cw) / 2) * viewport[1],
  };
}

export interface OcclusionOptions {
  /**
   * Overrides the surface the ray marches, in meters at grid coords —
   * the same option intersectHeightfield takes. The app passes the drawn
   * surface (base DEM geomorphed with the covering detail patches) so a
   * patch that hides a marker occludes it too.
   */
  readonly surfaceAt?: (i: number, j: number) => number;
  /**
   * How far (meters) the overridden surface may exceed the heightfield's
   * [min, max]; widens the clip box. Ignored without surfaceAt.
   */
  readonly surfaceMarginMeters?: number;
  /**
   * How much earlier than the marker a hit must land to count as
   * occlusion, in km. The marker anchors ON the surface, so the ray
   * reaches it right at the surface — the tolerance keeps that expected
   * hit (and bilinear-vs-mesh noise) from hiding the marker. Defaults to
   * max(50 m, 2% of the camera-marker distance).
   */
  readonly toleranceKm?: number;
}

/**
 * Approximate terrain occlusion: true when a ray from `eye` to
 * `markerWorld` hits the heightfield (or the overridden drawn surface)
 * before reaching the marker. Marched on the CPU with the same
 * intersectHeightfield the terrain picking uses.
 */
export function isOccluded(
  heightfield: Heightfield,
  eye: Vec3,
  markerWorld: Vec3,
  verticalExaggeration: number,
  opts: OcclusionOptions = {},
): boolean {
  const dx = markerWorld[0] - eye[0];
  const dy = markerWorld[1] - eye[1];
  const dz = markerWorld[2] - eye[2];
  const markerDist = Math.hypot(dx, dy, dz);
  if (!(markerDist > 0)) return false;
  const hit = intersectHeightfield(
    {
      origin: eye,
      direction: [dx / markerDist, dy / markerDist, dz / markerDist],
    },
    heightfield,
    verticalExaggeration,
    {
      ...(opts.surfaceAt !== undefined
        ? {
            surfaceAt: opts.surfaceAt,
            surfaceMarginMeters: opts.surfaceMarginMeters ?? 0,
          }
        : {}),
    },
  );
  if (!hit) return false;
  const hx = hit.world[0] - eye[0];
  const hy = hit.world[1] - eye[1];
  const hz = hit.world[2] - eye[2];
  const hitDist = Math.hypot(hx, hy, hz);
  const toleranceKm =
    opts.toleranceKm ?? Math.max(0.05, markerDist * 0.02);
  return hitDist < markerDist - toleranceKm;
}

export interface LabelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Greedy label declutter in screen space: keeps the labels (in input
 * order) whose rect does not overlap any already-kept rect, with `gapPx`
 * of breathing room counted as overlap. Dots are unaffected — the caller
 * only hides the label element.
 */
export function declutterLabels(
  rects: readonly LabelRect[],
  gapPx = 4,
): boolean[] {
  const kept: LabelRect[] = [];
  return rects.map((r) => {
    const overlaps = kept.some(
      (k) =>
        r.x < k.x + k.width + gapPx &&
        k.x < r.x + r.width + gapPx &&
        r.y < k.y + k.height + gapPx &&
        k.y < r.y + r.height + gapPx,
    );
    if (overlaps) return false;
    kept.push(r);
    return true;
  });
}
