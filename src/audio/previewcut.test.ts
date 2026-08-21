import { describe, expect, it } from "vitest";

import { cutToPreview } from "./player";
import type { Cut } from "../project";

const cut = (start: number, end: number): Cut => ({ start, end, tokenRange: null });

describe("cutToPreview (Ctrl+K target)", () => {
  it("returns null when nothing has been cut", () => {
    expect(cutToPreview([], 5)).toBeNull();
  });

  it("prefers the cut the playhead is sitting inside", () => {
    const cuts = [cut(1, 2), cut(5, 6)];
    expect(cutToPreview(cuts, 1.5)).toEqual(cut(1, 2));
  });

  it("otherwise jumps forward to the next cut", () => {
    const cuts = [cut(1, 2), cut(5, 6)];
    expect(cutToPreview(cuts, 3)).toEqual(cut(5, 6));
  });

  it("falls back to the last cut once the playhead is past them all", () => {
    // Ctrl+K near the end of the file should still audition something rather
    // than silently doing nothing.
    const cuts = [cut(1, 2), cut(5, 6)];
    expect(cutToPreview(cuts, 30)).toEqual(cut(5, 6));
  });

  it("does not care what order the EDL is stored in", () => {
    const cuts = [cut(9, 10), cut(1, 2), cut(5, 6)];
    expect(cutToPreview(cuts, 3)).toEqual(cut(5, 6));
    expect(cutToPreview(cuts, 0)).toEqual(cut(1, 2));
  });

  it("does not mutate the caller's EDL while sorting", () => {
    const cuts = [cut(9, 10), cut(1, 2)];
    cutToPreview(cuts, 0);
    expect(cuts[0]).toEqual(cut(9, 10));
  });

  it("treats a cut's end as outside it, so the next cut wins", () => {
    const cuts = [cut(1, 2), cut(2, 3)];
    expect(cutToPreview(cuts, 2)).toEqual(cut(2, 3));
  });
});
