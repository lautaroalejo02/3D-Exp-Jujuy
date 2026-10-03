import type { PlacePhoto } from "../../terrain/places-manifest";
import { classifyLightboxGesture } from "./lightbox-gestures";
import { photoCreditLine } from "./place-card-model";

/**
 * Full-screen photo viewer for the place card: a larger thumbnail
 * (photo.fullUrl) with the same credit line, arrow/swipe navigation,
 * close button and Esc. Pinch-zoom is implemented with Pointer Events
 * on the image itself — the app's touch-action rules intentionally
 * block page pinch-zoom, so zooming is allowed here and only here.
 * With a mouse the wheel zooms toward the cursor, a double-click
 * toggles zoom and dragging the zoomed image pans it (same Pointer
 * Events path as touch).
 *
 * Built once and reused: open() swaps the photo, caption and counter.
 * Focus moves into the dialog on open and back on close; Tab cycles
 * inside it.
 */

/** Max zoom factor over the fitted image. */
const MAX_ZOOM = 4;

export interface PhotoLightbox {
  readonly el: HTMLElement;
  open(
    photos: readonly PlacePhoto[],
    index: number,
    placeName: string,
  ): void;
  close(): void;
}

interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export function createPhotoLightbox(doc: Document): PhotoLightbox {
  const el = doc.createElement("div");
  el.className = "photo-lightbox";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");

  const stage = doc.createElement("div");
  stage.className = "photo-lightbox-stage";
  const img = doc.createElement("img");
  img.className = "photo-lightbox-image";
  img.draggable = false;
  img.decoding = "async";
  stage.appendChild(img);

  const caption = doc.createElement("p");
  caption.className = "photo-lightbox-caption";

  const prev = doc.createElement("button");
  prev.type = "button";
  prev.className = "photo-lightbox-nav photo-lightbox-prev";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "Foto anterior");
  const next = doc.createElement("button");
  next.type = "button";
  next.className = "photo-lightbox-nav photo-lightbox-next";
  next.textContent = "›";
  next.setAttribute("aria-label", "Foto siguiente");
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "photo-lightbox-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Cerrar foto");

  el.append(stage, caption, prev, next, closeButton);

  let photos: readonly PlacePhoto[] = [];
  let index = 0;
  let open = false;
  let savedFocus: Element | null = null;
  const zoom: ZoomState = { scale: 1, tx: 0, ty: 0 };

  const applyZoom = (): void => {
    img.style.transform =
      zoom.scale === 1
        ? ""
        : `translate(${zoom.tx.toFixed(1)}px, ${zoom.ty.toFixed(1)}px) ` +
          `scale(${zoom.scale.toFixed(3)})`;
  };

  const resetZoom = (): void => {
    zoom.scale = 1;
    zoom.tx = 0;
    zoom.ty = 0;
    applyZoom();
  };

  const link = (url: string, label: string): HTMLAnchorElement => {
    const a = doc.createElement("a");
    a.href = url;
    a.textContent = label;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    return a;
  };

  const credit = (photo: PlacePhoto): void => {
    caption.textContent = "";
    const c = photoCreditLine(photo);
    caption.append(
      doc.createTextNode("Foto: "),
      c.author === null
        ? doc.createTextNode("autor desconocido")
        : link(c.authorUrl, c.author),
      doc.createTextNode(" · "),
    );
    if (c.licenseUrl === null) {
      caption.appendChild(doc.createTextNode(c.license));
    } else {
      caption.appendChild(link(c.licenseUrl, c.license));
    }
    caption.appendChild(
      doc.createTextNode(` — ${index + 1} de ${photos.length}`),
    );
  };

  const show = (i: number): void => {
    const photo = photos[i];
    if (!photo) return;
    index = i;
    resetZoom();
    img.src = photo.fullUrl;
    img.alt = photo.description ?? `Foto ${i + 1}`;
    img.width = photo.width;
    img.height = photo.height;
    credit(photo);
    const single = photos.length <= 1;
    prev.hidden = single;
    next.hidden = single;
  };

  const move = (delta: number): void => {
    if (photos.length <= 1) return;
    show((index + delta + photos.length) % photos.length);
  };

  // Focus trap order follows the DOM: the caption's links come first,
  // then the nav and close controls.
  const focusables = (): HTMLElement[] => {
    const controls: HTMLElement[] = [...caption.querySelectorAll("a")];
    for (const button of [prev, next, closeButton]) {
      if (!button.hidden) controls.push(button);
    }
    return controls;
  };

  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      lightbox.close();
      return;
    }
    if (event.key === "ArrowLeft") move(-1);
    if (event.key === "ArrowRight") move(1);
    if (event.key === "Tab") {
      // Trap: wrap focus between the first and last control.
      const controls = focusables();
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = doc.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });

  closeButton.addEventListener("click", () => lightbox.close());
  prev.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  // A tap on the backdrop (not on the image or controls) closes — but
  // never the click that trails a swipe, pan or pinch: the classifier
  // sees the whole gesture tracked since pointerdown.
  el.addEventListener("click", (event) => {
    if (event.target !== el && event.target !== stage) return;
    const action = classifyLightboxGesture({
      dx: lastGesture?.dx ?? 0,
      dy: lastGesture?.dy ?? 0,
      pointerCount: lastGesture?.pointerCount ?? 1,
      zoomed: lastGesture?.zoomed ?? false,
      onBackdrop: true,
    });
    if (action === "close") lightbox.close();
  });

  // --- Gestures: 1 finger pans when zoomed / swipes when not; 2 pinch. ---

  const pointers = new Map<number, { x: number; y: number }>();
  let gestureHadPinch = false;
  let maxPointers = 0;
  let swipeStart: { x: number; y: number } | undefined;
  let pinchStart:
    | { d0: number; m0: { x: number; y: number }; z0: ZoomState }
    | undefined;
  /**
   * The last finished gesture, kept for the trailing click: a backdrop
   * click closes only when the gesture was a clean tap.
   */
  let lastGesture:
    | {
        dx: number;
        dy: number;
        pointerCount: number;
        zoomed: boolean;
      }
    | undefined;

  const twoPoints = (): [{ x: number; y: number }, { x: number; y: number }] | undefined => {
    const pts = [...pointers.values()];
    if (pts.length !== 2 || !pts[0] || !pts[1]) return undefined;
    return [pts[0], pts[1]];
  };

  stage.addEventListener("pointerdown", (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      swipeStart = { x: event.clientX, y: event.clientY };
      gestureHadPinch = false;
      maxPointers = 1;
      lastGesture = undefined;
    } else {
      maxPointers = Math.max(maxPointers, pointers.size);
      const pts = twoPoints();
      if (pts) {
        gestureHadPinch = true;
        pinchStart = {
          d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          m0: {
            x: (pts[0].x + pts[1].x) / 2,
            y: (pts[0].y + pts[1].y) / 2,
          },
          z0: { ...zoom },
        };
      }
    }
  });

  stage.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1 && zoom.scale > 1) {
      // One finger drags the zoomed image.
      zoom.tx += event.clientX - previous.x;
      zoom.ty += event.clientY - previous.y;
      applyZoom();
      return;
    }
    const pts = twoPoints();
    if (!pts || !pinchStart) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (!(d > 0) || !(pinchStart.d0 > 0)) return;
    const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const scale = Math.min(
      MAX_ZOOM,
      Math.max(1, pinchStart.z0.scale * (d / pinchStart.d0)),
    );
    if (scale === 1) {
      resetZoom();
      return;
    }
    // Keep the image point under the pinch midpoint fixed.
    const ratio = scale / pinchStart.z0.scale;
    zoom.scale = scale;
    zoom.tx = m.x - (pinchStart.m0.x - pinchStart.z0.tx) * ratio;
    zoom.ty = m.y - (pinchStart.m0.y - pinchStart.z0.ty) * ratio;
    applyZoom();
  });

  const endPointer = (event: PointerEvent): void => {
    const wasSingle =
      pointers.size === 1 && pointers.has(event.pointerId);
    pointers.delete(event.pointerId);
    if (wasSingle && swipeStart) {
      lastGesture = {
        dx: event.clientX - swipeStart.x,
        dy: event.clientY - swipeStart.y,
        pointerCount: maxPointers,
        zoomed: zoom.scale > 1 || gestureHadPinch,
      };
      const action = classifyLightboxGesture({
        ...lastGesture,
        onBackdrop: false,
      });
      if (action === "next") move(1);
      else if (action === "prev") move(-1);
    }
    if (pointers.size < 2) pinchStart = undefined;
    if (pointers.size === 0) swipeStart = undefined;
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  // --- Mouse: wheel zooms toward the cursor, double-click toggles. ---

  /**
   * Zoom to `target` keeping the image point under the client point
   * (cx, cy) fixed — the same anchored-zoom math as the pinch, with
   * the transform origin (the image center) made explicit.
   */
  const zoomAt = (cx: number, cy: number, target: number): void => {
    const scale = Math.min(MAX_ZOOM, Math.max(1, target));
    if (scale === 1) {
      resetZoom();
      return;
    }
    const rect = img.getBoundingClientRect();
    const ox = rect.left + rect.width / 2 - zoom.tx;
    const oy = rect.top + rect.height / 2 - zoom.ty;
    const ratio = scale / zoom.scale;
    zoom.scale = scale;
    zoom.tx = cx - ox - (cx - ox - zoom.tx) * ratio;
    zoom.ty = cy - oy - (cy - oy - zoom.ty) * ratio;
    applyZoom();
  };

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      // deltaMode 1 reports lines (Firefox); normalize to ~pixels.
      const dy =
        event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(
        event.clientX,
        event.clientY,
        zoom.scale * Math.exp(-dy * 0.002),
      );
    },
    { passive: false },
  );

  stage.addEventListener("dblclick", (event) => {
    zoomAt(event.clientX, event.clientY, zoom.scale > 1 ? 1 : 2.5);
  });

  const lightbox: PhotoLightbox = {
    el,
    open(nextPhotos, startIndex, placeName) {
      photos = nextPhotos;
      if (photos.length === 0) return;
      savedFocus = doc.activeElement;
      el.setAttribute("aria-label", `Fotos de ${placeName}`);
      show(Math.min(Math.max(0, startIndex), photos.length - 1));
      el.hidden = false;
      open = true;
      closeButton.focus();
    },
    close() {
      if (!open) return;
      open = false;
      pointers.clear();
      lastGesture = undefined;
      resetZoom();
      el.hidden = true;
      if (savedFocus instanceof HTMLElement) savedFocus.focus();
      savedFocus = null;
    },
  };
  return lightbox;
}
