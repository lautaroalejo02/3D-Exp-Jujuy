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
import {
  detailPatchCenterBaseGrid,
  detailPatchRectBaseGrid,
  MAX_DETAIL_PATCHES,
  patchBaseGridMap,
} from "../../terrain/detail-grids";
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
  DETAIL_SPLIT_BAND_CELLS,
  detailDrawDistanceKm,
  patchGlobalPixelToWorld,
} from "./detail-uniforms";

/**
 * High-resolution detail patches: a small mesh + satellite texture per
 * site, draped over the base terrain where its coarse pixels (70–140 m)
 * undersell places like the Hornocal stripes (~9 m/px here).
 *
 * Drawn after the terrain layer inside the same pass. There is NO lift:
 * the base terrain discards its fragments inside each drawn patch's full
 * rect and the patch geomorphs its elevation onto the base surface across
 * the border band — see detail.wgsl for the mechanics. Unlike the base
 * terrain the patch applies NO outside-province dimming: sites can
 * straddle the border (Salinas Grandes does) and dimming would erase
 * exactly the detail they carry.
 *
 * OVERLAP ARBITRATION (task A1): when two drawn patches cover the same
 * base-grid pixels — tilcara touches siete-colores, humahuaca may touch
 * hornocal — the shader runs a Voronoi split on patch centers and only
 * the owner draws each pixel (detail.wgsl). Every drawn patch's uniforms
 * therefore carry the rects+centers of the WHOLE covering set plus its
 * own slot; refreshArbitration() rewrites them whenever that set
 * changes, in the same runtimes order the CPU picking twin
 * (detail-pick.ts) sees.
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
  /**
   * The base terrain's drawn surface, shared — never duplicated. `grid`
   * is the terrain layer's own grid uniforms (mesh spacing included) and
   * `heights()` returns its heights storage buffer; it is only called
   * inside the async loader, once the terrain layer has initialized.
   */
  readonly baseSurface: {
    readonly grid: TerrainGridUniforms;
    heights(): StorageBuffer;
  };
  readonly sites: readonly DetailSiteData[];
  readonly shaders: DetailLayerShaders;
  /** Live vertical exaggeration (the value the terrain slider drives). */
  readonly verticalExaggeration: () => number;
  readonly ambient?: number;
  readonly lightStrength?: number;
  /**
   * Base-resolution sun-shadow texture (the terrain layer's engine
   * output), bound on every site draw — the getter runs inside the
   * async loader, after the terrain layer has initialized. Absent: a
   * 1x1 fully-lit fallback is bound.
   */
  readonly shadowTexture?: () => Texture;
  /**
   * Fires once per site when its GPU resources finish creating — the
   * app should request a frame (dirty tracker) and refresh any GPU
   * memory readout. Runs on the loader task, never inside update/draw.
   */
  readonly onSiteReady?: (site: DetailSite) => void;
  /**
   * Fires whenever the set of COVERING sites changes — a site covers
   * while it is loaded AND inside its draw distance, which is exactly
   * when the base terrain may discard fragments under it. The app gates
   * the base-terrain mask on this so a site that is merely in range but
   * still loading, or loaded but out of range, never punches a hole.
   * May fire inside update() (visibility edge) or on the loader task
   * (load finished while in range).
   */
  readonly onCoveringChange?: (siteIds: readonly string[]) => void;
  /**
   * How the async loader is scheduled; defaults to setTimeout(0), which
   * is what guarantees resource creation runs outside the frameLoop
   * callback stack. Injectable for tests/headless drivers.
   */
  readonly schedule?: (task: () => void) => void;
}

export interface DetailLayer extends Layer {
  /** Push the sun light — same convention as TerrainLayer.setSun. */
  setSun(
    direction: readonly [number, number, number],
    color: readonly [number, number, number],
    ambient: readonly [number, number, number],
  ): void;
  /** Fade the cast-shadow term in or out (same flag as the terrain). */
  setShadowsEnabled(enabled: boolean): void;
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
  sunColor: number[];
  ambientColor: number[];
  sunDir: number[];
  shadowStrength: number;
  biasNdc: number;
  edgeFade: number;
  patchToBaseK: readonly [number, number];
  patchToBaseC: readonly [number, number];
  baseGridSize: readonly [number, number];
  baseMeshToGrid: readonly [number, number];
  /**
   * Voronoi overlap arbitration (detail.wgsl): rects [i0,j0,i1,j1] and
   * centers (xy) of the currently drawn patches — patchCount of them —
   * in base grid coords; patchIndex is this draw's slot.
   */
  patchRects: number[][];
  patchCenters: number[][];
  patchCount: number;
  patchIndex: number;
  splitBand: number;
}

