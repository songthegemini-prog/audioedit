/** Draggable splitter for the transcript panel.
 *
 * The panel was a fixed 30% of the window height. On a long Thai transcript
 * that is a few lines of text with the rest of the screen given to a waveform
 * the editor may not be looking at, and there was no way to change it
 * (reported 2026-08-23).
 *
 * The height is remembered, because a panel you have to re-drag every time you
 * open the app is barely better than a fixed one.
 */

const STORAGE_KEY = "audioedit.transcriptPanelHeight";

/** Never leave less than this for the panel itself. */
export const MIN_PANEL_PX = 140;

/** Never leave less than this for the waveform above it.
 *
 * Without a ceiling the panel can be dragged over the whole window, hiding the
 * waveform and the fine-adjust row entirely — with the splitter itself pushed
 * off screen, so there is no way to drag it back.
 */
export const MIN_ABOVE_PX = 220;

export function clampPanelHeight(desiredPx: number, viewportPx: number): number {
  const ceiling = Math.max(MIN_PANEL_PX, viewportPx - MIN_ABOVE_PX);
  return Math.min(Math.max(desiredPx, MIN_PANEL_PX), ceiling);
}

/** Height implied by dragging the splitter to `pointerY`. */
export function heightFromPointer(pointerY: number, viewportPx: number): number {
  return clampPanelHeight(viewportPx - pointerY, viewportPx);
}

export function loadStoredHeight(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    // A corrupt or hand-edited value must not wedge the layout.
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null; // storage disabled — the splitter still works, it just forgets
  }
}

export function storeHeight(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(Math.round(px)));
  } catch {
    /* not worth surfacing: the drag already worked */
  }
}

export interface SplitterHandles {
  splitter: HTMLElement;
  panel: HTMLElement;
  /** Called after the height changes, so the waveform can re-measure. */
  onResize?: () => void;
}

export function installPanelSplitter({
  splitter,
  panel,
  onResize,
}: SplitterHandles): void {
  /** `notify` is false when the caller is ALREADY inside a resize event.
   *
   * onResize is expected to announce a layout change, and the natural way to
   * do that is to dispatch a window resize — which lands right back here. The
   * flag is what stops that becoming an infinite loop.
   */
  const apply = (px: number | null, notify = true): void => {
    if (px === null) {
      panel.style.removeProperty("height"); // back to the stylesheet's 30%
    } else {
      panel.style.height = `${clampPanelHeight(px, window.innerHeight)}px`;
    }
    if (notify) onResize?.();
  };

  apply(loadStoredHeight());

  let dragging = false;

  const move = (e: PointerEvent): void => {
    if (!dragging) return;
    e.preventDefault(); // otherwise the drag selects transcript text
    apply(heightFromPointer(e.clientY, window.innerHeight));
  };

  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    storeHeight(panel.getBoundingClientRect().height);
  };

  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    splitter.classList.add("dragging");
    // Capture is a nicety — it keeps the drag alive if the pointer outruns the
    // 6px handle. It THROWS for a pointer id that is not currently active, and
    // an exception here would escape before the move/up listeners are attached,
    // leaving a splitter that highlights on click and then refuses to drag.
    try {
      splitter.setPointerCapture?.(e.pointerId);
    } catch {
      /* drag still works; it is tracked on window, not on the handle */
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  });

  // Double-click restores the default, so a drag that went wrong is one
  // gesture to undo rather than a fiddle back to roughly where it was.
  splitter.addEventListener("dblclick", () => {
    storeHeight(null);
    apply(null);
  });

  // Keyboard: the splitter is focusable, so it has to be operable too.
  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 48 : 12;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const current = panel.getBoundingClientRect().height;
      const next = current + (e.key === "ArrowUp" ? step : -step);
      apply(next);
      storeHeight(panel.getBoundingClientRect().height);
    }
  });

  // A stored height can be impossible after the window is made smaller.
  window.addEventListener("resize", () => {
    const stored = loadStoredHeight();
    if (stored !== null) apply(stored, false);
  });
}
