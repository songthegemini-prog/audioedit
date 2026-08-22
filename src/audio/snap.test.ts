import { describe, expect, it } from "vitest";

import { clampCutBounds, fineStepVisibility, snapCutPoint } from "./snap";

const SR = 1000; // 1kHz keeps the numbers easy to reason about

/** loud sine | silence | loud sine, each `secs` long */
function burstSilenceBurst(secs: number): Float32Array {
  const n = Math.round(secs * SR);
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const s = 0.8 * Math.sin((2 * Math.PI * 50 * i) / SR);
    out[i] = s;
    out[2 * n + i] = s;
  }
  return out;
}

describe("snapCutPoint", () => {
  it("snaps into a nearby silence gap", () => {
    const samples = burstSilenceBurst(0.5); // silence = 0.5s..1.0s
    // target just inside the loud burst, silence within ±120ms
    const snapped = snapCutPoint(samples, SR, 0.45);
    expect(snapped).toBeGreaterThanOrEqual(0.5);
    expect(snapped).toBeLessThanOrEqual(0.6);
  });

  it("stays put when already in silence", () => {
    const samples = burstSilenceBurst(0.5);
    const snapped = snapCutPoint(samples, SR, 0.75);
    expect(Math.abs(snapped - 0.75)).toBeLessThanOrEqual(0.02);
  });

  it("falls back to the nearest zero-crossing in continuous sound", () => {
    // continuous loud 50Hz sine — no silence anywhere
    const samples = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      samples[i] = 0.8 * Math.sin((2 * Math.PI * 50 * i) / SR);
    }
    const snapped = snapCutPoint(samples, SR, 0.5051);
    // 50Hz at 1kHz: zero-crossings every 10ms — nearest is 0.51 or 0.50
    const idx = Math.round(snapped * SR);
    expect(Math.abs(samples[idx])).toBeLessThan(0.3); // near a crossing
    expect(Math.abs(snapped - 0.5051)).toBeLessThanOrEqual(0.03);
  });

  it("keeps the target when nothing better exists nearby", () => {
    const samples = new Float32Array(SR).fill(0.9); // DC — no crossings, loud
    expect(snapCutPoint(samples, SR, 0.5)).toBe(0.5);
  });
});

describe("snapCutPoint — Thai fricative tails", () => {
  it("does not mistake quiet high-ZCR noise (ส/ฟ/ช tail) for silence", () => {
    // loud sine, then a quiet-but-busy fricative-like tail, then true silence
    const n = Math.round(0.4 * SR);
    const samples = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.8 * Math.sin((2 * Math.PI * 50 * i) / SR);
      // alternating-sign low-amplitude noise: RMS ~0.005 but ZCR ~1.0
      samples[n + i] = (i % 2 === 0 ? 1 : -1) * 0.005;
      // samples[2n..3n] stay 0 = real silence
    }
    // target inside the fricative tail; nearest true silence starts at 0.8s
    const snapped = snapCutPoint(samples, SR, 0.72);
    expect(snapped).toBeGreaterThanOrEqual(0.8 - 0.01);
  });
});

describe("clampCutBounds", () => {
  it("never eats the previous word's tail or the next word's head", () => {
    expect(clampCutBounds(1.0, 2.0, 1.2, 1.8, 10)).toEqual([1.2, 1.8]);
  });

  it("uses file bounds when there is no neighbour", () => {
    expect(clampCutBounds(-0.5, 12, null, null, 10)).toEqual([0, 10]);
  });

  it("keeps start <= end even when clamps collide", () => {
    const [start, end] = clampCutBounds(1.0, 2.0, 1.9, 1.1, 10);
    expect(start).toBeLessThanOrEqual(end);
  });
});

describe("fineStepVisibility (can you see a ±1ms press?)", () => {
  it("says a 1ms step is invisible at the default zoom", () => {
    // 20 px/s is where the app starts. This is the reported bug: the value
    // changes on every press but the screen does not move, so the buttons
    // feel broken.
    const v = fineStepVisibility(20, 0.001);
    expect(v.visible).toBe(false);
    expect(v.pixels).toBeCloseTo(0.02, 5);
    expect(v.pressesPerPixel).toBe(50);
  });

  it("says a 10ms step is still invisible at the default zoom", () => {
    expect(fineStepVisibility(20, 0.01).visible).toBe(false);
  });

  it("becomes visible once zoomed in", () => {
    expect(fineStepVisibility(980, 0.001).visible).toBe(false); // 0.98px, just under
    expect(fineStepVisibility(980, 0.01).visible).toBe(true); // 9.8px
    expect(fineStepVisibility(8365, 0.001).visible).toBe(true); // 8.4px
  });

  it("needs exactly one press per pixel once a step exceeds a pixel", () => {
    expect(fineStepVisibility(8365, 0.001).pressesPerPixel).toBe(1);
  });

  it("does not divide by zero before the zoom is known", () => {
    const v = fineStepVisibility(0, 0.01);
    expect(v.pixels).toBe(0);
    expect(v.visible).toBe(false);
    expect(Number.isFinite(v.pressesPerPixel)).toBe(false);
  });
});
