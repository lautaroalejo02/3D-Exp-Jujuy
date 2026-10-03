import type { DeviceProfile } from "../../app/device-profile";
import { textureBytesWithMips } from "../../render/gpu-memory";
import { detailSatelliteDivisor } from "./detail-load";

/**
 * Pure selection/budget/eviction policy for the detail layer
 * (detail-layer.ts) — no GPU, no DOM, no timers, so it is unit-testable.
 * The layer feeds camera state in and applies the returned id sets; all
 * the "which patches get GPU resources" decisions live here.
 *
 * THE BUDGET: a patch costs ~28 MiB of texture + storage on desktop
 * (~7 MiB on mobile, satellite uploaded at half resolution). With 29
 * sites the patches cannot all stay live, so at most
 * DETAIL_LIVE_PATCH_BUDGET[profile] residents hold GPU resources (or a
 * decoded payload) at once. The largest profile budget is also the size
 * of the patchRects/patchCenters uniform arrays (MAX_DETAIL_PATCHES in
 * src/terrain/detail-grids.ts — detail-budget.test.ts pins the equality).
 */

/** Live detail patches allowed at once, per device profile. */
export const DETAIL_LIVE_PATCH_BUDGET: Record<DeviceProfile, number> = {
  mobile: 3,
  desktop: 8,
};

/** Live-patch budget for a device profile. */
export function detailLivePatchBudget(profile: DeviceProfile): number {
  return DETAIL_LIVE_PATCH_BUDGET[profile];
}

/** One site's selection inputs for a frame. */
export interface DetailSiteCandidate {
  readonly id: string;
  /** Ground-plane distance from the camera eye to the patch center, km. */
  readonly distanceKm: number;
  /** True when the patch's bounding box intersects the camera frustum. */
  readonly inFrustum: boolean;
}

/**
 * The sites that should hold GPU resources this frame: candidates inside
 * their draw distance (the caller filters that — the distance threshold
 * is per-site) AND inside the frustum, nearest first, capped at
 * `maxLive`. In-range-but-off-screen sites stay cold: no fetch, no GPU —
 * the base terrain simply keeps showing there.
 */
export function selectLiveDetailPatches(
  candidates: readonly DetailSiteCandidate[],
  maxLive: number,
): readonly string[] {
  return candidates
    .filter((c) => c.inFrustum)
    .sort(
      // Distance asc; the id makes ties deterministic so both the shader
      // arbitration order and tests stay stable.
      (a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, maxLive))
    .map((c) => c.id);
}

/** A site currently holding resources (GPU buffers and/or payload). */
export interface DetailPatchResident {
  readonly id: string;
  /** Last measured ground-plane camera distance to the patch center. */
  readonly distanceKm: number;
  /** Update tick when the site was last selected (drives the LRU leg). */
  readonly lastUsed: number;
  /** True while the site is in the current selection — never a victim. */
  readonly wanted: boolean;
}

/**
 * Eviction victims to free `excess` slots: only non-wanted residents are
 * eligible (a wanted site is by definition inside the budget). The
 * farthest site goes first — LRU por distancia — with `lastUsed` as the
 * tiebreak so the resident unused for longest drops before a
 * same-distance recent one. Deterministic order, deterministic victims.
 */
export function chooseDetailEvictions(
  residents: readonly DetailPatchResident[],
  excess: number,
): readonly string[] {
  if (excess <= 0) return [];
  return residents
    .filter((r) => !r.wanted)
    .sort(
      (a, b) =>
        b.distanceKm - a.distanceKm ||
        a.lastUsed - b.lastUsed ||
        a.id.localeCompare(b.id),
    )
    .slice(0, excess)
    .map((r) => r.id);
}

/**
 * Conservative frustum test for one patch: the patch's ground rect
 * (center ± half size on the X/Z plane, km) extruded between its lowest
 * and highest DRAWN elevation (already exaggerated, km) forms a box; the
 * box is outside only when every one of its 8 corners fails the same
 * clip plane. Corner-outside/corner-inside cases are handled — a patch
 * clipped by a frustum edge still counts as visible.
 *
 * The view-projection is column-major (OrbitCamera.viewProjectionMatrix,
 * reversed-Z infinite far, NDC z in [0, w]). Point p is inside the clip
 * volume iff 0 <= z <= w and -w <= x,y <= w, i.e. it satisfies all six
 * plane rows: w+x, w-x, w+y, w-y, z, w-z.
 */
export function detailPatchInFrustum(
  viewProjection: readonly number[],
  centerX: number,
  centerZ: number,
  halfX: number,
  halfZ: number,
  yMinKm: number,
  yMaxKm: number,
): boolean {
  type Vec4 = [number, number, number, number];
  type Vec3 = [number, number, number];
  const m = viewProjection;
  const row = (r: number): Vec4 => [
    m[r] ?? 0,
    m[4 + r] ?? 0,
    m[8 + r] ?? 0,
    m[12 + r] ?? 0,
  ];
  const add = (a: Vec4, b: Vec4): Vec4 => [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
    a[3] + b[3],
  ];
  const sub = (a: Vec4, b: Vec4): Vec4 => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
    a[3] - b[3],
  ];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const planes: Vec4[] = [
    add(r3, r0),
    sub(r3, r0),
    add(r3, r1),
    sub(r3, r1),
    r2,
    sub(r3, r2),
  ];
  const corners: Vec3[] = [];
  for (const x of [centerX - halfX, centerX + halfX]) {
    for (const y of [yMinKm, yMaxKm]) {
      for (const z of [centerZ - halfZ, centerZ + halfZ]) {
        corners.push([x, y, z]);
      }
    }
  }
  for (const plane of planes) {
    let anyInside = false;
    for (const c of corners) {
      const d =
        plane[0] * c[0] + plane[1] * c[1] + plane[2] * c[2] + plane[3];
      if (d >= 0) {
        anyInside = true;
        break;
      }
    }
    if (!anyInside) return false;
  }
  return true;
}

/**
 * GPU bytes one resident patch costs on `profile`: the satellite texture
 * with its full mip chain — uploaded at 1/divisor resolution
 * (detailSatelliteDivisor) — plus the float32 height storage. Same
 * accounting the layer's getGpuMemoryReport uses, so the peak estimate
 * below and the live report agree.
 */
export function detailPatchGpuBytes(
  satellitePixels: readonly [number, number],
  heightCellCount: number,
  profile: DeviceProfile,
): number {
  const divisor = detailSatelliteDivisor(profile);
  const width = Math.max(1, Math.floor(satellitePixels[0] / divisor));
  const height = Math.max(1, Math.floor(satellitePixels[1] / divisor));
  return textureBytesWithMips(width, height, 4) + heightCellCount * 4;
}

/**
 * Worst-case detail-patch GPU memory for `profile`: the live set can hold
 * at most DETAIL_LIVE_PATCH_BUDGET[profile] residents, so the peak is the
 * sum of the budget's largest per-site footprints. Inputs are per-site
 * footprints (detailPatchGpuBytes) — pure, so the snapshot script and
 * tests share it.
 */
export function detailBudgetPeakBytes(
  footprints: readonly number[],
  profile: DeviceProfile,
): number {
  return [...footprints]
    .sort((a, b) => b - a)
    .slice(0, detailLivePatchBudget(profile))
    .reduce((sum, bytes) => sum + bytes, 0);
}
