import { CHART_HEIGHT_PX, chartModel, type ChartModel } from "./chart-model";
import type { ProfilePoint, ProfileStats } from "./profile";

/**
 * The elevation chart inside the Perfil sheet: one SVG rebuilt from the
 * pure chartModel on every new profile or resize, with touch/mouse
 * scrubbing that reports the transect distance under the pointer so the
 * map marker can follow the finger (and back). All geometry math lives
 * in chart-model.ts; this file only creates SVG nodes and pointer input.
 */

/** Fallback width before the SVG can be measured. */
const FALLBACK_WIDTH_PX = 320;

export interface PerfilChart {
  readonly el: HTMLElement;
  /** Rebuild the paths/ticks for a new transect. */
  setProfile(samples: readonly ProfilePoint[], stats: ProfileStats): void;
  /**
   * Move (or hide) the cursor: `distanceMeters` along the transect and
   * the elevation there (undefined -> crosshair line only).
   */
  setCursor(
    distanceMeters: number | undefined,
    elevationMeters: number | undefined,
  ): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const svgEl = <K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
): SVGElementTagNameMap[K] => doc.createElementNS(SVG_NS, tag);

/** "3.000 m" — meters with the "." thousands separator. */
const fmtMetersTick = (v: number): string =>
  `${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} m`;

/** "50 km" / "7,5 km" — whole km where possible, else one decimal. */
const fmtKmTick = (v: number): string =>
  `${Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ",")} km`;

