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
 * Radius around a marker's projected dot that a canvas tap may land in
 * and still count as a marker tap, in CSS px. Generous for touch (the
 * dot itself is 10 px) but small enough that nearby terrain taps keep
 * picking the terrain.
 */
export const MARKER_TAP_RADIUS_PX = 22;

/**
 * Screen distance (CSS px) under which markers merge into one cluster
 * dot. Roughly two dot diameters: closer than this, two markers overlap
 * visually and stop being separate tap targets.
 */
export const MARKER_CLUSTER_PX = 22;

/**
 * A group of markers closer than MARKER_CLUSTER_PX on screen, drawn as a
 * single cluster dot. `members` are indices into the input points array;
 * `x`/`y` is the cluster center (member mean) in the same units.
 */
export interface MarkerCluster {
  readonly members: readonly number[];
  readonly x: number;
  readonly y: number;
}

/**
 * Greedy screen-space clustering of the projected marker positions:
 * two points nearer than `thresholdPx` belong to the same cluster and
 * the merge is transitive (A near B, B near C -> one cluster even when
 * A and C are farther apart). `undefined` points (off-screen, occluded,
 * hidden or the selected marker — the caller decides) never cluster.
 * Singletons come back as one-member clusters so the caller can treat
 * every marker uniformly. Order of the input is preserved per cluster.
 */
export function clusterMarkers(
  points: readonly (ScreenPoint | undefined)[],
  thresholdPx = MARKER_CLUSTER_PX,
): MarkerCluster[] {
  // Union-find over the indices that have a point.
  const indices: number[] = [];
  for (const [i, p] of points.entries()) {
    if (p !== undefined) indices.push(i);
  }
  const parent = new Map<number, number>(indices.map((i) => [i, i]));
  const root = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression keeps later unions near O(1).
    while (parent.get(i) !== i) {
      const next = parent.get(i)!;
      parent.set(i, r);
      i = next;
    }
    return r;
  };
  const t2 = thresholdPx * thresholdPx;
  for (let a = 0; a < indices.length; a++) {
    const pa = points[indices[a]!]!;
    for (let b = a + 1; b < indices.length; b++) {
      const pb = points[indices[b]!]!;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      if (dx * dx + dy * dy < t2) {
        const ra = root(indices[a]!);
        const rb = root(indices[b]!);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of indices) {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].map((members) => {
    let x = 0;
    let y = 0;
    for (const i of members) {
      x += points[i]!.x;
      y += points[i]!.y;
    }
    return { members, x: x / members.length, y: y / members.length };
  });
}

/**
 * Camera distance a cluster tap should fly to: enough zoom-in for the
 * cluster's current screen spread to grow to `targetSpreadPx`. Screen
 * spread scales inversely with camera distance, so
 * d_new = d_now * spread / targetSpread — never wider than the current
 * distance (a cluster tap only zooms in) and never closer than `minKm`.
 */
export function clusterZoomDistanceKm(
  currentDistanceKm: number,
  spreadPx: number,
  targetSpreadPx = MARKER_CLUSTER_PX * 3,
  minKm = 12,
): number {
  if (!(currentDistanceKm > 0)) return minKm;
  if (!(spreadPx > 0)) return currentDistanceKm;
  const wanted = (currentDistanceKm * spreadPx) / Math.max(1, targetSpreadPx);
  return Math.min(currentDistanceKm, Math.max(minKm, wanted));
}

/**
 * Index of the candidate screen point nearest to `tap`, or undefined
 * when none lies within `radiusPx`. `undefined` entries are markers that
 * are off-screen, occluded or hidden — they are never tapped. Runs on
 * the same projected positions the marker layer renders, so the tap
 * target matches what the user sees.
 */
export function nearestMarker(
  points: readonly (ScreenPoint | undefined)[],
  tap: ScreenPoint,
  radiusPx = MARKER_TAP_RADIUS_PX,
): number | undefined {
  let best: number | undefined;
  let bestD2 = radiusPx * radiusPx;
  for (const [index, p] of points.entries()) {
    if (p === undefined) continue;
    const dx = p.x - tap.x;
    const dy = p.y - tap.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      best = index;
      bestD2 = d2;
    }
  }
  return best;
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
