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
}

/**
 * Control panel: vertical exaggeration slider (1x–5x, updates only the
 * terrain uniform) and a quality toggle that reloads the page with or
 * without `?calidad=alta`.
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
  };
  renderValue();

  slider.addEventListener("input", () => {
    renderValue();
    opts.onExaggeration(Number(slider.value));
  });

  label.append(labelText, slider, value);

  const quality = doc.createElement("a");
  quality.className = "quality-toggle";
  const isHigh = opts.quality === "high";
  quality.textContent = `Calidad: ${isHigh ? "alta" : "normal"}`;
  const url = new URL(doc.defaultView?.location.href ?? "http://localhost/");
  if (isHigh) url.searchParams.delete("calidad");
  else url.searchParams.set("calidad", "alta");
  quality.href = `${url.pathname}${url.search}`;

  panel.append(label, quality);
  return panel;
}