const IDENTITY_MAT4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/**
 * Inactive arbitration slots get a degenerate rect (i0 > i1) so the
 * contain test can never fire even if the shader read past patchCount.
 */
function emptySlotRects(): number[][] {
  return Array.from({ length: MAX_DETAIL_PATCHES }, () => [0, 0, -1, -1]);
}

function emptySlotCenters(): number[][] {
  return Array.from({ length: MAX_DETAIL_PATCHES }, () => [0, 0, 0, 0]);
}

interface SiteGpuResources {
  readonly heights: StorageBuffer;
  readonly satellite: Texture;
  readonly draw: Draw;
}

interface SiteRuntime {
  readonly data: DetailSiteData;
  readonly params: DetailParamsValue;
  /** Full outer extent in base grid coords: [i0, j0, i1, j1]. */
  readonly baseRect: readonly [number, number, number, number];
  /** Patch center in base grid coords (Voronoi arbitration point). */
  readonly baseCenter: readonly [number, number];
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
    const toBase = patchBaseGridMap(spec, opts.baseSpec);
    const [pcx, pcy] = gridCenterGlobalPixel(spec);
    return {
      data,
      params: {
        ...gridUniforms,
        viewProjection: [...IDENTITY_MAT4],
        exaggeration: opts.verticalExaggeration(),
        // Same default light as the terrain: NW 45 deg, grey direct,
        // grey ambient — the shipped look until the sun mode drives it.
        sunColor: [
          opts.lightStrength ?? 0.85,
          opts.lightStrength ?? 0.85,
          opts.lightStrength ?? 0.85,
        ],
        ambientColor: [
          opts.ambient ?? 0.42,
          opts.ambient ?? 0.42,
          opts.ambient ?? 0.42,
        ],
        sunDir: [-0.5, 0.7071067811865476, -0.5],
        shadowStrength: 0,
        biasNdc: DETAIL_DEPTH_BIAS_NDC,
        edgeFade: DETAIL_EDGE_FADE,
        patchToBaseK: toBase.k,
        patchToBaseC: toBase.c,
        baseGridSize: opts.baseSurface.grid.gridSize,
        baseMeshToGrid: opts.baseSurface.grid.meshToGrid,
        // Filled by refreshArbitration() once sites start covering.
        patchRects: emptySlotRects(),
        patchCenters: emptySlotCenters(),
        patchCount: 0,
        patchIndex: 0,
        splitBand: DETAIL_SPLIT_BAND_CELLS,
      },
      baseRect: detailPatchRectBaseGrid(spec, opts.baseSpec),
      baseCenter: detailPatchCenterBaseGrid(spec, opts.baseSpec),
      centerWorld: patchGlobalPixelToWorld(gridUniforms, pcx, pcy),
      drawDistanceKm: detailDrawDistanceKm(data.site.sizeKm),
      status: "idle",
      visible: false,
    };
  });

  /**
   * Rewrite the Voronoi arbitration uniforms on every runtime from the
   * current covering set (visible AND loaded = exactly what draw()
   * draws), in runtimes order — the same order the CPU picking twin
   * sees. Runs inside update() so the uniforms each frame's draw.set
   * pushes already reflect any covering change.
   */
  const refreshArbitration = (): void => {
    const covering = runtimes.filter(
      (rt) => rt.visible && rt.gpu !== undefined,
    );
    if (covering.length > MAX_DETAIL_PATCHES) {
      console.warn(
        `detail patches: ${covering.length} covering sites exceed the ` +
          `${MAX_DETAIL_PATCHES}-slot shader limit; extra patches draw ` +
          `without overlap arbitration`,
      );
    }
    const slots = covering.slice(0, MAX_DETAIL_PATCHES);
    const rects = emptySlotRects();
    const centers = emptySlotCenters();
    slots.forEach((rt, i) => {
      rects[i] = [...rt.baseRect];
      centers[i] = [rt.baseCenter[0], rt.baseCenter[1], 0, 0];
    });
    const indexByRuntime = new Map<SiteRuntime, number>(
      slots.map((rt, i) => [rt, i]),
    );
    for (const rt of runtimes) {
      rt.params.patchRects = rects;
      rt.params.patchCenters = centers;
      rt.params.patchCount = slots.length;
      rt.params.patchIndex = indexByRuntime.get(rt) ?? 0;
    }
  };

  let gpuRef: Gpu | undefined;
  let fallbackShadowTex: Texture | undefined;

  // Layer-level sun state: shared by every site draw. Written into each
  // runtime's params on setSun/setShadowsEnabled so a draw created later
  // (async site load) picks up the current values automatically.
  const sun: {
    direction: readonly [number, number, number];
    color: readonly [number, number, number];
    ambient: readonly [number, number, number];
    shadowsEnabled: boolean;
  } = {
    direction: [-0.5, 0.7071067811865476, -0.5],
    color: [
      opts.lightStrength ?? 0.85,
      opts.lightStrength ?? 0.85,
      opts.lightStrength ?? 0.85,
    ],
    ambient: [opts.ambient ?? 0.42, opts.ambient ?? 0.42, opts.ambient ?? 0.42],
    shadowsEnabled: false,
  };
  const applySunTo = (rt: SiteRuntime): void => {
    rt.params.sunDir = [...sun.direction];
    rt.params.sunColor = [...sun.color];
    rt.params.ambientColor = [...sun.ambient];
    rt.params.shadowStrength = sun.shadowsEnabled ? 1 : 0;
  };

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
    // The site's uniforms must already carry the layer's current sun
    // state — the params object was seeded with defaults at creation.
    applySunTo(rt);
    const shadowTex = opts.shadowTexture?.() ?? fallbackShadowTex;
    if (!shadowTex) {
      throw new Error("detail layer used before init()");
    }
    return {
      heights,
      satellite,
      draw: draw(gpu, {
        shader: opts.shaders.detail,
        label: `detail-${rt.data.site.id}`,
        vertices: vertexCount,
        cull: "none",
        // Reversed-Z like the base terrain; the shared border line is
        // handled by the shader's clip-z bias. Opaque: the base under the
        // patch is discarded, so there is nothing to blend with.
        depth: { compare: "greater", write: true },
        set: {
          params: rt.params,
          heights,
          baseHeights: opts.baseSurface.heights(),
          satelliteTex: satellite,
          shadowTex,
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
    // A site that just became ready (or failed) while the camera is in
    // range changes the covering set; report before resolving waiters so
    // the base mask is already right when whenSettled() resolves.
    syncCovering();
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

  // The sites whose patches currently cover the base terrain (loaded AND
  // in draw distance) — the same condition draw() uses. Reported to the
  // app so the base-terrain discard mask tracks it exactly.
  let coveringKey = "";
  const syncCovering = (): void => {
    const ids = runtimes
      .filter((rt) => rt.visible && rt.gpu !== undefined)
      .map((rt) => rt.data.site.id);
    const key = ids.join(",");
    if (key === coveringKey) return;
    coveringKey = key;
    opts.onCoveringChange?.(ids);
  };

  return {
    id: "detail",

    init(ctx: LayerContext): void {
      // Only the Gpu handle is kept: per-site resources are created by
      // the scheduled loader — see the module comment. A camera that
      // never approaches a patch should not pay ~28 MiB for it.
      gpuRef = ctx.gpu;
      // 1x1 fully-lit shadow fallback for site draws when the app does
      // not provide the terrain's shadow texture.
      fallbackShadowTex = texture(ctx.gpu, {
        kind: "2d",
        size: [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst"],
        label: "detail-shadow-fallback",
      });
      ctx.gpu.gpu.queue.writeTexture(
        { texture: fallbackShadowTex.gpu },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4, rowsPerImage: 1 },
        [1, 1],
      );
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
      }
      // The covering set just settled for this frame; arbitration
      // uniforms go out with the same draw.set batch.
      refreshArbitration();
      for (const rt of runtimes) {
        if (!rt.visible || !rt.gpu) continue; // requested/loading/failed: base terrain shows
        rt.params.viewProjection = viewProjection;
        rt.params.exaggeration = exaggeration;
        rt.gpu.draw.set({ params: rt.params });
      }
      // Visibility edges flip the covering set even without any load —
      // the base terrain must discard exactly while a patch is drawn.
      syncCovering();
    },

    draw(pass: FramePass): void {
      for (const rt of runtimes) {
        if (rt.visible && rt.gpu) pass.draw(rt.gpu.draw);
      }
    },

    setSun(direction, color, ambient): void {
      sun.direction = direction;
      sun.color = color;
      sun.ambient = ambient;
      for (const rt of runtimes) {
        applySunTo(rt);
        rt.gpu?.draw.set({
          params: {
            sunDir: rt.params.sunDir,
            sunColor: rt.params.sunColor,
            ambientColor: rt.params.ambientColor,
          },
        });
      }
    },

    setShadowsEnabled(enabled: boolean): void {
      if (enabled === sun.shadowsEnabled) return;
      sun.shadowsEnabled = enabled;
      for (const rt of runtimes) {
        applySunTo(rt);
        rt.gpu?.draw.set({
          params: { shadowStrength: rt.params.shadowStrength },
        });
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
