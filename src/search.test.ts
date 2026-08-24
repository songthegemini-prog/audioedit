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

describe("search only what the editor can see (reported 2026-08-24)", () => {
  /** "ซ่อนคำที่ไม่ใช้" hides cut and excluded words with CSS. The index used to
   * keep counting them, so the search read text that was not on screen —
   * "ตัวค้นหากับตัวอักษรไม่ตรงกัน". These pin the three ways that showed up. */
  const visible = (project: Project) => (i: number) =>
    !project.isExcluded(i) && !project.isTokenCut(i);

  it("finds a phrase that a hidden word sits in the middle of", () => {
    // THE symptom: on screen the two halves are adjacent, so the editor types
    // them as one phrase — and got "ไม่พบ" because a hidden word split them.
    const project = makeProject();
    project.toggleExclude(1); // hide "เรา" between "วันนี้" and "ทดสอบ"

    const hidden = findMatches(buildSearchIndex(project, visible(project)), "วันนี้ทดสอบ");
    const shown = findMatches(buildSearchIndex(project), "วันนี้ทดสอบ");

    expect(hidden).toEqual([{ startToken: 0, endToken: 2 }]);
    expect(shown).toEqual([]); // what it used to do
  });

  it("does not report matches the editor cannot see", () => {
    // The counter said "1/2" while only one was on screen, so "next" appeared
    // to do nothing.
    const project = makeProject();
    project.toggleExclude(3); // hide the second "วันนี้"

    const matches = findMatches(buildSearchIndex(project, visible(project)), "วันนี้");

    expect(matches).toEqual([{ startToken: 0, endToken: 0 }]);
  });

  it("never lands a match on a cut word, whose audio is gone", () => {
    // Jumping to such a match seeked into audio the export no longer contains.
    const project = makeProject();
    project.addCut({ start: 0.9, end: 2.1, tokenRange: [1, 2] });

    const matches = findMatches(buildSearchIndex(project, visible(project)), "ทดสอบ");

    expect(matches).toEqual([]);
    expect(project.isTokenCut(2)).toBe(true); // and it really is cut
  });

  it("token indices still mean the same thing when words are skipped", () => {
    // The mapping from character offset back to token index is what every
    // highlight and seek depends on; skipping must not shift it.
    const project = makeProject();
    project.toggleExclude(0);
    project.toggleExclude(1);

    const matches = findMatches(buildSearchIndex(project, visible(project)), "ทดสอบวันนี้");

    expect(matches).toEqual([{ startToken: 2, endToken: 3 }]);
  });

  it("shows everything again once hiding is turned off", () => {
    const project = makeProject();
    project.toggleExclude(1);

    // no predicate = the "โชว์คำที่ไม่ใช้" state
    expect(findMatches(buildSearchIndex(project), "วันนี้เรา")).toEqual([
      { startToken: 0, endToken: 1 },
    ]);
  });
})
