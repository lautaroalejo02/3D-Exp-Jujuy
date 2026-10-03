/**
 * Reusable bottom sheet: a drag handle + title row on top of a scrollable
 * content box, with three snap heights — minimized (handle + title only),
 * half and full. Dragging uses Pointer Events so mouse and touch share one
 * path; releasing snaps by nearest height or by fling velocity; tapping
 * the handle toggles min <-> half. The content scrolls natively
 * (touch-action: pan-y) inside the sheet box, so it never drags the map.
 *
 * The snap math is pure and unit tested; the DOM part only measures the
 * viewport and writes a transform. On desktop (>= 1024 px) the CSS turns
 * the sheets into a static side panel — the drag is disabled there.
 */

/** Visible height of a minimized sheet (grip + title row), px. */
export const SHEET_MIN_VISIBLE_PX = 64;
/** Half snap: fraction of the viewport height. */
export const SHEET_HALF_FRACTION = 0.45;
/** Full snap: fraction of the viewport height. */
export const SHEET_FULL_FRACTION = 0.88;
/** Release speed (px/ms) that counts as a fling and skips a snap. */
export const SHEET_FLING_VELOCITY_PX_PER_MS = 0.35;

export type SheetSnap = "min" | "half" | "full";
const SNAPS: readonly SheetSnap[] = ["min", "half", "full"];

/** Media query where the sheets stop being draggable bottom sheets. */
const DESKTOP_PANEL_QUERY = "(min-width: 1024px)";

/**
 * The three visible heights in px for a viewport, capped by the sheet's
 * own height (CSS may shrink it on short screens). Ascending order:
 * [min, half, full].
 */
export function sheetSnapHeightsPx(
  viewportHeightPx: number,
  sheetHeightPx: number,
): readonly [number, number, number] {
  const full = Math.min(SHEET_FULL_FRACTION * viewportHeightPx, sheetHeightPx);
  const half = Math.min(SHEET_HALF_FRACTION * viewportHeightPx, full);
  const min = Math.min(SHEET_MIN_VISIBLE_PX, half);
  return [min, half, full];
}

