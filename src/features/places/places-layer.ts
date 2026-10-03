import type { Layer, LayerState } from "../../app/layers";
import type { GridSpec } from "../../geo/grid";
import { gridToWorld, lonLatToGrid } from "../../geo";
import type { Heightfield } from "../../terrain/heightfield";
import type { Place } from "../../terrain/places-manifest";
import {
  formatElevation,
  formatLatitude,
  formatLongitude,
} from "../../ui/pick-panel";
import {
  declutterLabels,
  isOccluded,
  MARKER_LIFT_METERS,
  MARKER_TAP_RADIUS_PX,
  nearestMarker,
  projectToScreen,
  type LabelRect,
} from "./places-markers";

/**
 * DOM place markers over the 3D terrain: one purely visual marker per
 * place, projected every rendered frame from its world position with
 * the live camera matrix and the CURRENT vertical exaggeration.
 * Tapping a marker opens a card ("ficha") with the sourced data from
 * places.json.
 *
 * The layer and its markers are pointer-events: none — a full-screen
 * interactive layer would swallow every map gesture (iOS Safari then
 * pinch-zooms the page). Marker taps therefore come in through the
 * canvas tap path: main.ts calls pickAt() before running the terrain
 * pick, and this layer answers from the same projected positions it
 * renders. Drags starting on a marker hit the canvas and pan the map.
 * Keyboard users get the same cards from the "Lugares" list control.
 *
 * - Markers anchor a few meters above the DRAWN surface — the same
 *   geomorphed surface picking uses — so they ride the terrain (and the
 *   detail patches) instead of floating at raw-DEM height.
 * - Occlusion is approximate and CPU-side: a throttled round-robin of
 *   rays (a few markers per rendered frame) tested against the same
 *   drawn surface, so a ridge blocks the markers behind it.
 * - Labels declutter greedily in screen space; dots always stay. The
 *   open card's marker keeps its label pinned.
 *
 * The layer is a DOM citizen like the pick panel: init/draw are no-ops,
 * update() touches the DOM only while mounted (ui.mount), so the headless
 * snapshot never reaches it — the snapshot draws equivalent dots with the
 * same pure helpers (places-markers.ts).
 */

/** Markers whose occlusion is re-checked per rendered frame. */
const OCCLUSION_BATCH = 4;
/**
 * Labels only appear when the camera is this close to the marker (km):
 * at overview distance the map shows dots only, and names fade in as the
 * user zooms toward a region. Occlusion and declutter apply on top.
 */
const LABEL_MAX_DISTANCE_KM = 150;
/** Screen margin kept when projecting, in CSS px (half a marker). */
const VIEWPORT_MARGIN_PX = 24;
/** Fallback label size before the element can be measured, in CSS px. */
const ESTIMATED_LABEL_HEIGHT = 18;
const ESTIMATED_LABEL_CHAR_WIDTH = 6.5;

export interface PlacesLayerOptions {
  readonly places: readonly Place[];
  /** GridSpec of the loaded base terrain level (world-space anchor). */
  readonly spec: GridSpec;
  /** Live vertical exaggeration (the value the terrain slider drives). */
  readonly verticalExaggeration: () => number;
  /** Physical px per CSS px (the surface DPR), for the overlay units. */
  readonly pixelRatio: () => number;
  /**
   * Elevation of the drawn surface in meters at base grid coords —
   * detailSurfaceElevation over the covering patches, or the plain DEM
   * sample elsewhere. Read every update so markers track the patches.
   */
  readonly drawnElevationAt: (i: number, j: number) => number;
  /** Occlusion march inputs. */
  readonly occlusion: {
    readonly heightfield: Heightfield;
    /**
     * How far (meters) the drawn surface may exceed the heightfield's
     * [min, max] — the same margin the pick path computes. Live getter:
     * the covering patch set changes as the camera moves.
     */
    readonly surfaceMarginMeters?: () => number;
  };
}

interface MarkerState {
  readonly place: Place;
  /** Base grid coords of the place, fixed at construction. */
  readonly i: number;
  readonly j: number;
  /** On-screen position from the last update, CSS px. */
  screen: { x: number; y: number } | undefined;
  /** World anchor from the last update, km — also the label distance. */
  world: readonly [number, number, number] | undefined;
  occluded: boolean;
  el: HTMLElement | undefined;
  labelEl: HTMLElement | undefined;
  labelSize: { w: number; h: number } | undefined;
}

