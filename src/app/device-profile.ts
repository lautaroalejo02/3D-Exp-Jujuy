import type { MeshSize } from "../terrain/terrain-layer";
import type { TerrainQuality } from "../terrain/heightfield";

/**
 * Pure device-profile detection and render planning. All inputs are
 * injectable so the policy is unit-testable without a DOM or a GPU: the
 * caller reads matchMedia/screen/navigator and passes the values in.
 *
 * The profile is a one-time decision at startup (a reload changes it).
 * Mobile means "treat as a phone": a smaller terrain mesh and a lower DPR
 * cap so the GPU work per frame stays affordable on modest hardware.
 *
 * Adapter limits are not an input: the WebGPU spec guarantees every
 * adapter reports limits at or above the defaults (maxTextureDimension2D
 * >= 8192, maxStorageBufferBindingSize >= 128 MiB), so a "constrained
 * adapter" check can never fire.
 */

export type DeviceProfile = "mobile" | "desktop";

/** Screens whose smaller side is below this many CSS px are "small". */
export const SMALL_SIDE_MAX_CSS_PX = 900;
/**
 * deviceMemory (GB) at or below this marks a low-memory device. Roughly the
 * low end of Android phones; Chrome also buckets the value, so it only ever
 * hints.
 */
export const LOW_MEMORY_MAX_GB = 4;

export const MOBILE_DPR_MAX = 1.5;
export const DESKTOP_DPR_MAX = 2;

export interface DeviceProfileInputs {
  /** matchMedia("(pointer: coarse)").matches — primary input is touch. */
  readonly coarsePointer: boolean;
  /** Smaller screen side in CSS px (screen.width/screen.height). */
  readonly smallerSideCssPx: number;
  /** navigator.deviceMemory in GB when the browser exposes it. */
  readonly deviceMemoryGb?: number;
}

/**
 * Shadow-texture budget for the sun engine (src/sun/shadow-engine.ts):
 * texels in the shadow map aligned to the height grid, and ray-march
 * steps per texel. Desktop marches the full-res grid footprint; mobile
 * halves it so one recompute stays cheap on a phone.
 */
export interface ShadowPlan {
  readonly width: number;
  readonly height: number;
  readonly steps: number;
}

export function planShadows(profile: DeviceProfile): ShadowPlan {
  return profile === "desktop"
    ? { width: 1216, height: 1280, steps: 128 }
    : { width: 608, height: 640, steps: 64 };
}

/**
 * Coarse march used while the sun slider is dragged or the clock plays
 * (task decision): the same ~304x320 cells and 48 steps on every
 * device — cheap enough to recompute on input frames; a "final" update
 * at `planShadows` resolution refines the texture on release/pause.
 */
export const INTERACTIVE_SHADOW_PLAN: ShadowPlan = {
  width: 304,
  height: 320,
  steps: 48,
};

export interface RenderPlan {
  readonly profile: DeviceProfile;
  /** Mesh vertices for the terrain layer. */
  readonly mesh: MeshSize;
  /** Upper bound for the canvas surface DPR. */
  readonly dprMax: number;
  /** True when ?calidad=alta runs on a phone — show the warning. */
  readonly warnHighQuality: boolean;
  /** Shadow texture resolution + march steps for this profile. */
  readonly shadows: ShadowPlan;
}

/** `?perfil=movil|escritorio` — manual override, wins over detection. */
export function profileOverrideFromSearch(
  search: string,
): DeviceProfile | undefined {
  const value = new URLSearchParams(search).get("perfil");
  if (value === "movil") return "mobile";
  if (value === "escritorio") return "desktop";
  return undefined;
}

export function selectDeviceProfile(
  inputs: DeviceProfileInputs,
): DeviceProfile {
  const smallScreen = inputs.smallerSideCssPx < SMALL_SIDE_MAX_CSS_PX;
  const lowMemory =
    inputs.deviceMemoryGb !== undefined &&
    inputs.deviceMemoryGb <= LOW_MEMORY_MAX_GB;
  if (inputs.coarsePointer && smallScreen) return "mobile";
  if (smallScreen && lowMemory) return "mobile";
  return "desktop";
}

const half = (v: number): number => Math.max(2, Math.floor(v / 2));
const quarter = (v: number): number => Math.max(2, Math.floor(v / 4));

/**
 * Mesh and DPR for a (profile, quality) pair. `heightSpec` is the loaded
 * height grid: desktop keeps the long-standing half-grid mesh (608x640 on
 * the default 1216x1280 heights, 1216x1280 on full-res); mobile uses a
 * quarter of the grid — 304x320 default, 608x640 on ?calidad=alta.
 */
export function planRender(
  profile: DeviceProfile,
  quality: TerrainQuality,
  heightSpec: { readonly width: number; readonly height: number },
): RenderPlan {
  const shadows = planShadows(profile);
  if (profile === "desktop") {
    return {
      profile,
      mesh: { width: half(heightSpec.width), height: half(heightSpec.height) },
      dprMax: DESKTOP_DPR_MAX,
      warnHighQuality: false,
      shadows,
    };
  }
  return {
    profile,
    mesh: {
      width: quarter(heightSpec.width),
      height: quarter(heightSpec.height),
    },
    dprMax: MOBILE_DPR_MAX,
    warnHighQuality: quality === "high",
    shadows,
  };
}