/** Index of the snap height closest to `positionPx`. */
export function nearestSnapIndex(
  positionPx: number,
  snaps: readonly number[],
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < snaps.length; i++) {
    const d = Math.abs((snaps[i] ?? 0) - positionPx);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Where a release lands: a fast flick goes to the next snap in the
 * motion's direction (positive velocity = sheet growing), a slow release
 * goes to the nearest snap. Out-of-range positions clamp to the extremes.
 */
export function snapSheetIndex(
  positionPx: number,
  velocityPxPerMs: number,
  snaps: readonly number[],
): number {
  if (velocityPxPerMs > SHEET_FLING_VELOCITY_PX_PER_MS) {
    for (let i = 0; i < snaps.length; i++) {
      if ((snaps[i] ?? 0) > positionPx) return i;
    }
    return snaps.length - 1;
  }
  if (velocityPxPerMs < -SHEET_FLING_VELOCITY_PX_PER_MS) {
    for (let i = snaps.length - 1; i >= 0; i--) {
      if ((snaps[i] ?? 0) < positionPx) return i;
    }
    return 0;
  }
  return nearestSnapIndex(positionPx, snaps);
}

export interface Sheet {
  readonly el: HTMLElement;
  /** Scrollable region the caller fills with content. */
  readonly contentEl: HTMLElement;
  /** Handle + title row (the drag surface). */
  readonly headEl: HTMLElement;
  setTitle(title: string): void;
  /** Current snap state (tracked even while hidden or on desktop). */
  snap(): SheetSnap;
  /** Animate to a snap height; no-op visually on desktop. */
  setSnap(snap: SheetSnap): void;
  /** Make the sheet visible (keeps the current snap). */
  show(): void;
  /** Hide the sheet entirely. */
  hide(): void;
  isShown(): boolean;
  /**
   * Show the sheet if hidden and lift it out of the minimized state —
   * the presentation a detail sheet wants when new content arrives.
   */
  present(): void;
}

export interface SheetOptions {
  readonly id?: string;
  readonly title: string;
  /** Extra class(es) on the sheet root, e.g. "sheet--detail". */
  readonly className?: string;
  /**
   * Fired whenever the sheet's occluded screen area may have changed:
   * snap changes and show/hide/present. The camera framing uses it to
   * re-derive the UI-free rectangle.
   */
  readonly onGeometryChange?: () => void;
  /**
   * Fired after every snap change — drag releases, handle taps and
   * programmatic setSnap calls all pass through it, so a stacking
   * controller observes the user's intent the same way it observes its
   * own updates.
   */
  readonly onSnapChange?: (snap: SheetSnap) => void;
}

export function createSheet(
  opts: SheetOptions,
  doc: Document = document,
): Sheet {
  const el = doc.createElement("section");
  el.className = `sheet${opts.className ? ` ${opts.className}` : ""}`;
  if (opts.id) el.id = opts.id;
  el.hidden = true;
  el.setAttribute("role", "region");

  const head = doc.createElement("header");
  head.className = "sheet-head";
  const grip = doc.createElement("span");
  grip.className = "sheet-grip";
  grip.setAttribute("aria-hidden", "true");
  const title = doc.createElement("h2");
  title.className = "sheet-title";
  title.textContent = opts.title;
  head.append(grip, title);

  const content = doc.createElement("div");
  content.className = "sheet-content";

  el.append(head, content);

  let snapState: SheetSnap = "min";
  let shown = false;

  const desktopLayout = (): boolean =>
    doc.defaultView?.matchMedia?.(DESKTOP_PANEL_QUERY)?.matches ?? false;

  const snapHeights = (): readonly [number, number, number] =>
    sheetSnapHeightsPx(
      doc.defaultView?.innerHeight ?? 0,
      el.offsetHeight,
    );

  const visibleHeightPx = (): number =>
    snapHeights()[SNAPS.indexOf(snapState)] ?? 0;

  const applyTransform = (heightPx: number): void => {
    const h = el.offsetHeight;
    if (h <= 0) return; // not laid out yet (hidden or detached)
    el.style.transform = `translateY(${Math.max(0, h - heightPx)}px)`;
  };

  const applySnap = (): void => {
    applyTransform(visibleHeightPx());
  };

  const geometryChanged = (): void => {
    opts.onGeometryChange?.();
  };

  const setSnap = (snap: SheetSnap): void => {
    snapState = snap;
    // Reflected for tests, the screenshot harness and e2e debugging.
    el.setAttribute("data-snap", snap);
    applySnap();
    geometryChanged();
    opts.onSnapChange?.(snap);
  };

  // --- Drag ---------------------------------------------------------------

  let dragPointerId: number | undefined;
  let dragStartY = 0;
  let dragStartHeight = 0;
  let dragStartMs = 0;
  // Recent (time, height) samples for the release velocity estimate.
  let samples: { t: number; h: number }[] = [];

  const onPointerDown = (e: PointerEvent): void => {
    if (desktopLayout() || dragPointerId !== undefined) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragPointerId = e.pointerId;
    dragStartY = e.clientY;
    dragStartHeight = visibleHeightPx();
    dragStartMs = e.timeStamp;
    samples = [{ t: e.timeStamp, h: dragStartHeight }];
    head.setPointerCapture(e.pointerId);
    el.classList.add("sheet--dragging");
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== dragPointerId) return;
    const h = Math.max(
      0,
      Math.min(el.offsetHeight, dragStartHeight + (dragStartY - e.clientY)),
    );
    samples.push({ t: e.timeStamp, h });
    // Keep ~120 ms of history — enough for a stable fling estimate.
    while (samples.length > 2 && e.timeStamp - (samples[0]?.t ?? 0) > 120) {
      samples.shift();
    }
    applyTransform(h);
  };

  const endDrag = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerId !== dragPointerId) return;
    dragPointerId = undefined;
    el.classList.remove("sheet--dragging");
    if (head.hasPointerCapture(e.pointerId)) {
      head.releasePointerCapture(e.pointerId);
    }
    if (cancelled) {
      applySnap();
      return;
    }
    const current = Math.max(
      0,
      Math.min(el.offsetHeight, dragStartHeight + (dragStartY - e.clientY)),
    );
    const elapsed = e.timeStamp - dragStartMs;
    const moved = Math.abs(current - dragStartHeight);
    if (moved < 8 && elapsed < 400) {
      // Tap on the handle: toggle between minimized and half.
      setSnap(snapState === "min" ? "half" : "min");
      return;
    }
    const first = samples[0];
    const velocity =
      first !== undefined && e.timeStamp - first.t > 0
        ? (current - first.h) / (e.timeStamp - first.t)
        : 0;
    const snaps = snapHeights();
    setSnap(SNAPS[snapSheetIndex(current, velocity, snaps)] ?? "min");
  };

  head.addEventListener("pointerdown", onPointerDown);
  head.addEventListener("pointermove", onPointerMove);
  head.addEventListener("pointerup", (e) => endDrag(e, false));
  head.addEventListener("pointercancel", (e) => endDrag(e, true));

  // The snap heights depend on the viewport; re-apply on resize so a
  // rotated phone keeps the same snap state.
  doc.defaultView?.addEventListener("resize", () => {
    if (shown) applySnap();
  });

  return {
    el,
    contentEl: content,
    headEl: head,
    setTitle(t: string): void {
      title.textContent = t;
      el.setAttribute("aria-label", t);
    },
    snap: () => snapState,
    setSnap,
    show(): void {
      shown = true;
      el.hidden = false;
      el.setAttribute("data-sheet-open", "");
      applySnap();
      geometryChanged();
    },
    hide(): void {
      shown = false;
      el.hidden = true;
      el.removeAttribute("data-sheet-open");
      geometryChanged();
    },
    isShown: () => shown,
    present(): void {
      shown = true;
      el.hidden = false;
      el.setAttribute("data-sheet-open", "");
      if (snapState === "min") setSnap("half");
      else {
        applySnap();
        geometryChanged();
      }
    },
  };
}
