/**
 * Placement helpers for the overlay UI. `sheetLiftPx` is pure (and unit
 * tested); `syncSheetState` is the thin DOM side that measures the open
 * bottom sheets and applies the result so the "Fuentes de datos" toggle
 * never collides with them.
 */

/**
 * Extra bottom offset in px that keeps a bottom-anchored element clear
 * of open bottom sheets: the tallest open sheet plus `gapPx`, or 0 when
 * no sheet is open. Sheets are anchored to the same screen edge, so the
 * tallest one is the bound — stacking them is not supported.
 */
export function sheetLiftPx(
  sheetHeights: readonly number[],
  gapPx = 8,
): number {
  let max = 0;
  for (const h of sheetHeights) {
    if (h > max) max = h;
  }
  return max === 0 ? 0 : max + gapPx;
}

/**
 * Recompute the overlay's sheet state after any bottom sheet (pick
 * panel, place card) shows or hides: toggles `overlay--sheet-open` and
 * writes `--sheet-lift`, which the CSS uses to lift the attributions
 * toggle above the sheets on compact screens.
 */
export function syncSheetState(root: HTMLElement, gapPx = 8): void {
  const heights: number[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(".pick-panel")) {
    if (!el.hidden) heights.push(el.offsetHeight);
  }
  const lift = sheetLiftPx(heights, gapPx);
  root.classList.toggle("overlay--sheet-open", lift > 0);
  root.style.setProperty("--sheet-lift", `${lift}px`);
}
