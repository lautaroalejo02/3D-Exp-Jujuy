import {
  draw,
  sampler,
  storage,
  texture,
  type Draw,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  type Texture,
} from "vgpu";

import type { Layer, LayerContext, LayerState } from "../app/layers";
import type { ShadowPlan } from "../app/device-profile";
import {
  buildGpuMemoryReport,
  mipLevelCount,
  textureBytesWithMips,
  type GpuMemoryReport,
} from "../render/gpu-memory";
import { generateMipmaps } from "../render/mipmap";
import { createShadowEngine, type ShadowEngine } from "../sun/shadow-engine";
import { createTerrainControls } from "../ui/controls";
import {
  MAX_DETAIL_PATCHES,
  type DetailPatchRect,
} from "./detail-grids";
import type { Heightfield, TerrainQuality } from "./heightfield";
import type { SatelliteImage } from "./satellite";
import {
  buildTerrainGridUniforms,
  hazeRangeKm,
  type TerrainGridUniforms,
} from "./terrain-uniforms";

/**
 * Vertical exaggeration of the relief at startup. Shared by the app and
 * the headless snapshot renderer so captures match the shipped view.
 */
export const DEFAULT_VERTICAL_EXAGGERATION = 3;

/** Mesh resolution in vertices, independent from the height grid. */
export interface MeshSize {
  readonly width: number;
  readonly height: number;
}

export interface TerrainLayerShaders {
  /** terrain.wgsl (or its resolved WGSL text). */
  readonly terrain: string | ShaderSource;
  /** mipmap.wgsl (or its resolved WGSL text). */
  readonly mipmap: string | ShaderSource;
}

/**
 * Department index raster + province SDF for the loaded quality level
 * (from loadDepartments). Their grid covers the same ground extent as the
 * height grid — the shader samples both through the satellite UV. The
 * SDF drives the outside dimming and the province outline; the index is
 * what the regions overlay is baked from.
 */
export interface ProvinceMask {
  readonly grid: { readonly width: number; readonly height: number };
  /** Department index per cell, row-major: 0 outside, 1..16 departments. */
  readonly index: Uint8Array;
  /** Signed distance to the boundary in cells, Int8, + inside / - outside. */
  readonly sdf: Int8Array;
}

/**
 * RGBA raster for the shader's overlay slot, on the province-mask grid
 * (buildRegionOverlay): region color with alpha>0 inside the province,
 * transparent outside. Bound to overlayTex; overlayOpacity is the tint
 * strength and regionBorders draws the thin region boundaries.
 */
export interface RegionOverlay {
  readonly grid: { readonly width: number; readonly height: number };
  readonly rgba: Uint8Array;
}

export interface TerrainLayerOptions {
  readonly heightfield: Heightfield;
  readonly satellite: SatelliteImage;
  readonly shaders: TerrainLayerShaders;
  /** Which manifest level was loaded; used by the quality toggle UI. */
  readonly quality?: TerrainQuality;
  /**
   * Mesh vertices. Defaults to half the height-grid dimensions: 608x640
   * verts sampling the half-res heights, or 1216x1280 sampling full-res.
   */
  readonly mesh?: MeshSize;
  readonly verticalExaggeration?: number;
  readonly ambient?: number;
  readonly lightStrength?: number;
  /**
   * Cast-shadow engine (src/sun/shadow-engine.ts): creates the shadow
   * texture + compute march over the heights buffer, re-dispatched only
   * when the sun direction or exaggeration changes. Absent: a 1x1
   * fully-lit texture is bound and setShadowsEnabled is a visual no-op.
   */
  readonly shadows?: {
    readonly shader: string | ShaderSource;
    readonly plan: ShadowPlan;
  };
  /**
   * Boundary rasters for the province mask. When absent, 1x1 fallbacks are
   * bound instead: SDF deep-inside and index 0 everywhere, so the mask
   * terms are no-ops.
   */
  readonly provinceMask?: ProvinceMask;
  /** How much terrain outside the province is dimmed (0..1, default .9). */
  readonly dimStrength?: number;
  /** Thin department borders inside the province; default off. */
  readonly showDepartmentBorders?: boolean;
  /**
   * Region tint raster (see RegionOverlay). When absent, the overlay slot
   * gets the 1x1 transparent fallback and setRegionsVisible is a no-op.
   */
  readonly regionOverlay?: RegionOverlay;
  /** Start with the region tint and borders visible; default off. */
  readonly showRegions?: boolean;
  /** Region tint strength 0..1 (the overlayOpacity uniform, default .55). */
  readonly regionTintStrength?: number;
  /** Province outline width in CSS px (default 2). */
  readonly outlineCssPx?: number;
  /**
   * Physical pixels per CSS pixel (the surface DPR). Read every update so
   * the outline stays ~outlineCssPx wide when the DPR changes. Default 1.
   */
  readonly pixelRatio?: () => number;
  /**
   * Called whenever the exaggeration changes (slider or setter), so the
   * app can keep other layers (e.g. the pick marker) in sync.
   */
  readonly onExaggeration?: (value: number) => void;
  /** Adds the "alta puede ir lenta en celulares" note to the controls. */
  readonly warnHighQualityOnMobile?: boolean;
  /**
   * Detail patches that may cover part of this terrain (their FULL outer
   * extents in this grid's coords). The rects are not drawn by this
   * layer — setDetailPatchMask toggles which of them discard the base
   * surface while their patch is on screen.
   */
  readonly detailPatches?: readonly DetailPatchRect[];
}

