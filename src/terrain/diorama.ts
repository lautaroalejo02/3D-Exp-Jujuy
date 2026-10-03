import {
  draw,
  sampler,
  storage,
  texture,
  type Draw,
  type FramePass,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  type Texture,
} from "vgpu";

import type { Layer, LayerContext, LayerState } from "../app/layers";
import {
  contextBaseKm,
  OUTSIDE_FLATTEN,
  SHADOW_KM,
  SLAB_KM,
  SLAB_MARGIN,
  basePlaneKm,
} from "./context-flatten";
import { CARTOGRAPHIC_SUN } from "./terrain-layer";
import { hazeRangeKm, type TerrainGridUniforms } from "./terrain-uniforms";

/**
 * Diorama surroundings — the "maqueta" look behind and under the terrain:
 * a sky gradient backdrop, a thin context rim on the rectangular grid
 * border (the outside terrain is flattened toward a low plain, and this
 * plinth drops from that flattened edge to the base plane), ONE cut wall
 * following the province outline from the full relief down to the same
 * base plane, and a flush base slab (plinth) under it all.
 *
 * Implemented as one Layer whose draw() encodes four draws from
 * diorama.wgsl (entry points vs_sky/fs_sky, vs_wall/fs_wall,
 * vs_cutwall/fs_wall, vs_slab/fs_slab — vgpu reflects bindings per entry,
 * so each draw only binds what it uses). GPU resources are created once
 * in init; update() only rewrites the two uniform structs, so it costs
 * nothing while the app idles.
 *
 * The layer must precede the terrain in the layers array: the sky is an
 * opaque fullscreen draw with depth disabled and relies on everything else
 * overdrawing it. The heights buffer and the province SDF texture belong
 * to the terrain layer, which inits after this one — the walls bind them
 * lazily on the first update(), the same deferred pattern the detail
 * layer uses for site resources.
 */

export interface ProvinceOutline {
  /**
   * Flat [i0,j0, i1,j1, ...] ring in the departments raster's grid
   * coords (cell centers at integers), wound with positive signed area
   * — the shader derives outward normals from that winding. Produced by
   * provinceOutlineRing at build time (province-outline-*.bin).
   */
  readonly points: Float32Array;
  /** Size of the grid the outline coords live in. */
  readonly gridWidth: number;
  readonly gridHeight: number;
}

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
  /**
   * The province SDF texture the terrain layer owns — the same deferred
   * getter pattern as `heights`. The rim wall samples it to flatten the
   * context edge exactly like the terrain vertex shader does. Absent:
   * the rim keeps the unflattened edge heights (the pre-Bordes look).
   */
  readonly provinceSdfTexture?: () => Texture;
  /**
   * Province outline ring for the cut wall (build-data output). The
   * layer converts it into height-grid coords once at init and uploads
   * it as a storage buffer with the closing point duplicated. Absent:
   * no cut wall is drawn.
   */
  readonly outline?: ProvinceOutline;
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
   * bound on the wall draws. Absent: a 1x1 fully-lit fallback is bound.
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
  contextBaseKm: number;
  outsideFlatten: number;
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
 * Vertex layout of the diorama draws, mirrored by vs_wall / vs_cutwall /
 * vs_slab in diorama.wgsl. The rim edges N and S run along X (meshW-1
 * quads each); W and E run along Z (meshH-1 quads). The cut wall emits 6
 * vertices per outline segment. Returns the non-indexed vertex counts.
 */
export function dioramaVertexPlan(
  meshSize: readonly [number, number],
  outlinePoints = 0,
): {
  readonly vertexCount: number;
  readonly slabVertexCount: number;
  readonly cutWallVertexCount: number;
} {
  if (meshSize[0] < 2 || meshSize[1] < 2) {
    throw new Error(
      `diorama walls need at least 2x2 mesh vertices, got ${meshSize[0]}x${meshSize[1]}`,
    );
  }
  const wallVertices = 12 * (meshSize[0] - 1) + 12 * (meshSize[1] - 1);
  // Slab: one quad for the top face + one rim quad per edge (N, S, W, E).
  return {
    vertexCount: wallVertices,
    slabVertexCount: 30,
    cutWallVertexCount: outlinePoints * 6,
  };
}

