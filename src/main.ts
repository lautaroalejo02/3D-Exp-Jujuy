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
import { overviewCamera } from "./camera/framing";
import { attachCameraInput } from "./camera/input";
import { createPickMarkerLayer } from "./features/pick-marker/pick-marker";
import markerShader from "./features/pick-marker/pick-marker.wgsl";
import { metersPerGridCell } from "./geo";
import { intersectHeightfield, screenToRay } from "./picking/ray";
import { formatBytes } from "./render/gpu-memory";
import mipmapShader from "./render/mipmap.wgsl";
import presentShader from "./render/present.wgsl";
import { createSceneRenderer } from "./render/scene-renderer";
import {
  loadHeightfield,
  loadTerrainManifest,
  type TerrainQuality,
} from "./terrain/heightfield";
import type { SatelliteImage } from "./terrain/satellite";
import { createTerrainLayer } from "./terrain/terrain-layer";
import terrainShader from "./terrain/terrain.wgsl";
import { createAttributionPanel } from "./ui/attributions";
import { createLoadingMessage } from "./ui/controls";
import { createDebugOverlay, type DebugOverlay } from "./ui/debug-overlay";
import { createPickPanelLayer } from "./ui/pick-panel";

/** Initial vertical exaggeration of the relief (adjustable with the UI slider). */
const INITIAL_VERTICAL_EXAGGERATION = 2.5;

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
  /**
   * Mean reconstruction error of the downsampled level, meters. Only the
   * default quality reports one; shown in the pick panel's precision note.
   */
  readonly meanAbsErrorMeters?: number;
}

async function fetchTerrainData(quality: TerrainQuality): Promise<TerrainData> {
  const manifest = await loadTerrainManifest((url) => fetch(url));
  const heightfield = await loadHeightfield(manifest, quality);
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
    satellite: {
      kind: "bitmap",
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    },
    meanAbsErrorMeters: level.heights.reconstructionError?.meanAbsErrorMeters,
  };
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
  let data: TerrainData;
  try {
    data = await fetchTerrainData(quality);
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

  // Device profile: ?perfil=movil|escritorio wins; otherwise detect from the
  // pointer, screen size and device memory hint. Mobile gets a smaller
  // terrain mesh and a lower DPR cap.
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

  let verticalExaggeration = INITIAL_VERTICAL_EXAGGERATION;
  const terrain = createTerrainLayer({
    heightfield: data.heightfield,
    satellite: data.satellite,
    shaders: { terrain: terrainShader, mipmap: mipmapShader },
    quality,
    mesh: plan.mesh,
    verticalExaggeration,
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
  const pickPanel = createPickPanelLayer({
    cellSizeMeters: metersPerGridCell(data.heightfield.spec),
    meanAbsErrorMeters: data.meanAbsErrorMeters,
  });
  const layers: readonly Layer[] = [terrain, pickMarker, pickPanel];
  for (const layer of layers) layer.init({ gpu });
  for (const layer of layers) layer.ui?.mount(overlay);

  const camera = overviewCamera(
    data.heightfield.spec,
    canvasSurface.size[0] / canvasSurface.size[1],
    {
      maxElevationMeters: data.heightfield.max,
      verticalExaggeration: INITIAL_VERTICAL_EXAGGERATION,
    },
  );
  attachCameraInput(canvas, {
    camera,
    onTap: (point) => {
      const ray = screenToRay(
        camera,
        point.x,
        point.y,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      const hit = intersectHeightfield(
        ray,
        data.heightfield,
        verticalExaggeration,
      );
      // A miss (sky) dispatches undefined so layers clear pick state.
      for (const layer of layers) layer.onPick?.(hit);
    },
    onActivity: requestFrame,
  });
  const appClock = clock(gpu);

  const memoryReport = {
    entries: [
      ...renderer.gpuMemoryEntries(),
      ...terrain.getGpuMemoryReport().entries,
    ],
  };
  const totalBytes = memoryReport.entries.reduce((s, e) => s + e.bytes, 0);
  console.info(
    `GPU memory (${quality}, ${profile}): ${formatBytes(totalBytes)} total\n` +
      memoryReport.entries
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
          memoryBytes: totalBytes,
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
