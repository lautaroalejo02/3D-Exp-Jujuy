import type { DeviceProfile } from "../../app/device-profile";

/**
 * Pure per-site lazy-load state machine for the detail layer — no GPU, no
 * timers, no DOM, so it is unit-testable.
 *
 * GPU resources for a patch may never be created inside update()/draw()
 * (the render-pass rule in src/app/layers.ts) nor at init (~28 MiB per site
 * the camera may never approach). The compromise: update() only DETECTS
 * that the camera entered the site's draw distance and transitions the
 * site to "requested"; a separately scheduled task performs the actual
 * "load-start" -> "loading" -> "ready" | "failed" transition while
 * creating the resources. "failed" is terminal — a site that could not
 * build its resources is disabled for the session and the base terrain
 * keeps rendering in its place.
 */
export type DetailSiteStatus =
  | "idle"
  | "requested"
  | "loading"
  | "ready"
  | "failed";

export type DetailSiteEvent =
  | "camera-in-range"
  | "load-start"
  | "load-ok"
  | "load-fail";

/**
 * Reduce one site status by an event. Out-of-order or repeated events are
 * no-ops, which keeps the caller simple: update() can fire
 * "camera-in-range" every frame and only the idle->requested edge acts.
 */
export function nextDetailSiteStatus(
  status: DetailSiteStatus,
  event: DetailSiteEvent,
): DetailSiteStatus {
  switch (event) {
    case "camera-in-range":
      return status === "idle" ? "requested" : status;
    case "load-start":
      return status === "requested" ? "loading" : status;
    case "load-ok":
      return status === "loading" ? "ready" : status;
    case "load-fail":
      return status === "loading" ? "failed" : status;
  }
}

/**
 * Proximity trigger: true while the ground-plane distance between the
 * camera eye and the patch center is under the site's draw distance. The
 * camera's height is ignored on purpose — a high camera looking down at
 * the patch still wants the imagery when horizontally close.
 */
export function cameraInDrawDistance(
  eyeX: number,
  eyeZ: number,
  centerX: number,
  centerZ: number,
  drawDistanceKm: number,
): boolean {
  return Math.hypot(eyeX - centerX, eyeZ - centerZ) < drawDistanceKm;
}

/**
 * Satellite upload divisor per device profile. Mobile uploads each patch
 * satellite at half resolution (each side / 2, so a quarter of the texels
 * — ~7 MiB with mips instead of ~28 MiB); desktop keeps the z14 pixels.
 */
export function detailSatelliteDivisor(profile: DeviceProfile): number {
  return profile === "mobile" ? 2 : 1;
}
