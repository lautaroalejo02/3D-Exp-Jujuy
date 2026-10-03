/**
 * Agua mode sheet: "Lluvia" play/pause, the "Intensidad" slider (the
 * live particle share of the profile budget), the "Mostrar cuencas"
 * switch with its legend, a short educational note on what a cuenca is
 * and the hydrology data attribution. Text is Argentine Spanish for
 * high-school students; every datum carries its source link.
 */
import { BASIN_COLORS } from "./agua-config";
import type { FlowBasinInfo } from "./flow-data";

/** Educational note on "cuenca", with its source. */
const CUENCA_NOTE =
  "Una cuenca (o cuenca hidrográfica) es el territorio cuya lluvia " +
  "drena hacia un mismo río o sistema de drenaje: toda el agua que cae " +
  "dentro termina saliendo por el mismo lugar.";

const CUENCA_SOURCE = {
  label: "Wikipedia, «Cuenca hidrográfica»",
  url: "https://es.wikipedia.org/wiki/Cuenca_hidrogr%C3%A1fica",
} as const;

/** Educational note on what an endorheic basin is, with its source. */
const ENDORHEIC_NOTE =
  "Una cuenca endorreica (o cerrada) es una cuenca cuya agua no " +
  "llega al mar.";

const ENDORHEIC_SOURCE = {
  label: "Wikipedia, «Endorreísmo»",
  url: "https://es.wikipedia.org/wiki/Endorre%C3%ADsmo",
} as const;

/**
 * Fallback sink label written by scripts/build-flow.ts when a cerrada
 * basin's terminal matches no named laguna/salar — not a place name,
 * so it is excluded from the computed note's name list.
 */
const SINK_FALLBACK_NAME = "laguna o salar";

/**
 * Named sinks the flow build matched for the cerrada basins, e.g.
 * "Laguna de los Pozuelos y Salinas Grandes". Empty when no terminal
 * matched a named water place.
 */
