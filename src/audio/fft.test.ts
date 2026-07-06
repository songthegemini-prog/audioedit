import { describe, expect, it } from "vitest";

import { fft, hannWindow, powerSpectrumDb } from "./fft";

describe("fft", () => {
  it("puts a pure sine's energy in its own bin", () => {
    const n = 512;
    const k = 37; // cycles per window
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    fft(re, im);

    let maxBin = 0;
    let maxMag = -1;
    for (let bin = 1; bin < n / 2; bin++) {
      const mag = re[bin] * re[bin] + im[bin] * im[bin];
      if (mag > maxMag) {
        maxMag = mag;
        maxBin = bin;
      }
    }
    expect(maxBin).toBe(k);
  });

  it("gives a flat spectrum for an impulse", () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re[0] = 1;
    fft(re, im);
    for (let bin = 0; bin < n; bin++) {
      const mag = Math.hypot(re[bin], im[bin]);
      expect(mag).toBeCloseTo(1, 5);
    }
  });

  it("rejects non power-of-two input", () => {
    expect(() => fft(new Float32Array(100), new Float32Array(100))).toThrow();
  });
});

describe("powerSpectrumDb", () => {
  it("peaks at the sine's bin and is far above the noise floor", () => {
    const n = 256;
    const k = 20;
    const frame = new Float32Array(n);
    for (let i = 0; i < n; i++) frame[i] = Math.sin((2 * Math.PI * k * i) / n);
    const bins = powerSpectrumDb(frame, hannWindow(n));
    expect(bins).toHaveLength(n / 2);

    const peak = bins.indexOf(Math.max(...bins));
    expect(Math.abs(peak - k)).toBeLessThanOrEqual(1); // Hann spreads ±1 bin
    expect(bins[peak] - bins[3]).toBeGreaterThan(30); // >30dB over far bins
  });
});
