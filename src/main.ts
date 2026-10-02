import { clock, frameLoop, init, surface, type Gpu } from "vgpu";

import type { Layer, LayerState } from "./app/layers";
import { checkWebGpuSupport, type WebGpuSupport } from "./app/webgpu-support";
import { overviewCamera } from "./camera/framing";
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

function showWebGpuNotice(overlay: HTMLElement, reason: string, detail?: string): void {
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
    showWebGpuNotice(overlay, reason, detail);
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

  const canvasSurface = surface(gpu, canvas, {
    dpr: [1, 2],
    label: "scene",
  });
  const renderer = createSceneRenderer(gpu, {
    shader: presentShader,
    size: canvasSurface.size,
    clearColor: [0.1, 0.12, 0.16, 1],
  });
  canvasSurface.onResize(({ width, height }) => {
    renderer.resize([width, height]);
  });

  const terrain = createTerrainLayer({
    heightfield: data.heightfield,
    satellite: data.satellite,
    shaders: { terrain: terrainShader, mipmap: mipmapShader },
    quality,
    verticalExaggeration: INITIAL_VERTICAL_EXAGGERATION,
  });
  terrain.init({ gpu });
  const layers: readonly Layer[] = [terrain];
  for (const layer of layers) layer.ui?.mount(overlay);

  const camera = overviewCamera(
    data.heightfield.spec,
    canvasSurface.size[0] / canvasSurface.size[1],
    {
      maxElevationMeters: data.heightfield.max,
      verticalExaggeration: INITIAL_VERTICAL_EXAGGERATION,
    },
  );
  const appClock = clock(gpu);

  const memoryReport = {
    entries: [
      ...renderer.gpuMemoryEntries(),
      ...terrain.getGpuMemoryReport().entries,
    ],
  };
  const totalBytes = memoryReport.entries.reduce((s, e) => s + e.bytes, 0);
  console.info(
    `GPU memory (${quality}): ${formatBytes(totalBytes)} total\n` +
      memoryReport.entries
        .map((e) => `  ${e.estimate ? "~" : " "}${e.label}: ${formatBytes(e.bytes)}`)
        .join("\n"),
  );

  const loop = frameLoop(gpu, (frame) => {
    try {
      camera.setAspect(canvasSurface.size[0] / canvasSurface.size[1]);
      const state: LayerState = {
        time: appClock.time,
        viewport: canvasSurface.size,
        camera,
      };
      for (const layer of layers) layer.update(state, appClock.deltaTime);
      renderer.renderFrame(frame, canvasSurface, layers);
    } catch (error) {
      // A failed frame would leave a frozen canvas otherwise.
      try {
        frame.cancel();
      } catch (cancelError) {
        console.error("frame cancel failed", cancelError);
      }
      handleFrameError(error);
    }
  });

  // onError, device loss and a failed frame can all fire for the same fault;
  // show the notice once and keep later errors in the console.
  let failed = false;
  const handleFrameError = (error: unknown): void => {
    if (failed) {
      console.error("Additional render error after failure", error);
      return;
    }
    failed = true;
    loop.stop();
    fail(
      "Ocurrió un error al dibujar el relieve.",
      error instanceof Error ? error.message : String(error),
    );
  };

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
