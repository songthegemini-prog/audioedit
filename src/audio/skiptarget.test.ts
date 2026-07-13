import { describe, expect, it } from "vitest";

import { skipTarget } from "./player";
import type { Cut } from "../project";

const cut = (start: number, end: number): Cut => ({ start, end, tokenRange: null });

describe("skipTarget (test-cut / skip-cuts playback)", () => {
  it("returns null when t is outside every cut", () => {
    expect(skipTarget([cut(1, 2)], 0.5)).toBeNull();
    expect(skipTarget([cut(1, 2)], 2.0)).toBeNull(); // end is exclusive
    expect(skipTarget([], 5)).toBeNull();
  });

  it("jumps to the end of a single cut", () => {
    expect(skipTarget([cut(1, 2)], 1.3)).toBe(2);
  });

  it("jumps past a whole run of OVERLAPPING cuts (Codex #8)", () => {
    // [1,3] and [2,5] overlap → landing at 3 is still inside [2,5]
    expect(skipTarget([cut(1, 3), cut(2, 5)], 1.5)).toBe(5);
  });

  it("jumps past exactly-adjacent cuts", () => {
    // [1,2] then [2,4]: end 2 falls in [2,4] → continue to 4
    expect(skipTarget([cut(1, 2), cut(2, 4)], 1.5)).toBe(4);
  });

  it("chains three stacked cuts in one hop", () => {
    expect(skipTarget([cut(1, 2), cut(1.5, 3), cut(2.9, 6)], 1.2)).toBe(6);
  });

  it("a gap between cuts stops the chain", () => {
    // [1,2] then [2.5,3]: end 2 is NOT inside [2.5,3] → stop at 2
    expect(skipTarget([cut(1, 2), cut(2.5, 3)], 1.5)).toBe(2);
  });
});
