import { describe, expect, it } from "vitest";

import type { TranscribeResult } from "./api";
import { Project } from "./project";

function makeTranscription(): TranscribeResult {
  return {
    text: "สวัสดีอ่าครับ",
    segments: [{ text: "สวัสดีอ่าครับ", start: 0, end: 2 }],
    tokens: [
      { text: "สวัสดี", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 0.9 },
      { text: "อ่า", start: 1, end: 1.5, isFiller: true, docCharRange: null, confidence: 0.4 },
      { text: "ครับ", start: 1.5, end: 2, isFiller: false, docCharRange: null, confidence: 0.95 },
    ],
    timestamps: "aligned",
    alignError: null,
  };
}

describe("Project edits", () => {
  it("effectiveText prefers the human fix", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.setEditedText(0, "สวัสดิ์");
    expect(p.effectiveText(0)).toBe("สวัสดิ์");
    expect(p.effectiveText(2)).toBe("ครับ");
    expect(p.isEdited(0)).toBe(true);
    expect(p.dirty).toBe(true);
  });

  it("re-entering the original text clears the edit", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.setEditedText(0, "สวัสดิ์");
    p.setEditedText(0, "สวัสดี");
    expect(p.isEdited(0)).toBe(false);
    expect(JSON.parse(p.serialize()).edits).toEqual({});
  });

  it("empty text clears the edit instead of blanking the word", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.setEditedText(0, "สวัสดิ์");
    p.setEditedText(0, "   ");
    expect(p.effectiveText(0)).toBe("สวัสดี");
  });

  it("toggleExclude keeps audio metadata and flips back cleanly", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.toggleExclude(1);
    expect(p.isExcluded(1)).toBe(true);
    p.toggleExclude(1);
    expect(p.isExcluded(1)).toBe(false);
    expect(JSON.parse(p.serialize()).edits).toEqual({});
  });

  it("excludeAllFillers marks only fillers, once", () => {
    const p = new Project("/a.wav", makeTranscription());
    expect(p.excludeAllFillers()).toBe(1);
    expect(p.isExcluded(1)).toBe(true);
    expect(p.isExcluded(0)).toBe(false);
    expect(p.excludeAllFillers()).toBe(0); // idempotent
  });
});

describe("Project EDL", () => {
  it("addCut keeps the list sorted and marks tokens as cut", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.5, end: 2.0, tokenRange: [2, 2] });
    p.addCut({ start: 1.0, end: 1.4, tokenRange: [1, 1] });
    expect(p.edl.map((c) => c.start)).toEqual([1.0, 1.5]);
    expect(p.isTokenCut(1)).toBe(true);
    expect(p.isTokenCut(0)).toBe(false);
  });

  it("resizing a cut recomputes which tokens it covers (Codex #1)", () => {
    const p = new Project("/a.wav", makeTranscription());
    // cut covers tokens 1 (อ่า 1.0-1.5) and 2 (ครับ 1.5-2.0)
    p.addCut({ start: 1.0, end: 2.0, tokenRange: [1, 2] });
    expect(p.isTokenCut(1)).toBe(true);
    expect(p.isTokenCut(2)).toBe(true);
    // drag the end back to 1.5 → token 2 (ครับ) is no longer inside the cut
    p.updateCutBounds(0, 1.0, 1.5);
    expect(p.isTokenCut(1)).toBe(true);
    expect(p.isTokenCut(2)).toBe(false); // its audio came back → back in .docx
  });

  it("resizing a pure waveform cut stays tokenRange=null", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.0, end: 1.4, tokenRange: null });
    p.updateCutBounds(0, 1.0, 2.0);
    expect(p.edl[0].tokenRange).toBeNull();
  });

  it("undo/redo walk the EDL history", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.0, end: 1.4, tokenRange: [1, 1] });
    p.updateCutBounds(0, 0.9, 1.45);
    expect(p.edl[0].start).toBe(0.9);

    expect(p.undo()).toBe(true);
    expect(p.edl[0].start).toBe(1.0);
    expect(p.undo()).toBe(true);
    expect(p.edl).toHaveLength(0);
    expect(p.undo()).toBe(false);

    expect(p.redo()).toBe(true);
    expect(p.edl).toHaveLength(1);
    expect(p.redo()).toBe(true);
    expect(p.edl[0].start).toBe(0.9);
    expect(p.redo()).toBe(false);
  });

  it("a new mutation clears the redo branch", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.0, end: 1.4, tokenRange: null });
    p.undo();
    p.addCut({ start: 2.0, end: 2.5, tokenRange: null });
    expect(p.canRedo).toBe(false);
  });

  it("EDL round-trips through the v2 file and v1 files still open", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.0, end: 1.4, tokenRange: [1, 1] });
    const restored = Project.parse(p.serialize());
    expect(restored.edl).toEqual([{ start: 1.0, end: 1.4, tokenRange: [1, 1] }]);

    const v1 = JSON.parse(p.serialize());
    v1.version = 1;
    delete v1.edl;
    const fromV1 = Project.parse(JSON.stringify(v1));
    expect(fromV1.edl).toEqual([]);
  });

  it("parse drops malformed cuts instead of crashing", () => {
    const file = JSON.parse(new Project("/a.wav", makeTranscription()).serialize());
    file.edl = [{ start: 2, end: 1 }, { start: "x", end: 3 }, { start: 0.5, end: 0.9 }];
    const p = Project.parse(JSON.stringify(file));
    expect(p.edl).toEqual([{ start: 0.5, end: 0.9, tokenRange: null }]);
  });
});

