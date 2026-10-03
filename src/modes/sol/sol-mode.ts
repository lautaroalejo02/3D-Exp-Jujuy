/**
 * Sol mode controller: owns the sheet's state (local date, minutes,
 * playback, shadows) and drives the real sun into the terrain and
 * diorama layers while the mode is active. Entering the mode switches
 * the lighting from the shipped cartographic look to the real sun with
 * cast shadows on; leaving restores the defaults — the chosen
 * time/date is kept so re-entering resumes where the user left it.
 *
 * Shadow quality follows the task's progressive rule: scrubs and
 * playback recompute at the interactive plan; pause/release/date
 * changes refine once at the device-profile resolution. The engine
 * itself skips recomputes when the sun moved < 0.25 degrees.
 */
import type { ShadowQuality } from "../../sun/shadow-engine";
import { summerSolstice, sunLook, winterSolstice } from "../../sun/solar";
import type { DioramaLayer } from "../../terrain/diorama";
import {
  CARTOGRAPHIC_SUN,
  type TerrainLayer,
} from "../../terrain/terrain-layer";
import type { AppMenu } from "../../ui/menu";
import {
  arcProgress,
  dayWindow,
  formatDateValue,
  formatDeg,
  formatHourMin,
  localInstantUtc,
  localMinutesNow,
  localToday,
  type DayWindow,
  type LocalDate,
} from "./sol-clock";
import { createSolSheet, type SolPreset } from "./sol-sheet";

/**
 * Solar reference point: San Salvador de Jujuy (Wikidata P625 of
 * Q44217 — https://www.wikidata.org/wiki/Q44217) — the same coordinate
 * the solar unit tests and the headless sun snapshots use. The sun
 * direction is practically constant across the province, so one point
 * drives the whole maqueta.
 */
const JUJUY_SOLAR = { lat: -24.1856, lon: -65.2994 } as const;

/** Cap on the simulated step per animation frame (a hidden tab can stall rAF). */
const MAX_PLAY_STEP_MS = 120;

export interface SolModeDeps {
  readonly menu: AppMenu;
  readonly terrain: Pick<
    TerrainLayer,
    "setSun" | "setShadowsEnabled" | "setShadowQuality"
  >;
  readonly diorama: Pick<
    DioramaLayer,
    "setSun" | "setShadowsEnabled" | "setSkyTint"
  >;
  /** Marks a frame dirty so the render-on-demand loop paints. */
  readonly requestFrame: () => void;
}

/**
 * Mounts the Sol sheet into the mode host and wires it to the layers.
 * Called once at startup; the mode stays inert until the user opens it.
 */