export function createDioramaLayer(opts: DioramaLayerOptions): DioramaLayer {
  // Outline ring re-expressed in height-grid coords (the two grids share
  // the ground extent; this is the pure cell-center rescale) with the
  // closing point duplicated so segment s reads points[s..s+1].
  let outlineVertices: Float32Array | undefined;
  if (opts.outline && opts.outline.points.length >= 6) {
    const src = opts.outline.points;
    const n = src.length / 2;
    const kx = opts.grid.gridSize[0] / opts.outline.gridWidth;
    const ky = opts.grid.gridSize[1] / opts.outline.gridHeight;
    outlineVertices = new Float32Array((n + 1) * 2);
    for (let k = 0; k <= n; k++) {
      const s = (k % n) * 2;
      outlineVertices[k * 2] = (src[s]! + 0.5) * kx - 0.5;
      outlineVertices[k * 2 + 1] = (src[s + 1]! + 0.5) * ky - 0.5;
    }
  }
  const { vertexCount: wallVertices, slabVertexCount, cutWallVertexCount } =
    dioramaVertexPlan(opts.grid.meshSize, outlineVertices ? outlineVertices.length / 2 - 1 : 0);

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
    contextBaseKm: 0,
    outsideFlatten: OUTSIDE_FLATTEN,
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
  let cutWallDraw: Draw | undefined;
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
      // Shadow texture for the wall draws: the terrain's engine output.
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
      // SDF fallback while the terrain's texture is not bound yet: one
      // texel at 255 decodes to +128 (deep inside) so the rim wall keeps
      // unflattened edge heights until the real raster arrives.
      const fallbackSdfTex = texture(gpu, {
        kind: "2d",
        size: [1, 1],
        format: "r8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "diorama-sdf-fallback",
      });
      gpu.gpu.queue.writeTexture(
        { texture: fallbackSdfTex.gpu },
        new Uint8Array([255]),
        { bytesPerRow: 1, rowsPerImage: 1 },
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
          provinceSdfTex: fallbackSdfTex,
          linearSampler: sampler(gpu, {
            minFilter: "linear",
            magFilter: "linear",
          }),
        },
      });
      if (outlineVertices) {
        const outlineBuffer = storage(
          gpu,
          outlineVertices.byteLength,
          "read",
        );
        outlineBuffer.write(outlineVertices as Float32Array<ArrayBuffer>);
        cutWallDraw = draw(gpu, {
          shader: opts.shader,
          entry: { vertex: "vs_cutwall", fragment: "fs_wall" },
          label: "diorama-cutwall",
          vertices: cutWallVertexCount,
          cull: "none",
          depth: { compare: "greater", write: true }, // reversed-Z
          set: {
            params,
            outline: outlineBuffer,
            shadowTex: fallbackShadowTex,
            linearSampler: sampler(gpu, {
              minFilter: "linear",
              magFilter: "linear",
            }),
          },
        });
      }
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
        // Deferred binds: the terrain layer owns the buffers (and the
        // shadow + SDF textures) and inits after this layer — the sky
        // must draw first. Binding a vgpu resource is not GPU allocation
        // — the draws themselves were created once in init().
        const heights = opts.heights();
        wallDraw.set({ heights });
        const sdfTex = opts.provinceSdfTexture?.();
        if (sdfTex) wallDraw.set({ provinceSdfTex: sdfTex });
        if (cutWallDraw) cutWallDraw.set({ heights });
        const shadowTex = opts.shadowTexture?.();
        if (shadowTex) {
          wallDraw.set({ shadowTex });
          cutWallDraw?.set({ shadowTex });
        }
        heightsBound = true;
      }
      const exaggeration = opts.verticalExaggeration();
      params.viewProjection = state.camera.viewProjectionMatrix();
      params.cameraPos = [...state.camera.eye()];
      params.exaggeration = exaggeration;
      // One shared base plane: both wall bottoms and the slab top use it
      // (context-flatten.ts is the single source — the unit test pins it).
      params.baseKm = basePlaneKm(opts.minElevationMeters, exaggeration);
      params.contextBaseKm = contextBaseKm(
        opts.minElevationMeters,
        exaggeration,
      );
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
      cutWallDraw?.set({ params });
      slabDraw.set({ params });
      skyDraw.set({ sky });
    },

    draw(pass: FramePass): void {
      // Order matters: sky first (no depth), then opaque geometry that
      // depth-tests against the terrain drawn later in the pass.
      if (skyDraw) pass.draw(skyDraw);
      if (slabDraw) pass.draw(slabDraw);
      if (wallDraw) pass.draw(wallDraw);
      if (cutWallDraw) pass.draw(cutWallDraw);
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
      cutWallDraw?.set({ params: partial });
      slabDraw?.set({ params: partial });
    },

    setShadowsEnabled(enabled: boolean): void {
      params.shadowStrength = enabled ? 1 : 0;
      wallDraw?.set({ params: { shadowStrength: params.shadowStrength } });
      cutWallDraw?.set({ params: { shadowStrength: params.shadowStrength } });
    },

    setSkyTint(tint): void {
      sky.sunTint = [...tint];
      skyDraw?.set({ sky: { sunTint: sky.sunTint } });
    },
  };
}
