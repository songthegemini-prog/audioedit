/** SampleProvider (Phase 9c): one interface for "give me PCM of [start,end]".
 *
 * Short files keep the whole decoded buffer in memory (MemorySamples — the
 * behavior the app always had). Long files fetch bounded windows from the
 * backend's canonical cache WAV (RemoteSamples) so an hour-long file never
 * lives in frontend RAM. The spectrogram and cut-point snapping consume this
 * interface and no longer care which mode they're in.
 */

import { snapCutPoint } from "./snap";

export interface SampleWindow {
  data: Float32Array;
  startSec: number;
  sampleRate: number;
}

export interface SampleProvider {
  readonly sampleRate: number;
  /** Total audio length in seconds (fetch ranges are clamped to this). */
  readonly durationSec: number;
  /** Longest window this provider can serve in one call (seconds). */
  readonly maxWindowSec: number;
  getWindow(startSec: number, endSec: number): Promise<SampleWindow>;
}

/** Whole file already decoded in RAM — zero-copy subarray views. */
export class MemorySamples implements SampleProvider {
  readonly maxWindowSec = Infinity;
  readonly durationSec: number;

  constructor(
    private data: Float32Array,
    readonly sampleRate: number,
  ) {
    this.durationSec = data.length / sampleRate;
  }

  async getWindow(startSec: number, endSec: number): Promise<SampleWindow> {
    const from = Math.max(0, Math.floor(startSec * this.sampleRate));
    const to = Math.min(this.data.length, Math.ceil(endSec * this.sampleRate));
    return {
      data: this.data.subarray(from, Math.max(from, to)),
      startSec: from / this.sampleRate,
      sampleRate: this.sampleRate,
    };
  }
}

// Remote windows are fetched on a coarse grid with margins so that small
// scrolls and repeated snaps reuse the same cached window.
const GRID_SEC = 5;
const LRU_WINDOWS = 4;
export const REMOTE_MAX_WINDOW_SEC = 110; // backend caps /pcm at 120s

export type WindowFetcher = (
  startSec: number,
  endSec: number,
) => Promise<{ data: Float32Array; sampleRate: number }>;

/** Snap a fetch range onto the grid (pure — unit tested). */
export function gridRange(
  startSec: number,
  endSec: number,
  durationSec: number,
  maxWindowSec: number = REMOTE_MAX_WINDOW_SEC,
  gridSec: number = GRID_SEC,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(startSec / gridSec) * gridSec);
  let end = Math.min(durationSec, Math.ceil(endSec / gridSec) * gridSec);
  if (end - start > maxWindowSec) end = start + maxWindowSec;
  return { start, end: Math.max(end, Math.min(start + gridSec, durationSec)) };
}

/** Bounded windows fetched from the backend's canonical WAV, LRU-cached. */
export class RemoteSamples implements SampleProvider {
  readonly maxWindowSec = REMOTE_MAX_WINDOW_SEC;
  private cache = new Map<string, Promise<SampleWindow>>(); // insertion = LRU order

  constructor(
    private fetcher: WindowFetcher,
    readonly sampleRate: number,
    readonly durationSec: number,
  ) {}

  getWindow(startSec: number, endSec: number): Promise<SampleWindow> {
    const { start, end } = gridRange(startSec, endSec, this.durationSec);
    const key = `${start}:${end}`;
    const hit = this.cache.get(key);
    if (hit) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const pending = this.fetcher(start, end).then((w) => ({
      data: w.data,
      startSec: start,
      sampleRate: w.sampleRate || this.sampleRate,
    }));
    // a failed fetch must not poison the cache
    pending.catch(() => this.cache.delete(key));
    this.cache.set(key, pending);
    while (this.cache.size > LRU_WINDOWS) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return pending;
  }
}

/** Snap a cut boundary using whichever provider is active: fetch a small
 * window around the target, snap inside it, map back to absolute time. */
export async function snapWithProvider(
  provider: SampleProvider,
  sec: number,
): Promise<number> {
  const w = await provider.getWindow(sec - 1.5, sec + 1.5);
  if (w.data.length === 0) return sec;
  const rel = snapCutPoint(w.data, w.sampleRate, sec - w.startSec);
  return w.startSec + rel;
}
