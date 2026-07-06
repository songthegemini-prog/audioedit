/** Cut-point snapping (pure, unit-tested).
 *
 * CLAUDE.md: every cut boundary snaps to the nearest silence gap or
 * zero-crossing, and must never eat a word's tail. */

export interface SnapOptions {
  /** RMS window length used to detect silence (seconds). */
  silenceWindowSec: number;
  /** RMS below this (full-scale) counts as silence. */
  silenceThreshold: number;
  /** How far around the target to look for silence (seconds). */
  silenceSearchSec: number;
  /** How far around the target to look for a zero-crossing (seconds). */
  zeroCrossSearchSec: number;
  /** Windows with a zero-crossing rate above this are NOT silence, however
   * quiet — Thai fricative tails (ส/ฟ/ช) are low-amplitude but very "busy". */
  maxSilenceZcr: number;
}

export const DEFAULT_SNAP: SnapOptions = {
  silenceWindowSec: 0.01,
  silenceThreshold: 0.01,
  silenceSearchSec: 0.12,
  zeroCrossSearchSec: 0.03,
  maxSilenceZcr: 0.18,
};

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(to - from, 1));
}

/** Zero-crossing rate: fraction of consecutive sample pairs changing sign.
 * Ignores near-zero dithering below a tiny amplitude floor. */
function zcr(samples: Float32Array, from: number, to: number): number {
  const FLOOR = 1e-4;
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if ((Math.abs(a) > FLOOR || Math.abs(b) > FLOOR) && a * b < 0) crossings++;
  }
  return crossings / Math.max(to - from - 1, 1);
}

/** Snap a cut point to the middle of the nearest silent window if one exists
 * nearby, else to the nearest zero-crossing, else keep the target. */
export function snapCutPoint(
  samples: Float32Array,
  sampleRate: number,
  targetSec: number,
  opts: SnapOptions = DEFAULT_SNAP,
): number {
  const target = Math.round(targetSec * sampleRate);
  const win = Math.max(1, Math.round(opts.silenceWindowSec * sampleRate));
  const searchRadius = Math.round(opts.silenceSearchSec * sampleRate);

  // 1) nearest silent RMS window, centered comparison against the target
  let bestSilence = -1;
  let bestDist = Infinity;
  const from = Math.max(0, target - searchRadius);
  const to = Math.min(samples.length - win, target + searchRadius);
  for (let start = from; start <= to; start += win) {
    if (
      rms(samples, start, start + win) < opts.silenceThreshold &&
      zcr(samples, start, start + win) <= opts.maxSilenceZcr
    ) {
      const center = start + win / 2;
      const dist = Math.abs(center - target);
      if (dist < bestDist) {
        bestDist = dist;
        bestSilence = center;
      }
    }
  }
  if (bestSilence >= 0) return bestSilence / sampleRate;

  // 2) nearest zero-crossing
  const zcRadius = Math.round(opts.zeroCrossSearchSec * sampleRate);
  for (let d = 0; d <= zcRadius; d++) {
    for (const i of [target - d, target + d]) {
      if (i > 0 && i < samples.length) {
        const a = samples[i - 1];
        const b = samples[i];
        if (a === 0 || (a < 0 && b >= 0) || (a > 0 && b <= 0)) {
          return i / sampleRate;
        }
      }
    }
  }

  // 3) give up — keep the requested point
  return targetSec;
}

/** Keep cut bounds from eating neighbouring words: the cut may not start
 * before the previous token ends, nor end after the next token starts. */
export function clampCutBounds(
  startSec: number,
  endSec: number,
  prevTokenEnd: number | null,
  nextTokenStart: number | null,
  durationSec: number,
): [number, number] {
  const lo = prevTokenEnd ?? 0;
  const hi = nextTokenStart ?? durationSec;
  let start = Math.max(startSec, lo);
  let end = Math.min(endSec, hi);
  if (end < start) [start, end] = [Math.min(start, end), Math.max(start, end)];
  return [start, end];
}
