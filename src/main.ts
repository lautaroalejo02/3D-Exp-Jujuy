import { effect, frameLoop, init, surface } from "vgpu";

import { checkWebGpuSupport, type WebGpuSupport } from "./app/webgpu-support";
import clearShader from "./render/clear.wgsl";
import { createAttributionPanel } from "./ui/attributions";

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

async function main(): Promise<void> {
  const canvas = document.getElementById("scene");
  const overlay = document.getElementById("overlay");
  if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
    throw new Error("index.html is missing #scene canvas or #overlay root");
  }

  overlay.appendChild(createAttributionPanel());

  const support = await checkWebGpuSupport(navigator);
  if (!support.supported) {
    canvas.hidden = true;
    showWebGpuNotice(overlay, describeFailure(support), support.detail);
    return;
  }

  let gpu: Awaited<ReturnType<typeof init>>;
  try {
    gpu = await init();
  } catch (error) {
    canvas.hidden = true;
    showWebGpuNotice(
      overlay,
      "WebGPU está disponible, pero falló al iniciarse el motor de render.",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const canvasSurface = surface(gpu, canvas, { dpr: [1, 2], label: "scene" });
  const clear = effect(gpu, clearShader, { label: "scaffold-clear" });
  frameLoop(gpu, (frame) => {
    frame.pass(canvasSurface, clear);
  });
}

main().catch((error: unknown) => {
  // Last-resort fallback: never leave a blank page or an unhandled rejection.
  const overlay = document.getElementById("overlay") ?? document.body;
  try {
    overlay.appendChild(createAttributionPanel());
  } catch (panelError: unknown) {
    // The notice below still renders; keep the failure visible in the console.
    console.error("Attribution panel failed to render", panelError);
  }
  showWebGpuNotice(
    overlay,
    "Ocurrió un error inesperado al arrancar la aplicación.",
    error instanceof Error ? error.message : String(error),
  );
});
