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

/** Media query that matches the collapsed-controls layout in index.html. */
const COMPACT_CONTROLS_QUERY = "(max-width: 640px)";

/**
 * Control panel: vertical exaggeration slider (1x–5x, updates only the
 * terrain uniform) and a quality button that reloads the page with or
 * without `?calidad=alta`. On small screens a "Controles" pill collapses
 * the whole panel so it never covers the center of the map.
 */
export function createTerrainControls(
  opts: TerrainControlsOptions,
  doc: Document = document,
): HTMLElement {
  const panel = doc.createElement("section");
  panel.className = "terrain-controls";

  // Collapse affordance: CSS hides this button on wide screens, where the
  // panel always stays expanded.
  const collapse = doc.createElement("button");
  collapse.type = "button";
  collapse.className = "controls-collapse";
  collapse.textContent = "Controles";
  let collapsed =
    doc.defaultView?.matchMedia?.(COMPACT_CONTROLS_QUERY)?.matches ?? false;
  const renderCollapsed = (): void => {
    panel.dataset.collapsed = String(collapsed);
    collapse.setAttribute("aria-expanded", String(!collapsed));
  };
  renderCollapsed();
  collapse.addEventListener("click", () => {
    collapsed = !collapsed;
    renderCollapsed();
  });

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

  panel.append(collapse, label, quality);
  if (opts.warnHighQualityOnMobile) {
    const warning = doc.createElement("p");
    warning.className = "quality-warning";
    warning.textContent =
      "La calidad alta puede ir lenta en celulares.";
    panel.appendChild(warning);
  }
  return panel;
}
