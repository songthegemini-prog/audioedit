import { describe, expect, it } from "vitest";

import { buildColormap, chooseFftSize, planFrame, rowToBin } from "./spectrogram";

describe("chooseFftSize", () => {
  it("keeps the window at least twice the hop", () => {
    expect(chooseFftSize(100)).toBe(256);
    expect(chooseFftSize(200)).toBe(512);
    expect(chooseFftSize(900)).toBe(2048);
  });

  it("clamps to the 256..4096 range", () => {
    expect(chooseFftSize(0.5)).toBe(256); // sample-level zoom: tiny hop
    expect(chooseFftSize(1e6)).toBe(4096); // whole-file view: huge hop
  });
});

describe("rowToBin (log frequency axis)", () => {
  const SR = 16000;
  const FFT = 1024;

  it("top row maps to the highest bin, bottom row to a low bin", () => {
    const top = rowToBin(0, 200, FFT, SR);
    const bottom = rowToBin(199, 200, FFT, SR);
    expect(top).toBe(FFT / 2 - 1);
    expect(bottom).toBeLessThan(16); // near F_MIN
    expect(bottom).toBeGreaterThanOrEqual(0);
  });

  it("is monotonically non-increasing from top to bottom", () => {
    let prev = Infinity;
    for (let row = 0; row < 100; row++) {
      const bin = rowToBin(row, 100, FFT, SR);
      expect(bin).toBeLessThanOrEqual(prev);
      prev = bin;
    }
  });
});

describe("buildColormap", () => {
  it("produces 256 RGB entries from dark to light", () => {
    const lut = buildColormap();
    expect(lut).toHaveLength(256 * 3);
    const darkSum = lut[0] + lut[1] + lut[2];
    const lightSum = lut[255 * 3] + lut[255 * 3 + 1] + lut[255 * 3 + 2];
    expect(lightSum).toBeGreaterThan(darkSum + 300);
  });
});

describe("planFrame (what to paint while a PCM window is loading)", () => {
  it("paints the new image as soon as there is one", () => {
    expect(planFrame(true, false)).toBe("fresh");
    expect(planFrame(true, true)).toBe("fresh");
  });

  it("holds the previous image instead of flashing black", () => {
    // The reported symptom: every jump in long-file mode blanked the panel
    // for a moment while the backend returned the new window.
    expect(planFrame(false, true)).toBe("stale");
  });

  it("only shows an empty panel when there is genuinely nothing yet", () => {
    expect(planFrame(false, false)).toBe("empty");
  });

  it("never reports stale when a fresh image exists", () => {
    // A stale frame is drawn dimmed and shows a DIFFERENT moment of the file;
    // preferring it over a real one would be actively misleading.
    expect(planFrame(true, true)).not.toBe("stale");
  });
});
