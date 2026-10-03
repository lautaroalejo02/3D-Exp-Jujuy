import {
  draw,
  sampler,
  texture,
  type Draw,
  type FramePass,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  type Texture,
} from "vgpu";

import type { Layer, LayerContext, LayerState } from "../app/layers";
import { CARTOGRAPHIC_SUN } from "./terrain-layer";
import { hazeRangeKm, type TerrainGridUniforms } from "./terrain-uniforms";

/**
 * Diorama surroundings — the "maqueta" look behind and under the terrain:
 * a sky gradient backdrop, earthy side walls hanging from each terrain
 * border down to a base plane under the minimum elevation, and a thin base
 * slab (plinth) with a soft contact-shadow ring.
 *
 * Implemented as one Layer whose draw() encodes three draws from
 * diorama.wgsl (entry points vs_sky/fs_sky, vs_wall/fs_wall, vs_slab/
 * fs_slab — vgpu reflects bindings per entry, so each draw only binds what
 * it uses). GPU resources are created once in init; update() only rewrites
 * the two uniform structs, so it costs nothing while the app idles.
 *
 * The layer must precede the terrain in the layers array: the sky is an
 * opaque fullscreen draw with depth disabled and relies on everything else
 * overdrawing it. The heights buffer belongs to the terrain layer, which
 * inits after this one — the walls bind it lazily on the first update(),
 * the same deferred pattern the detail layer uses for site resources.
 */

/** Depth of the block below the exaggerated minimum elevation, in km. */
const SKIRT_KM = 10;
/** Thickness of the plinth slab under the walls, in km. */
const SLAB_KM = 2.2;
/** Slab half-extents = block half-extents * SLAB_MARGIN (the plinth lip). */
const SLAB_MARGIN = 1.04;
/** Width of the soft contact-shadow ring on the slab, in km. */
const SHADOW_KM = 14;

export interface DioramaLayerOptions {
  /**
   * The grid mapping the terrain shader uses (same object the terrain
   * layer exposes): the walls hang from the same world mapping and mesh
   * resolution so the silhouette matches exactly.
   */
  readonly grid: TerrainGridUniforms;
  /**
   * The base heights storage the terrain shader reads — a getter because
   * this layer inits before the terrain layer (draw order = init order:
   * the sky must be first) and binds it lazily on the first update().
   */
  readonly heights: () => StorageBuffer;
  /** Minimum DEM elevation in meters (heightfield.min). */
  readonly minElevationMeters: number;
  /** Live vertical exaggeration (the value the slider drives). */
  readonly verticalExaggeration: () => number;
  /** diorama.wgsl (or its resolved WGSL text). */
  readonly shader: string | ShaderSource;
  readonly ambient?: number;
  readonly lightStrength?: number;
  /**
   * Sun-shadow visibility texture (the terrain layer's engine output),
   * bound on the wall draw. Absent: a 1x1 fully-lit fallback is bound.
   */
  readonly shadowTexture?: () => Texture;
}

export interface DioramaLayer extends Layer {
  /** Push the sun light — same convention as TerrainLayer.setSun. */
  setSun(
    direction: readonly [number, number, number],
    color: readonly [number, number, number],
    ambient: readonly [number, number, number],
  ): void;
  /** Fade the wall shadow term in or out (same flag as the terrain). */
  setShadowsEnabled(enabled: boolean): void;
  /** Multiplicative tint on the sky gradient (vec3(1) = neutral). */
  setSkyTint(tint: readonly [number, number, number]): void;
}

interface DioramaParamsValue {
  viewProjection: number[];
  cameraPos: number[];
  originPx: readonly [number, number];
  centerPx: readonly [number, number];
  gridSize: readonly [number, number];
  meshSize: readonly [number, number];
  meshToGrid: readonly [number, number];
  cellScale: number;
  kmPerPx: number;
  exaggeration: number;
  baseKm: number;
  slabKm: number;
  slabMargin: number;
  shadowKm: number;
  hazeStart: number;
  hazeEnd: number;
  sunColor: number[];
  ambientColor: number[];
  sunDir: number[];
  shadowStrength: number;
}

