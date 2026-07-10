import { describe, expect, it } from "vitest";

import { minMaxColumns } from "./wavedetail";

const SR = 1000;

describe("minMaxColumns", () => {
  it("finds the min and max inside each pixel column", () => {
    // 1s of data: first half +0.5, second half -0.25
    const data = new Float32Array(SR);
    data.fill(0.5, 0, SR / 2);
    data.fill(-0.25, SR / 2);
    const cols = minMaxColumns(data, 0, SR, 0, 1, 2);
    expect(cols[0]).toBeCloseTo(0.5); // col 0 min
    expect(cols[1]).toBeCloseTo(0.5); // col 0 max
    expect(cols[2]).toBeCloseTo(-0.25);
    expect(cols[3]).toBeCloseTo(-0.25);
  });

  it("maps window offset to absolute time", () => {
    // window starts at 100s; a spike at 100.5s absolute
    const data = new Float32Array(SR);
    data[SR / 2] = 0.9;
    const cols = minMaxColumns(data, 100, SR, 100.4, 100.6, 1);
    expect(cols[1]).toBeCloseTo(0.9); // spike falls in the single column
  });

  it("leaves columns outside the data as NaN", () => {
    const data = new Float32Array(SR).fill(0.3); // covers 0..1s only
    const cols = minMaxColumns(data, 0, SR, 0.5, 2.5, 4);
    expect(cols[0]).toBeCloseTo(0.3); // 0.5-1.0s inside
    expect(Number.isNaN(cols[4])).toBe(true); // 1.5-2.0s outside
    expect(Number.isNaN(cols[6])).toBe(true);
  });

  it("handles sub-sample columns (deep zoom: many px per sample)", () => {
    const data = Float32Array.from([0.1, -0.4, 0.8]);
    const cols = minMaxColumns(data, 0, SR, 0, 3 / SR, 12);
    // every column must carry a value; the -0.4 sample appears in the middle
    for (let x = 0; x < 12; x++) expect(Number.isNaN(cols[x * 2])).toBe(false);
    expect(Math.min(...cols)).toBeCloseTo(-0.4);
    expect(Math.max(...cols)).toBeCloseTo(0.8);
  });
});