function sinkNames(basins: readonly FlowBasinInfo[]): string {
  const names = [
    ...new Set(
      basins
        .filter(
          (b): b is FlowBasinInfo & { sinkName: string } =>
            b.kind === "cerrada" &&
            typeof b.sinkName === "string" &&
            b.sinkName !== SINK_FALLBACK_NAME,
        )
        .map((b) => b.sinkName),
    ),
  ];
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

export interface AguaSheetOptions {
  readonly basins: readonly FlowBasinInfo[];
  /** Department index (1..16) → name, from departments.json. */
  readonly departmentName: (index: number) => string | undefined;
  /** "Lluvia" play/pause flipped. */
  readonly onPlay: (playing: boolean) => void;
  /** "Intensidad" slider, 0.1..1 of the profile particle budget. */
  readonly onIntensity: (value: number) => void;
  /** "Mostrar cuencas" switch flipped. */
  readonly onBasins: (visible: boolean) => void;
  /** Hydrology data attribution, from flow.json. */
  readonly attribution: string;
  readonly initialPlaying?: boolean;
  readonly initialIntensity?: number;
}

export function createAguaSheet(
  opts: AguaSheetOptions,
  doc: Document = document,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "agua";

  const lede = doc.createElement("p");
  lede.className = "agua-lede";
  lede.textContent =
    "Gotas que caen sobre la provincia y escurren por el relieve real, " +
    "siguiendo la pendiente hacia los ríos.";

  // Lluvia play/pause: a pill button that reads as the primary action.
  const play = doc.createElement("button");
  play.type = "button";
  play.className = "agua-play";
  const renderPlay = (playing: boolean): void => {
    play.setAttribute("aria-pressed", String(playing));
    play.textContent = playing ? "⏸ Lluvia" : "▶ Lluvia";
  };
  let playing = opts.initialPlaying ?? true;
  renderPlay(playing);
  play.addEventListener("click", () => {
    playing = !playing;
    renderPlay(playing);
    opts.onPlay(playing);
  });

  // Intensidad slider: same styled-range markup as the exaggeration
  // slider (the --fill custom property paints the track on WebKit).
  const intensityLabel = doc.createElement("label");
  intensityLabel.className = "agua-intensity";
  const intensityText = doc.createElement("span");
  intensityText.textContent = "Intensidad";
  const slider = doc.createElement("input");
  slider.type = "range";
  slider.min = "10";
  slider.max = "100";
  slider.step = "5";
  slider.value = String(
    Math.round((opts.initialIntensity ?? 0.75) * 100),
  );
  const sliderValue = doc.createElement("span");
  sliderValue.className = "agua-intensity-value";
  const renderSlider = (): void => {
    sliderValue.textContent = `${slider.value}%`;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const fill = ((Number(slider.value) - min) / (max - min)) * 100;
    slider.style.setProperty("--fill", `${fill}%`);
  };
  renderSlider();
  slider.addEventListener("input", () => {
    renderSlider();
    opts.onIntensity(Number(slider.value) / 100);
  });
  intensityLabel.append(intensityText, slider, sliderValue);

  // "Mostrar cuencas" switch + legend, reusing the regions-toggle
  // switch chrome.
  const basinsLabel = doc.createElement("label");
  basinsLabel.className = "regions-toggle";
  const basinsCheck = doc.createElement("input");
  basinsCheck.type = "checkbox";
  basinsCheck.checked = false;
  const basinsText = doc.createElement("span");
  basinsText.textContent = "Mostrar cuencas";
  basinsLabel.append(basinsCheck, basinsText);
  basinsCheck.addEventListener("change", () => {
    opts.onBasins(basinsCheck.checked);
  });

  const legend = doc.createElement("ul");
  legend.className = "regions-legend-items agua-legend";
  for (const basin of opts.basins) {
    const item = doc.createElement("li");
    const row = doc.createElement("div");
    row.className = "agua-basin-item";
    const swatch = doc.createElement("span");
    swatch.className = "region-swatch";
    const [r, g, b] = BASIN_COLORS[basin.id] ?? BASIN_COLORS[0] ?? [0, 0, 0];
    swatch.style.background = `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
    const name = doc.createElement("span");
    name.className = "agua-basin-name";
    if (basin.kind === "cerrada") {
      name.textContent =
        `Cuenca cerrada — termina en ${basin.sinkName ?? "laguna o salar"}`;
    } else {
      const dept = opts.departmentName(basin.outletDepartmentIndex);
      name.textContent = `Cuenca abierta — desagua hacia ${dept ?? "el borde"}`;
    }
    row.append(swatch, name);
    item.appendChild(row);
    legend.appendChild(item);
  }
  const otherItem = doc.createElement("li");
  const otherRow = doc.createElement("div");
  otherRow.className = "agua-basin-item";
  const otherSwatch = doc.createElement("span");
  otherSwatch.className = "region-swatch";
  const [or_, og, ob] = BASIN_COLORS[0] ?? [0, 0, 0];
  otherSwatch.style.background = `rgb(${Math.round(or_ * 255)} ${Math.round(og * 255)} ${Math.round(ob * 255)})`;
  const otherName = doc.createElement("span");
  otherName.className = "agua-basin-name";
  otherName.textContent = "Otras cuencas";
  otherRow.append(otherSwatch, otherName);
  otherItem.appendChild(otherRow);
  legend.appendChild(otherItem);

  // Educational note with its source, then the data attribution.
  const note = doc.createElement("p");
  note.className = "agua-note";
  note.appendChild(doc.createTextNode(CUENCA_NOTE + " "));
  const noteLink = doc.createElement("a");
  noteLink.href = CUENCA_SOURCE.url;
  noteLink.rel = "noopener noreferrer";
  noteLink.target = "_blank";
  noteLink.textContent = `Fuente: ${CUENCA_SOURCE.label}`;
  note.appendChild(noteLink);

  const endorheic = doc.createElement("p");
  endorheic.className = "agua-note";
  endorheic.appendChild(doc.createTextNode(ENDORHEIC_NOTE + " "));
  const endorheicLink = doc.createElement("a");
  endorheicLink.href = ENDORHEIC_SOURCE.url;
  endorheicLink.rel = "noopener noreferrer";
  endorheicLink.target = "_blank";
  endorheicLink.textContent = `Fuente: ${ENDORHEIC_SOURCE.label}`;
  endorheic.appendChild(endorheicLink);

  // The named-sinks claim is this project's own computation over the
  // elevation model (the sink names come from flow.json), so its
  // "source" is the Fuentes panel — the link takes the user there.
  const names = sinkNames(opts.basins);
  const computed = doc.createElement("p");
  computed.className = "agua-note";
  computed.appendChild(
    doc.createTextNode(
      "Según el cálculo sobre el modelo de elevación, el agua de " +
        "estas cuencas no llega al mar: termina en lagunas y salares " +
        `de la Puna${names ? ` como ${names}` : ""}. `,
    ),
  );
  const computedLink = doc.createElement("a");
  computedLink.href = "#";
  computedLink.textContent =
    "Cálculo: modelo de elevación (Terrain Tiles) — ver Fuentes";
  computedLink.addEventListener("click", (event) => {
    event.preventDefault();
    doc.querySelector<HTMLElement>('[data-mode="explorar"]')?.click();
    const fuentes = doc.querySelector<HTMLElement>(".attributions");
    if (fuentes instanceof HTMLDetailsElement) fuentes.open = true;
    fuentes?.scrollIntoView({ block: "nearest" });
  });
  computed.appendChild(computedLink);

  const attribution = doc.createElement("p");
  attribution.className = "agua-attribution";
  attribution.textContent = opts.attribution;

  root.append(
    lede,
    play,
    intensityLabel,
    basinsLabel,
    legend,
    note,
    endorheic,
    computed,
    attribution,
  );
  return root;
}
