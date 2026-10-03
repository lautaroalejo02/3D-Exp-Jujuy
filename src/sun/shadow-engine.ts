import {
  compute,
  texture,
  type Compute,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  type Texture,
} from "vgpu";

import type { ShadowPlan } from "../app/device-profile";
import type { TerrainGridUniforms } from "../terrain/terrain-uniforms";
import { angularDistanceDeg } from "./solar";

/**
 * Shadow-texture engine: owns the storage-written visibility texture and
 * the compute pass that fills it (src/sun/shadow.wgsl). Created once at
 * layer-init time; `update()` re-dispatches the pass ONLY when the sun
 * direction or the vertical exaggeration actually changed — with the sun
 * mode's play button that is at most once per frame, and zero cost while
 * anything idles.
 *
 * Quality: `plan` is the device-profile resolution; `interactive` is the
 * coarser march (304x320 cells, 48 steps) used while the time slider is
 * dragged or the clock plays. Both write into the SAME texture — the
 * interactive dispatch covers it with texel blocks, so no sampler or
 * binding ever changes; a "final" update later refines it in place.
 * Dedupe: a request is skipped when the texture already holds content at
 * that quality or better AND the sun moved less than 0.25 degrees (and
 * the exaggeration is unchanged).
 *
 * Timing: `compute.dispatch` submits its own pass outside any frame, so
 * vgpu's frame-pass `timer` cannot bracket it. The recompute is measured
 * CPU-side instead: dispatch time to `queue.onSubmittedWorkDone()`, which
 * covers the GPU execution. A `timestamp-query` device feature would only
 * help inside a frame pass and is not requested.
 */

/** Penumbra sharpness: clearance/t ratio that reads as fully lit. */
const PENUMBRA = 40;
/**
 * March step growth per iteration (see shadow.wgsl): the first step is
 * one grid cell and later steps grow, so near occluders keep fine
 * sampling while the ray still reaches far at grazing sun.
 */
const STEP_GROWTH = 0.1;
/** Hard cap on the horizontal march distance, km. */
const MAX_MARCH_KM = 90;
/** Vertical bias at march start, in drawn km, against self-shadow acne. */
const BIAS_KM = 0.01;
/**
 * Sun-direction movement below this angle keeps the current shadow map —
 * an invisible change is not worth a recompute (odd/tasks decision).
 */
export const SHADOW_RECOMPUTE_MIN_DEG = 0.25;

/**
 * Recompute quality: "interactive" is the coarse march used while the
 * user drags the time slider or the clock plays; "final" is the
 * device-profile resolution applied once the input settles.
 */
export type ShadowQuality = "interactive" | "final";

interface ShadowParamsValue {
  gridSize: readonly [number, number];
  virtualSize: number[];
  sunDir: number[];
  exaggeration: number;
  cellKm: number;
  stepKm: number;
  growth: number;
  steps: number;
  maxKm: number;
  penumbra: number;
  biasKm: number;
}

export interface ShadowEngineOptions {
  /** The grid mapping the terrain shader uses (gridSize + cellKm). */
  readonly grid: TerrainGridUniforms;
  /** shadow.wgsl (or its resolved WGSL text). */
  readonly shader: string | ShaderSource;
  /** Resolution + march steps for the device profile ("final"). */
  readonly plan: ShadowPlan;
  /**
   * Coarser march used while the sun input is moving. Absent: every
   * update dispatches at `plan`.
   */
  readonly interactive?: ShadowPlan;
}

export interface ShadowEngine {
  /** Visibility texture the terrain/detail/diorama shaders sample. */
  readonly texture: Texture;
  /**
   * Re-dispatch the march at `quality` if the texture's current content
   * is stale: the sun direction moved >= 0.25 deg, the exaggeration
   * changed, or the texture holds a coarser quality than requested.
   */
  update(
    sunDir: readonly [number, number, number],
    exaggeration: number,
    quality?: ShadowQuality,
  ): void;
  /** Milliseconds of the last recompute (submit-to-GPU-done), if any. */
  readonly lastShadowMs: number | undefined;
  /** Resolves when the last dispatched recompute finished on the GPU. */
  whenSettled(): Promise<void>;
}

export function createShadowEngine(
  gpu: Gpu,
  heights: StorageBuffer,
  opts: ShadowEngineOptions,
): ShadowEngine {
  const params: ShadowParamsValue = {
    gridSize: opts.grid.gridSize,
    virtualSize: [opts.plan.width, opts.plan.height],
    sunDir: [0, 1, 0],
    exaggeration: 1,
    cellKm: opts.grid.cellKm,
    stepKm: opts.grid.cellKm,
    growth: STEP_GROWTH,
    steps: opts.plan.steps,
    maxKm: MAX_MARCH_KM,
    penumbra: PENUMBRA,
    biasKm: BIAS_KM,
  };

  const shadowTex = texture(gpu, {
    kind: "2d",
    size: [opts.plan.width, opts.plan.height],
    format: "rgba8unorm",
    // texture_binding for the samplers in the draw shaders, copy_src so
    // headless runs can read the visibility field back for debugging.
    usage: ["storage_binding", "texture_binding", "copy_src"],
    label: "sun-shadow",
  });

  const march = compute(gpu, opts.shader, {
    label: "sun-shadow",
    set: {
      params,
      heights,
      shadowTex,
    },
  });

  /** Quality rank: "final" content already covers an "interactive" ask. */
  const rank = (q: ShadowQuality): number => (q === "final" ? 1 : 0);

  /** What the texture currently holds — nothing until the first dispatch. */
  let content:
    | {
        quality: ShadowQuality;
        dir: readonly [number, number, number];
        exaggeration: number;
      }
    | undefined;
  let lastShadowMs: number | undefined;
  let settle: Promise<void> = Promise.resolve();

  const engine: ShadowEngine = {
    texture: shadowTex,

    update(sunDir, exaggeration, quality = "final") {
      const q: ShadowQuality =
        quality === "interactive" && opts.interactive === undefined
          ? "final"
          : quality;
      // Skip when the texture already covers this request: same-or-better
      // quality, same exaggeration, sun moved less than the threshold.
      if (
        content !== undefined &&
        rank(content.quality) >= rank(q) &&
        content.exaggeration === exaggeration &&
        angularDistanceDeg(content.dir, sunDir) < SHADOW_RECOMPUTE_MIN_DEG
      ) {
        return;
      }
      const res = q === "interactive" && opts.interactive ? opts.interactive : opts.plan;
      params.sunDir = [...sunDir];
      params.exaggeration = exaggeration;
      params.virtualSize = [res.width, res.height];
      params.steps = res.steps;
      march.set({ params });
      const startedAt = performance.now();
      march.dispatch(Math.ceil(res.width / 8), Math.ceil(res.height / 8));
      content = {
        quality: q,
        dir: [...sunDir],
        exaggeration,
      };
      settle = gpu.gpu.queue
        .onSubmittedWorkDone()
        .then(() => {
          lastShadowMs = performance.now() - startedAt;
        })
        .catch((reason: unknown) => {
          // Device loss rejects the wait — keep the last timing instead
          // of letting it surface as an unhandled rejection.
          console.warn("sun-shadow: GPU settle wait failed", reason);
        });
    },

    get lastShadowMs() {
      return lastShadowMs;
    },

    whenSettled() {
      return settle;
    },
  };
  return engine;
}
