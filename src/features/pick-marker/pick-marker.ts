import { draw, type Draw, type FramePass, type ShaderSource } from "vgpu";

import type { Layer, LayerContext, LayerState, PickHit } from "../../app/layers";
import { gridToWorld, type GridSpec } from "../../geo";

/**
 * Marker layer: a screen-space ring anchored to the last picked point. It
 * is the first consumer of the Layer extension point after the terrain —
 * GPU resources are created once in `init`, and `update` only rewrites the
 * uniform struct (viewProjection + anchor + viewport + ring size).
 *
 * The anchor is stored as grid coordinates plus the DEM elevation, and the
 * world position is recomputed every frame with the CURRENT vertical
 * exaggeration, so the ring stays glued to the surface when the
 * exaggeration slider moves.
 */
export interface PickMarkerLayerOptions {
  /** Height grid spec: world mapping for the stored grid coordinates. */
  readonly spec: GridSpec;
  /** pick-marker.wgsl (or its resolved WGSL text). */
  readonly shader: string | ShaderSource;
  /** Live vertical exaggeration (the value the slider drives). */
  readonly verticalExaggeration: () => number;
  /**
   * Drawn-surface elevation in (virtual) meters at grid coords — what
   * the user actually sees (detail geomorph + outside-province
   * flattening). The ring anchors to this so it sits ON the drawn
   * surface; falls back to the hit's DEM elevation when absent.
   */
  readonly drawnElevationAt?: (i: number, j: number) => number;
}

interface PickAnchor {
  readonly i: number;
  readonly j: number;
  readonly elevationMeters: number;
}

interface MarkerParamsValue {
  viewProjection: number[];
  center: number[];
  radiusPx: number;
  viewportPx: number[];
  thicknessPx: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** A Layer whose onPick is always present (anchor set/clear). */
export interface PickMarkerLayer extends Layer {
  onPick(hit: PickHit | undefined): void;
}

export function createPickMarkerLayer(opts: PickMarkerLayerOptions): PickMarkerLayer {
  const params: MarkerParamsValue = {
    viewProjection: [...IDENTITY_MAT4],
    center: [0, 0, 0],
    radiusPx: 16,
    viewportPx: [1, 1],
    thicknessPx: 4,
  };
  let anchor: PickAnchor | undefined;
  let markerDraw: Draw | undefined;

  return {
    id: "pick-marker",

    init(ctx: LayerContext): void {
      markerDraw = draw(ctx.gpu, {
        shader: opts.shader,
        label: "pick-marker",
        vertices: 6,
        cull: "none",
        // No depth test: the marker is a UI affordance and stays visible
        // even where terrain would occlude the anchor.
        depth: false,
        blend: "alpha",
        set: { params },
      });
    },

    update(state: LayerState): void {
      if (!markerDraw || !anchor) return;
      const [x, y, z] = gridToWorld(opts.spec, anchor.i, anchor.j, {
        elevationMeters:
          opts.drawnElevationAt?.(anchor.i, anchor.j) ??
          anchor.elevationMeters,
        verticalExaggeration: opts.verticalExaggeration(),
      });
      params.viewProjection = state.camera.viewProjectionMatrix();
      params.center = [x, y, z];
      params.viewportPx = [state.viewport[0], state.viewport[1]];
      const shortSide = Math.min(state.viewport[0], state.viewport[1]);
      params.radiusPx = Math.min(48, Math.max(12, shortSide * 0.022));
      params.thicknessPx = Math.max(3, params.radiusPx * 0.22);
      markerDraw.set({ params });
    },

    draw(pass: FramePass): void {
      if (markerDraw && anchor) pass.draw(markerDraw);
    },

    onPick(hit: PickHit | undefined): void {
      anchor = hit
        ? {
            i: hit.grid[0],
            j: hit.grid[1],
            elevationMeters: hit.elevationMeters,
          }
        : undefined;
    },
  };
}
