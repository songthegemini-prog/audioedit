import { describe, expect, it } from "vitest";

import {
  clampPanelHeight,
  heightFromPointer,
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