export interface TerrainLayer extends Layer {
  /** Update the vertical exaggeration uniform (slider callback). */
  setVerticalExaggeration(value: number): void;
  /** Toggle the region tint + borders (the "Regiones" UI toggle). */
  setRegionsVisible(visible: boolean): void;
  /** Vertex count of the generated mesh draw call. */
  readonly vertexCount: number;
  readonly meshSize: MeshSize;
  /**
   * The grid mapping the terrain shader uses (mesh spacing included).
   * Stable from construction — the detail layer derives its geomorph
   * uniforms from it.
   */
  readonly gridUniforms: TerrainGridUniforms;
  /**
   * The base heights storage buffer the terrain shader reads. Only valid
   * after init() — the detail layer calls it lazily when a site loads.
   */
  baseHeightsStorage(): StorageBuffer;
  /**
   * Toggle which declared detail patches discard the base surface: only
   * patches that are loaded AND inside their draw distance may be in the
   * set — a loaded patch the camera left behind must not punch a hole in
   * the terrain.
   */
  setDetailPatchMask(activeIds: ReadonlySet<string>): void;
  /**
   * Push the sun light: `direction` is the unit vector TO the sun in
   * world space (X east, Y up, Z south), `color` the direct light tint,
   * `ambient` the ambient (sky) light. Triggers a shadow recompute when
   * shadows are enabled and the direction changed.
   */
  setSun(
    direction: readonly [number, number, number],
    color: readonly [number, number, number],
    ambient: readonly [number, number, number],
  ): void;
  /** Fade the cast-shadow term in (the sun mode is on) or out. */
  setShadowsEnabled(enabled: boolean): void;
  /** The shadow visibility texture (or the 1x1 lit fallback). */
  shadowTexture(): Texture;
  /** Milliseconds of the last shadow recompute, if it ran. */
  shadowMs(): number | undefined;
  /** Resolves when the last shadow recompute finished on the GPU. */
  shadowSettled(): Promise<void>;
  getGpuMemoryReport(): GpuMemoryReport;
}

