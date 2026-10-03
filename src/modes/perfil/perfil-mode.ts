import type { Layer, LayerState, PickHit } from "../../app/layers";
import { projectToScreen } from "../../features/places/places-markers";
import { gridToWorld, metersPerGridCell } from "../../geo";
import { lonLatToGrid } from "../../geo/grid";
import type { Heightfield } from "../../terrain/heightfield";
import { formatElevation } from "../../ui/pick-panel";

/** Elevation difference in plain meters ("3.764 m"), Spanish thousands separator. */
function formatMetersDifference(meters: number): string {
  const digits = String(Math.round(Math.abs(meters))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${digits} m`;
}
import { createPerfilChart, type PerfilChart } from "./perfil-chart";
import {
  buildProfileSamples,
  computeProfileStats,
  distanceAtFractionalIndex,
  nearestOnPolyline,
  profileGroundDistanceMeters,
  sampleAtDistance,
  type ProfilePoint,
  type ProfileStats,
} from "./profile";

/**
 * Perfil mode: an A-B transect across the relief with the elevation
 * profile chart in the mode sheet.
 *
 * - Taps place point A then point B (the same CPU picking the terrain
 *   tap uses). Both ends are DOM handles, projected every rendered frame
 *   and draggable (pointer capture re-picks the terrain under the
 *   finger, mouse and touch on one path).
 * - The transect line is an SVG overlay, not a GPU line layer — the
 *   cheapest robust option: the samples are projected on the CPU with
 *   the same camera math the place markers use, so there are no GPU
 *   resources to manage, no shader to validate and no WebGPU 1-px
 *   line-width limit. Like the pick ring it is a UI affordance that
 *   stays visible instead of being occluded by ridges.
 * - The profile samples reuse Heightfield.sampleAlong at ~2 samples per
 *   grid cell; the elevation comes from the DRAWN surface (the base DEM
 *   blended with the covering detail patches — detailSurfaceElevation),
 *   so the chart and the drape include the patches the line crosses and
 *   match what the user sees.
 * - Two-way cursor: scrubbing the chart moves a marker along the line
 *   on the map; hovering or tapping near the map line moves the chart
 *   cursor (nearestOnPolyline over the projected samples).
 *
 * DOM only: init/draw are no-ops, update() writes positions only while
 * mounted — the headless snapshot never reaches the DOM path.
 */

/** A tap/hover counts as "on the line" within this screen radius, CSS px. */
const NEAR_LINE_PX = 22;
/**
 * Lift of the draped line/handles above the drawn surface, meters —
 * keeps the SVG stroke from visually clipping into the silhouette where
 * the mesh undercuts the DEM samples.
 */
const LINE_LIFT_METERS = 40;

/** DEM source shown under the chart (AGENTS.md: a source next to every datum). */
const HEIGHTS_SOURCE = {
  label: "Terrain Tiles (Mapzen)",
  url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
} as const;

interface EndPoint {
  readonly lon: number;
  readonly lat: number;
  readonly i: number;
  readonly j: number;
}

export interface PerfilModeOptions {
  readonly heightfield: Heightfield;
  /**
   * Elevation of the drawn surface in meters at base grid coords —
   * detailSurfaceElevation over the covering patches elsewhere.
   */
  readonly drawnElevationAt: (i: number, j: number) => number;
  /** CPU terrain pick at a canvas-relative CSS px point. */
  readonly pickTerrainAt: (x: number, y: number) => PickHit | undefined;
  /** The map canvas (hover + handle-drag coordinates). */
  readonly canvas: HTMLCanvasElement;
  /** `#sheet-perfil` — its `hidden` flag tells whether the mode is active. */
  readonly sheetHost: HTMLElement;
  readonly verticalExaggeration: () => number;
  readonly pixelRatio: () => number;
  /**
   * Bump counter for the covering detail-patch set; the profile is
   * recomputed when it changes so the chart tracks the drawn surface.
   */
  readonly coveringVersion?: () => number;
  readonly requestFrame: () => void;
}

export interface PerfilMode {
  readonly layer: Layer;
  /**
   * A canvas tap: returns true when the Perfil mode consumed it (always,
   * while the mode is active) so the pick panel does not fire.
   */
  onTap(
    point: { readonly x: number; readonly y: number },
    hit: PickHit | undefined,
  ): boolean;
  /**
   * Place both endpoints from lon/lat — the `?modo=perfil&tramo=`
   * deep-link the UI shots use to stage a deterministic transect.
   */
  seed(a: readonly [number, number], b: readonly [number, number]): void;
}

/** "123,4 km" / "9,5 km" — one decimal under 10 km, whole km above. */
const formatKm = (meters: number): string => {
  const km = meters / 1000;
  const v = km < 10 ? km.toFixed(1) : String(Math.round(km));
  return `${v.replace(".", ",")} km`;
};

/** "123,4 km · 2.345 m" — the scrub readout under the chart. */
const formatReadout = (
  distanceMeters: number,
  elevationMeters: number | undefined,
): string =>
  elevationMeters !== undefined
    ? `${formatKm(distanceMeters)} · ${formatElevation(elevationMeters)}`
    : `${formatKm(distanceMeters)} · sin dato de altura`;

const SVG_NS = "http://www.w3.org/2000/svg";

interface MapEls {
  readonly svg: SVGSVGElement;
  readonly halo: SVGPolylineElement;
  readonly line: SVGPolylineElement;
  readonly cursorG: SVGGElement;
  readonly handleA: HTMLElement;
  readonly handleB: HTMLElement;
}

interface SheetEls {
  readonly hint: HTMLElement;
  readonly tip: HTMLElement;
  readonly chart: PerfilChart;
  readonly readout: HTMLElement;
  readonly statsDl: HTMLElement;
  readonly statEls: Readonly<Record<string, HTMLElement>>;
  readonly invertBtn: HTMLButtonElement;
  readonly clearBtn: HTMLButtonElement;
  readonly source: HTMLElement;
}

export function createPerfilMode(opts: PerfilModeOptions): PerfilMode {
  const spec = opts.heightfield.spec;

  let pointA: EndPoint | undefined;
  let pointB: EndPoint | undefined;
  let samples: readonly ProfilePoint[] = [];
  let stats: ProfileStats | undefined;
  /** Cursor position as ground distance along the transect, meters. */
  let cursorDistance: number | undefined;
  let lastCoveringVersion = -1;

  let mapEls: MapEls | undefined;
  let sheetEls: SheetEls | undefined;
  /** Screen-space polyline from the last update(), CSS px. */
  let screenPts: { x: number; y: number }[] = [];

  const isActive = (): boolean => !opts.sheetHost.hidden;

  const hitToPoint = (hit: PickHit): EndPoint => ({
    lon: hit.lonLat[0],
    lat: hit.lonLat[1],
    i: hit.grid[0],
    j: hit.grid[1],
  });

  const setCursor = (distanceMeters: number | undefined): void => {
    cursorDistance = distanceMeters;
    const at =
      distanceMeters !== undefined
        ? sampleAtDistance(samples, distanceMeters)
        : undefined;
    sheetEls?.chart.setCursor(distanceMeters, at?.elevationMeters);
    if (sheetEls) {
      sheetEls.readout.hidden = distanceMeters === undefined;
      if (distanceMeters !== undefined && at) {
        sheetEls.readout.textContent = formatReadout(
          distanceMeters,
          at.elevationMeters,
        );
      }
    }
    opts.requestFrame();
  };

  const syncSheet = (): void => {
    if (!sheetEls) return;
    const awaiting = !pointA ? "a" : !pointB ? "b" : undefined;
    if (awaiting === "a") {
      sheetEls.hint.textContent =
        "Tocá el mapa para marcar el punto A del corte.";
      sheetEls.hint.hidden = false;
    } else if (awaiting === "b") {
      sheetEls.hint.textContent =
        "Ahora tocá otro punto del mapa para el punto B.";
      sheetEls.hint.hidden = false;
    } else if (stats === undefined) {
      sheetEls.hint.textContent =
        "Sin datos de altura en este tramo; probá con otros puntos.";
      sheetEls.hint.hidden = false;
    } else {
      sheetEls.hint.hidden = true;
    }
    sheetEls.tip.hidden = stats === undefined;
    sheetEls.chart.el.hidden = stats === undefined;
    sheetEls.statsDl.hidden = stats === undefined;
    sheetEls.source.hidden = stats === undefined;
    sheetEls.readout.hidden = cursorDistance === undefined;
    sheetEls.invertBtn.disabled = stats === undefined;
    sheetEls.clearBtn.disabled = !pointA;
    if (stats) {
      sheetEls.chart.setProfile(samples, stats);
      const els = sheetEls;
      const set = (key: string, v: string): void => {
        els.statEls[key]!.textContent = v;
      };
      set("distance", formatKm(stats.distanceMeters));
      set("max", formatElevation(stats.maxMeters));
      set("min", formatElevation(stats.minMeters));
      // Differences, not heights above sea level: plain meters.
      set("range", formatMetersDifference(stats.rangeMeters));
      set("ascent", formatMetersDifference(stats.ascentMeters));
      set("descent", formatMetersDifference(stats.descentMeters));
    }
  };

  const recompute = (): void => {
    if (!pointA || !pointB) {
      samples = [];
      stats = undefined;
      return;
    }
    samples = buildProfileSamples(
      opts.heightfield,
      [pointA.lon, pointA.lat],
      [pointB.lon, pointB.lat],
      { elevationAt: opts.drawnElevationAt },
    );
    stats = computeProfileStats(samples);
    if (stats && cursorDistance !== undefined) {
      // Keep the cursor on the transect after a recompute.
      cursorDistance = Math.min(cursorDistance, stats.distanceMeters);
    }
    // syncSheet rebuilds the chart (which hides its cursor); re-apply
    // the cursor afterwards so it survives the recompute.
    syncSheet();
    if (cursorDistance !== undefined) setCursor(cursorDistance);
  };

  const clearAll = (): void => {
    pointA = undefined;
    pointB = undefined;
    samples = [];
    stats = undefined;
    screenPts = [];
    setCursor(undefined);
    syncSheet();
    opts.requestFrame();
  };

  /**
   * The transect's screen polyline for the current camera: every sample
   * keeps its slot (behind-camera points are filled from the nearest
   * valid neighbour) so a fractional polyline index maps straight back
   * to a sample index for the two-way cursor.
   */
  const computeScreenLine = (
    viewProjection: readonly number[],
    viewportCss: readonly [number, number],
    exaggeration: number,
  ): { x: number; y: number }[] => {
    const pts: { x: number; y: number }[] = new Array(samples.length);
    let last = { x: 0, y: 0 };
    const pending: number[] = [];
    for (let k = 0; k < samples.length; k++) {
      const s = samples[k]!;
      const world = gridToWorld(spec, s.i, s.j, {
        elevationMeters:
          opts.drawnElevationAt(s.i, s.j) + LINE_LIFT_METERS,
        verticalExaggeration: exaggeration,
      });
      const p = projectToScreen(viewProjection, world, viewportCss);
      if (p === undefined) {
        pts[k] = last;
        pending.push(k);
      } else {
        last = { x: p.x, y: p.y };
        pts[k] = last;
        for (const q of pending) pts[q] = last;
        pending.length = 0;
      }
    }
    return pts;
  };

  const canvasPoint = (e: PointerEvent): { x: number; y: number } => {
    const rect = opts.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Nearest transect distance (meters) to a canvas CSS-px point. */
  const distanceNearPoint = (p: { x: number; y: number }): number | undefined => {
    if (samples.length < 2 || screenPts.length < 2) return undefined;
    const near = nearestOnPolyline(screenPts, p);
    if (!near || near.distPx > NEAR_LINE_PX) return undefined;
    return distanceAtFractionalIndex(samples, near.index);
  };

  const onHover = (e: PointerEvent): void => {
    if (e.buttons !== 0 || !isActive() || stats === undefined) return;
    const d = distanceNearPoint(canvasPoint(e));
    if (d !== undefined) setCursor(d);
  };

  const attachHandleDrag = (el: HTMLElement, which: "a" | "b"): void => {
    let dragId: number | undefined;
    el.addEventListener("pointerdown", (e) => {
      if (dragId !== undefined) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== dragId) return;
      // Re-pick the terrain under the finger, like the tap path does.
      const p = canvasPoint(e);
      const hit = opts.pickTerrainAt(p.x, p.y);
      if (!hit) return;
      const next = hitToPoint(hit);
      if (which === "a") pointA = next;
      else pointB = next;
      recompute();
      opts.requestFrame();
    });
    const endDrag = (e: PointerEvent): void => {
      if (e.pointerId !== dragId) return;
      dragId = undefined;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  };

  const placeHandle = (
    el: HTMLElement,
    p: { x: number; y: number } | undefined,
  ): void => {
    const show = p !== undefined;
    if (el.hidden === show) el.hidden = !show;
    if (p) {
      el.style.transform =
        `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) ` +
        "translate(-50%, -50%)";
    }
  };

  const update = (state: LayerState): void => {
    if (!mapEls) return; // headless or unmounted
    const active = isActive();
    // Patch coverage changed under an existing transect: recompute so
    // the chart numbers track the drawn surface.
    const covering = opts.coveringVersion?.();
    if (covering !== undefined && covering !== lastCoveringVersion) {
      lastCoveringVersion = covering;
      if (pointA && pointB) recompute();
    }

    const dpr = opts.pixelRatio() || 1;
    const viewportCss: [number, number] = [
      state.viewport[0] / dpr,
      state.viewport[1] / dpr,
    ];
    const svg = mapEls.svg;
    const viewBox = `0 0 ${Math.round(viewportCss[0])} ${Math.round(viewportCss[1])}`;
    if (svg.getAttribute("viewBox") !== viewBox) {
      svg.setAttribute("viewBox", viewBox);
    }

    const exaggeration = opts.verticalExaggeration();
    const viewProjection = state.camera.viewProjectionMatrix();
    const showLine = active && samples.length >= 2;
    if (showLine) {
      screenPts = computeScreenLine(viewProjection, viewportCss, exaggeration);
      const pts = screenPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      mapEls.halo.setAttribute("points", pts);
      mapEls.line.setAttribute("points", pts);
      mapEls.halo.setAttribute("visibility", "visible");
      mapEls.line.setAttribute("visibility", "visible");
    } else {
      screenPts = [];
      mapEls.halo.setAttribute("visibility", "hidden");
      mapEls.line.setAttribute("visibility", "hidden");
    }

    // Handles A/B, anchored to the drawn surface like the line.
    const projectEnd = (end: EndPoint | undefined): { x: number; y: number } | undefined => {
      if (!end || !active) return undefined;
      const world = gridToWorld(spec, end.i, end.j, {
        elevationMeters:
          opts.drawnElevationAt(end.i, end.j) + LINE_LIFT_METERS,
        verticalExaggeration: exaggeration,
      });
      return projectToScreen(viewProjection, world, viewportCss);
    };
    placeHandle(mapEls.handleA, projectEnd(pointA));
    placeHandle(mapEls.handleB, projectEnd(pointB));

    // Map cursor at the current transect distance.
    if (active && cursorDistance !== undefined && samples.length >= 2) {
      const at = sampleAtDistance(samples, cursorDistance);
      const world = gridToWorld(spec, at.i, at.j, {
        elevationMeters:
          opts.drawnElevationAt(at.i, at.j) + LINE_LIFT_METERS,
        verticalExaggeration: exaggeration,
      });
      const p = projectToScreen(viewProjection, world, viewportCss);
      if (p) {
        mapEls.cursorG.setAttribute(
          "transform",
          `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
        );
        mapEls.cursorG.setAttribute("visibility", "visible");
      } else {
        mapEls.cursorG.setAttribute("visibility", "hidden");
      }
    } else {
      mapEls.cursorG.setAttribute("visibility", "hidden");
    }
  };

  const layer: Layer = {
    id: "perfil",
    init(): void {},
    draw(): void {},
    update,
    ui: {
      mount(root: HTMLElement): () => void {
        const doc = root.ownerDocument;
        const svg = doc.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "perfil-overlay");
        svg.setAttribute("aria-hidden", "true");
        const halo = doc.createElementNS(SVG_NS, "polyline");
        halo.setAttribute("class", "perfil-line-halo");
        const line = doc.createElementNS(SVG_NS, "polyline");
        line.setAttribute("class", "perfil-line");
        const cursorG = doc.createElementNS(SVG_NS, "g");
        cursorG.setAttribute("class", "perfil-map-cursor");
        cursorG.setAttribute("visibility", "hidden");
        const cursorOuter = doc.createElementNS(SVG_NS, "circle");
        cursorOuter.setAttribute("r", "9");
        cursorOuter.setAttribute("class", "outer");
        const cursorInner = doc.createElementNS(SVG_NS, "circle");
        cursorInner.setAttribute("r", "4");
        cursorInner.setAttribute("class", "inner");
        cursorG.append(cursorOuter, cursorInner);
        svg.append(halo, line, cursorG);
        halo.setAttribute("visibility", "hidden");
        line.setAttribute("visibility", "hidden");

        const handleA = doc.createElement("div");
        handleA.className = "perfil-handle perfil-handle--a";
        handleA.hidden = true;
        const handleB = doc.createElement("div");
        handleB.className = "perfil-handle perfil-handle--b";
        handleB.hidden = true;
        for (const [el, letter] of [
          [handleA, "A"],
          [handleB, "B"],
        ] as const) {
          const label = doc.createElement("span");
          label.textContent = letter;
          el.appendChild(label);
        }
        attachHandleDrag(handleA, "a");
        attachHandleDrag(handleB, "b");

        root.append(svg, handleA, handleB);

        // --- Sheet content ---------------------------------------------
        const host = opts.sheetHost;
        host.textContent = ""; // replaces the "Próximamente" placeholder
        const sheet = doc.createElement("div");
        sheet.className = "perfil";

        const hint = doc.createElement("p");
        hint.className = "perfil-hint";
        const tip = doc.createElement("p");
        tip.className = "perfil-tip";
        tip.textContent =
          "Arrastrá A o B sobre el mapa para ajustar el corte; recorré el gráfico o acercate a la línea para ver valores.";
        tip.hidden = true;

        const chart = createPerfilChart(
          {
            onScrub: (d) => {
              setCursor(d);
            },
          },
          doc,
        );
        chart.el.hidden = true;

        const readout = doc.createElement("p");
        readout.className = "perfil-readout";
        readout.hidden = true;
        readout.setAttribute("aria-live", "polite");

        const statsDl = doc.createElement("dl");
        statsDl.className = "perfil-stats pick-panel-data";
        statsDl.hidden = true;
        const statEls: Record<string, HTMLElement> = {};
        for (const [key, label] of [
          ["distance", "Distancia"],
          ["max", "Altura máxima"],
          ["min", "Altura mínima"],
          ["range", "Desnivel"],
          ["ascent", "Ascenso total"],
          ["descent", "Descenso total"],
        ] as const) {
          const dt = doc.createElement("dt");
          dt.textContent = label;
          const dd = doc.createElement("dd");
          statEls[key] = dd;
          statsDl.append(dt, dd);
        }

        const actions = doc.createElement("div");
        actions.className = "perfil-actions";
        const invertBtn = doc.createElement("button");
        invertBtn.type = "button";
        invertBtn.className = "perfil-button";
        invertBtn.textContent = "Invertir";
        invertBtn.disabled = true;
        invertBtn.addEventListener("click", () => {
          const a = pointA;
          pointA = pointB;
          pointB = a;
          recompute();
          opts.requestFrame();
        });
        const clearBtn = doc.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "perfil-button";
        clearBtn.textContent = "Borrar";
        clearBtn.disabled = true;
        clearBtn.addEventListener("click", clearAll);
        actions.append(invertBtn, clearBtn);

        const source = doc.createElement("p");
        source.className = "perfil-source";
        source.hidden = true;
        source.append(
          doc.createTextNode("Alturas: modelo de elevación — "),
        );
        const sourceLink = doc.createElement("a");
        sourceLink.href = HEIGHTS_SOURCE.url;
        sourceLink.textContent = HEIGHTS_SOURCE.label;
        sourceLink.rel = "noopener noreferrer";
        sourceLink.target = "_blank";
        source.appendChild(sourceLink);
        source.appendChild(doc.createTextNode("."));

        sheet.append(
          hint,
          tip,
          chart.el,
          readout,
          statsDl,
          actions,
          source,
        );
        host.appendChild(sheet);

        mapEls = { svg, halo, line, cursorG, handleA, handleB };
        sheetEls = {
          hint,
          tip,
          chart,
          readout,
          statsDl,
          statEls,
          invertBtn,
          clearBtn,
          source,
        };
        syncSheet();
        // Switching modes flips host.hidden: repaint so the overlay
        // appears/disappears, and rebuild the chart — it may have been
        // laid out while the host was hidden (zero measurable width).
        const observer = new MutationObserver(() => {
          if (!host.hidden && stats && sheetEls) {
            sheetEls.chart.setProfile(samples, stats);
            setCursor(cursorDistance);
          }
          opts.requestFrame();
        });
        observer.observe(host, {
          attributes: true,
          attributeFilter: ["hidden"],
        });
        opts.canvas.addEventListener("pointermove", onHover);

        return () => {
          observer.disconnect();
          opts.canvas.removeEventListener("pointermove", onHover);
          svg.remove();
          handleA.remove();
          handleB.remove();
          sheet.remove();
          mapEls = undefined;
          sheetEls = undefined;
        };
      },
    },
  };

  return {
    layer,
    onTap(point, hit): boolean {
      if (!isActive()) return false;
      // Both points set: a tap near the line drives the chart cursor.
      const d = distanceNearPoint(point);
      if (d !== undefined) {
        setCursor(d);
        return true;
      }
      if (hit) {
        if (!pointA) {
          pointA = hitToPoint(hit);
          syncSheet();
          opts.requestFrame();
          return true;
        }
        if (!pointB) {
          // Too close to A: keep waiting for a real second point.
          const farEnough =
            profileGroundDistanceMeters(
              spec,
              [pointA.lon, pointA.lat],
              hit.lonLat,
            ) >= metersPerGridCell(spec);
          if (farEnough) {
            pointB = hitToPoint(hit);
            recompute();
            opts.requestFrame();
          }
          return true;
        }
      }
      // In Perfil mode every canvas tap belongs to the transect flow —
      // the pick panel stays out of the way.
      return true;
    },
    seed(a, b): void {
      const [ai, aj] = lonLatToGrid(spec, a[0], a[1]);
      const [bi, bj] = lonLatToGrid(spec, b[0], b[1]);
      pointA = { lon: a[0], lat: a[1], i: ai, j: aj };
      pointB = { lon: b[0], lat: b[1], i: bi, j: bj };
      recompute();
      opts.requestFrame();
    },
  };
}