export interface PlacesLayer extends Layer {
  /** The "Lugares" marker visibility; on by default. */
  setVisible(visible: boolean): void;
  /**
   * Canvas-tap hit test at (x, y) in canvas CSS px: opens the card of
   * the nearest on-screen, unoccluded marker inside MARKER_TAP_RADIUS_PX
   * and returns true. False means no marker was hit — the caller should
   * run the normal terrain pick.
   */
  pickAt(x: number, y: number): boolean;
}

export function createPlacesLayer(opts: PlacesLayerOptions): PlacesLayer {
  const markers: MarkerState[] = opts.places.map((place) => {
    const [i, j] = lonLatToGrid(opts.spec, place.lon, place.lat);
    return {
      place,
      i,
      j,
      screen: undefined,
      world: undefined,
      occluded: false,
      el: undefined,
      labelEl: undefined,
      labelSize: undefined,
    };
  });

  let visible = true;
  let selected: MarkerState | undefined;
  let occlusionCursor = 0;

  // Mounted DOM (set by ui.mount; absent in the headless snapshot).
  let container: HTMLElement | undefined;
  let card: HTMLElement | undefined;
  let cardName: HTMLElement | undefined;
  let cardDesc: HTMLElement | undefined;
  let cardDept: HTMLElement | undefined;
  let cardAlt: HTMLElement | undefined;
  let cardLat: HTMLElement | undefined;
  let cardLon: HTMLElement | undefined;
  let cardAltNote: HTMLElement | undefined;
  let cardLinks: HTMLElement | undefined;
  let visibleCheckbox: HTMLInputElement | undefined;

  const closeCard = (): void => {
    if (card) card.hidden = true;
    selected = undefined;
  };

  const openCard = (marker: MarkerState): void => {
    if (!card) return;
    const place = marker.place;
    if (cardName) cardName.textContent = place.name;
    if (cardDesc) {
      cardDesc.textContent = place.description ?? "Sin descripción";
      cardDesc.classList.toggle(
        "place-card-desc--empty",
        place.description === null,
      );
    }
    if (cardDept) cardDept.textContent = place.department;
    if (cardAlt) cardAlt.textContent = formatElevation(place.elevationMeters);
    if (cardLat) cardLat.textContent = formatLatitude(place.lat);
    if (cardLon) cardLon.textContent = formatLongitude(place.lon);
    if (cardAltNote) {
      cardAltNote.textContent =
        place.elevationSource === "detail-dem"
          ? "Altura: modelo de elevación de detalle."
          : "Altura: modelo de elevación.";
    }
    if (cardLinks) {
      cardLinks.textContent = "";
      const doc = cardLinks.ownerDocument;
      const wikidata = doc.createElement("a");
      wikidata.href = place.wikidataUrl;
      wikidata.textContent = "Ver en Wikidata";
      const links = [wikidata];
      if (place.eswikiUrl !== null) {
        const wikipedia = doc.createElement("a");
        wikipedia.href = place.eswikiUrl;
        wikipedia.textContent = "Artículo en Wikipedia";
        links.push(wikipedia);
      }
      for (const [k, link] of links.entries()) {
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        if (k > 0) cardLinks.appendChild(doc.createTextNode(" · "));
        cardLinks.appendChild(link);
      }
    }
    card.hidden = false;
    selected = marker;
  };

  /** One occlusion check per rendered frame for a rotating batch. */
  const updateOcclusion = (state: LayerState): void => {
    if (markers.length === 0) return;
    const eye = state.camera.eye();
    const exaggeration = opts.verticalExaggeration();
    const margin = opts.occlusion.surfaceMarginMeters?.() ?? 0;
    const drawnSurface = (i: number, j: number): number =>
      opts.drawnElevationAt(i, j);
    for (let k = 0; k < OCCLUSION_BATCH; k++) {
      const marker = markers[occlusionCursor % markers.length];
      occlusionCursor += 1;
      // Only on-screen candidates cost a ray march.
      if (!marker?.world || marker.screen === undefined) continue;
      marker.occluded = isOccluded(
        opts.occlusion.heightfield,
        eye,
        marker.world,
        exaggeration,
        {
          surfaceAt: drawnSurface,
          surfaceMarginMeters: margin,
        },
      );
    }
  };

  return {
    id: "places",

    init(): void {},
    draw(): void {},

    update(state: LayerState): void {
      if (!container) return; // headless or unmounted
      const dpr = opts.pixelRatio() || 1;
      const viewport: [number, number] = [
        state.viewport[0] / dpr,
        state.viewport[1] / dpr,
      ];
      const viewProjection = state.camera.viewProjectionMatrix();
      const exaggeration = opts.verticalExaggeration();

      for (const marker of markers) {
        const world = gridToWorld(opts.spec, marker.i, marker.j, {
          elevationMeters:
            opts.drawnElevationAt(marker.i, marker.j) + MARKER_LIFT_METERS,
          verticalExaggeration: exaggeration,
        });
        marker.world = world;
        const p = projectToScreen(viewProjection, world, viewport);
        marker.screen =
          p !== undefined &&
          p.x >= -VIEWPORT_MARGIN_PX &&
          p.x <= viewport[0] + VIEWPORT_MARGIN_PX &&
          p.y >= -VIEWPORT_MARGIN_PX &&
          p.y <= viewport[1] + VIEWPORT_MARGIN_PX
            ? p
            : undefined;
      }
      updateOcclusion(state);

      // Labels show only when the camera is near enough — dots always
      // stay. Declutter among the labels left visible; the selected
      // marker's label is pinned regardless of overlaps or distance.
      const eye = state.camera.eye();
      const labelCandidate = (m: MarkerState): boolean => {
        if (!m.world || m.screen === undefined || m.occluded) return false;
        const dx = m.world[0] - eye[0];
        const dy = m.world[1] - eye[1];
        const dz = m.world[2] - eye[2];
        return (
          dx * dx + dy * dy + dz * dz <=
          LABEL_MAX_DISTANCE_KM * LABEL_MAX_DISTANCE_KM
        );
      };
      const decluttered = markers.filter(
        (m) => m !== selected && labelCandidate(m),
      );
      const keep = declutterLabels(
        decluttered.map((m) => {
          const size = m.labelSize ?? {
            w: m.place.name.length * ESTIMATED_LABEL_CHAR_WIDTH + 12,
            h: ESTIMATED_LABEL_HEIGHT,
          };
          const s = m.screen ?? { x: 0, y: 0 };
          // The label sits to the right of the centered marker dot.
          return {
            x: s.x + 10,
            y: s.y - size.h / 2,
            width: size.w,
            height: size.h,
          } satisfies LabelRect;
        }),
      );
      const labelShown = new Map<MarkerState, boolean>(
        decluttered.map((m, k) => [m, keep[k] === true]),
      );

      for (const marker of markers) {
        const el = marker.el;
        if (!el) continue;
        const onScreen =
          visible && marker.screen !== undefined && !marker.occluded;
        if (el.hidden === onScreen) el.hidden = !onScreen;
        if (!onScreen || !marker.screen) continue;
        el.style.transform =
          `translate(${marker.screen.x.toFixed(1)}px, ` +
          `${marker.screen.y.toFixed(1)}px) translate(-50%, -50%)`;
        if (marker.labelSize === undefined && marker.labelEl) {
          const w = marker.labelEl.offsetWidth;
          const h = marker.labelEl.offsetHeight;
          if (w > 0 && h > 0) marker.labelSize = { w, h };
        }
        const labelOn =
          marker === selected || labelShown.get(marker) === true;
        marker.labelEl?.classList.toggle(
          "place-marker-label--hidden",
          !labelOn,
        );
      }
    },

    pickAt(x: number, y: number): boolean {
      const index = nearestMarker(
        markers.map((m) =>
          visible && m.screen !== undefined && !m.occluded
            ? m.screen
            : undefined,
        ),
        { x, y },
        MARKER_TAP_RADIUS_PX,
      );
      const marker = index === undefined ? undefined : markers[index];
      if (!marker) return false;
      openCard(marker);
      return true;
    },

    onPick(): void {
      // A canvas tap that missed every marker means the user aimed at
      // the terrain, so the card is dismissed.
      closeCard();
    },

    ui: {
      mount(root: HTMLElement): () => void {
        const doc = root.ownerDocument;

        const layer = doc.createElement("div");
        layer.className = "places-layer";

        for (const marker of markers) {
          // Purely visual: taps reach the card through pickAt(), keyboard
          // users through the "Lugares" list — aria-hidden keeps the
          // decorative dot out of the a11y tree either way.
          const el = doc.createElement("span");
          el.className = "place-marker";
          el.setAttribute("aria-hidden", "true");
          // Hidden until the first update() projects a position — avoids a
          // flash of unpositioned markers at the corner.
          el.hidden = true;
          const dot = doc.createElement("span");
          dot.className = "place-marker-dot";
          const label = doc.createElement("span");
          label.className = "place-marker-label";
          label.textContent = marker.place.name;
          el.append(dot, label);
          marker.el = el;
          marker.labelEl = label;
          layer.appendChild(el);
        }

        // Card ("ficha"): reuses the pick-panel shell + data grid so the
        // two panels read and behave identically, including the mobile
        // bottom sheet.
        const cardEl = doc.createElement("section");
        cardEl.className = "pick-panel place-card";
        cardEl.hidden = true;
        cardEl.setAttribute("aria-live", "polite");

        const close = doc.createElement("button");
        close.type = "button";
        close.className = "pick-panel-close";
        close.textContent = "×";
        close.setAttribute("aria-label", "Cerrar");
        close.addEventListener("click", closeCard);

        const name = doc.createElement("h2");
        name.className = "place-card-name";
        const desc = doc.createElement("p");
        desc.className = "place-card-desc";

        const rows = doc.createElement("dl");
        rows.className = "pick-panel-data";
        const row = (labelText: string): HTMLElement => {
          const dt = doc.createElement("dt");
          dt.textContent = labelText;
          const dd = doc.createElement("dd");
          rows.append(dt, dd);
          return dd;
        };
        const dept = row("Departamento");
        const alt = row("Altura");
        const lat = row("Latitud");
        const lon = row("Longitud");

        const altNote = doc.createElement("p");
        altNote.className = "pick-panel-note";
        const sourceNote = doc.createElement("p");
        sourceNote.className = "pick-panel-note";
        sourceNote.textContent =
          "Nombre, descripción y coordenadas: Wikidata (CC0).";
        const links = doc.createElement("p");
        links.className = "place-card-links";

        cardEl.append(close, name, desc, rows, altNote, sourceNote, links);
        layer.appendChild(cardEl);
        root.appendChild(layer);

        // "Lugares" control: a button that expands a list with one button
        // per place (sorted by name) — the keyboard path to the same card
        // pickAt() opens — plus a checkbox that keeps the show/hide-
        // markers toggle. Inside the existing controls panel when it is
        // there (it mounts first), floating top-left as a fallback.
        const control = doc.createElement("div");
        control.className = "places-control";

        const listToggle = doc.createElement("button");
        listToggle.type = "button";
        listToggle.className = "places-toggle";
        listToggle.textContent = "Lugares";
        listToggle.setAttribute("aria-expanded", "false");
        listToggle.setAttribute(
          "aria-label",
          "Mostrar la lista de lugares",
        );

        const listPanel = doc.createElement("div");
        listPanel.className = "places-list";
        listPanel.hidden = true;

        const visLabel = doc.createElement("label");
        visLabel.className = "places-list-visible";
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = visible;
        visLabel.append(
          checkbox,
          doc.createTextNode("Mostrar en el mapa"),
        );

        const items = doc.createElement("ul");
        items.className = "places-list-items";
        const sorted = [...markers].sort((a, b) =>
          a.place.name.localeCompare(b.place.name, "es"),
        );
        for (const marker of sorted) {
          const li = doc.createElement("li");
          const item = doc.createElement("button");
          item.type = "button";
          item.className = "places-list-item";
          item.textContent = marker.place.name;
          item.addEventListener("click", () => {
            openCard(marker);
          });
          li.appendChild(item);
          items.appendChild(li);
        }
        listPanel.append(visLabel, items);
        control.append(listToggle, listPanel);

        listToggle.addEventListener("click", () => {
          const open = listPanel.hidden;
          listPanel.hidden = !open;
          listToggle.setAttribute("aria-expanded", String(open));
        });

        const applyVisible = (v: boolean): void => {
          visible = v;
          checkbox.checked = v;
          layer.hidden = !v;
          if (!v) closeCard();
        };
        checkbox.addEventListener("change", () => {
          applyVisible(checkbox.checked);
        });

        const panel = root.querySelector(".terrain-controls");
        if (panel) {
          panel.appendChild(control);
        } else {
          control.classList.add("places-control--floating");
          root.appendChild(control);
        }
        visibleCheckbox = checkbox;
        layer.hidden = !visible;

        container = layer;
        card = cardEl;
        cardName = name;
        cardDesc = desc;
        cardDept = dept;
        cardAlt = alt;
        cardLat = lat;
        cardLon = lon;
        cardAltNote = altNote;
        cardLinks = links;

        return () => {
          container = undefined;
          card = undefined;
          visibleCheckbox = undefined;
          layer.remove();
          control.remove();
        };
      },
    },

    setVisible(v: boolean): void {
      visible = v;
      if (container) container.hidden = !v;
      if (visibleCheckbox) visibleCheckbox.checked = v;
      if (!v) closeCard();
    },
  };
}
