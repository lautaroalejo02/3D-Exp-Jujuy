/**
 * The maqueta menu: the bottom mode bar plus the two bottom sheets —
 * the "mode" sheet (per-mode content, always present at least minimized)
 * and the "detail" sheet stacked above it (place card / pick info,
 * hidden until something is picked). Created once at startup, before the
 * WebGPU check, so the chrome is also on screen on the fallback notice.
 *
 * Mode content lives in one host section per mode inside the mode
 * sheet's scrollable content; switching modes swaps the visible host and
 * retitles the sheet. `#sheet-sol` stays empty on purpose — it is the
 * mount point the sun-mode stage attaches to.
 */
import {
  createModeBar,
  MODE_LABELS,
  type AppMode,
} from "./mode-bar";
import { createSheet, type Sheet } from "./sheet";
import {
  initialSheetStack,
  reduceSheetStack,
  type SheetStackEvent,
} from "./sheet-stack";

export interface AppMenu {
  readonly modeSheet: Sheet;
  readonly detailSheet: Sheet;
  /** Active mode. */
  mode(): AppMode;
  /** Switch mode: updates tabs, sheet title and the visible host. */
  setMode(mode: AppMode): void;
  /** Content host of each mode inside the mode sheet. */
  readonly modeHosts: Readonly<Record<AppMode, HTMLElement>>;
  /**
   * Show the detail sheet. On the stacked mobile/tablet layout it also
   * folds the mode sheet to its title row (the detail presents at half,
   * keeping the map visible above); on desktop it just docks.
   */
  presentDetail(): void;
  /**
   * Hide the detail sheet. On the stacked layout the mode sheet returns
   * to the snap it had before the detail opened.
   */
  dismissDetail(): void;
}

const MODES: readonly AppMode[] = ["explorar", "sol", "perfil", "agua"];

/** Media query where the sheets stop being draggable bottom sheets. */
const DESKTOP_PANEL_QUERY = "(min-width: 1024px)";

export function createAppMenu(
  overlay: HTMLElement,
  opts: {
    readonly initial?: AppMode;
    /**
     * Fired when a sheet's occluded screen area may have changed (snap,
     * show, hide, present) — the camera framing re-derives its UI-free
     * rectangle from it.
     */
    readonly onSheetGeometry?: () => void;
  } = {},
): AppMenu {
  const doc = overlay.ownerDocument;
  let mode: AppMode = opts.initial ?? "explorar";
  const onGeometryChange = (): void => opts.onSheetGeometry?.();

  // The two sheets share the strip above the mode bar on phone/tablet:
  // reduceSheetStack keeps the invariant that at most one is expanded.
  // Function declarations hoist, so the sheet callbacks below can
  // dispatch before modeSheet/detailSheet are assigned — events can only
  // fire after both sheets exist (the sheets are inert until shown).
  let stack = initialSheetStack;

  function applyStack(): void {
    if (modeSheet.snap() !== stack.modeSnap) modeSheet.setSnap(stack.modeSnap);
    if (stack.detailOpen) {
      if (!detailSheet.isShown()) detailSheet.show();
      if (detailSheet.snap() !== stack.detailSnap) {
        detailSheet.setSnap(stack.detailSnap);
      }
    } else if (detailSheet.isShown()) {
      detailSheet.hide();
    }
  }

  function dispatch(event: SheetStackEvent): void {
    const next = reduceSheetStack(stack, event);
    if (next === stack) return;
    stack = next;
    applyStack();
  }

  const modeSheet = createSheet(
    {
      id: "sheet-mode",
      title: MODE_LABELS[mode],
      className: "sheet--mode",
      onGeometryChange,
      onSnapChange: (snap) => dispatch({ type: "mode-snap", snap }),
    },
    doc,
  );
  const detailSheet = createSheet(
    {
      id: "sheet-detail",
      title: "Detalle",
      className: "sheet--detail",
      onGeometryChange,
      onSnapChange: (snap) => dispatch({ type: "detail-snap", snap }),
    },
    doc,
  );

  const hosts = {} as Record<AppMode, HTMLElement>;
  for (const id of MODES) {
    const host = doc.createElement("section");
    host.id = `sheet-${id}`;
    host.className = "mode-host";
    host.hidden = id !== mode;
    if (id !== "explorar") {
      // Stage-1 placeholders; the mode sheets get real content later.
      // For sol the note lives inside #sheet-sol, so the sun stage
      // replaces the mount point's children and it goes away by itself.
      const note = doc.createElement("p");
      note.className = "mode-placeholder";
      note.textContent = "Próximamente";
      host.appendChild(note);
    }
    hosts[id] = host;
    modeSheet.contentEl.appendChild(host);
  }

  const setMode = (next: AppMode): void => {
    mode = next;
    for (const id of MODES) hosts[id].hidden = id !== next;
    modeSheet.setTitle(MODE_LABELS[next]);
    bar.setActive(next);
    // A mode tap is intent to see its content — lift a minimized sheet.
    if (modeSheet.snap() === "min") modeSheet.setSnap("half");
  };

  const bar = createModeBar({ initial: mode, onSelect: setMode }, doc);

  overlay.append(detailSheet.el, modeSheet.el, bar.el);
  modeSheet.show();
  modeSheet.setSnap("min");

  // Phone/tablet only: on desktop the sheets form a static side panel
  // where the detail docks at the top — nothing folds or stacks there.
  const stackedLayout = (): boolean =>
    !(doc.defaultView?.matchMedia?.(DESKTOP_PANEL_QUERY)?.matches ?? false);

  return {
    modeSheet,
    detailSheet,
    mode: () => mode,
    setMode,
    modeHosts: hosts,
    presentDetail(): void {
      if (stackedLayout()) dispatch({ type: "open-detail" });
      else detailSheet.present();
    },
    dismissDetail(): void {
      if (stackedLayout()) dispatch({ type: "close-detail" });
      else detailSheet.hide();
    },
  };
}
