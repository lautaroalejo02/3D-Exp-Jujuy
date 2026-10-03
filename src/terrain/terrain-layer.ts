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
   * Called whenever the exaggeration changes (slider or setter), so the
   * app can keep other layers (e.g. the pick marker) in sync.
   */
  readonly onExaggeration?: (value: number) => void;
}

export interface TerrainLayer extends Layer {
  /** Update the vertical exaggeration uniform (slider callback). */
  setVerticalExaggeration(value: number): void;
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
  kmPerPx: number;
  cellScale: number;
  cellKm: number;
  exaggeration: number;
  ambient: number;
  lightStrength: number;
  overlayOpacity: number;
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

  const params: TerrainParamsValue = {
    ...gridUniforms,
    viewProjection: [...IDENTITY_MAT4],
    exaggeration: opts.verticalExaggeration ?? 2.5,
    ambient: opts.ambient ?? 0.42,
    lightStrength: opts.lightStrength ?? 0.85,
    overlayOpacity: 1,
  };

  let heightsBuffer: ReturnType<typeof storage> | undefined;
  let satelliteTex: Texture | undefined;
  let overlayTex: Texture | undefined;
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

      // Overlay slot for future layers (regions tint, …): 1x1 transparent
      // by default so the shader's mix() is a no-op until a real overlay
      // is bound.
      overlayTex = texture(gpu, {
        kind: "2d",
        size: [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "terrain-overlay",
      });
      gpu.gpu.queue.writeTexture(
        { texture: overlayTex.gpu },
        new Uint8Array([0, 0, 0, 0]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1],
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
        },
      });
    },

    update(state: LayerState): void {
      if (!terrainDraw) return;
      params.viewProjection = state.camera.viewProjectionMatrix();
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

    getGpuMemoryReport(): GpuMemoryReport {
      const sat = opts.satellite;
      return buildGpuMemoryReport([
        {
          label: `satellite texture ${sat.width}x${sat.height} rgba8unorm + mips`,
          bytes: textureBytesWithMips(sat.width, sat.height, 4),
        },
        {
          label: `heights storage buffer ${spec.width}x${spec.height} f32`,
          bytes: spec.width * spec.height * 4,
        },
        { label: "overlay texture 1x1", bytes: 4 },
        {
          label: "terrain uniforms (approx)",
          bytes: 64 + 5 * 8 + 7 * 4 + 4,
          estimate: true,
        },
      ]);
    },
  };
  return layer;
}