describe("Project.replaceSegment (index remapping)", () => {
  function makeTwoSegments(): Project {
    const transcription: TranscribeResult = {
      text: "สวัสดีครับวันนี้ร้อน",
      segments: [
        { text: "สวัสดีครับ", start: 0, end: 2 },
        { text: "วันนี้ร้อน", start: 2, end: 4 },
      ],
      tokens: [
        { text: "สวัสดี", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "ครับ", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "วันนี้", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "ร้อน", start: 3, end: 4, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    };
    return new Project("/a.wav", transcription);
  }

  const newTokens = [
    { text: "หวัด", start: 0.1, end: 0.5, isFiller: false, docCharRange: null, confidence: 0.9 },
    { text: "ดี", start: 0.5, end: 0.8, isFiller: false, docCharRange: null, confidence: 0.9 },
    { text: "จ้า", start: 0.8, end: 1.2, isFiller: false, docCharRange: null, confidence: 0.9 },
  ];

  it("maps segment index to its token range", () => {
    const p = makeTwoSegments();
    expect(p.segmentTokenRange(0)).toEqual([0, 2]);
    expect(p.segmentTokenRange(1)).toEqual([2, 4]);
    expect(p.segmentEffectiveText(1)).toBe("วันนี้ร้อน");
  });

  it("shifts later word-edits by the token-count delta", () => {
    const p = makeTwoSegments();
    p.setEditedText(3, "หนาว"); // edit in segment 2
    p.setEditedText(0, "โดนทิ้ง"); // edit in segment 1 (will be replaced)
    p.replaceSegment(0, "หวัดดีจ้า", newTokens); // 2 tokens -> 3 (delta +1)

    expect(p.transcription.tokens).toHaveLength(5);
    expect(p.effectiveText(0)).toBe("หวัด"); // dropped edit inside segment
    expect(p.effectiveText(4)).toBe("หนาว"); // shifted from index 3 -> 4
    expect(p.segmentEffectiveText(0)).toBe("หวัดดีจ้า");
  });

  it("nulls tokenRange of cuts overlapping the segment, shifts later ones", () => {
    const p = makeTwoSegments();
    p.addCut({ start: 0.2, end: 0.9, tokenRange: [0, 0] }); // in segment 1
    p.addCut({ start: 3.0, end: 3.9, tokenRange: [3, 3] }); // in segment 2
    p.replaceSegment(0, "หวัดดีจ้า", newTokens);

    expect(p.edl[0].tokenRange).toBeNull(); // overlapped -> null, cut kept
    expect(p.edl[0].start).toBe(0.2); // times untouched
    expect(p.edl[1].tokenRange).toEqual([4, 4]); // shifted by +1
    expect(p.canUndo).toBe(false); // history cleared (stale indices)
    expect(p.dirty).toBe(true);
  });
});

describe("Project.exportLines (audio and doc must tell the same story)", () => {
  function makeTwoSegs(): Project {
    const transcription: TranscribeResult = {
      text: "",
      segments: [
        { text: "สวัสดีอ่าครับ", start: 0, end: 3 },
        { text: "ลาก่อนนะ", start: 3, end: 5 },
      ],
      tokens: [
        { text: "สวัสดี", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "อ่า", start: 1, end: 2, isFiller: true, docCharRange: null, confidence: 1 },
        { text: "ครับ", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "ลาก่อน", start: 3, end: 4, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "นะ", start: 4, end: 5, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    };
    return new Project("/a.wav", transcription);
  }

  it("uses edited text, drops excluded and cut tokens", () => {
    const p = makeTwoSegs();
    p.setEditedText(0, "หวัดดี"); // spelling fix appears
    p.toggleExclude(1); // filler excluded from doc (audio kept)
    p.addCut({ start: 2, end: 3, tokenRange: [2, 2] }); // ครับ cut
    expect(p.exportLines()).toEqual(["หวัดดี", "ลาก่อนนะ"]);
  });

  it("time-only cuts (no tokenRange) also remove covered words", () => {
    const p = makeTwoSegs();
    p.addCut({ start: 2.99, end: 5.05, tokenRange: null }); // covers segment 2
    expect(p.exportLines()).toEqual(["สวัสดีอ่าครับ"]); // segment 2 vanished
  });

  it("no edits = original text per segment", () => {
    expect(makeTwoSegs().exportLines()).toEqual(["สวัสดีอ่าครับ", "ลาก่อนนะ"]);
  });
});

describe("Project serialization", () => {
  it("round-trips edits through JSON", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.setEditedText(0, "สวัสดิ์");
    p.toggleExclude(1);
    const restored = Project.parse(p.serialize());
    expect(restored.audioPath).toBe("/a.wav");
    expect(restored.effectiveText(0)).toBe("สวัสดิ์");
    expect(restored.isExcluded(1)).toBe(true);
    expect(restored.transcription.timestamps).toBe("aligned");
  });

  it("rejects non-JSON and unknown versions with readable errors", () => {
    expect(() => Project.parse("not json")).toThrow(/JSON/);
    expect(() => Project.parse('{"version": 99}')).toThrow(/เวอร์ชัน/);
    expect(() => Project.parse('{"version": 1}')).toThrow(/ขาดข้อมูล/);
  });

  it("drops out-of-range edit keys instead of crashing", () => {
    const p = new Project("/a.wav", makeTranscription());
    const file = JSON.parse(p.serialize());
    file.edits = { "999": { editedText: "x" }, "0": { editedText: "ดี" } };
    const restored = Project.parse(JSON.stringify(file));
    expect(restored.effectiveText(0)).toBe("ดี");
  });
});
