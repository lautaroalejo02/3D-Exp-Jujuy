/**
 * Bottom mode bar: the four maqueta modes (Explorar, Sol, Perfil, Agua)
 * as thumb-reachable tabs with a simple inline SVG icon + label each.
 * The bar only reports selections — the caller decides what each mode
 * shows (sheet content, placeholders).
 */

export type AppMode = "explorar" | "sol" | "perfil" | "agua";

export const MODE_LABELS: Record<AppMode, string> = {
  explorar: "Explorar",
  sol: "Sol",
  perfil: "Perfil",
  agua: "Agua",
};

const MODES: readonly AppMode[] = ["explorar", "sol", "perfil", "agua"];

/**
 * Inline 24x24 stroke icons (currentColor): a compass for Explorar, a
 * sun for Sol, an elevation profile for Perfil and a droplet for Agua.
 */
const MODE_ICONS: Record<AppMode, string> = {
  explorar:
    '<circle cx="12" cy="12" r="9"/>' +
    '<polygon points="15.5,8.5 13.2,13.2 8.5,15.5 10.8,10.8" fill="currentColor" stroke="none"/>',
  sol:
    '<circle cx="12" cy="12" r="4"/>' +
    '<line x1="12" y1="2.5" x2="12" y2="5.5"/>' +
    '<line x1="12" y1="18.5" x2="12" y2="21.5"/>' +
    '<line x1="2.5" y1="12" x2="5.5" y2="12"/>' +
    '<line x1="18.5" y1="12" x2="21.5" y2="12"/>' +
    '<line x1="5.3" y1="5.3" x2="7.4" y2="7.4"/>' +
    '<line x1="16.6" y1="16.6" x2="18.7" y2="18.7"/>' +
    '<line x1="18.7" y1="5.3" x2="16.6" y2="7.4"/>' +
    '<line x1="7.4" y1="16.6" x2="5.3" y2="18.7"/>',
  perfil:
    '<polyline points="2.5,20 8,9.5 12,14.5 15.5,6.5 21.5,20"/>' +
    '<line x1="2.5" y1="20" x2="21.5" y2="20"/>',
  agua:
    '<path d="M12 3 C12 3 6 10.2 6 14.2 a6 6 0 0 0 12 0 C18 10.2 12 3 12 3 Z"/>',
};

export interface ModeBar {
  readonly el: HTMLElement;
  /** Mark `mode` as the pressed tab. */
  setActive(mode: AppMode): void;
}

export function createModeBar(
  opts: {
    readonly initial?: AppMode;
    readonly onSelect: (mode: AppMode) => void;
  },
  doc: Document = document,
): ModeBar {
  const nav = doc.createElement("nav");
  nav.id = "mode-bar";
  nav.setAttribute("aria-label", "Modos de la maqueta");

  const tabs = new Map<AppMode, HTMLButtonElement>();
  for (const mode of MODES) {
    const tab = doc.createElement("button");
    tab.type = "button";
    tab.className = "mode-tab";
    tab.dataset.mode = mode;
    tab.setAttribute("aria-pressed", "false");
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = MODE_ICONS[mode];
    const label = doc.createElement("span");
    label.textContent = MODE_LABELS[mode];
    tab.append(icon, label);
    tab.addEventListener("click", () => {
      opts.onSelect(mode);
    });
    tabs.set(mode, tab);
    nav.appendChild(tab);
  }

  const setActive = (mode: AppMode): void => {
    for (const [id, tab] of tabs) {
      tab.setAttribute("aria-pressed", String(id === mode));
    }
  };
  setActive(opts.initial ?? "explorar");

  return { el: nav, setActive };
}
