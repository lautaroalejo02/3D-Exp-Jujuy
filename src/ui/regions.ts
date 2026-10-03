/**
 * "Regiones" UI: a checkbox toggle (off by default, the satellite view is
 * the default), a compact legend while the layer is on, and a small card
 * per region with its sourced description, the source's nuance (if any)
 * as "Nota: …" and the PIP Jujuy source link. Text is Argentine Spanish
 * for high-school students.
 */
import {
  REGION_COLORS,
  type Region,
  type RegionsSource,
} from "../terrain/regions";

export interface RegionsControlsOptions {
  readonly regions: readonly Region[];
  readonly source: RegionsSource;
  /** Called when the checkbox flips; the caller triggers a re-render. */
  readonly onToggle: (on: boolean) => void;
  /** Start checked; default off. */
  readonly initiallyOn?: boolean;
}

export function createRegionsControls(
  opts: RegionsControlsOptions,
  doc: Document = document,
): HTMLElement {
  const panel = doc.createElement("section");
  panel.className = "regions-controls";

  const toggleLabel = doc.createElement("label");
  toggleLabel.className = "regions-toggle";
  const checkbox = doc.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = opts.initiallyOn ?? false;
  const toggleText = doc.createElement("span");
  toggleText.textContent = "Regiones";
  toggleLabel.append(checkbox, toggleText);

  const legend = doc.createElement("ul");
  legend.className = "regions-legend";
  legend.hidden = !checkbox.checked;

  const card = doc.createElement("article");
  card.className = "region-card";
  card.hidden = true;

  const cardClose = doc.createElement("button");
  cardClose.type = "button";
  cardClose.className = "region-card-close";
  cardClose.textContent = "×";
  cardClose.setAttribute("aria-label", "Cerrar");
  cardClose.addEventListener("click", () => {
    card.hidden = true;
  });

  const cardTitle = doc.createElement("h3");
  const cardDepartments = doc.createElement("p");
  cardDepartments.className = "region-card-departments";
  const cardText = doc.createElement("p");
  cardText.className = "region-card-text";
  const cardNote = doc.createElement("p");
  cardNote.className = "region-card-note";
  const cardSource = doc.createElement("p");
  cardSource.className = "region-card-source";
  const sourceLink = doc.createElement("a");
  sourceLink.href = opts.source.url;
  sourceLink.rel = "noopener noreferrer";
  sourceLink.target = "_blank";
  sourceLink.textContent = `Fuente: ${opts.source.title.replace(/\s*—.*$/, "")} (${opts.source.publisher})`;
  cardSource.appendChild(sourceLink);

  const showRegion = (region: Region): void => {
    cardTitle.textContent = region.name;
    cardDepartments.textContent =
      `Departamentos: ${region.departments.join(", ")}.`;
    cardText.textContent = region.description.text;
    // The source's caveat, quoted verbatim so nothing is reworded.
    cardNote.hidden = region.nuance === undefined;
    cardNote.textContent =
      region.nuance === undefined
        ? ""
        : `Nota: la fuente aclara: «${region.nuance}».`;
    card.hidden = false;
  };

  for (const region of opts.regions) {
    const item = doc.createElement("li");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "region-item";
    const swatch = doc.createElement("span");
    swatch.className = "region-swatch";
    swatch.style.background = REGION_COLORS[region.id].css;
    const name = doc.createElement("span");
    name.className = "region-name";
    name.textContent = region.name;
    button.append(swatch, name);
    button.addEventListener("click", () => {
      showRegion(region);
    });
    item.appendChild(button);
    legend.appendChild(item);
  }

  checkbox.addEventListener("change", () => {
    legend.hidden = !checkbox.checked;
    if (!checkbox.checked) card.hidden = true;
    opts.onToggle(checkbox.checked);
  });

  card.append(
    cardClose,
    cardTitle,
    cardDepartments,
    cardText,
    cardNote,
    cardSource,
  );
  panel.append(toggleLabel, legend, card);
  return panel;
}
