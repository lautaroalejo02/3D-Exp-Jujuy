/**
 * Dropdown coordination for the overlay UI: at most one dropdown is open
 * at a time and a tap outside its container closes it. One group is
 * shared by every overlay component (the "Lugares" list, the "Fuentes
 * de datos" disclosure, ...) so they can't pile up over the map or each
 * other.
 */

export interface Dropdown {
  /**
   * Element that contains the open dropdown — pointerdowns inside it do
   * not close it. Usually the panel holding both trigger and content.
   */
  readonly container: HTMLElement;
  /** Idempotent close (hide the content, reset the trigger state). */
  close(): void;
}

export class DropdownGroup {
  /** The dropdown currently open, if any. */
  private entry: Dropdown | undefined;

  constructor(doc: Document) {
    // Capture phase so the close runs before the tap's other handlers
    // (e.g. a map pick) — the dropdown is already gone when they run.
    doc.addEventListener(
      "pointerdown",
      (event) => {
        const open = this.entry;
        if (
          open &&
          event.target instanceof Node &&
          !open.container.contains(event.target)
        ) {
          open.close();
        }
      },
      true,
    );
  }

  /**
   * Call when `d` opens: closes whichever dropdown was open before and
   * remembers `d` as the open one.
   */
  opened(d: Dropdown): void {
    if (this.entry && this.entry !== d) this.entry.close();
    this.entry = d;
  }

  /** Call when `d` closes by its own means (toggle, item click, ×). */
  closed(d: Dropdown): void {
    if (this.entry === d) this.entry = undefined;
  }
}