interface SkyParamsValue {
  upView: number[];
  sunTint: number[];
  tanHalfFov: number;
  aspect: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/**
 * Vertex layout of the wall draw, mirrored by vs_wall in diorama.wgsl.
 * Edges N and S run along X (meshW-1 quads each); W and E run along Z
 * (meshH-1 quads). Returns the total non-indexed vertex count.
 */
export function dioramaVertexPlan(
  meshSize: readonly [number, number],
): { readonly vertexCount: number; readonly slabVertexCount: number } {
  if (meshSize[0] < 2 || meshSize[1] < 2) {
    throw new Error(
      `diorama walls need at least 2x2 mesh vertices, got ${meshSize[0]}x${meshSize[1]}`,
    );
  }
  const wallVertices = 12 * (meshSize[0] - 1) + 12 * (meshSize[1] - 1);
  // Slab: one quad for the top face + one rim quad per edge (N, S, W, E).
  return { vertexCount: wallVertices, slabVertexCount: 30 };
}

export function createDioramaLayer(opts: DioramaLayerOptions): DioramaLayer {
  const { vertexCount: wallVertices, slabVertexCount } = dioramaVertexPlan(
    opts.grid.meshSize,
  );

  const ambient = opts.ambient ?? CARTOGRAPHIC_SUN.ambient[0];
  const lightStrength = opts.lightStrength ?? CARTOGRAPHIC_SUN.color[0];
  const params: DioramaParamsValue = {
    viewProjection: [...IDENTITY_MAT4],
    cameraPos: [0, 0, 0],
    originPx: opts.grid.originPx,
    centerPx: opts.grid.centerPx,
    gridSize: opts.grid.gridSize,
    meshSize: opts.grid.meshSize,
    meshToGrid: opts.grid.meshToGrid,
    cellScale: opts.grid.cellScale,
    kmPerPx: opts.grid.kmPerPx,
    exaggeration: opts.verticalExaggeration(),
    baseKm: 0,
    slabKm: SLAB_KM,
    slabMargin: SLAB_MARGIN,
    shadowKm: SHADOW_KM,
    hazeStart: 0,
    hazeEnd: 1,
    // Same default light as the terrain: NW 45 deg sun, grey direct and
    // grey ambient — the shipped look until the sun mode drives it.
    sunColor: [lightStrength, lightStrength, lightStrength],
    ambientColor: [ambient, ambient, ambient],
    sunDir: [...CARTOGRAPHIC_SUN.direction],
    shadowStrength: 0,
  };
  const sky: SkyParamsValue = {
    upView: [0, 1, 0],
    sunTint: [1, 1, 1],
    tanHalfFov: 1,
    aspect: 1,
  };

  let skyDraw: Draw | undefined;
  let wallDraw: Draw | undefined;
  let slabDraw: Draw | undefined;
  let heightsBound = false;

  return {
    id: "diorama",

    init(ctx: LayerContext): void {
      const gpu: Gpu = ctx.gpu;
      skyDraw = draw(gpu, {
        shader: opts.shader,
        entry: { vertex: "vs_sky", fragment: "fs_sky" },
        label: "diorama-sky",
        vertices: 3,
        // Opaque backdrop: no depth test or write — it is drawn first in
        // the scene pass and everything else draws over it.
        depth: false,
        set: { sky },
      });
      // Shadow texture for the wall draw: the terrain's engine output.
      // The terrain layer inits after this one (draw order = init order:
      // the sky must be first), so the getter runs lazily on the first
      // update — the same deferred-bind pattern as `heights` — and this
      // 1x1 fully-lit fallback keeps the binding valid until then.
      const fallbackShadowTex = texture(gpu, {
        kind: "2d",
        size: [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "diorama-shadow-fallback",
      });
      gpu.gpu.queue.writeTexture(
        { texture: fallbackShadowTex.gpu },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1],
      );
      wallDraw = draw(gpu, {
        shader: opts.shader,
        entry: { vertex: "vs_wall", fragment: "fs_wall" },
        label: "diorama-walls",
        vertices: wallVertices,
        cull: "none",
        depth: { compare: "greater", write: true }, // reversed-Z
        set: {
          params,
          shadowTex: fallbackShadowTex,
          linearSampler: sampler(gpu, {
            minFilter: "linear",
            magFilter: "linear",
          }),
        },
      });
      slabDraw = draw(gpu, {
        shader: opts.shader,
        entry: { vertex: "vs_slab", fragment: "fs_slab" },
        label: "diorama-slab",
        vertices: slabVertexCount,
        cull: "none",
        depth: { compare: "greater", write: true }, // reversed-Z
        set: { params },
      });
    },

    update(state: LayerState): void {
      if (!wallDraw || !slabDraw || !skyDraw) return;
      if (!heightsBound) {
        // Deferred binds: the terrain layer owns the buffer (and the
        // shadow texture) and inits after this layer — the sky must draw
        // first. Binding a vgpu resource is not GPU allocation — the
        // draw itself was created once in init().
        wallDraw.set({ heights: opts.heights() });
        const shadowTex = opts.shadowTexture?.();
        if (shadowTex) wallDraw.set({ shadowTex });
        heightsBound = true;
      }
      const exaggeration = opts.verticalExaggeration();
      params.viewProjection = state.camera.viewProjectionMatrix();
      params.cameraPos = [...state.camera.eye()];
      params.exaggeration = exaggeration;
      params.baseKm =
        (opts.minElevationMeters / 1000) * exaggeration - SKIRT_KM;
      // The haze ramp scales with the orbit distance: at the default
      // framing it starts beyond the block's far corner, so only grazing
      // views show a subtle far-edge fade (hazeRangeKm).
      [params.hazeStart, params.hazeEnd] = hazeRangeKm(
        state.camera.distanceKm,
      );
      const view = state.camera.viewMatrix();
      // World up in view space is the middle column of the (column-major)
      // view matrix: V · (0,1,0) = (right.y, up.y, -forward.y). The sky
      // only needs the direction; the matrix is already orthonormal.
      sky.upView = [view[4] ?? 0, view[5] ?? 1, view[6] ?? 0];
      sky.tanHalfFov = Math.tan((state.camera.fovDeg * Math.PI) / 360);
      sky.aspect = state.camera.aspect;
      wallDraw.set({ params });
      slabDraw.set({ params });
      skyDraw.set({ sky });
    },

    draw(pass: FramePass): void {
      // Order matters: sky first (no depth), then opaque geometry that
      // depth-tests against the terrain drawn later in the pass.
      if (skyDraw) pass.draw(skyDraw);
      if (slabDraw) pass.draw(slabDraw);
      if (wallDraw) pass.draw(wallDraw);
    },

    setSun(direction, color, ambient): void {
      params.sunDir = [...direction];
      params.sunColor = [...color];
      params.ambientColor = [...ambient];
      const partial = {
        sunDir: params.sunDir,
        sunColor: params.sunColor,
        ambientColor: params.ambientColor,
      };
      wallDraw?.set({ params: partial });
      slabDraw?.set({ params: partial });
    },

    setShadowsEnabled(enabled: boolean): void {
      params.shadowStrength = enabled ? 1 : 0;
      wallDraw?.set({ params: { shadowStrength: params.shadowStrength } });
    },

    setSkyTint(tint): void {
      sky.sunTint = [...tint];
      skyDraw?.set({ sky: { sunTint: sky.sunTint } });
    },
  };
}