export function registerSolMode(
  deps: SolModeDeps,
  doc: Document = document,
): void {
  const state = {
    date: localToday(),
    minutes: localMinutesNow(),
    speedHps: 1 as number,
    shadows: true,
    playing: false,
    active: false,
  };

  const win = (): DayWindow => {
    // Polar day/night is unreachable inside Jujuy; the full-day range is
    // a defensive fallback, not a real case.
    return (
      dayWindow(state.date, JUJUY_SOLAR.lat, JUJUY_SOLAR.lon) ?? {
        sunriseMinutes: 360,
        sunsetMinutes: 1200,
        min: 0,
        max: 1439,
      }
    );
  };

  /**
   * Push the current instant into the layers: real sun direction +
   * colors on the terrain and the diorama walls, sky tint, then the
   * sheet readout. `quality` selects the shadow march resolution.
   */
  const apply = (quality: ShadowQuality): void => {
    deps.terrain.setShadowQuality(quality);
    const look = sunLook(
      localInstantUtc(state.date, state.minutes),
      JUJUY_SOLAR.lat,
      JUJUY_SOLAR.lon,
    );
    deps.terrain.setSun(look.direction, look.sunColor, look.ambientColor);
    deps.diorama.setSun(look.direction, look.sunColor, look.ambientColor);
    deps.diorama.setSkyTint(look.skyTint);

    const w = win();
    sheet.setMinutes(state.minutes);
    sheet.setReadout({
      hora: formatHourMin(state.minutes),
      elevacion: formatDeg(look.elevationDeg),
      azimut: formatDeg(look.azimuthDeg),
      salida: formatHourMin(w.sunriseMinutes),
      puesta: formatHourMin(w.sunsetMinutes),
    });
    sheet.setArc(arcProgress(state.minutes, w), look.elevationDeg > 0);
    deps.requestFrame();
  };

  // ---- Playback ---------------------------------------------------------

  let raf = 0;
  let lastTs = 0;
  const step = (ts: number): void => {
    if (!state.playing) return;
    const dtMs = Math.min(MAX_PLAY_STEP_MS, ts - lastTs);
    lastTs = ts;
    const w = win();
    state.minutes += state.speedHps * (dtMs / 1000) * 60;
    // The day loops: past the sunset+twilight end it wraps to the start.
    if (state.minutes > w.max) {
      state.minutes = w.min + (state.minutes - w.max);
    }
    apply("interactive");
    raf = doc.defaultView?.requestAnimationFrame(step) ?? 0;
  };
  const stopLoop = (): void => {
    if (!state.playing) return;
    state.playing = false;
    doc.defaultView?.cancelAnimationFrame(raf);
    sheet.setPlaying(false);
  };
  const play = (): void => {
    state.playing = true;
    sheet.setPlaying(true);
    lastTs = performance.now();
    raf = doc.defaultView?.requestAnimationFrame(step) ?? 0;
  };
  const pause = (): void => {
    stopLoop();
    apply("final"); // refine the shadows once at device quality
  };

  // ---- Date --------------------------------------------------------------

  const setDate = (date: LocalDate, preset?: SolPreset): void => {
    state.date = date;
    const w = win();
    sheet.setTimeWindow(w.min, w.max);
    state.minutes = Math.min(w.max, Math.max(w.min, state.minutes));
    sheet.setDateValue(formatDateValue(date));
    sheet.setActivePreset(preset);
    apply("final");
  };

  const sheet = createSolSheet(
    {
      onScrub(minutes) {
        // Grabbing the slider takes over the playback.
        stopLoop();
        state.minutes = minutes;
        apply("interactive");
      },
      onCommit(minutes) {
        state.minutes = minutes;
        apply("final");
      },
      onPlayToggle() {
        if (state.playing) pause();
        else play();
      },
      onSpeed(hoursPerSecond) {
        state.speedHps = hoursPerSecond;
        sheet.setSpeed(hoursPerSecond);
      },
      onPreset(preset) {
        if (preset === "hoy") {
          setDate(localToday(), "hoy");
          return;
        }
        // The solstice date is computed from the NOAA equations (the
        // declination-extremum instant), not hardcoded to the 21st;
        // localToday converts that UTC instant to the Argentina date.
        const instant =
          preset === "verano"
            ? summerSolstice(state.date.year)
            : winterSolstice(state.date.year);
        setDate(localToday(instant), preset);
      },
      onDate(date) {
        setDate(date);
      },
      onShadows(enabled) {
        state.shadows = enabled;
        if (!state.active) return;
        deps.terrain.setShadowsEnabled(enabled);
        deps.diorama.setShadowsEnabled(enabled);
        deps.requestFrame();
      },
    },
    doc,
  );
  deps.menu.modeHosts.sol.replaceChildren(sheet.el);
  sheet.setSpeed(state.speedHps);
  sheet.setShadows(state.shadows);

  // ---- Mode enter / leave ------------------------------------------------

  deps.menu.onModeChange((mode) => {
    if (mode === "sol" && !state.active) {
      state.active = true;
      const w = win();
      sheet.setTimeWindow(w.min, w.max);
      state.minutes = Math.min(w.max, Math.max(w.min, state.minutes));
      sheet.setDateValue(formatDateValue(state.date));
      apply("final");
      if (state.shadows) {
        // Enabling after the uniforms are set dispatches the march once.
        deps.terrain.setShadowsEnabled(true);
        deps.diorama.setShadowsEnabled(true);
      }
      deps.requestFrame();
    } else if (mode !== "sol" && state.active) {
      state.active = false;
      stopLoop();
      deps.terrain.setShadowsEnabled(false);
      deps.diorama.setShadowsEnabled(false);
      deps.terrain.setSun(
        CARTOGRAPHIC_SUN.direction,
        CARTOGRAPHIC_SUN.color,
        CARTOGRAPHIC_SUN.ambient,
      );
      deps.diorama.setSun(
        CARTOGRAPHIC_SUN.direction,
        CARTOGRAPHIC_SUN.color,
        CARTOGRAPHIC_SUN.ambient,
      );
      deps.diorama.setSkyTint([1, 1, 1]);
      deps.requestFrame();
    }
  });
}