// Uniform struct mirrored by Params in terrain.wgsl. `viewProjection` is
// rewritten every frame; the rest changes only through the setters below.
interface TerrainParamsValue {
  viewProjection: number[];
  cameraPos: number[];
  originPx: readonly [number, number];
  centerPx: readonly [number, number];
  gridSize: readonly [number, number];
  meshSize: readonly [number, number];
  meshToGrid: readonly [number, number];
  deptGridSize: readonly [number, number];
  kmPerPx: number;
  cellScale: number;
  cellKm: number;
  exaggeration: number;
  /** Direct light tint; defaults to grey so the old look is unchanged. */
  sunColor: number[];
  /** Ambient light color; defaults to grey. */
  ambientColor: number[];
  /** Unit vector TO the sun (X east, Y up, Z south); default NW 45 deg. */
  sunDir: number[];
  /** 0 = ignore shadowTex (default), 1 = full cast shadows. */
  shadowStrength: number;
  overlayOpacity: number;
  dimStrength: number;
  outlinePx: number;
  deptBorders: number;
  regionBorders: number;
  /** Haze ramp in km from the camera (hazeRangeKm of the orbit distance). */
  hazeStart: number;
  hazeEnd: number;
  /**
   * Live detail-patch discard rects [i0, j0, i1, j1] in grid coords;
   * only the first patchRectCount slots are read by the shader. Mirrors
   * `patchRects: array<vec4f, 16>` in terrain.wgsl.
   */
  patchRects: number[][];
  patchRectCount: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/**
 * Inactive slots get a degenerate rect (i0 > i1, j0 > j1): the inside
 * test can never fire on them even if the shader read past the count.
 */
function emptyPatchRects(): number[][] {
  return Array.from({ length: MAX_DETAIL_PATCHES }, () => [0, 0, -1, -1]);
}

function uploadSatellite(gpu: Gpu, tex: Texture, image: SatelliteImage): void {
  if (image.kind === "bitmap") {
    // copyExternalImageToTexture needs COPY_DST | RENDER_ATTACHMENT |
    // TEXTURE_BINDING on the destination — all requested at creation.
    gpu.gpu.queue.copyExternalImageToTexture(
      { source: image.bitmap },
      { texture: tex.gpu },
      [image.width, image.height],
    );
    return;
  }
  if (image.pixels.length !== image.width * image.height * 4) {
    throw new Error(
      `satellite RGBA payload ${image.pixels.length} does not match ${image.width}x${image.height}x4`,
    );
  }
  gpu.gpu.queue.writeTexture(
    { texture: tex.gpu },
    // jpeg-js allocates a plain ArrayBuffer; the field type is the wider
    // Uint8Array<ArrayBufferLike>, so narrow it for writeTexture.
    image.pixels as Uint8Array<ArrayBuffer>,
    { bytesPerRow: image.width * 4, rowsPerImage: image.height },
    [image.width, image.height],
  );
}

export function createTerrainLayer(opts: TerrainLayerOptions): TerrainLayer {
  const spec = opts.heightfield.spec;
  const quality: TerrainQuality = opts.quality ?? "default";
  const mesh: MeshSize = opts.mesh ?? {
    width: Math.max(2, Math.floor(spec.width / 2)),
    height: Math.max(2, Math.floor(spec.height / 2)),
  };
  const gridUniforms = buildTerrainGridUniforms(spec, [
    mesh.width,
    mesh.height,
  ]);
  const vertexCount = (mesh.width - 1) * (mesh.height - 1) * 6;
  const regionTintStrength = opts.regionTintStrength ?? 0.55;

  const params: TerrainParamsValue = {
    ...gridUniforms,
    viewProjection: [...IDENTITY_MAT4],
    cameraPos: [0, 0, 0],
    deptGridSize: opts.provinceMask
      ? [opts.provinceMask.grid.width, opts.provinceMask.grid.height]
      : [1, 1],
    exaggeration: opts.verticalExaggeration ?? DEFAULT_VERTICAL_EXAGGERATION,
    // Default light reproduces the long-standing cartographic look:
    // NW 45 deg sun, grey direct and grey ambient.
    sunColor: [opts.lightStrength ?? 0.85, opts.lightStrength ?? 0.85, opts.lightStrength ?? 0.85],
    ambientColor: [opts.ambient ?? 0.42, opts.ambient ?? 0.42, opts.ambient ?? 0.42],
    sunDir: [-0.5, 0.7071067811865476, -0.5],
    shadowStrength: 0,
    overlayOpacity: opts.showRegions ? regionTintStrength : 0,
    dimStrength: opts.dimStrength ?? 0.55,
    outlinePx: opts.outlineCssPx ?? 2,
    deptBorders: opts.showDepartmentBorders ? 1 : 0,
    regionBorders: opts.showRegions ? 1 : 0,
    hazeStart: 0,
    hazeEnd: 1,
    // No patch is live until the app calls setDetailPatchMask: a site
    // that is merely in range but still loading keeps the base surface.
    patchRects: emptyPatchRects(),
    patchRectCount: 0,
  };

  let heightsBuffer: ReturnType<typeof storage> | undefined;
  let satelliteTex: Texture | undefined;
  let overlayTex: Texture | undefined;
  let deptIndexTex: Texture | undefined;
  let provinceSdfTex: Texture | undefined;
  let shadowTex: Texture | undefined;
  let shadowEngine: ShadowEngine | undefined;
  let shadowsEnabled = false;
  let terrainDraw: Draw | undefined;

  const layer: TerrainLayer = {
    id: "terrain",
    vertexCount,
    meshSize: mesh,

    // Exaggeration slider + quality toggle, mounted by the app into the
    // overlay's control column (#hud). DOM lives behind `ui` so
    // init/update/draw stay headless.
    ui: {
      mount(root: HTMLElement): () => void {
        const panel = createTerrainControls({
          quality,
          initialExaggeration: params.exaggeration,
          onExaggeration: (v) => layer.setVerticalExaggeration(v),
          warnHighQualityOnMobile: opts.warnHighQualityOnMobile,
        });
        (root.querySelector("#hud") ?? root).appendChild(panel);
        return () => panel.remove();
      },
    },

    init(ctx: LayerContext): void {
      const gpu = ctx.gpu;

      // Heights: Int16 heightfield converted once to f32 on the CPU
      // (Heightfield.data is already Float32), uploaded once.
      const heights = opts.heightfield.data;
      heightsBuffer = storage(gpu, heights.byteLength, "read");
      // Heightfield.data is produced by Float32Array.from / decode paths
      // that always allocate a plain ArrayBuffer — the generic type is the
      // wider ArrayBufferLike, so narrow it for writeBuffer.
      heightsBuffer.write(heights as Float32Array<ArrayBuffer>);

      // Satellite texture with a full mip chain so zoomed-out views do not
      // shimmer. vgpu has no mip-generation helper; generateMipmaps fills
      // the chain with one compute dispatch per level.
      satelliteTex = texture(gpu, {
        kind: "2d",
        size: [opts.satellite.width, opts.satellite.height],
        format: "rgba8unorm",
        mipLevelCount: mipLevelCount(
          opts.satellite.width,
          opts.satellite.height,
        ),
        usage: [
          "texture_binding",
          "copy_dst",
          "storage_binding",
          // required by copyExternalImageToTexture (browser bitmap path)
          "render_attachment",
        ],
        label: "satellite",
      });
      uploadSatellite(gpu, satelliteTex, opts.satellite);
      generateMipmaps(gpu, opts.shaders.mipmap, satelliteTex);

      // Overlay slot: the regions tint raster when provided, else a 1x1
      // transparent fallback so the shader's mix() is a no-op.
      const overlay = opts.regionOverlay;
      overlayTex = texture(gpu, {
        kind: "2d",
        size: overlay ? [overlay.grid.width, overlay.grid.height] : [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "terrain-overlay",
      });
      gpu.gpu.queue.writeTexture(
        { texture: overlayTex.gpu },
        // buildRegionOverlay allocates a plain ArrayBuffer; narrow the
        // wider ArrayBufferLike generic for writeTexture.
        overlay
          ? (overlay.rgba as Uint8Array<ArrayBuffer>)
          : new Uint8Array([0, 0, 0, 0]),
        {
          bytesPerRow: overlay ? overlay.grid.width * 4 : 4,
          rowsPerImage: overlay ? overlay.grid.height : 1,
        },
        overlay ? [overlay.grid.width, overlay.grid.height] : [1, 1],
      );

      // Province mask, uploaded once. Both textures are r8unorm: the
      // department index is stored as its raw byte (decoded *255) and the
      // SDF is biased by +127 (decoded *255 - 127). When no mask was
      // provided, 1x1 fallbacks keep the bindings valid and inert: SDF
      // 255 decodes to +128 (deep inside → nothing is dimmed or outlined)
      // and index 0 marks the single texel as outside (no borders).
      const mask = opts.provinceMask;
      deptIndexTex = texture(gpu, {
        kind: "2d",
        size: mask ? [mask.grid.width, mask.grid.height] : [1, 1],
        format: "r8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "department-index",
      });
      gpu.gpu.queue.writeTexture(
        { texture: deptIndexTex.gpu },
        // The loader's typed arrays are plain ArrayBuffer-backed; narrow
        // the wider ArrayBufferLike generic for writeTexture.
        mask ? (mask.index as Uint8Array<ArrayBuffer>) : new Uint8Array([0]),
        {
          bytesPerRow: mask ? mask.grid.width : 1,
          rowsPerImage: mask ? mask.grid.height : 1,
        },
        mask ? [mask.grid.width, mask.grid.height] : [1, 1],
      );
      provinceSdfTex = texture(gpu, {
        kind: "2d",
        size: mask ? [mask.grid.width, mask.grid.height] : [1, 1],
        format: "r8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "province-sdf",
      });
      gpu.gpu.queue.writeTexture(
        { texture: provinceSdfTex.gpu },
        mask
          ? Uint8Array.from(mask.sdf, (v) => v + 127)
          : new Uint8Array([255]),
        {
          bytesPerRow: mask ? mask.grid.width : 1,
          rowsPerImage: mask ? mask.grid.height : 1,
        },
        mask ? [mask.grid.width, mask.grid.height] : [1, 1],
      );

      // Cast shadows: the engine owns the visibility texture + the
      // compute march over the same heights buffer. Without the option a
      // 1x1 fully-lit texture is bound and the shader term stays a no-op
      // (shadowStrength starts at 0 either way).
      if (opts.shadows) {
        shadowEngine = createShadowEngine(gpu, heightsBuffer, {
          grid: gridUniforms,
          shader: opts.shadows.shader,
          plan: opts.shadows.plan,
        });
        shadowTex = shadowEngine.texture;
      } else {
        shadowTex = texture(gpu, {
          kind: "2d",
          size: [1, 1],
          format: "rgba8unorm",
          usage: ["texture_binding", "copy_dst"],
          label: "sun-shadow-fallback",
        });
        gpu.gpu.queue.writeTexture(
          { texture: shadowTex.gpu },
          new Uint8Array([255, 255, 255, 255]),
          { bytesPerRow: 4, rowsPerImage: 1 },
          [1, 1],
        );
      }

      terrainDraw = draw(gpu, {
        shader: opts.shaders.terrain,
        label: "terrain",
        vertices: vertexCount,
        cull: "none",
        depth: { compare: "greater", write: true }, // reversed-Z
        set: {
          params,
          heights: heightsBuffer,
          satelliteTex,
          linearSampler: sampler(gpu, {
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
          }),
          overlayTex,
          deptIndexTex,
          provinceSdfTex,
          shadowTex,
        },
      });
    },

    update(state: LayerState): void {
      if (!terrainDraw) return;
      params.viewProjection = state.camera.viewProjectionMatrix();
      params.cameraPos = [...state.camera.eye()];
      params.outlinePx =
        (opts.outlineCssPx ?? 2) * (opts.pixelRatio?.() ?? 1);
      // The haze ramp scales with the orbit distance so the default
      // framing keeps full satellite color: the start sits beyond the
      // block's far corner and only grazing views pick up a soft fade.
      [params.hazeStart, params.hazeEnd] = hazeRangeKm(
        state.camera.distanceKm,
      );
      terrainDraw.set({ params });
    },

    draw(pass) {
      if (terrainDraw) pass.draw(terrainDraw);
    },

    setVerticalExaggeration(value: number): void {
      params.exaggeration = value;
      // Immediate uniform update; the next frame's update() would push it
      // anyway, but this keeps the slider responsive outside the loop.
      terrainDraw?.set({ params: { exaggeration: value } });
      // The shadow march runs over drawn heights — exaggeration is an
      // input, so a change re-dispatches the pass (when shadows are on).
      if (shadowsEnabled) {
        shadowEngine?.update(
          params.sunDir as [number, number, number],
          value,
        );
      }
      opts.onExaggeration?.(value);
    },

    setSun(direction, color, ambient): void {
      params.sunDir = [...direction];
      params.sunColor = [...color];
      params.ambientColor = [...ambient];
      terrainDraw?.set({
        params: {
          sunDir: params.sunDir,
          sunColor: params.sunColor,
          ambientColor: params.ambientColor,
        },
      });
      if (shadowsEnabled) {
        shadowEngine?.update(direction, params.exaggeration);
      }
    },

    setShadowsEnabled(enabled: boolean): void {
      if (enabled === shadowsEnabled) return;
      shadowsEnabled = enabled;
      params.shadowStrength = enabled ? 1 : 0;
      terrainDraw?.set({ params: { shadowStrength: params.shadowStrength } });
      if (enabled) {
        // First activation (or re-activation after the inputs moved)
        // triggers the march; the engine itself dedupes identical inputs.
        shadowEngine?.update(
          params.sunDir as [number, number, number],
          params.exaggeration,
        );
      }
    },

    shadowTexture(): Texture {
      if (!shadowTex) {
        throw new Error("terrain layer used before init()");
      }
      return shadowTex;
    },

    shadowMs(): number | undefined {
      return shadowEngine?.lastShadowMs;
    },

    shadowSettled(): Promise<void> {
      return shadowEngine?.whenSettled() ?? Promise.resolve();
    },

    gridUniforms,

    baseHeightsStorage(): StorageBuffer {
      if (!heightsBuffer) {
        throw new Error("terrain layer used before init()");
      }
      return heightsBuffer;
    },

    setDetailPatchMask(activeIds: ReadonlySet<string>): void {
      const rects = emptyPatchRects();
      let count = 0;
      for (const patch of opts.detailPatches ?? []) {
        if (count >= MAX_DETAIL_PATCHES) break;
        if (!activeIds.has(patch.id)) continue;
        rects[count] = [...patch.rect];
        count++;
      }
      params.patchRects = rects;
      params.patchRectCount = count;
      terrainDraw?.set({ params: { patchRects: rects, patchRectCount: count } });
    },

    setRegionsVisible(visible: boolean): void {
      if (!opts.regionOverlay) return;
      params.overlayOpacity = visible ? regionTintStrength : 0;
      params.regionBorders = visible ? 1 : 0;
      // Immediate partial uniform update, like setVerticalExaggeration;
      // the caller requests a frame so the change shows right away.
      terrainDraw?.set({
        params: {
          overlayOpacity: params.overlayOpacity,
          regionBorders: params.regionBorders,
        },
      });
    },

    getGpuMemoryReport(): GpuMemoryReport {
      const sat = opts.satellite;
      const maskCells = opts.provinceMask
        ? opts.provinceMask.grid.width * opts.provinceMask.grid.height
        : 1;
      return buildGpuMemoryReport([
        {
          label: `satellite texture ${sat.width}x${sat.height} rgba8unorm + mips`,
          bytes: textureBytesWithMips(sat.width, sat.height, 4),
        },
        {
          label: `heights storage buffer ${spec.width}x${spec.height} f32`,
          bytes: spec.width * spec.height * 4,
        },
        opts.regionOverlay
          ? {
              label: `regions overlay texture ${opts.regionOverlay.grid.width}x${opts.regionOverlay.grid.height} rgba8unorm`,
              bytes:
                opts.regionOverlay.grid.width *
                opts.regionOverlay.grid.height *
                4,
            }
          : { label: "overlay texture 1x1", bytes: 4 },
        {
          label: `department index texture ${opts.provinceMask?.grid.width ?? 1}x${opts.provinceMask?.grid.height ?? 1} r8unorm`,
          bytes: maskCells,
        },
        {
          label: `province SDF texture ${opts.provinceMask?.grid.width ?? 1}x${opts.provinceMask?.grid.height ?? 1} r8unorm`,
          bytes: maskCells,
        },
        opts.shadows
          ? {
              label: `sun shadow texture ${opts.shadows.plan.width}x${opts.shadows.plan.height} rgba8unorm`,
              bytes:
                opts.shadows.plan.width * opts.shadows.plan.height * 4,
            }
          : { label: "sun shadow fallback texture 1x1", bytes: 4 },
        {
          label: "terrain uniforms (approx)",
          // Params (terrain.wgsl) at natural WGSL alignment: mat4x4f
          // (64 B) + cameraPos vec3f (12 B + 4 B pad) + 6 vec2f (48 B)
          // + 4 f32 (16 B) + 3 vec3f (48 B) + 8 f32 (32 B) = 224 B, the
          // patch rect array (MAX_DETAIL_PATCHES x vec4f = 128 B), then
          // patchRectCount + tail pad → ~368 B.
          bytes: 368,
          estimate: true,
        },
      ]);
    },
  };
  return layer;
}
