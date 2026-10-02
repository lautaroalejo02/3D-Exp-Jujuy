import {
  effect,
  sampler,
  target,
  type Effect,
  type Frame,
  type Gpu,
  type ShaderSource,
  type Target,
} from "vgpu";

import type { Layer } from "../app/layers";
import type { GpuMemoryEntry } from "./gpu-memory";

/**
 * Two-pass scene renderer, shared between the browser surface and the
 * headless snapshot targets (vgpu/node). Pass 1 renders every layer into an
 * offscreen target with a depth attachment; pass 2 composites that target
 * onto the output (canvas surface or offscreen target) with a fullscreen
 * effect.
 *
 * Depth is `depth32float` with reversed-Z (infinite far plane): draws use
 * compare "greater" and the pass clears depth to 0. See camera.ts.
 */
export interface SceneRendererOptions {
  readonly shader: string | ShaderSource;
  readonly size: readonly [number, number];
  /** Scene background; the satellite texture covers it once loaded. */
  readonly clearColor?: readonly [number, number, number, number];
  readonly label?: string;
}

export interface SceneRenderer {
  /** Offscreen target the layers render into. */
  readonly scene: Target;
  /** Follow the output size (called from surface.onResize in the browser). */
  resize(size: readonly [number, number]): void;
  /** Encode both passes of one frame. */
  renderFrame(frame: Frame, output: Target, layers: readonly Layer[]): void;
  gpuMemoryEntries(): GpuMemoryEntry[];
}

const DEFAULT_CLEAR: readonly [number, number, number, number] = [
  0.1, 0.12, 0.16, 1,
];

export function createSceneRenderer(
  gpu: Gpu,
  opts: SceneRendererOptions,
): SceneRenderer {
  const scene = target(gpu, {
    size: opts.size,
    depth: "depth32float",
    clearColor: opts.clearColor ?? DEFAULT_CLEAR,
    label: opts.label ?? "scene",
  });

  const present: Effect = effect(gpu, opts.shader, {
    label: "present",
    set: {
      // Bind the Target itself (not target.color) so the binding follows
      // attachment replacement on resize.
      scene,
      sceneSampler: sampler(gpu, {
        minFilter: "linear",
        magFilter: "linear",
        mipmapFilter: "linear",
      }),
    },
  });

  return {
    scene,

    resize(size) {
      scene.resize(size);
    },

    renderFrame(frame, output, layers) {
      frame.pass({ target: scene, clearDepth: 0 }, (pass) => {
        for (const layer of layers) layer.draw(pass);
      });
      frame.pass(output, present);
    },

    gpuMemoryEntries() {
      const [w, h] = scene.size;
      const entries: GpuMemoryEntry[] = [
        { label: "scene color (rgba8unorm)", bytes: w * h * 4 },
      ];
      if (scene.depth) {
        entries.push({
          label: "scene depth (depth32float)",
          bytes: w * h * 4,
        });
      }
      return entries;
    },
  };
}
