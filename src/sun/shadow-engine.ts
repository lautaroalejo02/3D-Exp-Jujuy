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

/**
 * Shadow-texture engine: owns the storage-written visibility texture and
 * the compute pass that fills it (src/sun/shadow.wgsl). Created once at
 * layer-init time; `update()` re-dispatches the pass ONLY when the sun
 * direction or the vertical exaggeration actually changed — with the sun
 * mode's play button that is at most once per frame, and zero cost while
 * anything idles.
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

interface ShadowParamsValue {
  gridSize: readonly [number, number];
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
  /** Resolution + march steps for the device profile. */
  readonly plan: ShadowPlan;
}

export interface ShadowEngine {
  /** Visibility texture the terrain/detail/diorama shaders sample. */
  readonly texture: Texture;
  /**
   * Re-dispatch the march if the sun direction or exaggeration changed
   * since the last dispatch. Inputs are compared with a small epsilon so
   * float noise from slider/scrubbing updates cannot retrigger the pass.
   */
  update(sunDir: readonly [number, number, number], exaggeration: number): void;
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

  let lastKey = "";
  let lastShadowMs: number | undefined;
  let settle: Promise<void> = Promise.resolve();

  const engine: ShadowEngine = {
    texture: shadowTex,

    update(sunDir, exaggeration) {
      const key = `${sunDir[0].toFixed(5)},${sunDir[1].toFixed(5)},${sunDir[2].toFixed(5)},${exaggeration.toFixed(4)}`;
      if (key === lastKey) return;
      lastKey = key;
      params.sunDir = [...sunDir];
      params.exaggeration = exaggeration;
      march.set({ params });
      const startedAt = performance.now();
      march.dispatch(
        Math.ceil(opts.plan.width / 8),
        Math.ceil(opts.plan.height / 8),
      );
      settle = gpu.gpu.queue
        .onSubmittedWorkDone()
        .then(() => {
          lastShadowMs = performance.now() - startedAt;
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
