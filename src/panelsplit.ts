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
  const apply = (px: number | null): void => {
    if (px === null) {
      panel.style.removeProperty("height"); // back to the stylesheet's 30%
    } else {
      panel.style.height = `${clampPanelHeight(px, window.innerHeight)}px`;
    }
    onResize?.();
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

  // A previously-fine height can become too tall after the window shrinks, so
  // re-clamp it on every resize.
  //
  // THE BUG (reported 2026-08-24, "ตัวขยายพาเนลพอเริ่มทำงานแล้วขยายไม่ได้" —
  // the splitter stops responding once it has worked once): onResize() above
  // re-broadcasts a window "resize" event so the waveform/spectrogram can
  // re-measure after WE change the panel's height — and that broadcast lands
  // right back on THIS listener, synchronously, before move()/the keydown
  // handler even returns. The previous version reacted by reloading the
  // STORED height and reapplying it — but storeHeight() only runs in end()
  // and the keydown handler, both of which fire AFTER apply(), so mid-drag
  // (and on every arrow-key press) it read the height from the drag/press
  // BEFORE this one and stomped the live update back to it. The very first
  // resize ever made was invisible (nothing was stored yet to revert to);
  // every one after that appeared to do nothing.
  //
  // Re-clamping whatever height is ALREADY on the element — instead of
  // consulting storage — sidesteps the stale-value problem entirely: by the
  // time this fires, apply() has already written the live value, so reading
  // it back and re-clamping is a no-op for our own broadcast, and still does
  // its job for a genuine window resize.
  window.addEventListener("resize", () => {
    if (dragging) return; // the live drag drives its own updates
    const inline = panel.style.height;
    if (!inline) return; // still on the CSS default (30%) — nothing to clamp
    const current = parseFloat(inline);
    const clamped = clampPanelHeight(current, window.innerHeight);
    if (Math.abs(clamped - current) > 0.5) {
      panel.style.height = `${clamped}px`;
    }
  });
}
