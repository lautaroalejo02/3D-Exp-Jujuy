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

import type { Layer, LayerContext, LayerState } from "../../app/layers";
import { gridCenterGlobalPixel, type GridSpec } from "../../geo";
import {
  buildGpuMemoryReport,
  mipLevelCount,
  textureBytesWithMips,
  type GpuMemoryEntry,
  type GpuMemoryReport,
} from "../../render/gpu-memory";
import { generateMipmaps } from "../../render/mipmap";
import type { DetailSite } from "../../terrain/detail-manifest";
import type { Heightfield } from "../../terrain/heightfield";
import type { SatelliteImage } from "../../terrain/satellite";
import type { TerrainGridUniforms } from "../../terrain/terrain-uniforms";
import {
  cameraInDrawDistance,
  nextDetailSiteStatus,
  type DetailSiteStatus,
} from "./detail-load";
import {
  buildPatchGridUniforms,
  DETAIL_DEPTH_BIAS_NDC,
  DETAIL_EDGE_FADE,
  detailDrawDistanceKm,
  patchGlobalPixelToWorld,
} from "./detail-uniforms";

/**
 * High-resolution detail patches: a small mesh + satellite texture per
 * site, draped over the base terrain where its coarse pixels (70–140 m)
 * undersell places like the Hornocal stripes (~9 m/px here).
 *
 * Drawn after the terrain layer inside the same pass; the patch wins the
 * depth test through a uniform elevation lift (tapered to zero across the
 * border fade band) plus a small clip-space z bias — see detail.wgsl for
 * the mechanics. Unlike the base terrain the patch applies NO
 * outside-province dimming: sites can straddle the border (Salinas Grandes
 * does) and dimming would erase exactly the detail they carry.
 *
 * LAZY GPU ALLOCATION, OUTSIDE THE FRAME LOOP (task D1b): a site's
 * resources (~28 MiB of texture + storage, ~7 MiB on mobile) are created
 * exactly once, but never inside update()/draw() — both run on the
 * frameLoop callback stack, where the layers contract forbids resource
 * creation. update() only runs the pure per-site state machine
 * (detail-load.ts): when the camera enters the draw distance the site
 * goes idle -> requested and is pushed onto a queue. A loader task —
 * scheduled with setTimeout(0) by default, so it runs off the frameLoop
 * stack — creates storage/texture/sampler/draw + mipmaps in its own
 * try/catch: a failure warns and marks the site "failed" (disabled) for
 * the session instead of reaching the app's render-error handler, and
 * the base terrain keeps showing underneath while a site loads. The app
 * gets onSiteReady so it can dirty a frame once the patch can draw.
 */

/** CPU-side data for one site: decoded heights + satellite image. */
export interface DetailSiteData {
  readonly site: DetailSite;
  readonly heightfield: Heightfield;
  readonly satellite: SatelliteImage;
}

export interface DetailLayerShaders {
  /** detail.wgsl (or its resolved WGSL text). */
  readonly detail: string | ShaderSource;
  /** mipmap.wgsl (or its resolved WGSL text). */
  readonly mipmap: string | ShaderSource;
}

export interface DetailLayerOptions {
  /** GridSpec of the loaded base terrain level (world-space anchor). */
  readonly baseSpec: GridSpec;
  readonly sites: readonly DetailSiteData[];
  readonly shaders: DetailLayerShaders;
  /** Live vertical exaggeration (the value the terrain slider drives). */
  readonly verticalExaggeration: () => number;
  readonly ambient?: number;
  readonly lightStrength?: number;
  /**
   * Fires once per site when its GPU resources finish creating — the
   * app should request a frame (dirty tracker) and refresh any GPU
   * memory readout. Runs on the loader task, never inside update/draw.
   */
  readonly onSiteReady?: (site: DetailSite) => void;
  /**
   * How the async loader is scheduled; defaults to setTimeout(0), which
   * is what guarantees resource creation runs outside the frameLoop
   * callback stack. Injectable for tests/headless drivers.
   */
  readonly schedule?: (task: () => void) => void;
}

export interface DetailLayer extends Layer {
  getGpuMemoryReport(): GpuMemoryReport;
  /**
   * Resolves when every queued/in-flight site load has settled (ready or
   * failed). Headless drivers (render-snapshot) await this after
   * update(), then call update() again so the just-created draws get
   * their uniforms before the frame is encoded.
   */
  whenSettled(): Promise<void>;
}

