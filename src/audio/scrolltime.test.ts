import { describe, expect, it } from "vitest";

import { previewRollFor, scrollTimeFor } from "./player";

/** Where the target ends up on screen, 0 = hard left, 0.5 = centred. */
const positionOnScreen = (target: number, span: number, duration: number): number =>
  (target - scrollTimeFor(target, span, duration)) / span;

describe("scrollTimeFor (where the view lands when you click a word)", () => {
  const SPAN = 60; // ~what you see at the default zoom
  const DURATION = 3000;

  it("centres the target instead of pinning it to the left edge", () => {
    // The reported bug: the old rule was `target - 1`, which at a 60s-wide
    // view put the clicked word about 2% from the left.
    expect(positionOnScreen(1500, SPAN, DURATION)).toBeCloseTo(0.5, 5);
  });

  it("keeps the target visible near the start of the file", () => {
    // Can't centre 5s in without scrolling before zero, so it sits left of
    // centre — but it must still be on screen.
    expect(scrollTimeFor(5, SPAN, DURATION)).toBe(0);
    const pos = positionOnScreen(5, SPAN, DURATION);
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThan(0.5);
  });

  it("keeps the target visible near the end of the file", () => {
    const target = DURATION - 5;
    expect(scrollTimeFor(target, SPAN, DURATION)).toBe(DURATION - SPAN);
    const pos = positionOnScreen(target, SPAN, DURATION);
    expect(pos).toBeGreaterThan(0.5);
    expect(pos).toBeLessThanOrEqual(1);
  });

  it("never scrolls past the end of the file", () => {
    for (const t of [0, 1, 100, 1500, 2999, 3000]) {
      const scroll = scrollTimeFor(t, SPAN, DURATION);
      expect(scroll).toBeGreaterThanOrEqual(0);
      expect(scroll).toBeLessThanOrEqual(DURATION - SPAN);
    }
  });

  it("handles a file shorter than the view without scrolling at all", () => {
    expect(scrollTimeFor(3, 60, 10)).toBe(0);
  });

  it("degrades safely when the view width is not known yet", () => {
    // clientWidth is 0 before layout; must not produce NaN or a negative
    expect(scrollTimeFor(42, 0, DURATION)).toBe(42);
    expect(scrollTimeFor(-5, 0, DURATION)).toBe(0);
  });

  it("centres at every zoom level", () => {
    for (const span of [2, 10, 60, 300]) {
      expect(positionOnScreen(1500, span, DURATION)).toBeCloseTo(0.5, 5);
    }
  });
});

describe("previewRollFor (Ctrl+K lead-in vs zoom)", () => {
  it("keeps the full 1.5s when zoomed out", () => {
    expect(previewRollFor(60)).toBe(1.5);
    expect(previewRollFor(13.3)).toBe(1.5);
  });

  it("shrinks so the seam stays on screen when zoomed in", () => {
    // The reported bug: at 980 px/s the view is ~1.3s wide, so a fixed 1.5s
    // lead-in put the cut off the right edge and the view looked like it had
    // jumped somewhere else entirely.
    const span = 1.3;
    const roll = previewRollFor(span);
    expect(roll).toBeLessThan(span / 2);
    expect(roll).toBeCloseTo(0.455, 3);
  });

  it("always leaves room for both the playhead and the seam", () => {
    for (const span of [0.5, 1.3, 3, 10, 60]) {
      expect(previewRollFor(span)).toBeLessThan(span);
    }
  });

  it("keeps an audible run-up at extreme zoom", () => {
    expect(previewRollFor(0.2)).toBe(0.25);
    expect(previewRollFor(0.01)).toBe(0.25);
  });

  it("falls back to the full roll before the zoom is known", () => {
    expect(previewRollFor(0)).toBe(1.5);
  });
});
