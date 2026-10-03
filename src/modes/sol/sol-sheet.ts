/**
 * DOM for the Sol mode sheet: sun-arc indicator, the time-of-day slider
 * bounded by the day's sunrise/sunset (plus a twilight pad on each
 * side), play/pause with a speed selector, the date presets and a
 * native date input, the numeric readout and the "Sombras" switch.
 * Text is Argentine Spanish for high-school students; the factory only
 * builds elements and reports user intent through the handlers — the
 * controller (sol-mode.ts) owns the state.
 */
import {
  ARC_CX,
  ARC_CY,
  ARC_R,
  formatHourMin,
  parseDateValue,
  sunArcPoint,
  type LocalDate,
} from "./sol-clock";

/** Playback speed choices, in simulated hours per real second. */
export const SOL_SPEEDS = [1, 3] as const;

export type SolPreset = "verano" | "invierno" | "hoy";

export interface SolSheetHandlers {
  /** Slider moved while held: apply the interactive shadow quality. */
  readonly onScrub: (minutes: number) => void;
  /** Slider released (or committed): refine the shadows once. */
  readonly onCommit: (minutes: number) => void;
  readonly onPlayToggle: () => void;
  readonly onSpeed: (hoursPerSecond: number) => void;
  readonly onPreset: (preset: SolPreset) => void;
  /** The native date input committed a valid date. */
  readonly onDate: (date: LocalDate) => void;
  readonly onShadows: (enabled: boolean) => void;
}

export interface SolSheetReadout {
  readonly hora: string;
  readonly elevacion: string;
  readonly azimut: string;
  readonly salida: string;
  readonly puesta: string;
}

export interface SolSheet {
  readonly el: HTMLElement;
  /** Slider bounds (local minutes); also repaints the end labels. */
  setTimeWindow(min: number, max: number): void;
  /** Slider position + value label, without firing handlers. */
  setMinutes(minutes: number): void;
  /** Sync the readout grid and the hour label. */
  setReadout(readout: SolSheetReadout): void;
  /**
   * Sun-arc indicator: `progress` is 0..1 between sunrise and sunset
   * (the dot clamps at the horizon outside it); `sunUp` switches the
   * "de noche" state.
   */
  setArc(progress: number, sunUp: boolean): void;
  /** Reflect the playing state on the play/pause button. */
  setPlaying(playing: boolean): void;
  /** Mark the active speed button. */
  setSpeed(hoursPerSecond: number): void;
  /** Reflect the shadows switch. */
  setShadows(enabled: boolean): void;
  /** Set the date input value ("YYYY-MM-DD"). */
  setDateValue(value: string): void;
  /** Highlight a preset button (undefined clears all). */
  setActivePreset(preset: SolPreset | undefined): void;
}