// Uniform struct mirrored by Params in detail.wgsl. `viewProjection` and
// `exaggeration` are rewritten every update; the rest is static per site.
interface DetailParamsValue extends TerrainGridUniforms {
  viewProjection: number[];
  exaggeration: number;
  ambient: number;
  lightStrength: number;
  liftMeters: number;
  biasNdc: number;
  edgeFade: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

interface SiteGpuResources {
  readonly heights: StorageBuffer;
  readonly satellite: Texture;
  readonly draw: Draw;
}

interface SiteRuntime {
  readonly data: DetailSiteData;
  readonly params: DetailParamsValue;
  /** Patch center in base-world km on the ground plane: [x, z]. */
  readonly centerWorld: readonly [number, number];
  /** Camera distance below which the patch is drawn, in km. */
  readonly drawDistanceKm: number;
  /** Lazy-load state machine position (detail-load.ts). */
  status: DetailSiteStatus;
  /** True while the camera is inside the site's draw distance. */
  visible: boolean;
  gpu?: SiteGpuResources;
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
      `detail satellite RGBA payload ${image.pixels.length} does not match ${image.width}x${image.height}x4`,
    );
  }
  gpu.gpu.queue.writeTexture(
    { texture: tex.gpu },
    // jpeg-js allocates a plain ArrayBuffer; narrow the wider
    // Uint8Array<ArrayBufferLike> field type for writeTexture.
    image.pixels as Uint8Array<ArrayBuffer>,
    { bytesPerRow: image.width * 4, rowsPerImage: image.height },
    [image.width, image.height],
  );
}

