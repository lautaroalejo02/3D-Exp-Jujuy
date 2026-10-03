import {
  clock,
  frameLoop,
  init,
  surface,
  type Frame,
  type FrameLoopHandle,
  type Gpu,
} from "vgpu";

import {
  planRender,
  profileOverrideFromSearch,
  selectDeviceProfile,
} from "./app/device-profile";
import { createDirtyTracker } from "./app/dirty-tracker";
import type { Layer, LayerState } from "./app/layers";
import { checkWebGpuSupport, type WebGpuSupport } from "./app/webgpu-support";
import { bboxOnGrid, overviewCamera } from "./camera/framing";
import { attachCameraInput } from "./camera/input";
import { detailSatelliteDivisor } from "./features/detail/detail-load";
import {
  createDetailLayer,
  type DetailSiteData,
} from "./features/detail/detail-layer";
import { DETAIL_EDGE_FADE } from "./features/detail/detail-uniforms";
import detailShader from "./features/detail/detail.wgsl";
import { createPickMarkerLayer } from "./features/pick-marker/pick-marker";
import markerShader from "./features/pick-marker/pick-marker.wgsl";
import { createPlacesLayer } from "./features/places/places-layer";
import { metersPerGridCell } from "./geo";
import {
  detailSurfaceElevation,
  type DetailPickPatch,
} from "./picking/detail-pick";
import { intersectHeightfield, screenToRay } from "./picking/ray";
import { formatBytes, type GpuMemoryEntry } from "./render/gpu-memory";
import mipmapShader from "./render/mipmap.wgsl";
import presentShader from "./render/present.wgsl";
import { createSceneRenderer } from "./render/scene-renderer";
import {
  loadDepartments,
  type DepartmentsData,
} from "./terrain/departments";
import {
  buildDetailPatchRects,
  patchBaseGridMap,
} from "./terrain/detail-grids";
import {
  assertDetailSatelliteSize,
  loadDetailManifest,
  loadDetailSite,
  type DetailSite,
} from "./terrain/detail-manifest";
import {
  buildDepartmentToRegion,
  buildRegionOverlay,
  departmentToRegionNames,
  parseRegions,
  type RegionsData,
} from "./terrain/regions";
import {
  loadHeightfield,
  loadTerrainManifest,
  type TerrainQuality,
} from "./terrain/heightfield";
import { loadPlaces, type Place } from "./terrain/places-manifest";
import type { SatelliteImage } from "./terrain/satellite";
import { assertSameGroundExtent } from "./terrain/validate";
import {
  createTerrainLayer,
  DEFAULT_VERTICAL_EXAGGERATION,
} from "./terrain/terrain-layer";
import terrainShader from "./terrain/terrain.wgsl";
import { createAttributionPanel } from "./ui/attributions";
import { createLoadingMessage } from "./ui/controls";
import { createDebugOverlay, type DebugOverlay } from "./ui/debug-overlay";
import { createPickPanelLayer } from "./ui/pick-panel";
import { createRegionsControls } from "./ui/regions";

// Bundled as a raw string (Vite ?raw) and validated by parseRegions; the
// file is hand-authored from the verified PIP Jujuy source — see
// data/raw/regions-jujuy.json and odd/research/pip-jujuy-extracto.txt.
import regionsJsonText from "../data/raw/regions-jujuy.json?raw";

function describeFailure(result: Extract<WebGpuSupport, { supported: false }>): string {
  switch (result.reason) {
    case "api-missing":
      return "Este navegador no tiene la API WebGPU.";
    case "adapter-unavailable":
      return "El navegador tiene WebGPU, pero no encontró una placa de video compatible.";
    case "adapter-request-failed":
      return "El navegador tiene WebGPU, pero falló al pedir acceso a la placa de video.";
  }
}

