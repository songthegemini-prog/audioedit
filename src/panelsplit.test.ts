import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampPanelHeight,
  heightFromPointer,
  installPanelSplitter,
  MIN_ABOVE_PX,
  MIN_PANEL_PX,
} from "./panelsplit";

describe("clampPanelHeight", () => {
  const VIEWPORT = 900;

  it("keeps a dragged height as asked when it is reasonable", () => {
    expect(clampPanelHeight(400, VIEWPORT)).toBe(400);
  });

  it("never shrinks the panel below a readable size", () => {
    expect(clampPanelHeight(10, VIEWPORT)).toBe(MIN_PANEL_PX);
    expect(clampPanelHeight(-500, VIEWPORT)).toBe(MIN_PANEL_PX);
  });

  it("never lets the panel swallow the waveform", () => {
    // Dragging to the top would otherwise push the splitter itself off screen,
    // leaving no way to drag it back.
    expect(clampPanelHeight(VIEWPORT, VIEWPORT)).toBe(VIEWPORT - MIN_ABOVE_PX);
  });

  it("prefers a usable panel on a window too small to satisfy both limits", () => {
    // On a very short window the two minimums conflict; the panel wins,
    // because that is the thing the user was dragging.
    expect(clampPanelHeight(500, 200)).toBe(MIN_PANEL_PX);
  });
});

describe("heightFromPointer", () => {
  const VIEWPORT = 900;

  it("measures the panel from the pointer down to the bottom of the window", () => {
    expect(heightFromPointer(500, VIEWPORT)).toBe(400);
  });

  it("dragging down makes the panel smaller", () => {
    const high = heightFromPointer(300, VIEWPORT);
    const low = heightFromPointer(600, VIEWPORT);
    expect(low).toBeLessThan(high);
  });

  it("applies the same limits as a direct set", () => {
    expect(heightFromPointer(VIEWPORT - 5, VIEWPORT)).toBe(MIN_PANEL_PX);
    expect(heightFromPointer(0, VIEWPORT)).toBe(VIEWPORT - MIN_ABOVE_PX);
  });
});

/** Minimal EventTarget-alike, so these tests exercise the REAL addEventListener
 * / dispatchEvent wiring in installPanelSplitter() without pulling in jsdom —
 * the bug this file guards against (see below) is entirely about listener
 * ordering and re-entrancy, which a plain function-call test would hide. */
class FakeTarget {
  private listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  addEventListener(type: string, fn: (e: Record<string, unknown>) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: (e: Record<string, unknown>) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(type: string, e: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
  }
}

class FakeElement extends FakeTarget {
  style: { height: string; removeProperty: (name: string) => void } = {
    height: "",
    removeProperty: () => {
      this.style.height = "";
    },
  };
  classList = {
    set: new Set<string>(),
    add(name: string) {
      this.set.add(name);
    },
    remove(name: string) {
      this.set.delete(name);
    },
  };
  setPointerCapture(): void {
    /* no-op: real capture has no equivalent here */
  }
  getBoundingClientRect(): { height: number } {
    // Real layout (flex/CSS %) isn't available; when no inline height is set,
    // fall back to a plausible default so getBoundingClientRect() during a
    // keyboard press from the CSS-default state doesn't read as 0.
    return { height: this.style.height ? parseFloat(this.style.height) : 300 };
  }
}

/** Wires a fake splitter/panel/window into the real installPanelSplitter().
 * `splitter`/`panel`/`fakeWindow` are the FakeElement/FakeTarget instances —
 * use THESE to dispatch synthetic events. `asProps` is the same pair cast to
 * HTMLElement, for the one call into installPanelSplitter() itself (which
 * only touches the subset of the DOM API FakeElement actually implements). */
function setUpFakeDom(viewportHeight: number) {
  const splitter = new FakeElement();
  const panel = new FakeElement();
  const fakeWindow = Object.assign(new FakeTarget(), { innerHeight: viewportHeight });
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("localStorage", fakeStorage);
  return {
    splitter,
    panel,
    fakeWindow,
    asProps: {
      splitter: splitter as unknown as HTMLElement,
      panel: panel as unknown as HTMLElement,
    },
  };
}

/** Simulate onResize the way main.ts really wires it: re-broadcast a window
 * "resize" event so other views re-measure. This is the exact mechanism that
 * caused the bug — a test that skips it would not catch a regression. */
function realisticOnResize(fakeWindow: FakeTarget) {
  return () => fakeWindow.dispatchEvent("resize");
}

describe("installPanelSplitter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a second drag, not just the first (regression, reported 2026-08-24)", () => {
    // THE bug: "ตัวขยายพาเนลพอเริ่มทำงานแล้วขยายไม่ได้" — the splitter worked
    // once, then every later drag silently reverted. Root cause: onResize()
    // re-broadcasts "resize", which used to make the internal resize listener
    // reload the STORED height and reapply it — but storage is only written
    // in end()/keydown, one step behind the live drag in progress, so it
    // stomped every live update back to whatever the PREVIOUS drag left.
    const { splitter, panel, fakeWindow, asProps } = setUpFakeDom(900);
    installPanelSplitter({ ...asProps, onResize: realisticOnResize(fakeWindow) });

    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 480 });
    fakeWindow.dispatchEvent("pointerup", {});
    expect(panel.style.height).toBe("480px");

