import { describe, expect, it } from "vitest";

import {
  MemorySamples,
  REMOTE_MAX_WINDOW_SEC,
  RemoteSamples,
  gridRange,
  snapWithProvider,
} from "./samples";
import type { WindowFetcher } from "./samples";

const SR = 1000;

function makeFetcher(total: Float32Array): { fetcher: WindowFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: WindowFetcher = async (start, end) => {
    calls.push(`${start}:${end}`);
    const from = Math.round(start * SR);
    const to = Math.min(total.length, Math.round(end * SR));
    return { data: total.slice(from, to), sampleRate: SR };
  };
  return { fetcher, calls };
}

describe("MemorySamples", () => {
  it("returns clamped zero-copy windows with the right offset", async () => {
    const data = Float32Array.from({ length: 3 * SR }, (_, i) => i);
    const mem = new MemorySamples(data, SR);
    const w = await mem.getWindow(1.0, 2.0);
    expect(w.startSec).toBe(1.0);
    expect(w.data.length).toBe(SR);
    expect(w.data[0]).toBe(SR); // sample index 1000
    const past = await mem.getWindow(2.5, 99);
    expect(past.data.length).toBe(0.5 * SR);
    expect(mem.durationSec).toBe(3);
  });
});

describe("gridRange", () => {
  it("aligns to the grid and clamps to the file", () => {
    expect(gridRange(7.2, 12.9, 600)).toEqual({ start: 5, end: 15 });
    expect(gridRange(-3, 2, 600)).toEqual({ start: 0, end: 5 });
    expect(gridRange(597, 640, 600)).toEqual({ start: 595, end: 600 });
  });

  it("never exceeds the max window", () => {
    const r = gridRange(0, 500, 600);
    expect(r.end - r.start).toBeLessThanOrEqual(REMOTE_MAX_WINDOW_SEC);
  });
});

describe("RemoteSamples", () => {
  it("caches windows: same viewport fetches once", async () => {
    const total = new Float32Array(600 * SR);
    const { fetcher, calls } = makeFetcher(total);
    const remote = new RemoteSamples(fetcher, SR, 600);
    await remote.getWindow(10, 20);
    await remote.getWindow(11, 19); // inside the same grid window
    expect(calls.length).toBe(1);
  });

  it("evicts the oldest window beyond the LRU size", async () => {
    const total = new Float32Array(600 * SR);
    const { fetcher, calls } = makeFetcher(total);
    const remote = new RemoteSamples(fetcher, SR, 600);
    for (const start of [0, 100, 200, 300, 400]) {
      await remote.getWindow(start, start + 10);
    }
    await remote.getWindow(0, 10); // evicted → fetched again
    expect(calls.length).toBe(6);
  });

  it("maps window offsets back to absolute samples", async () => {
    const total = Float32Array.from({ length: 600 * SR }, (_, i) => i);
    const { fetcher } = makeFetcher(total);
    const remote = new RemoteSamples(fetcher, SR, 600);
    const w = await remote.getWindow(103, 104);
    const absIndex = Math.round((103.5 - w.startSec) * SR);
    expect(w.data[absIndex]).toBe(103.5 * SR);
  });
});

describe("snapWithProvider", () => {
  it("snaps to a silence gap through the provider (absolute time)", async () => {
    // loud everywhere except a silent gap at 100.20–100.30s
    const total = new Float32Array(200 * SR).fill(0.5);
    for (let i = 100.2 * SR; i < 100.3 * SR; i++) total[i] = 0;
    const { fetcher } = makeFetcher(total);
    const remote = new RemoteSamples(fetcher, SR, 200);
    const snapped = await snapWithProvider(remote, 100.32);
    expect(snapped).toBeGreaterThan(100.19);
    expect(snapped).toBeLessThan(100.31);
  });
});
