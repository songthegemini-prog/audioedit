import { describe, expect, it } from "vitest";

import {
  buildColormap,
  chooseFftSize,
  MIN_FFT_SIZE,
  planFrame,
  rowToBin,
  windowCovers,
  windowRangeFor,
} from "./spectrogram";
import { gridRange, REMOTE_MAX_WINDOW_SEC } from "./samples";

describe("chooseFftSize", () => {
  it("keeps the window at least twice the hop", () => {
    expect(chooseFftSize(900)).toBe(2048);
    expect(chooseFftSize(1100)).toBe(4096);
  });

  it("clamps to the 1024..4096 range", () => {
    expect(chooseFftSize(0.5)).toBe(MIN_FFT_SIZE); // sample-level zoom
    expect(chooseFftSize(1e6)).toBe(4096); // whole-file view: huge hop
  });

  it("never drops below the floor, however deep the zoom", () => {
    // The regression the team saw: at a 2-second view the hop falls to ~74
    // samples, the window bottomed out at 256, and 44.1kHz / 256 is 172Hz per
    // band — wide enough to swallow a whole vocal fundamental. Anything at or
    // under 1024 must now return the floor.
    for (const hop of [0.1, 1, 37, 74, 184, 512]) {
      expect(chooseFftSize(hop)).toBe(MIN_FFT_SIZE);
    }
  });

  it("gives at least 50Hz resolution at the deepest useful zoom", () => {
    // The property that actually matters, stated in Hz rather than in taps.
    const sampleRate = 44100;
    expect(sampleRate / chooseFftSize(37)).toBeLessThan(50);
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

describe("windowRangeFor (how much PCM to fetch)", () => {
  const MARGIN = 0.01;
  const MAX = 120; // provider.maxWindowSec
  const DURATION = 3000;

  it("fetches wider than the viewport so playback can scroll", () => {
    // The reported bug: fetching exactly the viewport meant the view left the
    // window on the very next frame during playback, every fetch superseded
    // the last, and the spectrogram never finished loading at all.
    const { from, to } = windowRangeFor(100, 110, MARGIN, MAX, DURATION);
    expect(to - from).toBeGreaterThan(10 + 2 * MARGIN);
    expect(from).toBeLessThan(100);
    expect(to).toBeGreaterThan(110);
  });

  it("never asks for more than the provider can return in one call", () => {
    for (const span of [1, 10, 60, 110, 119]) {
      const { from, to } = windowRangeFor(500, 500 + span, MARGIN, MAX, DURATION);
      expect(to - from).toBeLessThanOrEqual(MAX + 1e-9);
    }
  });

  it("stays inside the file at the start", () => {
    const { from, to } = windowRangeFor(0, 10, MARGIN, MAX, DURATION);
    expect(from).toBe(0);
    expect(to).toBeLessThanOrEqual(DURATION);
  });

  it("stays inside the file at the end", () => {
    const { from, to } = windowRangeFor(DURATION - 10, DURATION, MARGIN, MAX, DURATION);
    expect(to).toBe(DURATION);
    expect(from).toBeGreaterThanOrEqual(0);
  });

  it("still covers the viewport plus its FFT margin", () => {
    // Padding is a bonus; the window must always contain what is on screen,
    // or the picture would be drawn from data it does not have.
    const { from, to } = windowRangeFor(200, 240, MARGIN, MAX, DURATION);
    expect(from).toBeLessThanOrEqual(200 - MARGIN + 1e-9);
    expect(to).toBeGreaterThanOrEqual(240 + MARGIN - 1e-9);
  });

  it("gives up padding rather than the viewport when headroom runs out", () => {
    // A viewport that already fills maxWindowSec gets no padding, but must
    // still be covered exactly.
    const { from, to } = windowRangeFor(500, 500 + MAX, MARGIN, MAX, DURATION);
    expect(from).toBeLessThanOrEqual(500);
    expect(to).toBeGreaterThanOrEqual(500 + MAX);
  });
});

describe("windowRangeFor survives playback scrolling", () => {
  const MARGIN = 0.01;
  const MAX = 120;
  const DURATION = 3000;

  /** Seconds of forward scrolling a single fetch buys before the viewport
   * leaves the window. This is the number that decides whether the
   * spectrogram can stay on screen during playback at all. */
  const secondsOfScrollCovered = (span: number): number => {
    const { to } = windowRangeFor(100, 100 + span, MARGIN, MAX, DURATION);
    return to - (100 + span);
  };

  it("buys seconds of playback, not milliseconds", () => {
    // Before the fix this was ~0.01s (the FFT margin alone), so playback at
    // 1x left the window on the very next frame and every fetch was
    // superseded before it could be drawn — the spectrogram just read
    // "loading" for the whole play.
    expect(secondsOfScrollCovered(10)).toBeGreaterThan(5);
    expect(secondsOfScrollCovered(30)).toBeGreaterThan(15);
  });

  it("a window fetched at t still covers the viewport several seconds later", () => {
    const span = 10;
    const { from, to } = windowRangeFor(100, 100 + span, MARGIN, MAX, DURATION);
    const laterStart = 105; // five seconds of playback later
    expect(from).toBeLessThanOrEqual(laterStart - MARGIN);
    expect(to).toBeGreaterThanOrEqual(laterStart + span + MARGIN);
  });

  it("covers scrolling backwards too, for a seek that jumps back", () => {
    const { from } = windowRangeFor(100, 110, MARGIN, MAX, DURATION);
    expect(from).toBeLessThanOrEqual(95);
  });
});

describe("windowCovers", () => {
  const win = (startSec: number, lenSec: number, sampleRate = 100) => ({
    startSec,
    data: { length: lenSec * sampleRate },
    sampleRate,
  });

  it("is false when there is no window at all", () => {
    expect(windowCovers(null, 10, 20)).toBe(false);
  });

  it("accepts a window that spans the range, and rejects one short at either end", () => {
    expect(windowCovers(win(10, 10), 12, 18)).toBe(true);
    expect(windowCovers(win(13, 10), 12, 18)).toBe(false); // starts too late
    expect(windowCovers(win(10, 5), 12, 18)).toBe(false); // ends too early
  });

  it("stays ready for every viewport the remote provider can serve", () => {
    /* The loop this guards against. windowRangeFor asks for padding on both
     * sides, RemoteSamples snaps that onto a 5s grid and caps the width, and
     * so hands back a range that can end short of the request. Judging
     * readiness on the REQUEST meant ensureWindow returned false forever:
     * every frame refetched, re-rendered, refetched, and the panel showed
     * "กำลังโหลด spectrogram…" while the app sat idle (reported 2026-08-25).
     * It bit ~69% of viewports — everything wider than about 35 seconds.
     *
     * The contract that actually matters: whatever the provider returns must
     * be enough to DRAW the viewport. */
    const duration = 3000;
    const margin = 0.03; // an FFT half-window at 44.1kHz
    for (let span = 5; span <= REMOTE_MAX_WINDOW_SEC; span += 1) {
      for (let viewStart = 100; viewStart < 130; viewStart += 0.7) {
        const viewEnd = viewStart + span;
        const need = windowRangeFor(
          viewStart,
          viewEnd,
          margin,
          REMOTE_MAX_WINDOW_SEC,
          duration,
        );
        const got = gridRange(need.from, need.to, duration);
        const served = {
          startSec: got.start,
          data: { length: Math.round((got.end - got.start) * 100) },
          sampleRate: 100,
        };
        expect(
          windowCovers(served, viewStart - margin, viewEnd + margin),
          `viewport ${viewStart.toFixed(1)}s +${span}s`,
        ).toBe(true);
      }
    }
  });
});
