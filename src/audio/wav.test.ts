import { describe, expect, it } from "vitest";

import { pcmToWavBlob } from "./wav";
import type { PcmSource } from "./wav";

function fakeBuffer(data: Float32Array[], sampleRate = 22050): PcmSource {
  return {
    numberOfChannels: data.length,
    sampleRate,
    length: data[0].length,
    getChannelData: (c) => data[c],
  };
}

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe("pcmToWavBlob", () => {
  it("writes a correct RIFF/WAVE header", async () => {
    const blob = pcmToWavBlob(fakeBuffer([new Float32Array(100)], 22050));
    const view = await bytes(blob);
    const tag = (o: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));
    expect(tag(0, 4)).toBe("RIFF");
    expect(tag(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050); // sample rate
    expect(view.getUint32(40, true)).toBe(200); // 100 samples * 2 bytes
    expect(blob.size).toBe(44 + 200);
  });

  it("encodes samples as clamped little-endian int16, interleaved", async () => {
    const left = new Float32Array([0, 1, -1, 2]); // 2 clamps to 1
    const right = new Float32Array([0.5, -0.5, 0, 0]);
    const view = await bytes(pcmToWavBlob(fakeBuffer([left, right])));
    expect(view.getInt16(44, true)).toBe(0); // L0
    expect(view.getInt16(46, true)).toBe(16384); // R0 ≈ 0.5
    expect(view.getInt16(48, true)).toBe(32767); // L1 = 1.0
    expect(view.getInt16(56, true)).toBe(32767); // L3 clamped from 2.0
  });
});
