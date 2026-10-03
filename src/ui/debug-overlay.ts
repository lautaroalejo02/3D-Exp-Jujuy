import type { DeviceProfile } from "../app/device-profile";
import type { MeshSize } from "../terrain/terrain-layer";
import type { TerrainQuality } from "../terrain/heightfield";
import { formatBytes } from "../render/gpu-memory";

/**
 * Debug overlay (?debug=1): FPS and frame time averaged over the frames the
 * app actually rendered (render-on-demand skips clean ticks), plus the
 * device profile, quality, mesh size, DPR, canvas pixel size and the GPU
 * memory total. Top-left, pointer-events: none so it never eats touches.
 *
 * DOM-only — mounted by the app into the overlay root like every other
 * LayerUi; the headless snapshot renderer never builds one.
 */

/** Rendered-frame CPU times kept for the rolling average. */
const WINDOW_FRAMES = 60;
/** DOM refresh is throttled: repainting text every frame defeats the point. */
const PAINT_INTERVAL_MS = 250;

export interface DebugOverlayInfo {
  readonly profile: DeviceProfile;
  readonly quality: TerrainQuality;
  readonly mesh: MeshSize;
  /** Physical canvas pixels — live, it changes with resize. */
  readonly canvasSize: () => readonly [number, number];
  /** Effective surface DPR — live, re-read each frame by the surface. */
  readonly dpr: () => number;
  /** Total GPU memory reported by the app, in bytes. */
  readonly memoryBytes: number;
}

export interface DebugOverlay {
  readonly el: HTMLElement;
  /** Record one rendered frame's CPU-side encode time, in milliseconds. */
  frameRendered(durationMs: number): void;
  /** Repaint static+live fields (call on resize). */
  refresh(): void;
}

const PROFILE_LABEL: Record<DeviceProfile, string> = {
  mobile: "móvil",
  desktop: "escritorio",
};

export function createDebugOverlay(
  info: DebugOverlayInfo,
  doc: Document = document,
): DebugOverlay {
  const el = doc.createElement("aside");
  el.className = "debug-overlay";
  el.setAttribute("aria-hidden", "true");

  const times: number[] = [];
  let lastPaint = 0;

  const paint = (): void => {
    const avgMs =
      times.length > 0
        ? times.reduce((a, b) => a + b, 0) / times.length
        : undefined;
    const [w, h] = info.canvasSize();
    const fpsText =
      avgMs === undefined || avgMs <= 0
        ? "— fps"
        : `${Math.round(1000 / avgMs)} fps · ${avgMs.toFixed(1).replace(".", ",")} ms`;
    el.textContent = [
      `${fpsText} (renderizado a demanda)`,
      `perfil: ${PROFILE_LABEL[info.profile]} · calidad: ${info.quality === "high" ? "alta" : "normal"}`,
      `malla: ${info.mesh.width}×${info.mesh.height} · dpr: ${info.dpr().toFixed(2)}`,
      `canvas: ${w}×${h} px`,
      `gpu: ${formatBytes(info.memoryBytes)}`,
    ].join("\n");
  };

  return {
    el,
    frameRendered(durationMs: number) {
      times.push(durationMs);
      if (times.length > WINDOW_FRAMES) times.shift();
      const now = performance.now();
      if (now - lastPaint >= PAINT_INTERVAL_MS) {
        lastPaint = now;
        paint();
      }
    },
    refresh: paint,
  };
}
