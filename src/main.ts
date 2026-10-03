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
  INTERACTIVE_SHADOW_PLAN,
  planRender,
  profileOverrideFromSearch,
  selectDeviceProfile,
} from "./app/device-profile";
import { createDirtyTracker } from "./app/dirty-tracker";
import type { Layer, LayerState, PickHit } from "./app/layers";
import { checkWebGpuSupport, type WebGpuSupport } from "./app/webgpu-support";
import {
  bboxOnGrid,
  freeRectViewFit,
  overviewCamera,
  type ViewRect,
} from "./camera/framing";
import {
  cameraPoseOf,
  flyTo,
  type FlyToHandle,
} from "./camera/fly-to";
import { attachCameraInput } from "./camera/input";
import { detailLivePatchBudget } from "./features/detail/detail-budget";
import { detailSatelliteDivisor } from "./features/detail/detail-load";
import {
  createDetailLayer,
  type DetailSiteData,
} from "./features/detail/detail-layer";
import {
  DETAIL_EDGE_FADE,
  DETAIL_SPLIT_BAND_CELLS,
} from "./features/detail/detail-uniforms";
import detailShader from "./features/detail/detail.wgsl";
import { createPickMarkerLayer } from "./features/pick-marker/pick-marker";
import markerShader from "./features/pick-marker/pick-marker.wgsl";
import { placeViewDistanceKm } from "./features/places/place-distance";
import { clusterZoomDistanceKm } from "./features/places/places-markers";
import { createPlacesLayer } from "./features/places/places-layer";
import { gridToWorld, lonLatToGrid, metersPerGridCell } from "./geo";
import { createPerfilMode } from "./modes/perfil/perfil-mode";
import { registerSolMode } from "./modes/sol/sol-mode";
import {
  detailSurfaceElevation,
  type DetailPickPatch,
} from "./picking/detail-pick";
import { intersectHeightfield, screenToRay } from "./picking/ray";
import { formatBytes, type GpuMemoryEntry } from "./render/gpu-memory";
import mipmapShader from "./render/mipmap.wgsl";
import presentShader from "./render/present.wgsl";
import { createSceneRenderer } from "./render/scene-renderer";
import shadowShader from "./sun/shadow.wgsl";
import {
  drawnMetersAt,
  flattenMarginMeters,
  type ContextFlatten,
} from "./terrain/context-flatten";
import {
  loadDepartments,
  type DepartmentsData,
} from "./terrain/departments";
import {
  buildDetailPatchRects,
  detailPatchCenterBaseGrid,
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
import { createDioramaLayer } from "./terrain/diorama";
import dioramaShader from "./terrain/diorama.wgsl";
import {
  createTerrainLayer,
  DEFAULT_VERTICAL_EXAGGERATION,
} from "./terrain/terrain-layer";
import terrainShader from "./terrain/terrain.wgsl";
import { createAttributionPanel } from "./ui/attributions";
import {
  createLoadingMessage,
  createResetViewButton,
  createTerrainControls,
} from "./ui/controls";
import { DropdownGroup } from "./ui/dropdowns";
import { createDebugOverlay, type DebugOverlay } from "./ui/debug-overlay";
import { createExplorarContent } from "./ui/explorar";
import { createAppMenu, type AppMenu } from "./ui/menu";
import { createPickPanelLayer, type PickPanelLayer } from "./ui/pick-panel";
import { createRegionsControls } from "./ui/regions";
import { sheetSnapHeightsPx, type SheetSnap } from "./ui/sheet";

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

/**
 * The menu chrome (mode bar + mode sheet + detail sheet) is created once
 * and shared by every code path — including the no-WebGPU fallback and
 * the last-resort catch, so the bars never hide.
 */
let appMenu: AppMenu | undefined;
/**
 * Set by main() once the camera exists: recomputes the view offset that
 * centers the framed scene in the UI-free screen rectangle. The menu is
 * created before the camera (also on failure paths), so the sheets report
 * geometry changes through this late-bound hook.
 */
let reframeView: (() => void) | undefined;
function ensureMenu(overlay: HTMLElement): AppMenu {
  appMenu ??= createAppMenu(overlay, {
    onSheetGeometry: () => reframeView?.(),
  });
  return appMenu;
}

/**
 * Mounts the attribution section once, no matter how many failure paths
 * run. It lives at the bottom of the Explorar sheet when the menu is up
 * and falls back to the overlay root otherwise. Returns the element so
 * the Explorar content can re-order it into its sections.
 */
function mountAttributions(
  overlay: HTMLElement,
  dropdowns?: DropdownGroup,
): HTMLElement {
  const existing = overlay.querySelector<HTMLElement>(".attributions");
  if (existing) return existing;
  const el = createAttributionPanel(document, dropdowns);
  (overlay.querySelector("#sheet-explorar") ?? overlay).appendChild(el);
  return el;
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
 * Detail patches are additive: if their manifest is missing or unreadable
 * the app still runs without them (logged), so older data/build outputs
 * keep working. Only the manifest is fetched at startup — each site's
 * heights/satellite payload is fetched lazily by the detail layer the
 * first time the camera selects it (detail-budget.ts bounds how many
 * are resident at once).
 */
async function fetchDetailSites(): Promise<DetailSite[]> {
  const manifest = await loadDetailManifest((url) => fetch(url));
  return [...manifest.sites];
}

/**
 * The detail layer's payload loader: download + decode one site's
 * heights and satellite (downsampled by the device profile). Runs inside
 * the layer's scheduled loader — never on the frameLoop stack.
 */
async function loadDetailSiteData(
  site: DetailSite,
  satelliteDivisor: number,
): Promise<DetailSiteData> {
  const payload = await loadDetailSite(site, (url) => fetch(url));
  const bitmap = await createImageBitmap(new Blob([payload.satelliteBytes]));
  assertDetailSatelliteSize(site, bitmap.width, bitmap.height);
  return {
    site,
    heightfield: payload.heightfield,
    satellite: downsampleDetailSatellite(site, bitmap, satelliteDivisor),
  };
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

  // The menu (mode bar + sheets) mounts before any data or GPU work, so
  // it is on screen on every path — loading, no-WebGPU and failures.
  const menu = ensureMenu(overlay);

  // Shared dropdown coordination for the whole overlay: one dropdown
  // open at a time, tapping outside closes it (the Fuentes details).
  const dropdowns = new DropdownGroup(document);
  const attributionsEl = mountAttributions(overlay, dropdowns);

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
  let detailSites: DetailSite[] = [];
  let placesData: Place[] = [];
  try {
    [data, detailSites, placesData] = await Promise.all([
      fetchTerrainData(quality),
      fetchDetailSites().catch((error: unknown) => {
        // Non-fatal: the maqueta still works without the detail patches.
        console.warn("detail patches unavailable", error);
        return [] as DetailSite[];
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
    // The free rectangle depends on the viewport: recompute the view
    // offset (sheet snap/show/hide report through the menu's hook).
    reframeView?.();
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
    detailSites.map((s) => ({ id: s.id, spec: s.heights.grid })),
    data.heightfield.spec,
  );
  const patchRectById = new Map(patchRects.map((r) => [r.id, r.rect]));
  /**
   * Pick surfaces for the sites whose payload is currently loaded —
   * populated by the detail layer's onSiteReady and dropped on
   * onSiteEvicted, so the map only ever holds live payloads.
   */
  const pickPatchById = new Map<string, DetailPickPatch>();
  let coveringPatchIds: ReadonlySet<string> = new Set();
  // Bump counter the Perfil mode watches: when the covering set changes
  // under an existing transect the profile recomputes.
  let coveringVersion = 0;

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
   * The outside-province context flattening (terrain/context-flatten.ts)
   * as CPU data: the same SDF the shaders sample, the same constants —
   * picking, marker anchoring and camera targets land on the drawn
   * surface instead of the raw DEM.
   */
  const flattenCtx: ContextFlatten = {
    sdf: data.departments.sdf,
    sdfWidth: data.departments.grid.width,
    sdfHeight: data.departments.grid.height,
    gridWidth: data.heightfield.spec.width,
    gridHeight: data.heightfield.spec.height,
    minElevationMeters: data.heightfield.min,
    verticalExaggeration: () => verticalExaggeration,
  };
  /**
   * How far the drawn surface may exceed the base heightfield's
   * [min, max] — the clip-box margin for ray marches over it. The
   * flattened context dips BELOW heightfield.min in virtual meters
   * (flattenMarginMeters), so it applies even with no patch covering.
   */
  const drawnSurfaceMarginMeters = (): number => {
    let margin = flattenMarginMeters(
      data.heightfield.min,
      verticalExaggeration,
    );
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
   * The unflattened drawn surface in meters at base grid coords — the
   * geomorphed blend inside covering patches, the plain DEM bilinear
   * sample elsewhere. This is the REAL elevation the pick panel shows.
   */
  const surfaceElevationAt = (i: number, j: number): number =>
    detailSurfaceElevation(
      {
        heightfield: data.heightfield,
        meshToGrid: terrain.gridUniforms.meshToGrid,
      },
      coveringPickPatches(),
      i,
      j,
      DETAIL_SPLIT_BAND_CELLS,
    );
  /**
   * The surface the user SEES, in meters at base grid coords: the
   * unflattened surface inside the province, the flattened context
   * outside (virtual meters — never display this value as an elevation).
   */
  const drawnElevationAt = (i: number, j: number): number =>
    drawnMetersAt(flattenCtx, surfaceElevationAt(i, j), i, j);

  const terrain = createTerrainLayer({
    heightfield: data.heightfield,
    satellite: data.satellite,
    shaders: { terrain: terrainShader, mipmap: mipmapShader },
    quality,
    mesh: plan.mesh,
    verticalExaggeration,
    detailPatches: patchRects,
    // Cast-shadow engine (compute march over the heights buffer). It
    // stays inert — shadows off, default NW light — until the sun mode
    // (S2b) calls setSun/setShadowsEnabled; the recompute runs only when
    // the sun direction or exaggeration changes.
    shadows: {
      shader: shadowShader,
      plan: plan.shadows,
      interactive: INTERACTIVE_SHADOW_PLAN,
    },
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
    // The ring anchors to the drawn surface: flattened context outside
    // the province, patch geomorph where patches cover.
    drawnElevationAt,
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
    {
      host: () => pickHost,
      onPresent: () => presentDetail("pick", "Punto elegido"),
      onDismiss: () => dismissDetail("pick"),
    },
  );
  const detail = createDetailLayer({
    baseSpec: data.heightfield.spec,
    // The patch geomorphs onto the terrain's own drawn surface: same
    // heights storage buffer + the terrain's grid uniforms, shared.
    baseSurface: {
      grid: terrain.gridUniforms,
      heights: () => terrain.baseHeightsStorage(),
      // The terrain's SDF texture, shared: the patch surface flattens
      // onto the context plain outside the province exactly like the
      // base mesh does.
      provinceSdf: () => terrain.provinceSdfTexture(),
      minElevationMeters: data.heightfield.min,
    },
    sites: detailSites,
    // Payloads are fetched lazily per site — only while the camera
    // selects the patch for drawing.
    loadSite: (site) =>
      loadDetailSiteData(site, detailSatelliteDivisor(profile)),
    maxLivePatches: detailLivePatchBudget(profile),
    shaders: { detail: detailShader, mipmap: mipmapShader },
    verticalExaggeration: () => verticalExaggeration,
    // Patches sample the base-resolution shadow texture at their world
    // position (the getter runs in the async loader, after terrain.init).
    shadowTexture: () => terrain.shadowTexture(),
    // The loader finished creating a site's GPU resources off the frame
    // loop — register its pick surface, repaint so the patch appears,
    // and refresh the overlay's GPU memory total.
    onSiteReady: (site, siteData) => {
      const rect = patchRectById.get(site.id);
      if (rect) {
        pickPatchById.set(site.id, {
          id: site.id,
          rect,
          center: detailPatchCenterBaseGrid(
            site.heights.grid,
            data.heightfield.spec,
          ),
          gridMap: patchBaseGridMap(
            site.heights.grid,
            data.heightfield.spec,
          ),
          heightfield: siteData.heightfield,
          edgeFade: DETAIL_EDGE_FADE,
        });
      }
      debugOverlay?.refresh();
      requestFrame();
    },
    // The memory budget evicted a site: drop its pick surface so the
    // payload does not linger on the CPU either.
    onSiteEvicted: (siteId) => {
      pickPatchById.delete(siteId);
      debugOverlay?.refresh();
    },
    // Base-terrain discard + pick surface follow exactly the sites the
    // detail layer draws.
    onCoveringChange: (ids) => {
      coveringPatchIds = new Set(ids);
      coveringVersion += 1;
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
    dropdowns,
    cardHost: () => cardHost,
    onCardPresent: (name) => presentDetail("card", name),
    onCardDismissed: () => dismissDetail("card"),
    // A cluster tap zooms in until its markers separate: the target is
    // the cluster's world centroid (it lands on the free rect's center
    // via the view offset) and the distance grows the current screen
    // spread to ~3x the merge threshold.
    onClusterTap: (cluster) => {
      flyToPose(
        {
          target: cluster.world,
          distanceKm: clusterZoomDistanceKm(
            camera.distanceKm,
            cluster.spreadPx,
          ),
          azimuthDeg: camera.azimuthDeg,
          elevationDeg: camera.elevationDeg,
        },
        900,
      );
    },
  });
  // Diorama first: its sky draw is the pass's opaque backdrop (no depth),
  // everything else overdraws it. The walls bind the terrain's heights
  // buffer lazily on the first update() — the terrain layer inits after
  // this one because draw order is init order.
  const diorama = createDioramaLayer({
    grid: terrain.gridUniforms,
    heights: () => terrain.baseHeightsStorage(),
    // The terrain's SDF texture, shared: the rim wall flattens its top
    // edge onto the context plain with the same sample the terrain
    // vertex shader takes. Bound lazily like `heights`.
    provinceSdfTexture: () => terrain.provinceSdfTexture(),
    outline: data.departments.outline
      ? {
          points: data.departments.outline,
          gridWidth: data.departments.grid.width,
          gridHeight: data.departments.grid.height,
        }
      : undefined,
    minElevationMeters: data.heightfield.min,
    verticalExaggeration: () => verticalExaggeration,
    shader: dioramaShader,
    // Walls pick the same cast shadows as the terrain; bound lazily in
    // update() — the diorama inits before the terrain owns the texture.
    shadowTexture: () => terrain.shadowTexture(),
  });
  const layers: Layer[] = [
    diorama,
    terrain,
    detail,
    pickMarker,
    pickPanel,
    places,
  ];
  // The detail sheet holds two mutually exclusive slots — pick info and
  // place card — so there are never two overlapping panels. presentDetail
  // swaps them (closing the other for real); dismissDetail hides the
  // sheet only when the dismissed slot is the one on screen. Both go
  // through the menu: on phone/tablet it folds the mode sheet while a
  // detail is up and restores it on close (sheet-stack.ts). The slots
  // and handlers exist before ui.mount runs: the layers' mount asks for
  // them via the host hooks above.
  const pickHost = document.createElement("div");
  pickHost.className = "detail-slot";
  const cardHost = document.createElement("div");
  cardHost.className = "detail-slot";
  menu.detailSheet.contentEl.append(pickHost, cardHost);
  let detailKind: "pick" | "card" | null = null;
  const syncDetail = (): void => {
    pickHost.hidden = detailKind !== "pick";
    cardHost.hidden = detailKind !== "card";
    if (detailKind === null) menu.dismissDetail();
    else menu.presentDetail();
  };
  const presentDetail = (kind: "pick" | "card", title: string): void => {
    detailKind = kind;
    if (kind === "pick") places.closeCard();
    else pickPanel.hide();
    menu.detailSheet.setTitle(title);
    syncDetail();
  };
  const dismissDetail = (kind: "pick" | "card"): void => {
    if (detailKind !== kind) return;
    detailKind = null;
    syncDetail();
  };
  syncDetail();

  for (const layer of layers) layer.init({ gpu });
  for (const layer of layers) {
    // The terrain layer's own ui.mount builds a floating control panel
    // for the old #hud column — skipped: its controls now live in the
    // Explorar sheet and drive the same layer setters.
    if (layer.id === "terrain") continue;
    layer.ui?.mount(overlay);
  }

  // Explorar sheet content: place search + list, "Mostrar lugares", the
  // Regiones switch + legend, the exaggeration slider, the quality
  // toggle and the "Fuentes de datos" section at the bottom.
  menu.modeHosts.explorar.appendChild(
    createExplorarContent({
      places: placesData,
      onSelectPlace: (place) => {
        flyToPlace(place);
      },
      onPlacesVisible: (v) => {
        places.setVisible(v);
      },
      sections: [
        createRegionsControls({
          regions: data.regions.regions,
          source: data.regions.source,
          onToggle: (on) => {
            terrain.setRegionsVisible(on);
            requestFrame();
          },
        }),
        createTerrainControls({
          quality,
          initialExaggeration: verticalExaggeration,
          onExaggeration: (v) => {
            terrain.setVerticalExaggeration(v);
          },
          warnHighQualityOnMobile: plan.warnHighQuality,
        }),
        attributionsEl,
      ],
    }),
  );

  // Sol sheet (S2b): time slider + playback + date presets driving the
  // real sun; shadows recompute at interactive quality while the input
  // moves and refine on release/pause. The mode keeps the cartographic
  // look until the user opens it (menu.onModeChange inside).
  registerSolMode({ menu, terrain, diorama, requestFrame });

  // ---- Framing inside the UI-free rectangle ---------------------------
  // The scene is framed for the part of the screen the chrome does NOT
  // cover: on mobile that's the strip above the mode bar + the sheets'
  // visible height at their current snap; on desktop the area right of
  // the fixed side panel. The projection gets a view offset (principal
  // point shift) so the camera target lands on the free rect's CENTER,
  // and overview framing fits the free rect's size. Recomputed on every
  // sheet snap/show/hide and on window resize (canvasSurface.onResize).
  const DESKTOP_PANEL_QUERY = "(min-width: 1024px)";
  const SNAP_INDEX: Record<SheetSnap, number> = { min: 0, half: 1, full: 2 };
  const modeBarEl = overlay.querySelector<HTMLElement>("#mode-bar");
  const computeFreeRect = (): ViewRect => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const barRect = modeBarEl?.getBoundingClientRect();
    if (window.matchMedia(DESKTOP_PANEL_QUERY).matches) {
      // Desktop: bar + sheets form a fixed panel of the bar's width.
      const panelW = barRect?.width ?? 0;
      return { x: panelW, y: 0, width: w - panelW, height: h };
    }
    const barH = barRect?.height ?? 0;
    // Each shown sheet anchors at the bar's top edge and covers
    // `visible px` above it; the topmost visible edge wins.
    let top = h - barH;
    for (const sheet of [menu.modeSheet, menu.detailSheet]) {
      if (!sheet.isShown()) continue;
      const visible =
        sheetSnapHeightsPx(h, sheet.el.offsetHeight)[
          SNAP_INDEX[sheet.snap()]
        ] ?? 0;
      top = Math.min(top, h - barH - visible);
    }
    return { x: 0, y: 0, width: w, height: top };
  };
  const fovDeg = 45;
  const viewFit = () =>
    freeRectViewFit(
      {
        width: canvas.clientWidth || window.innerWidth,
        height: canvas.clientHeight || window.innerHeight,
      },
      computeFreeRect(),
      fovDeg,
    );
  const startFit = viewFit();

  const camera = overviewCamera(
    data.heightfield.spec,
    canvasSurface.size[0] / canvasSurface.size[1],
    {
      maxElevationMeters: data.heightfield.max,
      verticalExaggeration: DEFAULT_VERTICAL_EXAGGERATION,
    },
    {
      fovDeg,
      // Fit the province to the free rect, not the whole viewport.
      fit: startFit,
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
  camera.setViewOffset(startFit.offsetX, startFit.offsetY);
  reframeView = () => {
    const fit = viewFit();
    camera.setViewOffset(fit.offsetX, fit.offsetY);
    requestFrame();
  };
  // Camera flights: one at a time, always cancelable — a new target or
  // any real user input takes over. Each step asks the dirty tracker for
  // a frame, so render-on-demand only runs while a flight is alive.
  let fly: FlyToHandle | undefined;
  const flyToPose = (
    pose: Parameters<typeof flyTo>[1],
    durationMs: number,
  ): void => {
    fly?.cancel();
    fly = flyTo(camera, pose, { durationMs, requestFrame });
  };
  const flyToPlace = (place: Place): void => {
    const [i, j] = lonLatToGrid(data.heightfield.spec, place.lon, place.lat);
    // The target rides the drawn surface (geomorph + exaggeration), the
    // same elevation the marker anchors to.
    const [x, y, z] = gridToWorld(data.heightfield.spec, i, j, {
      elevationMeters: drawnElevationAt(i, j),
      verticalExaggeration,
    });
    flyToPose(
      {
        target: [x, y, z],
        // Context, not a closeup: ~25 km for towns, ~40 km for large
        // features (place-distance.ts). Azimuth/elevation keep their
        // current values so the flight only re-centers and zooms.
        distanceKm: placeViewDistanceKm(place),
        azimuthDeg: camera.azimuthDeg,
        elevationDeg: camera.elevationDeg,
      },
      1300,
    );
    places.openPlaceCard(place);
  };

  const initialPose = cameraPoseOf(camera);
  overlay.appendChild(
    createResetViewButton(() => {
      flyToPose(initialPose, 1100);
    }),
  );

  /**
   * CPU terrain pick at a canvas-relative CSS px point: the ray marches
   * the DRAWN surface — the context flattening applies always, the patch
   * geomorph whenever patches cover (at ~patch-cell resolution then,
   * since patch cells are ~1/8 of a base cell and the default 0.5-cell
   * step could skip narrow ridges). displayAt is the unflattened surface
   * so the panel still shows a real elevation for a context pick.
   * Shared by the tap handler and the Perfil mode's handle dragging.
   */
  const pickTerrainAt = (x: number, y: number): PickHit | undefined =>
    intersectHeightfield(
      screenToRay(camera, x, y, canvas.clientWidth, canvas.clientHeight),
      data.heightfield,
      verticalExaggeration,
      {
        stepCells: coveringPickPatches().length === 0 ? 0.5 : 0.1,
        surfaceMarginMeters: drawnSurfaceMarginMeters(),
        surfaceAt: drawnElevationAt,
        displayAt: surfaceElevationAt,
      },
    );

  // Perfil mode (S3): A/B transect handles + the elevation chart inside
  // the mode sheet. The layer is DOM-only — pushing it into `layers`
  // makes its update() run on every rendered frame like the rest.
  const perfil = createPerfilMode({
    heightfield: data.heightfield,
    drawnElevationAt,
    pickTerrainAt,
    canvas,
    sheetHost: menu.modeHosts.perfil,
    verticalExaggeration: () => verticalExaggeration,
    pixelRatio: () => canvasSurface.dpr,
    coveringVersion: () => coveringVersion,
    requestFrame,
  });
  perfil.layer.init({ gpu });
  perfil.layer.ui?.mount(overlay);
  layers.push(perfil.layer);

  // Deep-link for the UI shots / QA: ?modo=perfil opens the Perfil sheet
  // and &tramo=lonA,latA,lonB,latB stages a deterministic transect.
  {
    const params = new URLSearchParams(window.location.search);
    if (params.get("modo") === "perfil") menu.setMode("perfil");
    const tramo = params.get("tramo")?.split(",").map(Number);
    if (tramo?.length === 4 && tramo.every(Number.isFinite)) {
      perfil.seed([tramo[0]!, tramo[1]!], [tramo[2]!, tramo[3]!]);
    }
  }

  attachCameraInput(canvas, {
    camera,
    onTap: (point) => {
      // Marker taps never reach the canvas as DOM events (the places
      // layer is click-through), so the tap is tested against the same
      // projected positions the layer draws. A marker hit opens its card
      // and the terrain pick does not run.
      if (places.pickAt(point.x, point.y)) return;
      const hit = pickTerrainAt(point.x, point.y);
      // In Perfil mode taps place/move the transect points instead of
      // showing the pick panel.
      if (perfil.onTap(point, hit)) return;
      // A miss (sky) dispatches undefined so layers clear pick state.
      for (const layer of layers) layer.onPick?.(hit);
    },
    onActivity: () => {
      // Real camera input takes over an in-flight animation.
      fly?.cancel();
      requestFrame();
    },
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
          // Same story: the value appears once a sun update triggers the
          // engine's first recompute.
          shadowMs: () => terrain.shadowMs(),
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
  ensureMenu(overlay);
  mountAttributions(overlay);
  showWebGpuNotice(
    overlay,
    "Ocurrió un error inesperado al arrancar la aplicación.",
    error instanceof Error ? error.message : String(error),
  );
});