function showWebGpuNotice(
  overlay: HTMLElement,
  reason: string,
  detail?: string,
  reload = false,
): void {
  const notice = document.createElement("section");
  notice.className = "webgpu-notice";

  const title = document.createElement("h1");
  title.textContent = "Tu navegador no puede mostrar la maqueta 3D";

  const what = document.createElement("p");
  what.textContent =
    "Esta página usa WebGPU, una tecnología que dibuja gráficos 3D con la placa de video del dispositivo.";

  const why = document.createElement("p");
  why.textContent = reason;

  const browsers = document.createElement("p");
  browsers.textContent =
    "Probá con Chrome o Edge recientes en una PC de escritorio o en Android, o con Safari 26 o superior.";

  notice.append(title, what, why, browsers);

  if (reload) {
    // Mobile browsers drop the GPU state when the page goes to the
    // background; a reload is the only reliable recovery.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "webgpu-notice-reload";
    button.textContent = "Recargar";
    button.addEventListener("click", () => {
      window.location.reload();
    });
    notice.appendChild(button);
  }

  if (detail) {
    const detailEl = document.createElement("p");
    detailEl.className = "detail";
    detailEl.textContent = detail;
    notice.appendChild(detailEl);
  }

  overlay.appendChild(notice);
}

/** Mounts the attribution panel once, no matter how many failure paths run. */
function mountAttributions(overlay: HTMLElement): void {
  if (overlay.querySelector(".attributions")) return;
  overlay.appendChild(createAttributionPanel());
}

interface TerrainData {
  readonly heightfield: Awaited<ReturnType<typeof loadHeightfield>>;
  readonly satellite: SatelliteImage;
  readonly departments: DepartmentsData;
  readonly regions: RegionsData;
  /**
   * Mean reconstruction error of the downsampled level, meters. Only the
   * default quality reports one; shown in the pick panel's precision note.
   */
  readonly meanAbsErrorMeters?: number;
}