export function createDetailLayer(opts: DetailLayerOptions): DetailLayer {
  const runtimes: SiteRuntime[] = opts.sites.map((data) => {
    const spec = data.heightfield.spec;
    // Mesh one vertex per height cell plus the closing border vertex:
    // interior vertices land on cell borders, preserving the full z12
    // detail (~35 m) — the point of the patch.
    const mesh: readonly [number, number] = [
      spec.width + 1,
      spec.height + 1,
    ];
    const gridUniforms = buildPatchGridUniforms(spec, opts.baseSpec, mesh);
    const [pcx, pcy] = gridCenterGlobalPixel(spec);
    return {
      data,
      params: {
        ...gridUniforms,
        viewProjection: [...IDENTITY_MAT4],
        exaggeration: opts.verticalExaggeration(),
        ambient: opts.ambient ?? 0.42,
        lightStrength: opts.lightStrength ?? 0.85,
        liftMeters: data.site.liftMeters,
        biasNdc: DETAIL_DEPTH_BIAS_NDC,
        edgeFade: DETAIL_EDGE_FADE,
      },
      centerWorld: patchGlobalPixelToWorld(gridUniforms, pcx, pcy),
      drawDistanceKm: detailDrawDistanceKm(data.site.sizeKm),
      status: "idle",
      visible: false,
    };
  });

  let gpuRef: Gpu | undefined;

  /**
   * Creates every GPU resource one site needs (heights storage, satellite
   * texture + mip chain, sampler, draw). Throws on any GPU error — the
   * caller owns the try/catch, so this stays a straight-line build.
   */
  const createSiteGpuResources = (gpu: Gpu, rt: SiteRuntime): SiteGpuResources => {
    const heights = storage(
      gpu,
      rt.data.heightfield.data.byteLength,
      "read",
    );
    // Heightfield.data is Float32Array<ArrayBufferLike>-typed; the decode
    // path allocates a plain ArrayBuffer — narrow for writeBuffer.
    heights.write(rt.data.heightfield.data as Float32Array<ArrayBuffer>);

    const sat = rt.data.satellite;
    const satellite = texture(gpu, {
      kind: "2d",
      size: [sat.width, sat.height],
      format: "rgba8unorm",
      mipLevelCount: mipLevelCount(sat.width, sat.height),
      usage: [
        "texture_binding",
        "copy_dst",
        "storage_binding",
        // required by copyExternalImageToTexture (browser bitmap path)
        "render_attachment",
      ],
      label: `detail-satellite-${rt.data.site.id}`,
    });
    uploadSatellite(gpu, satellite, sat);
    generateMipmaps(gpu, opts.shaders.mipmap, satellite);

    const vertexCount =
      (rt.params.meshSize[0] - 1) * (rt.params.meshSize[1] - 1) * 6;
    return {
      heights,
      satellite,
      draw: draw(gpu, {
        shader: opts.shaders.detail,
        label: `detail-${rt.data.site.id}`,
        vertices: vertexCount,
        cull: "none",
        // Reversed-Z like the base terrain; the win over the coincident
        // base surface comes from the shader's lift + clip-z bias.
        depth: { compare: "greater", write: true },
        blend: "alpha",
        set: {
          params: rt.params,
          heights,
          satelliteTex: satellite,
          linearSampler: sampler(gpu, {
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
          }),
        },
      }),
    };
  };

  // The async loader queue. update() — inside the frameLoop callback —
  // only appends "requested" sites here; the scheduled flush does all
  // GPU work off that stack (see the module comment).
  const pendingLoads: SiteRuntime[] = [];
  let flushScheduled = false;
  const settleWaiters = new Set<() => void>();
  const schedule = opts.schedule ?? ((task: () => void) => setTimeout(task, 0));

  const notifySettledIfIdle = (): void => {
    if (flushScheduled || pendingLoads.length > 0) return;
    for (const resolve of settleWaiters) resolve();
    settleWaiters.clear();
  };

  const flushLoads = (): void => {
    flushScheduled = false;
    let rt: SiteRuntime | undefined;
    while ((rt = pendingLoads.shift()) !== undefined) {
      rt.status = nextDetailSiteStatus(rt.status, "load-start");
      try {
        if (!gpuRef) {
          throw new Error("detail layer used before init()");
        }
        rt.gpu = createSiteGpuResources(gpuRef, rt);
        rt.status = nextDetailSiteStatus(rt.status, "load-ok");
        opts.onSiteReady?.(rt.data.site);
      } catch (error) {
        // Never the global render-error handler: a broken patch disables
        // itself and the base terrain simply keeps rendering.
        rt.status = nextDetailSiteStatus(rt.status, "load-fail");
        console.warn(`detail patch ${rt.data.site.id} disabled`, error);
      }
    }
    notifySettledIfIdle();
  };

  /** Queue a freshly "requested" site for the async loader. */
  const enqueueLoad = (rt: SiteRuntime): void => {
    pendingLoads.push(rt);
    if (!flushScheduled) {
      flushScheduled = true;
      schedule(flushLoads);
    }
  };

  return {
    id: "detail",

    init(ctx: LayerContext): void {
      // Only the Gpu handle is kept: per-site resources are created by
      // the scheduled loader — see the module comment. A camera that
      // never approaches a patch should not pay ~28 MiB for it.
      gpuRef = ctx.gpu;
    },

    update(state: LayerState): void {
      const eye = state.camera.eye();
      const viewProjection = state.camera.viewProjectionMatrix();
      const exaggeration = opts.verticalExaggeration();
      for (const rt of runtimes) {
        rt.visible = cameraInDrawDistance(
          eye[0],
          eye[2],
          rt.centerWorld[0],
          rt.centerWorld[1],
          rt.drawDistanceKm,
        );
        if (!rt.visible) continue;
        // Detection only: the idle -> requested edge queues the site for
        // the off-stack loader; every later in-range frame is a no-op.
        const previous = rt.status;
        rt.status = nextDetailSiteStatus(rt.status, "camera-in-range");
        if (previous === "idle" && rt.status === "requested") {
          enqueueLoad(rt);
        }
        if (!rt.gpu) continue; // requested/loading/failed: base terrain shows
        rt.params.viewProjection = viewProjection;
        rt.params.exaggeration = exaggeration;
        rt.gpu.draw.set({ params: rt.params });
      }
    },

    draw(pass: FramePass): void {
      for (const rt of runtimes) {
        if (rt.visible && rt.gpu) pass.draw(rt.gpu.draw);
      }
    },

    whenSettled(): Promise<void> {
      if (!flushScheduled && pendingLoads.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        settleWaiters.add(resolve);
      });
    },

    getGpuMemoryReport(): GpuMemoryReport {
      // Only sites whose resources actually exist are reported — the
      // total grows as the camera approaches new patches.
      const entries: GpuMemoryEntry[] = [];
      for (const rt of runtimes) {
        if (!rt.gpu) continue;
        const spec = rt.data.heightfield.spec;
        const sat = rt.data.satellite;
        entries.push(
          {
            label: `detail ${rt.data.site.id} satellite ${sat.width}x${sat.height} rgba8unorm + mips`,
            bytes: textureBytesWithMips(sat.width, sat.height, 4),
          },
          {
            label: `detail ${rt.data.site.id} heights ${spec.width}x${spec.height} f32`,
            bytes: spec.width * spec.height * 4,
          },
        );
      }
      return buildGpuMemoryReport(entries);
    },
  };
}