export function createPerfilChart(
  opts: {
    /** A scrub landed on this transect distance (meters). */
    readonly onScrub: (distanceMeters: number) => void;
  },
  doc: Document = document,
): PerfilChart {
  const wrap = doc.createElement("div");
  wrap.className = "perfil-chart-wrap";

  const svg = svgEl(doc, "svg");
  svg.setAttribute("class", "perfil-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Gráfico del corte de altura");

  const gridG = svgEl(doc, "g");
  gridG.setAttribute("class", "perfil-chart-grid");
  const area = svgEl(doc, "path");
  area.setAttribute("class", "perfil-chart-area");
  const line = svgEl(doc, "path");
  line.setAttribute("class", "perfil-chart-line");
  const cursorG = svgEl(doc, "g");
  cursorG.setAttribute("class", "perfil-chart-cursor");
  cursorG.setAttribute("visibility", "hidden");
  const cursorLine = svgEl(doc, "line");
  const cursorDot = svgEl(doc, "circle");
  cursorDot.setAttribute("r", "4.5");
  cursorG.append(cursorLine, cursorDot);
  const labelsG = svgEl(doc, "g");
  labelsG.setAttribute("class", "perfil-chart-labels");
  svg.append(gridG, area, line, cursorG, labelsG);
  wrap.appendChild(svg);

  let model: ChartModel | undefined;
  let viewWidth = FALLBACK_WIDTH_PX;

  const syncSize = (): void => {
    const w = svg.clientWidth;
    if (w > 0 && Math.abs(w - viewWidth) > 0.5) {
      viewWidth = w;
      svg.setAttribute("viewBox", `0 0 ${viewWidth} ${CHART_HEIGHT_PX}`);
    }
  };

  const text = (
    x: number,
    y: number,
    content: string,
    anchor: "start" | "middle" | "end" = "middle",
    cls = "",
  ): SVGTextElement => {
    const t = svgEl(doc, "text");
    t.setAttribute("x", String(Math.round(x * 10) / 10));
    t.setAttribute("y", String(Math.round(y * 10) / 10));
    if (anchor !== "middle") t.setAttribute("text-anchor", anchor);
    if (cls) t.setAttribute("class", cls);
    t.textContent = content;
    return t;
  };

  const renderAxes = (m: ChartModel): void => {
    gridG.textContent = "";
    labelsG.textContent = "";
    for (const tick of m.xTicks) {
      const g = svgEl(doc, "line");
      g.setAttribute("x1", String(tick.pos));
      g.setAttribute("x2", String(tick.pos));
      g.setAttribute("y1", String(m.plot.y));
      g.setAttribute("y2", String(m.baselineY));
      g.setAttribute("class", "perfil-chart-gridline");
      gridG.appendChild(g);
      labelsG.appendChild(
        text(tick.pos, m.baselineY + 14, fmtKmTick(tick.value)),
      );
    }
    for (const tick of m.yTicks) {
      const g = svgEl(doc, "line");
      g.setAttribute("x1", String(m.plot.x));
      g.setAttribute("x2", String(m.plot.x + m.plot.width));
      g.setAttribute("y1", String(tick.pos));
      g.setAttribute("y2", String(tick.pos));
      g.setAttribute("class", "perfil-chart-gridline");
      gridG.appendChild(g);
      labelsG.appendChild(
        text(m.plot.x - 5, tick.pos + 3, fmtMetersTick(tick.value), "end"),
      );
    }
    // Min / max labels pinned to their curve points.
    const extremumLabel = (
      p: { x: number; y: number; elevationMeters: number } | undefined,
      dy: number,
      prefix: string,
    ): void => {
      if (!p) return;
      const dot = svgEl(doc, "circle");
      dot.setAttribute("cx", String(p.x));
      dot.setAttribute("cy", String(p.y));
      dot.setAttribute("r", "3");
      dot.setAttribute("class", "perfil-chart-extremum");
      labelsG.appendChild(dot);
      // Flip the anchor near the edges so the label stays inside.
      const anchor = p.x < 42 ? "start" : p.x > viewWidth - 60 ? "end" : "middle";
      const lx = anchor === "start" ? m.plot.x : anchor === "end" ? m.plot.x + m.plot.width : p.x;
      labelsG.appendChild(
        text(lx, p.y + dy, `${prefix} ${fmtMetersTick(p.elevationMeters)}`, anchor, "perfil-chart-extremum-label"),
      );
    };
    extremumLabel(m.maxPoint, -7, "máx");
    // A min near the baseline would collide with the km tick row — flip
    // its label above the point.
    extremumLabel(
      m.minPoint,
      m.minPoint !== undefined && m.minPoint.y + 18 > m.baselineY ? -7 : 14,
      "mín",
    );
  };

  const scrubTo = (clientX: number): void => {
    if (!model) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((clientX - rect.left) / rect.width) * viewWidth;
    opts.onScrub(model.distanceFor(x));
  };

  let scrubPointer: number | undefined;
  svg.addEventListener("pointerdown", (e) => {
    if (!model) return;
    scrubPointer = e.pointerId;
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    scrubTo(e.clientX);
  });
  svg.addEventListener("pointermove", (e) => {
    if (e.pointerId !== scrubPointer) return;
    scrubTo(e.clientX);
  });
  const endScrub = (e: PointerEvent): void => {
    if (e.pointerId !== scrubPointer) return;
    scrubPointer = undefined;
    if (svg.hasPointerCapture(e.pointerId)) {
      svg.releasePointerCapture(e.pointerId);
    }
  };
  svg.addEventListener("pointerup", endScrub);
  svg.addEventListener("pointercancel", endScrub);

  return {
    el: wrap,
    setProfile(samples, stats): void {
      syncSize();
      if (svg.getAttribute("viewBox") === null) {
        svg.setAttribute("viewBox", `0 0 ${viewWidth} ${CHART_HEIGHT_PX}`);
      }
      model = chartModel(samples, stats, viewWidth, CHART_HEIGHT_PX);
      area.setAttribute("d", model.areaPath);
      line.setAttribute("d", model.linePath);
      renderAxes(model);
      cursorG.setAttribute("visibility", "hidden");
    },
    setCursor(distanceMeters, elevationMeters): void {
      if (!model || distanceMeters === undefined) {
        cursorG.setAttribute("visibility", "hidden");
        return;
      }
      const x = model.xFor(distanceMeters);
      cursorLine.setAttribute("x1", String(x));
      cursorLine.setAttribute("x2", String(x));
      cursorLine.setAttribute("y1", String(model.plot.y));
      cursorLine.setAttribute("y2", String(model.baselineY));
      if (elevationMeters !== undefined) {
        cursorDot.setAttribute("visibility", "visible");
        cursorDot.setAttribute("cx", String(x));
        cursorDot.setAttribute("cy", String(model.yFor(elevationMeters)));
      } else {
        cursorDot.setAttribute("visibility", "hidden");
      }
      cursorG.setAttribute("visibility", "visible");
    },
  };
}
