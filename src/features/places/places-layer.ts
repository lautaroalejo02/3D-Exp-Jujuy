import type { Layer, LayerState } from "../../app/layers";
import type { GridSpec } from "../../geo/grid";
import { gridToWorld, lonLatToGrid } from "../../geo";
import type { Heightfield } from "../../terrain/heightfield";
import type { Place } from "../../terrain/places-manifest";
import { createPlaceCard, type PlaceCard } from "./place-card";
import type { DropdownGroup } from "../../ui/dropdowns";
import {
  createPhotoLightbox,
  type PhotoLightbox,
} from "./photo-lightbox";
import type { PlaceRegionLookup } from "./place-region";
import {
  clusterMarkers,
  declutterLabels,
  isOccluded,
  MARKER_LIFT_METERS,
  MARKER_TAP_RADIUS_PX,
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
 * - Markers closer than MARKER_CLUSTER_PX on screen merge into one
 *   cluster dot with a member count; tapping it asks the caller to
 *   zoom in (onClusterTap) so the members separate. The selected
 *   marker never joins a cluster — it stays emphasized.
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
  /**
   * Department → region lookup for the card's "Región" row (the same
   * regionNames LUT the pick panel uses). When absent the card omits
   * the row.
   */
  readonly regions?: PlaceRegionLookup;
  /**
   * Shared dropdown coordination (one open at a time, tap outside to
   * close). Optional so headless/test callers don't need a Document.
   */
  readonly dropdowns?: DropdownGroup;
  /**
   * The element the place card mounts into (default: the overlay root).
   * The detail sheet passes its card slot here.
   */
  readonly cardHost?: (root: HTMLElement) => HTMLElement;
  /** A card opened — the detail sheet presents it under this title. */
  readonly onCardPresent?: (placeName: string) => void;
  /** The card closed — the detail sheet frees its slot. */
  readonly onCardDismissed?: () => void;
  /**
   * A cluster dot was tapped: the caller should fly the camera to the
   * cluster — `world` is the member mean on the drawn surface and
   * `spreadPx` the members' current screen spread, both ready to feed a
   * fly-to that separates the cluster.
   */
  readonly onClusterTap?: (cluster: {
    readonly places: readonly Place[];
    readonly world: readonly [number, number, number];
    readonly spreadPx: number;
  }) => void;
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

/** A visible marker cluster from the last update() — draw + tap state. */
interface ClusterState {
  /** Cluster center on screen, CSS px (member mean). */
  readonly x: number;
  readonly y: number;
  readonly members: readonly MarkerState[];
  /** Member mean in world km — the fly-to target on a cluster tap. */
  readonly world: readonly [number, number, number];
  /** Largest pairwise member distance on screen, CSS px. */
  readonly spreadPx: number;
}

/** One tappable dot on screen: a single marker or a cluster center. */
type PickTarget =
  | { readonly x: number; readonly y: number; readonly marker: MarkerState }
  | { readonly x: number; readonly y: number; readonly cluster: ClusterState };

export interface PlacesLayer extends Layer {
  /** The "Mostrar lugares" marker visibility; on by default. */
  setVisible(visible: boolean): void;
  /**
   * Canvas-tap hit test at (x, y) in canvas CSS px: opens the card of
   * the nearest on-screen, unoccluded marker inside MARKER_TAP_RADIUS_PX
   * and returns true. False means no marker was hit — the caller should
   * run the normal terrain pick.
   */
  pickAt(x: number, y: number): boolean;
  /** Open a place's card — the Explorar list's path to the same ficha. */
  openPlaceCard(place: Place): void;
  /** Close the open card (and lightbox), if any. */
  closeCard(): void;
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
  // Clustering state from the last update(): the drawn clusters, the
  // markers they absorbed, and the merged pick-target list (cluster
  // centers + unclustered marker dots) pickAt() hit-tests against.
  let clustersNow: ClusterState[] = [];
  const clusteredNow = new Set<MarkerState>();
  let pickTargets: readonly PickTarget[] = [];

  // Mounted DOM (set by ui.mount; absent in the headless snapshot).
  let container: HTMLElement | undefined;
  let card: PlaceCard | undefined;
  let lightbox: PhotoLightbox | undefined;
  const clusterEls: HTMLElement[] = [];

  const closeCard = (): void => {
    const wasOpen = card !== undefined && !card.el.hidden;
    card?.close();
    lightbox?.close();
    selected = undefined;
    if (wasOpen) opts.onCardDismissed?.();
  };

  const openCard = (marker: MarkerState): void => {
    if (!card) return;
    card.open(marker.place);
    selected = marker;
    opts.onCardPresent?.(marker.place.name);
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

      // Screen-space clustering: markers nearer than MARKER_CLUSTER_PX
      // merge into one dot with a count. The selected marker never
      // clusters — its card is open and the dot stays emphasized.
      clusteredNow.clear();
      clustersNow = [];
      const groups = clusterMarkers(
        markers.map((m) =>
          visible && m !== selected && m.screen !== undefined && !m.occluded
            ? m.screen
            : undefined,
        ),
      );
      for (const group of groups) {
        if (group.members.length < 2) continue;
        const members = group.members.map((i) => markers[i]!);
        let wx = 0;
        let wy = 0;
        let wz = 0;
        let spreadPx = 0;
        for (const [a, m] of members.entries()) {
          const w = m.world ?? [0, 0, 0];
          wx += w[0];
          wy += w[1];
          wz += w[2];
          for (const other of members.slice(a + 1)) {
            spreadPx = Math.max(
              spreadPx,
              Math.hypot(m.screen!.x - other.screen!.x, m.screen!.y - other.screen!.y),
            );
          }
          clusteredNow.add(m);
        }
        const n = members.length;
        clustersNow.push({
          x: group.x,
          y: group.y,
          members,
          world: [wx / n, wy / n, wz / n],
          spreadPx,
        });
      }

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
        (m) => m !== selected && !clusteredNow.has(m) && labelCandidate(m),
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
          visible &&
          marker.screen !== undefined &&
          !marker.occluded &&
          !clusteredNow.has(marker);
        if (el.hidden === onScreen) el.hidden = !onScreen;
        if (!onScreen || !marker.screen) continue;
        el.classList.toggle("place-marker--selected", marker === selected);
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

      // Cluster dots: one element per visible cluster (the pool grows on
      // demand, never shrinks). Same translate-centering as the markers.
      while (clusterEls.length < clustersNow.length && container) {
        const el = container.ownerDocument.createElement("span");
        el.className = "place-marker place-marker--cluster";
        el.setAttribute("aria-hidden", "true");
        const dot = container.ownerDocument.createElement("span");
        dot.className = "place-marker-dot";
        const count = container.ownerDocument.createElement("span");
        count.className = "place-marker-count";
        dot.appendChild(count);
        el.appendChild(dot);
        container.appendChild(el);
        clusterEls.push(el);
      }
      for (const [k, cluster] of clustersNow.entries()) {
        const el = clusterEls[k]!;
        el.hidden = false;
        el.style.transform =
          `translate(${cluster.x.toFixed(1)}px, ` +
          `${cluster.y.toFixed(1)}px) translate(-50%, -50%)`;
        const count = el.firstElementChild?.firstElementChild;
        if (count && count.textContent !== String(cluster.members.length)) {
          count.textContent = String(cluster.members.length);
        }
      }
      for (let k = clustersNow.length; k < clusterEls.length; k++) {
        clusterEls[k]!.hidden = true;
      }

      // The tap targets pickAt() sees — the same dots on screen: single
      // markers (incl. the selected one) and cluster centers.
      const targets: PickTarget[] = [];
      for (const marker of markers) {
        if (
          visible &&
          marker.screen !== undefined &&
          !marker.occluded &&
          !clusteredNow.has(marker)
        ) {
          targets.push({
            x: marker.screen.x,
            y: marker.screen.y,
            marker,
          });
        }
      }
      for (const cluster of clustersNow) {
        targets.push({ x: cluster.x, y: cluster.y, cluster });
      }
      pickTargets = targets;
    },

    pickAt(x: number, y: number): boolean {
      // Hit-test the same dots the layer draws: unclustered markers and
      // cluster centers. The nearest one inside the tap radius wins.
      const radius2 = MARKER_TAP_RADIUS_PX * MARKER_TAP_RADIUS_PX;
      let best: PickTarget | undefined;
      let bestD2 = radius2;
      for (const t of pickTargets) {
        const dx = t.x - x;
        const dy = t.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
          best = t;
          bestD2 = d2;
        }
      }
      if (best === undefined) return false;
      if ("marker" in best) {
        openCard(best.marker);
      } else {
        opts.onClusterTap?.({
          places: best.cluster.members.map((m) => m.place),
          world: best.cluster.world,
          spreadPx: best.cluster.spreadPx,
        });
      }
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

        // Card ("ficha") + photo lightbox: DOM components built by
        // place-card.ts / photo-lightbox.ts. The card mounts into the
        // detail sheet's card slot (cardHost) so it shares the sheet
        // system with the pick info — the lightbox mounts above
        // everything on the overlay root.
        const lightboxEl = createPhotoLightbox(doc);
        const cardComponent = createPlaceCard(doc, {
          ...(opts.regions !== undefined
            ? { regions: opts.regions }
            : {}),
          onPhoto: (place, index) => {
            lightboxEl.open(place.photos, index, place.name);
          },
          onDismiss: closeCard,
        });
        (opts.cardHost?.(root) ?? root).appendChild(cardComponent.el);
        root.appendChild(layer);
        root.appendChild(lightboxEl.el);

        layer.hidden = !visible;

        container = layer;
        card = cardComponent;
        lightbox = lightboxEl;

        return () => {
          container = undefined;
          card = undefined;
          lightbox = undefined;
          lightboxEl.el.remove();
          layer.remove();
          cardComponent.el.remove();
        };
      },
    },

    openPlaceCard(place: Place): void {
      const marker = markers.find((m) => m.place === place);
      if (marker) openCard(marker);
    },

    closeCard(): void {
      closeCard();
    },

    setVisible(v: boolean): void {
      visible = v;
      if (container) container.hidden = !v;
      if (!v) closeCard();
    },
  };
}
