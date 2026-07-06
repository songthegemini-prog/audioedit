import { describe, expect, it } from "vitest";

import type { TranscribeResult } from "./api";
import { Project } from "./project";
import { buildSearchIndex, findMatches } from "./search";

function makeProject(): Project {
  const transcription: TranscribeResult = {
    text: "วันนี้เราทดสอบวันนี้",
    segments: [{ text: "วันนี้เราทดสอบวันนี้", start: 0, end: 4 }],
    tokens: [
      { text: "วันนี้", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
      { text: "เรา", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 1 },
      { text: "ทดสอบ", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
      { text: "วันนี้", start: 3, end: 4, isFiller: false, docCharRange: null, confidence: 1 },
    ],
    timestamps: "aligned",
    alignError: null,
  };
  return new Project("/a.wav", transcription);
}

describe("search", () => {
  it("finds a word appearing in multiple tokens", () => {
    const index = buildSearchIndex(makeProject());
    const matches = findMatches(index, "วันนี้");
    expect(matches).toEqual([
      { startToken: 0, endToken: 0 },
      { startToken: 3, endToken: 3 },
    ]);
  });

  it("finds a phrase spanning token boundaries (Thai has no spaces)", () => {
    const index = buildSearchIndex(makeProject());
    const matches = findMatches(index, "วันนี้เรา");
    expect(matches).toEqual([{ startToken: 0, endToken: 1 }]);
  });

  it("searches the edited text, not the stale ASR text", () => {
    const project = makeProject();
    project.setEditedText(2, "ทดลอง");
    const index = buildSearchIndex(project);
    expect(findMatches(index, "ทดลอง")).toEqual([{ startToken: 2, endToken: 2 }]);
    expect(findMatches(index, "ทดสอบ")).toEqual([]);
  });

  it("empty or whitespace query matches nothing", () => {
    const index = buildSearchIndex(makeProject());
    expect(findMatches(index, "")).toEqual([]);
    expect(findMatches(index, "  ")).toEqual([]);
  });

  it("query missing from text matches nothing", () => {
    const index = buildSearchIndex(makeProject());
    expect(findMatches(index, "ไม่มีคำนี้")).toEqual([]);
  });
});
