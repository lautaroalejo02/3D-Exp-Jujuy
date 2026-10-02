import type { FramePass, Gpu } from "vgpu";

import type { OrbitCamera } from "../camera/camera";

/**
 * Extension point for map features. Future features — regions, places,
 * elevation profile and rain — plug in as `Layer` implementations under
 * `src/features/<name>/`. The app owns the vgpu frame; layers only encode
 * draws into the pass they are given and never create GPU resources inside
 * `update`/`draw` (create them once in `init`).
 *
 * Layers must not touch the DOM inside `init`/`update`/`draw` — the same
 * code runs headless under `vgpu/node` (scripts/render-snapshot.ts). DOM
 * contributions go through the optional `ui` object, which the app mounts
 * into the overlay root.
 */

/** Everything a layer needs at setup time. */
export interface LayerContext {
  readonly gpu: Gpu;
}

/** Per-frame shared state handed to `update`. */
export interface LayerState {
  /** Seconds since the app clock started. */
  readonly time: number;
  /** Physical canvas size in pixels: [width, height]. */
  readonly viewport: readonly [number, number];
  /** Shared orbit camera; layers read matrices from it, never mutate it. */
  readonly camera: OrbitCamera;
}

/** A resolved terrain pick, handed to layers that opt into picking. */
export interface PickHit {
  /** World-space position of the hit, in kilometers. */
  readonly world: readonly [number, number, number];
  /** Grid sample coordinates (fractional, cell centers at .5). */
  readonly grid: readonly [number, number];
  /** Geographic position: [longitude, latitude] in degrees. */
  readonly lonLat: readonly [number, number];
}

/** Optional DOM contribution a layer can mount into the overlay root. */
export interface LayerUi {
  mount(root: HTMLElement): void | (() => void);
}

export interface Layer {
  readonly id: string;
  init(ctx: LayerContext): void;
  update(state: LayerState, dt: number): void;
  draw(pass: FramePass): void;
  onPick?(hit: PickHit): void;
  readonly ui?: LayerUi;
}