export function createSolSheet(
  handlers: SolSheetHandlers,
  doc: Document = document,
): SolSheet {
  const root = doc.createElement("div");
  root.className = "sol";

  // ---- Sun arc + night chip -------------------------------------------
  const arcRow = doc.createElement("div");
  arcRow.className = "sol-arc-row";
  const arc = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  arc.setAttribute("viewBox", "0 0 100 46");
  arc.setAttribute("class", "sol-arc");
  arc.setAttribute("aria-hidden", "true");
  const x0 = ARC_CX - ARC_R;
  const x1 = ARC_CX + ARC_R;
  arc.innerHTML =
    `<line class="sol-arc-horizon" x1="${x0 - 8}" y1="${ARC_CY}" x2="${x1 + 8}" y2="${ARC_CY}"/>` +
    `<path class="sol-arc-path" d="M${x0},${ARC_CY} A${ARC_R},${ARC_R} 0 0 1 ${x1},${ARC_CY}"/>` +
    `<circle class="sol-arc-end" cx="${x0}" cy="${ARC_CY}" r="1.6"/>` +
    `<circle class="sol-arc-end" cx="${x1}" cy="${ARC_CY}" r="1.6"/>` +
    `<circle class="sol-arc-dot" r="3.4"/>`;
  const night = doc.createElement("span");
  night.className = "sol-night";
  night.hidden = true;
  night.textContent = "de noche";
  arcRow.append(arc, night);
  const arcDot = arc.querySelector<SVGCircleElement>(".sol-arc-dot")!;

  // ---- Time slider ------------------------------------------------------
  const timeRow = doc.createElement("label");
  timeRow.className = "sol-time";
  const timeLabel = doc.createElement("span");
  timeLabel.className = "sol-time-label";
  timeLabel.textContent = "Hora";
  const slider = doc.createElement("input");
  slider.type = "range";
  slider.className = "sol-time-slider";
  slider.min = "0";
  slider.max = "1439";
  slider.step = "1";
  slider.setAttribute("aria-label", "Hora del día");
  const timeValue = doc.createElement("span");
  timeValue.className = "sol-time-value";
  timeRow.append(timeLabel, slider, timeValue);
  slider.addEventListener("input", () => {
    handlers.onScrub(Number(slider.value));
  });
  slider.addEventListener("change", () => {
    handlers.onCommit(Number(slider.value));
  });

  // ---- Play + speed ------------------------------------------------------
  const playRow = doc.createElement("div");
  playRow.className = "sol-play-row";
  const play = doc.createElement("button");
  play.type = "button";
  play.className = "sol-play";
  play.setAttribute("aria-label", "Reproducir");
  const playIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  playIcon.setAttribute("viewBox", "0 0 24 24");
  playIcon.setAttribute("fill", "currentColor");
  playIcon.setAttribute("aria-hidden", "true");
  play.appendChild(playIcon);
  const PLAY_ICON = '<polygon points="7,4.5 19.5,12 7,19.5"/>';
  const PAUSE_ICON =
    '<rect x="6" y="4.5" width="4" height="15" rx="1"/>' +
    '<rect x="14" y="4.5" width="4" height="15" rx="1"/>';
  playIcon.innerHTML = PLAY_ICON;
  play.addEventListener("click", () => handlers.onPlayToggle());

  const speed = doc.createElement("div");
  speed.className = "sol-speed";
  speed.setAttribute("role", "group");
  speed.setAttribute("aria-label", "Velocidad");
  const speedButtons = new Map<number, HTMLButtonElement>();
  for (const s of SOL_SPEEDS) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "sol-speed-option";
    b.textContent = `${s} h/s`;
    b.addEventListener("click", () => handlers.onSpeed(s));
    speedButtons.set(s, b);
    speed.appendChild(b);
  }
  playRow.append(play, speed);

  // ---- Date presets + native input --------------------------------------
  const dates = doc.createElement("div");
  dates.className = "sol-dates";
  const presetButtons = new Map<SolPreset, HTMLButtonElement>();
  const PRESETS: readonly { id: SolPreset; label: string }[] = [
    { id: "verano", label: "Solsticio de verano" },
    { id: "invierno", label: "Solsticio de invierno" },
    { id: "hoy", label: "Hoy" },
  ];
  for (const p of PRESETS) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "sol-preset";
    b.textContent = p.label;
    b.addEventListener("click", () => handlers.onPreset(p.id));
    presetButtons.set(p.id, b);
    dates.appendChild(b);
  }
  const dateInput = doc.createElement("input");
  dateInput.type = "date";
  dateInput.className = "sol-date";
  dateInput.setAttribute("aria-label", "Elegir fecha");
  dateInput.addEventListener("change", () => {
    const d = parseDateValue(dateInput.value);
    if (d) handlers.onDate(d);
  });
  dates.appendChild(dateInput);

  // ---- Readout ------------------------------------------------------------
  const readout = doc.createElement("dl");
  readout.className = "sol-readout";
  const readoutFields = new Map<string, HTMLElement>();
  for (const [key, label] of [
    ["elevacion", "Elevación del sol"],
    ["azimut", "Azimut (dirección del sol, medida desde el norte)"],
    ["salida", "Salida del sol"],
    ["puesta", "Puesta del sol"],
  ] as const) {
    const item = doc.createElement("div");
    const dt = doc.createElement("dt");
    dt.textContent = label;
    const dd = doc.createElement("dd");
    dd.textContent = "—";
    item.append(dt, dd);
    readout.appendChild(item);
    readoutFields.set(key, dd);
  }

  // ---- Shadows switch ----------------------------------------------------
  const shadows = doc.createElement("label");
  shadows.className = "regions-toggle sol-shadows";
  const shadowsInput = doc.createElement("input");
  shadowsInput.type = "checkbox";
  shadowsInput.checked = true;
  shadowsInput.addEventListener("change", () => {
    handlers.onShadows(shadowsInput.checked);
  });
  const shadowsText = doc.createElement("span");
  shadowsText.textContent = "Sombras del relieve";
  shadows.append(shadowsInput, shadowsText);

  // ---- Source ------------------------------------------------------------
  const source = doc.createElement("p");
  source.className = "sol-source";
  source.appendChild(
    doc.createTextNode(
      "Posición del sol calculada para San Salvador de Jujuy con el algoritmo de la NOAA. ",
    ),
  );
  const sourceLink = doc.createElement("a");
  sourceLink.href = "https://gml.noaa.gov/grad/solcalc/azel.html";
  sourceLink.textContent = "Fuente";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.target = "_blank";
  source.appendChild(sourceLink);
  // The solstice preset dates are computed, not fixed to the 21st —
  // say so and cite the equations that produce them.
  source.appendChild(doc.createTextNode(". Fecha calculada con las "));
  const eqLink = doc.createElement("a");
  eqLink.href = "https://gml.noaa.gov/grad/solcalc/solareqns.PDF";
  eqLink.textContent = "ecuaciones solares de NOAA";
  eqLink.rel = "noopener noreferrer";
  eqLink.target = "_blank";
  source.append(eqLink, doc.createTextNode("."));

  root.append(arcRow, timeRow, playRow, dates, readout, shadows, source);

  const setFill = (): void => {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const fill =
      max > min ? ((Number(slider.value) - min) / (max - min)) * 100 : 0;
    slider.style.setProperty("--fill", `${fill}%`);
  };

  return {
    el: root,
    setTimeWindow(min, max) {
      slider.min = String(min);
      slider.max = String(max);
      setFill();
    },
    setMinutes(minutes) {
      slider.value = String(minutes);
      timeValue.textContent = formatHourMin(minutes);
      setFill();
    },
    setReadout(r) {
      readoutFields.get("elevacion")!.textContent = r.elevacion;
      readoutFields.get("azimut")!.textContent = r.azimut;
      readoutFields.get("salida")!.textContent = r.salida;
      readoutFields.get("puesta")!.textContent = r.puesta;
    },
    setArc(progress, sunUp) {
      const t = Math.min(1, Math.max(0, progress));
      const [x, y] = sunArcPoint(t);
      arcDot.setAttribute("cx", String(x));
      arcDot.setAttribute("cy", String(y));
      arcDot.classList.toggle("sol-arc-dot--night", !sunUp);
      night.hidden = sunUp;
    },
    setPlaying(playing) {
      playIcon.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      play.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
      play.setAttribute("aria-pressed", String(playing));
    },
    setSpeed(hoursPerSecond) {
      for (const [s, b] of speedButtons) {
        b.setAttribute("aria-pressed", String(s === hoursPerSecond));
      }
    },
    setShadows(enabled) {
      shadowsInput.checked = enabled;
    },
    setDateValue(value) {
      dateInput.value = value;
    },
    setActivePreset(preset) {
      for (const [id, b] of presetButtons) {
        b.setAttribute("aria-pressed", String(id === preset));
      }
    },
  };
}
