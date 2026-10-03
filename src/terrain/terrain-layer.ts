import {
  draw,
  sampler,
  storage,
  texture,
  type Draw,
  type Gpu,
  type ShaderSource,
  type Texture,
} from "vgpu";

import type { Layer, LayerContext, LayerState } from "../app/layers";
import {
  buildGpuMemoryReport,
  mipLevelCount,
  textureBytesWithMips,
  type GpuMemoryReport,
} from "../render/gpu-memory";
import { generateMipmaps } from "../render/mipmap";
import { createTerrainControls } from "../ui/controls";
import type { Heightfield, TerrainQuality } from "./heightfield";
import type { SatelliteImage } from "./satellite";
import { buildTerrainGridUniforms } from "./terrain-uniforms";

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
}

export interface TerrainLayer extends Layer {
  /** Update the vertical exaggeration uniform (slider callback). */
  setVerticalExaggeration(value: number): void;
  /** Toggle the region tint + borders (the "Regiones" UI toggle). */
  setRegionsVisible(visible: boolean): void;
  /** Vertex count of the generated mesh draw call. */
  readonly vertexCount: number;
  readonly meshSize: MeshSize;
  getGpuMemoryReport(): GpuMemoryReport;
}

// Uniform struct mirrored by Params in terrain.wgsl. `viewProjection` is
// rewritten every frame; the rest changes only through the setters below.
interface TerrainParamsValue {
  viewProjection: number[];
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
  ambient: number;
  lightStrength: number;
  overlayOpacity: number;
  dimStrength: number;
  outlinePx: number;
  deptBorders: number;
  regionBorders: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

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
    deptGridSize: opts.provinceMask
      ? [opts.provinceMask.grid.width, opts.provinceMask.grid.height]
      : [1, 1],
    exaggeration: opts.verticalExaggeration ?? DEFAULT_VERTICAL_EXAGGERATION,
    ambient: opts.ambient ?? 0.42,
    lightStrength: opts.lightStrength ?? 0.85,
    overlayOpacity: opts.showRegions ? regionTintStrength : 0,
    dimStrength: opts.dimStrength ?? 0.55,
    outlinePx: opts.outlineCssPx ?? 2,
    deptBorders: opts.showDepartmentBorders ? 1 : 0,
    regionBorders: opts.showRegions ? 1 : 0,
  };

  let heightsBuffer: ReturnType<typeof storage> | undefined;
  let satelliteTex: Texture | undefined;
  let overlayTex: Texture | undefined;
  let deptIndexTex: Texture | undefined;
  let provinceSdfTex: Texture | undefined;
  let terrainDraw: Draw | undefined;

  const layer: TerrainLayer = {
    id: "terrain",
    vertexCount,
    meshSize: mesh,

    // Exaggeration slider + quality toggle, mounted by the app into the
    // overlay root. DOM lives behind `ui` so init/update/draw stay headless.
    ui: {
      mount(root: HTMLElement): () => void {
        const panel = createTerrainControls({
          quality,
          initialExaggeration: params.exaggeration,
          onExaggeration: (v) => layer.setVerticalExaggeration(v),
          warnHighQualityOnMobile: opts.warnHighQualityOnMobile,
        });
        root.appendChild(panel);
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
        },
      });
    },

    update(state: LayerState): void {
      if (!terrainDraw) return;
      params.viewProjection = state.camera.viewProjectionMatrix();
      params.outlinePx =
        (opts.outlineCssPx ?? 2) * (opts.pixelRatio?.() ?? 1);
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
      opts.onExaggeration?.(value);
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
        {
          label: "terrain uniforms (approx)",
          bytes: 64 + 6 * 8 + 12 * 4,
          estimate: true,
        },
      ]);
    },
  };
  return layer;
}
