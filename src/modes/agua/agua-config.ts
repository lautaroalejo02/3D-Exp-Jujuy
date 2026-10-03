/**
 * Tunables for the Agua mode (rain particles + basin overlay), kept in
 * one place so the device-profile budgets and the shader constants can
 * be reviewed together. CPU side only — the WGSL mirrors get their
 * values through uniforms.
 */
import type { DeviceProfile } from "../../app/device-profile";

/**
 * Live rain-particle budget per device profile. The "Intensidad" slider
 * scales the live count between 10% and 100% of this budget — the full
 * allocation exists either way, only the active slice changes.
 */
export const RAIN_PARTICLE_BUDGET: Readonly<
  Record<DeviceProfile, number>
> = {
  mobile: 8_000,
  desktop: 32_000,
};

/** Compute dispatch workgroup size (rain-sim.wgsl @workgroup_size). */
export const RAIN_WORKGROUP_SIZE = 64;

/** Particle lifetime in seconds; a respawned particle starts at 0. */
export const RAIN_LIFE_SECONDS = 90;
/** Flow-grid cells per second at acc = 1 (headwaters crawl). */
export const RAIN_SPEED_BASE = 1.2;
/** Extra cells/s per log2(upstream cells) — rivers run visibly faster. */
export const RAIN_SPEED_GAIN = 0.28;
/** Trail length behind the head, in flow-grid cells. */
export const RAIN_TRAIL_CELLS = 1.6;
/**
 * Droplet core width in CSS pixels — the layer multiplies by the canvas
 * device-pixel-ratio, so a phone at DPR 3 still gets a ~2.5 CSS px dot
 * instead of an invisible sub-pixel streak.
 */
export const RAIN_WIDTH_CSS_PX = 2.5;
/** Quad span as a multiple of the core width — room for the glow. */
export const RAIN_HALO_SCALE = 2.0;
/** Overall droplet alpha scale — additive blending saturates fast. */
export const RAIN_ALPHA = 0.5;
/**
 * Seconds a particle that reached a sink (edge outlet or an endorheic
 * laguna/salar bottom) takes to fade out in place before respawning.
 * Must be <= the draw shader's 6 s fade-out window.
 */
export const RAIN_SINK_FADE_SECONDS = 4;
/** Draw lift above the terrain surface, in km (z-fight margin). */
export const RAIN_LIFT_KM = 0.03;

/** Basin overlay lift above the terrain surface, in km. */
export const BASINS_LIFT_KM = 0.02;
/** Basin tint alpha over the satellite image. */
export const BASINS_OPACITY = 0.4;

/**
 * Main-basin colors (Okabe-Ito, colorblind-safe), index 0 reserved for
 * "otras". Mirrored by the basins.wgsl palette uniform and the sheet's
 * legend swatches.
 */
export const BASIN_COLORS: readonly (readonly [number, number, number])[] =
  [
    [0.45, 0.5, 0.55], // 0: otras — muted grey-blue
    [0.34, 0.71, 0.91], // 1
    [0.9, 0.62, 0.0], // 2
    [0.0, 0.62, 0.45], // 3
    [0.8, 0.47, 0.65], // 4
    [0.0, 0.45, 0.7], // 5
    [0.94, 0.89, 0.26], // 6
    [0.84, 0.37, 0.0], // 7
    [0.47, 0.71, 0.24], // 8
  ];

/** River-emphasis color inside the basin overlay (acc >= riverAcc). */
export const RIVER_COLOR: readonly [number, number, number] = [
  0.31, 0.76, 0.97,
];
export const RIVER_ALPHA = 0.85;
