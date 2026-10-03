/**
 * DOM UI for the terrain view. All text is Argentine Spanish aimed at
 * high-school students. These factories only build elements — the app
 * mounts them into the overlay root.
 */
import type { TerrainQuality } from "../terrain/heightfield";

/** "Cargando relieve…" shown while terrain data is fetched and decoded. */
export function createLoadingMessage(doc: Document = document): HTMLElement {
  const el = doc.createElement("p");
  el.className = "loading-message";
  el.textContent = "Cargando relieve…";
  el.setAttribute("role", "status");
  return el;
}

/**
 * Round "reset view" button, the only floating control — top-right over
 * the map. The icon is a circular arrow around a small mountain.
 */
export function createResetViewButton(
  onReset: () => void,
  doc: Document = document,
): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.id = "reset-view";
  button.setAttribute("aria-label", "Volver a la vista inicial");
  const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<polyline points="4,17 9,8.5 12,12 15,6.5 20,17"/>' +
    '<line x1="4" y1="17" x2="20" y2="17"/>';
  button.appendChild(icon);
  button.addEventListener("click", onReset);
  return button;
}

export interface TerrainControlsOptions {
  readonly quality: TerrainQuality;
  readonly initialExaggeration: number;
  readonly onExaggeration: (value: number) => void;
  /**
   * True when the high quality level runs on a phone — adds a short
   * warning that it may be slow.
   */
  readonly warnHighQualityOnMobile?: boolean;
}

/**
 * Unambiguous quality toggle label: the current state and what the link
 * switches to ("Calidad: normal · Cambiar a alta").
 */
export function qualityToggleLabel(quality: TerrainQuality): string {
  const current = quality === "high" ? "alta" : "normal";
  const next = quality === "high" ? "normal" : "alta";
  return `Calidad: ${current} · Cambiar a ${next}`;
}

/**
 * Control panel: vertical exaggeration slider (1x–5x, updates only the
 * terrain uniform) and a quality button that reloads the page with or
 * without `?calidad=alta`. Lives inside the Explorar sheet — a plain
 * block, the sheet owns the chrome.
 */
export function createTerrainControls(
  opts: TerrainControlsOptions,
  doc: Document = document,
): HTMLElement {
  const panel = doc.createElement("section");
  panel.className = "terrain-controls";

  const label = doc.createElement("label");
  label.className = "exaggeration";
  const labelText = doc.createElement("span");
  labelText.textContent = "Exageración vertical";

  const slider = doc.createElement("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = "5";
  slider.step = "0.1";
  slider.value = String(opts.initialExaggeration);

  const value = doc.createElement("span");
  value.className = "exaggeration-value";
  const renderValue = (): void => {
    value.textContent = `${Number(slider.value).toFixed(1)}×`;
    // WebKit has no ::-moz-range-progress: the filled track portion is a
    // gradient stop driven by this property (see index.html).
    const min = Number(slider.min);
    const max = Number(slider.max);
    const fill = ((Number(slider.value) - min) / (max - min)) * 100;
    slider.style.setProperty("--fill", `${fill}%`);
  };
  renderValue();

  slider.addEventListener("input", () => {
    renderValue();
    opts.onExaggeration(Number(slider.value));
  });

  label.append(labelText, slider, value);

  const quality = doc.createElement("button");
  quality.type = "button";
  quality.className = "quality-toggle";
  const isHigh = opts.quality === "high";
  quality.textContent = qualityToggleLabel(opts.quality);
  const url = new URL(doc.defaultView?.location.href ?? "http://localhost/");
  if (isHigh) url.searchParams.delete("calidad");
  else url.searchParams.set("calidad", "alta");
  quality.addEventListener("click", () => {
    const view = doc.defaultView;
    if (view) view.location.href = `${url.pathname}${url.search}`;
  });

  panel.append(label, quality);
  if (opts.warnHighQualityOnMobile) {
    const warning = doc.createElement("p");
    warning.className = "quality-warning";
    warning.textContent =
      "La calidad alta puede ir lenta en celulares.";
    panel.appendChild(warning);
  }
  return panel;
}