    // A SECOND, independent drag to a different value.
    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 600 });
    fakeWindow.dispatchEvent("pointerup", {});
    expect(panel.style.height).toBe("600px"); // NOT reverted to 480px

    // And a third, back down — proves it isn't a one-way fluke.
    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 300 });
    fakeWindow.dispatchEvent("pointerup", {});
    expect(panel.style.height).toBe("300px");
  });

  it("does not fight a live drag mid-motion (multiple pointermoves)", () => {
    const { splitter, panel, fakeWindow, asProps } = setUpFakeDom(900);
    installPanelSplitter({ ...asProps, onResize: realisticOnResize(fakeWindow) });

    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    for (const y of [700, 650, 600, 550, 500]) {
      fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: y });
      expect(panel.style.height).toBe(`${900 - y}px`); // tracks the pointer exactly
    }
    fakeWindow.dispatchEvent("pointerup", {});
  });

  it("applies a second keyboard press, not just the first", () => {
    // The keyboard path calls apply() then storeHeight() in that order too,
    // so it shares the exact same bug shape as the drag path.
    const { splitter, panel, fakeWindow, asProps } = setUpFakeDom(900);
    installPanelSplitter({ ...asProps, onResize: realisticOnResize(fakeWindow) });

    splitter.dispatchEvent("keydown", { key: "ArrowUp", preventDefault: () => {} });
    const first = panel.style.height;
    splitter.dispatchEvent("keydown", { key: "ArrowUp", preventDefault: () => {} });
    const second = panel.style.height;

    expect(second).not.toBe(first); // the second press must move it further
  });

  it("still re-clamps a stored height that no longer fits after a genuine window resize", () => {
    const { splitter, panel, fakeWindow, asProps } = setUpFakeDom(900);
    installPanelSplitter({ ...asProps, onResize: realisticOnResize(fakeWindow) });

    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 600 });
    fakeWindow.dispatchEvent("pointerup", {});
    expect(panel.style.height).toBe("600px");

    // The OS window shrinks — nobody dragged anything, so `dragging` is false
    // and this must still be treated as a real resize to react to.
    fakeWindow.innerHeight = 400;
    fakeWindow.dispatchEvent("resize");

    expect(panel.style.height).toBe(`${clampPanelHeight(600, 400)}px`);
  });

  it("double-click resets to the CSS default, and a later drag still applies", () => {
    const { splitter, panel, fakeWindow, asProps } = setUpFakeDom(900);
    installPanelSplitter({ ...asProps, onResize: realisticOnResize(fakeWindow) });

    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 500 });
    fakeWindow.dispatchEvent("pointerup", {});
    splitter.dispatchEvent("dblclick", {});
    expect(panel.style.height).toBe(""); // back to the stylesheet's 30%

    splitter.dispatchEvent("pointerdown", { pointerId: 1 });
    fakeWindow.dispatchEvent("pointermove", { preventDefault: () => {}, clientY: 900 - 350 });
    fakeWindow.dispatchEvent("pointerup", {});
    expect(panel.style.height).toBe("350px");
  });
});
