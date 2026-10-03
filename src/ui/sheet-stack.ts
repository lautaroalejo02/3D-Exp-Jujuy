/**
 * Sheet stacking on narrow layouts: the mode sheet (Explorar, Sol, …)
 * and the detail sheet (place card / pick info) share the strip above
 * the mode bar, and only one of them is ever expanded. This reducer is
 * the whole policy — pure and unit tested; the DOM wiring in menu.ts
 * only turns events into sheet calls:
 *
 * - opening a detail folds the mode sheet to its title row ("min"),
 *   remembers the snap it had, and presents the detail at "half", so
 *   the picked place stays visible in the free rectangle above;
 * - closing the detail hides it and restores the remembered mode snap;
 * - user snaps (drags / handle taps) keep the invariant: expanding one
 *   sheet folds the other to "min"; folding the detail to "min" brings
 *   the mode sheet back to its remembered snap — the detail stays open
 *   as a title row the user can pull up again;
 * - re-expanding the mode sheet over a folded detail updates the
 *   remembered snap, so a later close lands where the user left it.
 *
 * `reduceSheetStack` returns the SAME state object when nothing
 * changes — callers rely on that to stop the apply -> notify -> reduce
 * loop.
 */
import type { SheetSnap } from "./sheet";

export interface SheetStackState {
  /** Current snap of the mode (per-mode content) sheet. */
  readonly modeSnap: SheetSnap;
  /** Whether the detail sheet is on screen (shown, at any snap). */
  readonly detailOpen: boolean;
  /** Current snap of the detail sheet. */
  readonly detailSnap: SheetSnap;
  /**
   * Mode snap the detail folded away from and returns to: saved on
   * open, refreshed whenever the user re-expands the mode sheet while
   * the detail stays folded.
   */
  readonly resumeModeSnap: SheetSnap;
}

export type SheetStackEvent =
  | { readonly type: "open-detail" }
  | { readonly type: "close-detail" }
  /** The mode sheet's snap changed (user drag/tap or a mode switch). */
  | { readonly type: "mode-snap"; readonly snap: SheetSnap }
  /** The detail sheet's snap changed (user drag/tap). */
  | { readonly type: "detail-snap"; readonly snap: SheetSnap };

/** Boot state: mode sheet minimized, no detail on screen. */
export const initialSheetStack: SheetStackState = {
  modeSnap: "min",
  detailOpen: false,
  detailSnap: "min",
  resumeModeSnap: "half",
};

const sameStack = (a: SheetStackState, b: SheetStackState): boolean =>
  a.modeSnap === b.modeSnap &&
  a.detailOpen === b.detailOpen &&
  a.detailSnap === b.detailSnap &&
  a.resumeModeSnap === b.resumeModeSnap;

export function reduceSheetStack(
  state: SheetStackState,
  event: SheetStackEvent,
): SheetStackState {
  let next = state;
  switch (event.type) {
    case "open-detail": {
      next = state.detailOpen
        ? // A detail is already up (a place card replacing the pick info,
          // or a second marker tap): keep the mode sheet folded and
          // re-present the detail — only a folded detail lifts.
          {
            ...state,
            modeSnap: "min",
            detailSnap: state.detailSnap === "min" ? "half" : state.detailSnap,
          }
        : {
            modeSnap: "min",
            detailOpen: true,
            detailSnap: "half",
            resumeModeSnap: state.modeSnap,
          };
      break;
    }
    case "close-detail": {
      if (state.detailOpen) {
        next = {
          ...state,
          detailOpen: false,
          detailSnap: "min",
          modeSnap: state.resumeModeSnap,
        };
      }
      break;
    }
    case "mode-snap": {
      next = !state.detailOpen
        ? { ...state, modeSnap: event.snap }
        : event.snap === "min"
          ? { ...state, modeSnap: "min" }
          : // Expanding the mode sheet folds the detail to its title row
            // (it stays open) and becomes the snap a close restores.
            {
              modeSnap: event.snap,
              detailOpen: true,
              detailSnap: "min",
              resumeModeSnap: event.snap,
            };
      break;
    }
    case "detail-snap": {
      if (state.detailOpen) {
        next =
          event.snap === "min"
            ? // Detail folded: the mode sheet comes back to the snap it
              // had — the folded detail remains as a title row above
              // the mode bar.
              {
                ...state,
                detailSnap: "min",
                modeSnap: state.resumeModeSnap,
              }
            : // Detail expanded: the mode sheet folds; the remembered
              // snap survives so a later close still restores it.
              { ...state, detailSnap: event.snap, modeSnap: "min" };
      }
      break;
    }
  }
  return sameStack(state, next) ? state : next;
}