async function fetchTerrainData(quality: TerrainQuality): Promise<TerrainData> {
  const manifest = await loadTerrainManifest((url) => fetch(url));
  const [heightfield, departments] = await Promise.all([
    loadHeightfield(manifest, quality),
    loadDepartments(manifest, quality),
  ]);
  // The mask rasters are sampled through the height grid's UV; same ground
  // extent is what makes that valid.
  assertSameGroundExtent(departments.grid, heightfield.spec);
  const level = manifest.levels[quality];
  const res = await fetch(level.satellite.file);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${level.satellite.file}`);
  }
  const bitmap = await createImageBitmap(await res.blob());
  if (
    bitmap.width !== level.satellite.grid.width ||
    bitmap.height !== level.satellite.grid.height
  ) {
    throw new Error(
      `satellite ${level.satellite.file} decoded as ${bitmap.width}x${bitmap.height}, expected ${level.satellite.grid.width}x${level.satellite.grid.height}`,
    );
  }
  return {
    heightfield,
    departments,
    regions: parseRegions(JSON.parse(regionsJsonText)),
    satellite: {
      kind: "bitmap",
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    },
    meanAbsErrorMeters: level.heights.reconstructionError?.meanAbsErrorMeters,
  };
}

/**
 * Downsample one site's satellite bitmap by `divisor` (2 on mobile) once
 * on the CPU: drawImage into a half-size OffscreenCanvas and take a new
 * ImageBitmap out of it. Chosen over a mip-chain downsample, which would
 * still allocate a transient full-size level-0 texture; over
 * createImageBitmap's resize options, which not every WebGPU browser
 * honors. Keeps the "bitmap" upload path; on any failure falls back to
 * the full-size bitmap — the patch still renders, it just costs the
 * full ~28 MiB instead of ~7 MiB.
 */
function downsampleDetailSatellite(
  site: DetailSite,
  full: ImageBitmap,
  divisor: number,
): SatelliteImage {
  if (divisor <= 1) {
    return {
      kind: "bitmap",
      bitmap: full,
      width: full.width,
      height: full.height,
    };
  }
  const width = Math.floor(full.width / divisor);
  const height = Math.floor(full.height / divisor);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, 0, 0, width, height);
    const bitmap = canvas.transferToImageBitmap();
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new Error(
        `downsampled to ${bitmap.width}x${bitmap.height}, expected ` +
          `${width}x${height}`,
      );
    }
    full.close();
    return { kind: "bitmap", bitmap, width, height };
  } catch (error) {
    console.warn(
      `detail ${site.id}: half-resolution satellite unavailable, ` +
        `uploading full resolution`,
      error,
    );
    return {
      kind: "bitmap",
      bitmap: full,
      width: full.width,
      height: full.height,
    };
  }
}

/**
 * Detail patches are additive: if their data is missing or unreadable the
 * app still runs without them (logged), so older data/build outputs keep
 * working. Site payloads are decoded up front; their GPU resources are
 * created lazily by the layer on first approach.
 */
async function fetchDetailSites(
  satelliteDivisor: number,
): Promise<DetailSiteData[]> {
  const manifest = await loadDetailManifest((url) => fetch(url));
  return Promise.all(
    manifest.sites.map(async (site) => {
      const payload = await loadDetailSite(site, (url) => fetch(url));
      const bitmap = await createImageBitmap(
        new Blob([payload.satelliteBytes]),
      );
      assertDetailSatelliteSize(site, bitmap.width, bitmap.height);
      return {
        site,
        heightfield: payload.heightfield,
        satellite: downsampleDetailSatellite(
          site,
          bitmap,
          satelliteDivisor,
        ),
      };
    }),
  );
}

/**
 * Places are additive like the detail patches: if places.json is missing
 * or unreadable the app still runs without markers (logged by the
 * caller).
 */
async function fetchPlaces(): Promise<Place[]> {
  const doc = await loadPlaces((url) => fetch(url));
  return [...doc.places];
}

function selectedQuality(search: string): TerrainQuality {
  return new URLSearchParams(search).get("calidad") === "alta"
    ? "high"
    : "default";
}

async function main(): Promise<void> {
  const canvas = document.getElementById("scene");
  const overlay = document.getElementById("overlay");
  if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
    throw new Error("index.html is missing #scene canvas or #overlay root");
  }

  mountAttributions(overlay);

  const support = await checkWebGpuSupport(navigator);
  if (!support.supported) {
    canvas.hidden = true;
    showWebGpuNotice(overlay, describeFailure(support), support.detail);
    return;
  }

  const loading = createLoadingMessage();
  overlay.appendChild(loading);

  const fail = (reason: string, detail?: string): void => {
    loading.remove();
    canvas.hidden = true;
    showWebGpuNotice(overlay, reason, detail, true);
  };

  const quality = selectedQuality(window.location.search);

  // Device profile: ?perfil=movil|escritorio wins; otherwise detect from the
  // pointer, screen size and device memory hint. Mobile gets a smaller
  // terrain mesh, a lower DPR cap and half-resolution detail patches.
  // Decided before the fetches: the detail decode needs it.
  const profile =
    profileOverrideFromSearch(window.location.search) ??
    selectDeviceProfile({
      coarsePointer:
        window.matchMedia?.("(pointer: coarse)").matches ?? false,
      smallerSideCssPx: Math.min(
        window.screen?.width ?? window.innerWidth,
        window.screen?.height ?? window.innerHeight,
      ),
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
    });

  let data: TerrainData;
  let detailSites: DetailSiteData[] = [];
  let placesData: Place[] = [];
  try {
    [data, detailSites, placesData] = await Promise.all([
      fetchTerrainData(quality),
      fetchDetailSites(detailSatelliteDivisor(profile)).catch((error: unknown) => {
        // Non-fatal: the maqueta still works without the detail patches.
        console.warn("detail patches unavailable", error);
        return [] as DetailSiteData[];
      }),
      fetchPlaces().catch((error: unknown) => {
        // Non-fatal like the patches: no markers, the rest still works.
        console.warn("places unavailable", error);
        return [] as Place[];
      }),
    ]);
  } catch (error) {
    fail(
      "No se pudieron descargar los datos del relieve.",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  let gpu: Gpu;
  try {
    gpu = await init();
  } catch (error) {
    fail(
      "WebGPU está disponible, pero falló al iniciarse el motor de render.",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const plan = planRender(profile, quality, data.heightfield.spec);

  const dirty = createDirtyTracker();
  const requestFrame = (): void => {
    dirty.request();
  };

  // Declared before surface.onResize subscribes: vgpu fires the callback
  // once immediately, so the overlay must be reachable from day one.
  let debugOverlay: DebugOverlay | undefined;
  const canvasSurface = surface(gpu, canvas, {
    dpr: [1, plan.dprMax],
    label: "scene",
  });
  const renderer = createSceneRenderer(gpu, {
    shader: presentShader,
    size: canvasSurface.size,
    clearColor: [0.1, 0.12, 0.16, 1],
  });
  canvasSurface.onResize(({ width, height }) => {
    renderer.resize([width, height]);
    debugOverlay?.refresh();
    requestFrame();
  });

  // Department raster value → region index, then the overlay RGBA the
  // shader tints by. Built once on the CPU from departments.json names.
  const deptToRegion = buildDepartmentToRegion(
    data.regions,
    data.departments.departments,
  );
  const regionOverlay = {
    grid: data.departments.grid,
    rgba: buildRegionOverlay(
      data.departments.index,
      deptToRegion,
      data.regions,
    ),
  };
  // Region name per department raster value — shared by the pick panel
  // and the place cards' "Región" row.
  const regionNames = departmentToRegionNames(deptToRegion, data.regions);

  let verticalExaggeration = DEFAULT_VERTICAL_EXAGGERATION;

  // Discard rects + pick data for the detail sites, in base grid coords.
  // The terrain keeps the rects and the detail layer says which sites
  // currently cover (loaded AND in draw distance) — only those may mask
  // the base surface.
  const patchRects = buildDetailPatchRects(
    detailSites.map((d) => ({ id: d.site.id, spec: d.heightfield.spec })),
    data.heightfield.spec,
  );
  const pickPatchById = new Map<string, DetailPickPatch>();
  for (const d of detailSites) {
    const rect = patchRects.find((r) => r.id === d.site.id)?.rect;
    if (!rect) continue;
    pickPatchById.set(d.site.id, {
      id: d.site.id,
      rect,
      gridMap: patchBaseGridMap(d.heightfield.spec, data.heightfield.spec),
      heightfield: d.heightfield,
      edgeFade: DETAIL_EDGE_FADE,
    });
  }
  let coveringPatchIds: ReadonlySet<string> = new Set();

  /**
   * The pick patches currently covering the base surface — shared by the
   * tap handler and the places layer's marker anchoring/occlusion.
   */
  const coveringPickPatches = (): DetailPickPatch[] => {
    const covering: DetailPickPatch[] = [];
    for (const id of coveringPatchIds) {
      const patch = pickPatchById.get(id);
      if (patch) covering.push(patch);
    }
    return covering;
  };
  /**
   * How far the geomorphed surface may exceed the base heightfield's
   * [min, max] — the clip-box margin for ray marches over it.
   */
  const drawnSurfaceMarginMeters = (): number => {
    let margin = 0;
    for (const patch of coveringPickPatches()) {
      // mix(base, patch) stays inside [min(baseMin, patchMin),
      // max(baseMax, patchMax)] — that is all the clip box must grow.
      margin = Math.max(
        margin,
        patch.heightfield.max - data.heightfield.max,
        data.heightfield.min - patch.heightfield.min,
      );
    }
    return Math.max(0, margin);
  };
  /**
   * Elevation of the surface the user sees, in meters at base grid
   * coords: the geomorphed blend inside covering patches, the plain DEM
   * bilinear sample elsewhere.
   */
  const drawnElevationAt = (i: number, j: number): number =>
    detailSurfaceElevation(
      {
        heightfield: data.heightfield,
        meshToGrid: terrain.gridUniforms.meshToGrid,
      },
      coveringPickPatches(),
      i,
      j,
    );

  const terrain = createTerrainLayer({
    heightfield: data.heightfield,
    satellite: data.satellite,
    shaders: { terrain: terrainShader, mipmap: mipmapShader },
    quality,
    mesh: plan.mesh,
    verticalExaggeration,
    detailPatches: patchRects,
    provinceMask: {
      grid: data.departments.grid,
      index: data.departments.index,
      sdf: data.departments.sdf,
    },
    regionOverlay,
    pixelRatio: () => canvasSurface.dpr,
    onExaggeration: (v) => {
      verticalExaggeration = v;
      requestFrame();
    },
    warnHighQualityOnMobile: plan.warnHighQuality,
  });
  // The marker re-anchors to the surface with the live exaggeration, so it
  // tracks the terrain when the slider moves.
  const pickMarker = createPickMarkerLayer({
    spec: data.heightfield.spec,
    shader: markerShader,
    verticalExaggeration: () => verticalExaggeration,
  });
  const pickPanel = createPickPanelLayer(
    {
      cellSizeMeters: metersPerGridCell(data.heightfield.spec),
      meanAbsErrorMeters: data.meanAbsErrorMeters,
    },
    {
      data: data.departments,
      hitSpec: data.heightfield.spec,
      regionNames,
    },
  );
  const detail = createDetailLayer({
    baseSpec: data.heightfield.spec,
    // The patch geomorphs onto the terrain's own drawn surface: same
    // heights storage buffer + the terrain's grid uniforms, shared.
    baseSurface: {
      grid: terrain.gridUniforms,
      heights: () => terrain.baseHeightsStorage(),
    },
    sites: detailSites,
    shaders: { detail: detailShader, mipmap: mipmapShader },
    verticalExaggeration: () => verticalExaggeration,
    // The loader finished creating a site's GPU resources off the frame
    // loop — repaint so the patch appears, and refresh the overlay's GPU
    // memory total (it now includes the site).
    onSiteReady: () => {
      debugOverlay?.refresh();
      requestFrame();
    },
    // Base-terrain discard + pick surface follow exactly the sites the
    // detail layer draws.
    onCoveringChange: (ids) => {
      coveringPatchIds = new Set(ids);
      terrain.setDetailPatchMask(coveringPatchIds);
      requestFrame();
    },
  });
  // DOM markers over the terrain: positions, occlusion and labels all
  // refresh inside update(), which runs only when a frame renders — the
  // layer itself never dirties the tracker.
  const places = createPlacesLayer({
    places: placesData,
    spec: data.heightfield.spec,
    verticalExaggeration: () => verticalExaggeration,
    pixelRatio: () => canvasSurface.dpr,
    drawnElevationAt,
    occlusion: {
      heightfield: data.heightfield,
      surfaceMarginMeters: drawnSurfaceMarginMeters,
    },
    regions: {
      departments: data.departments.departments,
      regionNames,
      source: data.regions.source,
    },
  });
  const layers: readonly Layer[] = [
    terrain,
    detail,
    pickMarker,
    pickPanel,
    places,
  ];
  for (const layer of layers) layer.init({ gpu });
  for (const layer of layers) layer.ui?.mount(overlay);
  overlay.appendChild(
    createRegionsControls({
      regions: data.regions.regions,
      source: data.regions.source,
      onToggle: (on) => {
        terrain.setRegionsVisible(on);
        requestFrame();
      },
    }),
  );

  const camera = overviewCamera(
    data.heightfield.spec,
    canvasSurface.size[0] / canvasSurface.size[1],
    {
      maxElevationMeters: data.heightfield.max,
      verticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
    },
    {
      // Frame the province, not the whole mosaic: the pipeline records the
      // mask's inclusive cell bounds per level in terrain.json (on the
      // departments raster's grid).
      region: {
        bboxGrid: bboxOnGrid(
          data.heightfield.spec,
          data.departments.grid,
          data.departments.provinceBBoxGrid,
        ),
      },
    },
  );
  attachCameraInput(canvas, {
    camera,
    onTap: (point) => {
      // Marker taps never reach the canvas as DOM events (the places
      // layer is click-through), so the tap is tested against the same
      // projected positions the layer draws. A marker hit opens its card
      // and the terrain pick does not run.
      if (places.pickAt(point.x, point.y)) return;
      const ray = screenToRay(
        camera,
        point.x,
        point.y,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      // While patches cover, march the geomorphed surface the user sees —
      // and at ~patch-cell resolution: patch cells are ~1/8 of a base
      // cell, so the default 0.5-cell step could skip narrow ridges.
      const covering = coveringPickPatches();
      const hit = intersectHeightfield(
        ray,
        data.heightfield,
        verticalExaggeration,
        covering.length === 0
          ? {}
          : {
              stepCells: 0.1,
              surfaceMarginMeters: drawnSurfaceMarginMeters(),
              surfaceAt: drawnElevationAt,
            },
      );
      // A miss (sky) dispatches undefined so layers clear pick state.
      for (const layer of layers) layer.onPick?.(hit);
    },
    onActivity: requestFrame,
  });
  const appClock = clock(gpu);

  // Detail patches are counted too, but only once the async loader has
  // created their resources — the total grows as the camera approaches
  // each site (~28 MiB on desktop, ~7 MiB on mobile).
  const gpuMemoryEntries = (): GpuMemoryEntry[] => [
    ...renderer.gpuMemoryEntries(),
    ...terrain.getGpuMemoryReport().entries,
    ...detail.getGpuMemoryReport().entries,
  ];
  const gpuMemoryBytes = (): number =>
    gpuMemoryEntries().reduce((s, e) => s + e.bytes, 0);
  console.info(
    `GPU memory (${quality}, ${profile}): ${formatBytes(gpuMemoryBytes())} ` +
      `total (detail patches add to this as their sites load)\n` +
      gpuMemoryEntries()
        .map((e) => `  ${e.estimate ? "~" : " "}${e.label}: ${formatBytes(e.bytes)}`)
        .join("\n"),
  );

  debugOverlay =
    new URLSearchParams(window.location.search).get("debug") === "1"
      ? createDebugOverlay({
          profile,
          quality,
          mesh: plan.mesh,
          canvasSize: () => canvasSurface.size,
          dpr: () => canvasSurface.dpr,
          // Getter, not a snapshot: the overlay re-reads it on every
          // paint, so the figure grows as detail sites come online.
          get memoryBytes() {
            return gpuMemoryBytes();
          },
        })
      : undefined;
  if (debugOverlay) {
    overlay.appendChild(debugOverlay.el);
    debugOverlay.refresh();
  }

  // onError, device loss and a failed frame can all fire for the same fault;
  // show the notice once and keep later errors in the console.
  let failed = false;
  let loop: FrameLoopHandle | undefined;
  const handleFrameError = (error: unknown): void => {
    if (failed) {
      console.error("Additional render error after failure", error);
      return;
    }
    failed = true;
    loop?.stop();
    loop = undefined;
    fail(
      "Ocurrió un error al dibujar el relieve.",
      error instanceof Error ? error.message : String(error),
    );
  };

  // Render on demand: only ticks with pending dirty requests encode GPU
  // work; clean ticks call frame.cancel(), vgpu's documented way to drop a
  // frame without presenting (nothing is encoded, nothing is submitted).
  const tick = (frame: Frame): void => {
    const tickStartedAt = performance.now();
    if (!dirty.isDirty()) {
      frame.cancel();
      // Clean ticks still reach the overlay: consecutive-rendered-frame
      // stats need to see the gap so idle time never counts as fps.
      debugOverlay?.tick(tickStartedAt);
      return;
    }
    try {
      camera.setAspect(canvasSurface.size[0] / canvasSurface.size[1]);
      const state: LayerState = {
        time: appClock.time,
        viewport: canvasSurface.size,
        camera,
      };
      for (const layer of layers) layer.update(state, appClock.deltaTime);
      renderer.renderFrame(frame, canvasSurface, layers);
      dirty.frameRendered();
      debugOverlay?.tick(tickStartedAt, performance.now() - tickStartedAt);
    } catch (error) {
      // A failed frame would leave a frozen canvas otherwise.
      try {
        frame.cancel();
      } catch (cancelError) {
        console.error("frame cancel failed", cancelError);
      }
      handleFrameError(error);
    }
  };
  const startLoop = (): void => {
    loop = frameLoop(gpu, tick);
  };
  startLoop();
  dirty.request(); // first paint once everything is initialized

  // The OS can reclaim the GPU while the tab is hidden — stop scheduling
  // frames entirely and repaint on return (device loss goes through
  // handleFrameError, which shows the notice with a Recargar button).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      loop?.stop();
      loop = undefined;
    } else if (!failed && !loop) {
      dirty.request();
      startLoop();
    }
  });

  gpu.onError((error) => {
    console.error(error);
    handleFrameError(error instanceof Error ? error : new Error(String(error)));
  });

  void gpu.gpu.lost.then((info) => {
    if (info.reason === "destroyed") return; // intentional teardown
    handleFrameError(
      new Error(`El dispositivo gráfico se desconectó (${info.message || info.reason}).`),
    );
  });

  loading.remove();
}

main().catch((error: unknown) => {
  // Last-resort fallback: never leave a blank page or an unhandled rejection.
  const overlay = document.getElementById("overlay") ?? document.body;
  mountAttributions(overlay);
  showWebGpuNotice(
    overlay,
    "Ocurrió un error inesperado al arrancar la aplicación.",
    error instanceof Error ? error.message : String(error),
  );
});
