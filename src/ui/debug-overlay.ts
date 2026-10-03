import type { DeviceProfile } from "../app/device-profile";
import type { MeshSize } from "../terrain/terrain-layer";
import type { TerrainQuality } from "../terrain/heightfield";
import { formatBytes } from "../render/gpu-memory";
import { createFrameStats } from "./frame-stats";

/**
 * Debug overlay (?debug=1): real render rate measured from the interval
 * between consecutive rendered frames — render-on-demand idle time never
 * counts as a slow frame — plus the CPU encode time, the device profile,
 * quality, mesh size, DPR, canvas pixel size and the GPU memory total.
 * Top-left, pointer-events: none so it never eats touches.
 *
 * DOM-only — mounted by the app into the overlay root like every other
 * LayerUi; the headless snapshot renderer never builds one.
 */

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
  /**
   * Record one animation tick at `nowMs`. Pass `cpuMs` — the frame's
   * CPU-side encode time — when the tick drew to the screen; clean ticks
   * keep the clock alive so "en reposo" shows up on time.
   */
  tick(nowMs: number, cpuMs?: number): void;
  /** Repaint static+live fields (call on resize). */
  refresh(): void;
}

const PROFILE_LABEL: Record<DeviceProfile, string> = {
  mobile: "móvil",
  desktop: "escritorio",
};

const formatMs = (ms: number): string => ms.toFixed(1).replace(".", ",");

export function createDebugOverlay(
  info: DebugOverlayInfo,
  doc: Document = document,
): DebugOverlay {
  const el = doc.createElement("aside");
  el.className = "debug-overlay";
  el.setAttribute("aria-hidden", "true");

  const stats = createFrameStats();
  let lastPaint = -PAINT_INTERVAL_MS;

  const paint = (nowMs: number): void => {
    const snap = stats.snapshot(nowMs);
    const fpsLine = snap.idle
      ? "FPS: — (en reposo)"
      : `FPS (en movimiento): ${snap.fps === undefined ? "—" : Math.round(snap.fps)}`;
    const [w, h] = info.canvasSize();
    el.textContent = [
      fpsLine,
      `ms CPU por frame: ${snap.cpuMs === undefined ? "—" : formatMs(snap.cpuMs)}`,
      `perfil: ${PROFILE_LABEL[info.profile]} · calidad: ${info.quality === "high" ? "alta" : "normal"}`,
      `malla: ${info.mesh.width}×${info.mesh.height} · dpr: ${info.dpr().toFixed(2)}`,
      `canvas: ${w}×${h} px`,
      `gpu: ${formatBytes(info.memoryBytes)}`,
    ].join("\n");
  };

  return {
    el,
    tick(nowMs, cpuMs) {
      stats.tick(nowMs, cpuMs);
      if (nowMs - lastPaint >= PAINT_INTERVAL_MS) {
        lastPaint = nowMs;
        paint(nowMs);
      }
    },
    refresh() {
      paint(performance.now());
    },
  };
}
