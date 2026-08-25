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
    // drag the end back to 1.5 → token 2 (ครับ mid 1.75) no longer covered
    p.updateCutBounds(0, 1.0, 1.5);
    expect(p.isTokenCut(1)).toBe(true);
    expect(p.isTokenCut(2)).toBe(false); // its audio came back → back in .docx
  });

  it("a tiny nudge into a word keeps it cut (midpoint rule, Codex re-review #1)", () => {
    const p = new Project("/a.wav", makeTranscription());
    // token 1 = อ่า 1.0-1.5 (mid 1.25); cut it exactly
    p.addCut({ start: 1.0, end: 1.5, tokenRange: [1, 1] });
    expect(p.isTokenCut(1)).toBe(true);
    // nudge the start 10ms into the word — ~all its audio is still gone, so
    // it must stay cut (whole-token-inside would have wrongly freed it)
    p.updateCutBounds(0, 1.01, 1.5);
    expect(p.isTokenCut(1)).toBe(true);
    // only when the cut clears the word's midpoint does it come back
    p.updateCutBounds(0, 1.26, 1.5);
    expect(p.isTokenCut(1)).toBe(false);
  });

  it("expanding a cut swallows a newly-covered word", () => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1.0, end: 1.5, tokenRange: [1, 1] }); // อ่า only
    expect(p.isTokenCut(2)).toBe(false);
    p.updateCutBounds(0, 1.0, 2.0); // now spans ครับ (mid 1.75) too
    expect(p.isTokenCut(1)).toBe(true);
    expect(p.isTokenCut(2)).toBe(true);
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
    expect(p.dirty).toBe(true);
  });

  it("keeps the undo history usable across a re-align", () => {
    // This used to clear undoStack outright, so cutting a few things and then
    // fixing a wording with ✎ left the undo button dead with no explanation
    // (reported 2026-08-24: "ปุ่มย้อนกลับก็กดไม่ได้").
    const p = makeTwoSegments();
    p.addCut({ start: 3.0, end: 3.9, tokenRange: [3, 3] }); // in segment 2
    expect(p.canUndo).toBe(true);

    p.replaceSegment(0, "หวัดดีจ้า", newTokens); // 2 tokens -> 3 (delta +1)

    expect(p.canUndo).toBe(true); // history survived
    expect(p.undo()).toBe(true);
    expect(p.edl).toHaveLength(0); // and it really undid the cut
    expect(p.canRedo).toBe(true);
  });

  it("remaps the snapshots too, so an undone cut still points at its own words", () => {
    // The reason the history used to be discarded: its snapshots hold token
    // indices that the splice invalidates. Remapping them is what makes
    // keeping the history safe rather than merely convenient.
    const p = makeTwoSegments();
    p.addCut({ start: 3.0, end: 3.9, tokenRange: [3, 3] }); // "ร้อน"
    p.addCut({ start: 2.0, end: 2.9, tokenRange: [2, 2] }); // "วันนี้"
    p.replaceSegment(0, "หวัดดีจ้า", newTokens); // segment 1: 2 -> 3 tokens

    // Live EDL: both cuts sat after the replaced segment, so both shift by +1.
    expect(p.edl.map((c) => c.tokenRange)).toEqual([
      [3, 3],
      [4, 4],
    ]);

    // Undo removes the most recent cut ("วันนี้", now index 3) and the one
    // left behind must still be the shifted "ร้อน" — not the stale index 3.
    p.undo();
    expect(p.edl).toHaveLength(1);
    expect(p.edl[0].tokenRange).toEqual([4, 4]);
    expect(p.effectiveText(4)).toBe("ร้อน"); // the word it claims to cut
  });

  it("a cut overlapping the replaced segment stays a time-only cut through undo", () => {
    const p = makeTwoSegments();
    p.addCut({ start: 3.0, end: 3.9, tokenRange: [3, 3] }); // segment 2, kept
    p.addCut({ start: 0.2, end: 0.9, tokenRange: [0, 0] }); // segment 1, doomed
    p.replaceSegment(0, "หวัดดีจ้า", newTokens);

    // Undo drops the overlapping cut; the snapshot it restores must carry the
    // SHIFTED index for the surviving one, or the .docx would omit the wrong
    // word after an undo.
    p.undo();
    expect(p.edl).toHaveLength(1);
    expect(p.edl[0].tokenRange).toEqual([4, 4]);
    expect(p.edl[0].start).toBe(3.0); // times never move
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

describe("markers (annotation for the cover sheet)", () => {
  const projectWith = (): Project => new Project("/a.wav", makeTranscription());

  it("keeps markers sorted by time however they were added", () => {
    const p = projectWith();
    p.addMarker(5, "ท้าย");
    p.addMarker(1, "ต้น");
    p.addMarker(3, "กลาง");
    expect(p.markers.map((m) => m.note)).toEqual(["ต้น", "กลาง", "ท้าย"]);
  });

  it("gives every marker a distinct id", () => {
    const p = projectWith();
    const ids = [p.addMarker(1).id, p.addMarker(1).id, p.addMarker(1).id];
    expect(new Set(ids).size).toBe(3);
  });

  it("edits a note by id, not by row position", () => {
    const p = projectWith();
    const first = p.addMarker(9, "ท้าย");
    p.addMarker(1, "ต้น"); // re-sorts: `first` is no longer row 0
    p.setMarkerNote(first.id, "แก้แล้ว");
    expect(p.markers.find((m) => m.id === first.id)?.note).toBe("แก้แล้ว");
    expect(p.markers[0].note).toBe("ต้น");
  });

  it("re-sorts when a marker moves", () => {
    const p = projectWith();
    const a = p.addMarker(1, "a");
    p.addMarker(5, "b");
    p.moveMarker(a.id, 9);
    expect(p.markers.map((m) => m.note)).toEqual(["b", "a"]);
  });

  it("removes by id and reports whether anything went", () => {
    const p = projectWith();
    const m = p.addMarker(1, "x");
    expect(p.removeMarker(m.id)).toBe(true);
    expect(p.removeMarker(m.id)).toBe(false);
    expect(p.markers).toHaveLength(0);
  });

  it("marks the project dirty on every mutation", () => {
    const p = projectWith();
    const m = p.addMarker(1, "x");
    p.dirty = false;
    p.setMarkerNote(m.id, "y");
    expect(p.dirty).toBe(true);
    p.dirty = false;
    p.moveMarker(m.id, 2);
    expect(p.dirty).toBe(true);
    p.dirty = false;
    p.removeMarker(m.id);
    expect(p.dirty).toBe(true);
  });

  it("does not dirty the project for a no-op edit", () => {
    const p = projectWith();
    const m = p.addMarker(1, "x");
    p.dirty = false;
    p.setMarkerNote(m.id, "x");
    p.moveMarker(m.id, 1);
    expect(p.dirty).toBe(false);
  });

  it("round-trips markers through save and load", () => {
    const p = projectWith();
    p.addMarker(2.5, "ตรงนี้เสียงแตก");
    p.addMarker(7, "");
    const loaded = Project.parse(p.serialize());
    expect(loaded.markers.map((m) => [m.time, m.note])).toEqual([
      [2.5, "ตรงนี้เสียงแตก"],
      [7, ""],
    ]);
  });

  it("writes version 3", () => {
    const p = projectWith();
    expect(JSON.parse(p.serialize()).version).toBe(3);
  });

  it("still opens a v2 project, with no markers", () => {
    const p = projectWith();
    const v2 = JSON.parse(p.serialize());
    v2.version = 2;
    delete v2.markers;
    const loaded = Project.parse(JSON.stringify(v2));
    expect(loaded.markers).toEqual([]);
  });

  it("re-mints ids on load so a duplicated id can't alias two markers", () => {
    const p = projectWith();
    const file = JSON.parse(p.serialize());
    file.markers = [
      { id: "same", time: 1, note: "หนึ่ง" },
      { id: "same", time: 2, note: "สอง" },
    ];
    const loaded = Project.parse(JSON.stringify(file));
    const ids = loaded.markers.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    loaded.setMarkerNote(ids[0], "แก้");
    expect(loaded.markers[1].note).toBe("สอง");
  });

  it("drops markers with a non-numeric time instead of failing the load", () => {
    const p = projectWith();
    const file = JSON.parse(p.serialize());
    file.markers = [{ id: "a", time: "ไม่ใช่เลข", note: "x" }, { id: "b", time: 3, note: "ok" }];
    expect(Project.parse(JSON.stringify(file)).markers).toHaveLength(1);
  });
});

describe("taking back one specific cut", () => {
  const projectWithCuts = (): Project => {
    const p = new Project("/a.wav", makeTranscription());
    p.addCut({ start: 1, end: 2, tokenRange: null });
    p.addCut({ start: 5, end: 6, tokenRange: null });
    p.addCut({ start: 9, end: 10, tokenRange: null });
    return p;
  };

  it("removes the chosen cut and keeps every later one", () => {
    // The whole point: undo walks backwards, which is useless when you listen
    // through, change your mind about ONE cut, and want to keep the rest.
    const p = projectWithCuts();
    p.removeCut(1);
    expect(p.edl.map((c) => c.start)).toEqual([1, 9]);
  });

  it("is undoable, so a mis-click restores the cut", () => {
    const p = projectWithCuts();
    p.removeCut(0);
    expect(p.edl).toHaveLength(2);
    expect(p.undo()).toBe(true);
    expect(p.edl.map((c) => c.start)).toEqual([1, 5, 9]);
  });

  it("ignores an out-of-range index instead of corrupting the list", () => {
    const p = projectWithCuts();
    p.removeCut(99);
    p.removeCut(-1);
    expect(p.edl.map((c) => c.start)).toEqual([1, 5, 9]);
  });

  it("does not burn an undo step on an out-of-range index", () => {
    // A no-op that still pushed history would make the next Ctrl+Z appear to
    // do nothing, which reads as "undo is broken".
    const p = projectWithCuts();
    p.removeCut(99);
    p.undo();
    expect(p.edl.map((c) => c.start)).toEqual([1, 5]); // undid the 3rd addCut
  });

  it("marks the project dirty so the change gets saved", () => {
    const p = projectWithCuts();
    p.dirty = false;
    p.removeCut(0);
    expect(p.dirty).toBe(true);
  });
});

describe("tokensInSpan — which words a waveform drag lights up", () => {
  /** Dragging a blue band on the waveform now highlights the words it covers,
   * so this mapping decides what the editor sees before they cut (reported
   * 2026-08-24: the band appeared but the transcript stayed blank). */
  const project = () =>
    new Project("/a.wav", {
      text: "หนึ่งสองสามสี่",
      segments: [{ text: "หนึ่งสองสามสี่", start: 0, end: 4 }],
      tokens: [
        { text: "หนึ่ง", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สอง", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สาม", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สี่", start: 3, end: 4, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    });

  it("covers the words inside the band", () => {
    expect(project().tokensInSpan(0.9, 3.1)).toEqual([1, 2]);
  });

  it("counts a word whose MIDPOINT the band covers, not only whole words", () => {
    // Same midpoint rule the cut itself uses, so the highlight cannot promise
    // a different set of words than the cut will take.
    expect(project().tokensInSpan(0.4, 1.6)).toEqual([0, 1]);
  });

  it("returns null for a band over no words at all", () => {
    // A drag through silence past the end: the band is still valid to cut
    // from, there is just nothing to light up.
    expect(project().tokensInSpan(4.5, 5.0)).toBeNull();
  });

  it("covers everything when the band spans the file", () => {
    expect(project().tokensInSpan(0, 4)).toEqual([0, 3]);
  });
})

describe("editing text never moves the audio (asked 2026-08-24)", () => {
  /** The editor needs to know they can fix spelling all day without disturbing
   * alignment. Per-word edits are stored beside the token, never on it. */
  const project = () =>
    new Project("/a.wav", {
      text: "หนึ่งสองสาม",
      segments: [{ text: "หนึ่งสองสาม", start: 0, end: 3 }],
      tokens: [
        { text: "หนึ่ง", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 0.9 },
        { text: "สอง", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 0.9 },
        { text: "สาม", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 0.9 },
      ],
      timestamps: "aligned",
      alignError: null,
    });

  const times = (p: Project) =>
    p.transcription.tokens.map((t) => [t.start, t.end, t.confidence]);

  it("correcting a word leaves every token's time untouched", () => {
    const p = project();
    const before = times(p);

    p.setEditedText(1, "สองสอง");

    expect(times(p)).toEqual(before);
    expect(p.effectiveText(1)).toBe("สองสอง");
  });

  it("striking a word out leaves every token's time untouched", () => {
    const p = project();
    const before = times(p);

    p.toggleExclude(1);

    expect(times(p)).toEqual(before);
  });

  it("a cut is reversible and restores the words it struck out", () => {
    // The safety net when alignment turns out to be wrong: the source audio is
    // never modified, so taking a cut back is complete.
    const p = project();
    p.addCut({ start: 0.9, end: 2.1, tokenRange: [1, 1] });
    expect(p.isTokenCut(1)).toBe(true);

    p.removeCut(0);

    expect(p.isTokenCut(1)).toBe(false);
    expect(times(p)).toEqual(times(project()));
  });
})

describe("keep the words, drop the sound (asked 2026-08-24)", () => {
  /** A cut used to be all-or-nothing: taking one back to fix the words brought
   * the audio back too. When alignment is off, the audio half is usually the
   * CORRECT half — the editor saw it on the waveform — so undoing everything
   * threw away good work. */
  const project = () => {
    const p = new Project("/a.wav", {
      text: "หนึ่งสองสาม",
      segments: [{ text: "หนึ่งสองสาม", start: 0, end: 3 }],
      tokens: [
        { text: "หนึ่ง", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สอง", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สาม", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    });
    p.addCut({ start: 0.9, end: 2.1, tokenRange: [1, 1] });
    return p;
  };

  it("a cut still takes its words by default", () => {
    expect(project().exportLines().join("")).toBe("หนึ่งสาม");
  });

  it("a kept word returns to the document while its audio stays cut", () => {
    const p = project();
    p.toggleKeepInDoc(1);

    expect(p.exportLines().join("")).toBe("หนึ่งสองสาม");
    expect(p.isTokenCut(1)).toBe(true); // the audio is still gone
    expect(p.edl).toHaveLength(1); // and the cut itself is untouched
  });

  it("keeping is reversible", () => {
    const p = project();
    p.toggleKeepInDoc(1);
    p.toggleKeepInDoc(1);

    expect(p.exportLines().join("")).toBe("หนึ่งสาม");
    expect(p.isKeptInDoc(1)).toBe(false);
  });

  it("keeping clears 'not content', which says the opposite", () => {
    // Holding both would make the export depend on which check runs first.
    const p = project();
    p.toggleExclude(1);
    p.toggleKeepInDoc(1);

    expect(p.isExcluded(1)).toBe(false);
    expect(p.exportLines().join("")).toBe("หนึ่งสองสาม");
  });

  it("survives a save and reload", () => {
    // The flag is editing state, so it belongs in the project file — losing it
    // would silently revert the editor's decision on the next open.
    const p = project();
    p.toggleKeepInDoc(1);

    const reloaded = Project.parse(p.serialize());

    expect(reloaded.isKeptInDoc(1)).toBe(true);
    expect(reloaded.exportLines().join("")).toBe("หนึ่งสองสาม");
  });

  it("works for a waveform-only cut, which has no token range", () => {
    // tokenRange is null there, so the word is caught by TIME instead — the
    // path that would be easy to miss.
    const p = new Project("/a.wav", {
      text: "หนึ่งสองสาม",
      segments: [{ text: "หนึ่งสองสาม", start: 0, end: 3 }],
      tokens: [
        { text: "หนึ่ง", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สอง", start: 1, end: 2, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "สาม", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    });
    p.addCut({ start: 0.95, end: 2.05, tokenRange: null });
    expect(p.exportLines().join("")).toBe("หนึ่งสาม");

    p.toggleKeepInDoc(1);

    expect(p.exportLines().join("")).toBe("หนึ่งสองสาม");
  });
})

describe("undo covers text edits, not only cuts (reported 2026-08-24)", () => {
  /** "ตัว text ถ้ามีการแก้ไข จะย้อนกลับไม่ได้ เพราะตัวย้อนกลับทำไว้แค่เสียง
   * เท่านั้น" — the history held EDL snapshots only, so a wording fix or a
   * struck-out word could not be taken back at all. */
  const project = () =>
    new Project("/a.wav", {
      text: "หนึ่งอ่าสองอืมสาม",
      segments: [{ text: "หนึ่งอ่าสองอืมสาม", start: 0, end: 5 }],
      tokens: [
        { text: "หนึ่ง", start: 0, end: 1, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "อ่า", start: 1, end: 2, isFiller: true, docCharRange: null, confidence: 1 },
        { text: "สอง", start: 2, end: 3, isFiller: false, docCharRange: null, confidence: 1 },
        { text: "อืม", start: 3, end: 4, isFiller: true, docCharRange: null, confidence: 1 },
        { text: "สาม", start: 4, end: 5, isFiller: false, docCharRange: null, confidence: 1 },
      ],
      timestamps: "aligned",
      alignError: null,
    });

  it("takes back a corrected word", () => {
    const p = project();
    p.setEditedText(0, "หนึ่งหนึ่ง");
    expect(p.canUndo).toBe(true);

    p.undo();

    expect(p.effectiveText(0)).toBe("หนึ่ง");
  });

  it("takes back striking a word out", () => {
    const p = project();
    p.toggleExclude(2);

    p.undo();

    expect(p.isExcluded(2)).toBe(false);
  });

  it("takes back 'keep the words, drop the sound'", () => {
    const p = project();
    p.addCut({ start: 1.9, end: 3.1, tokenRange: [2, 2] });
    p.toggleKeepInDoc(2);

    p.undo();

    expect(p.isKeptInDoc(2)).toBe(false);
    expect(p.isTokenCut(2)).toBe(true); // only the keep came back, not the cut
  });

  it("redo puts a text edit back", () => {
    const p = project();
    p.setEditedText(0, "หนึ่งหนึ่ง");
    p.undo();

    p.redo();

    expect(p.effectiveText(0)).toBe("หนึ่งหนึ่ง");
  });

  it("undoes text and audio in the order they happened", () => {
    // They share one history, so the editor gets back exactly the previous
    // state rather than two separate timelines that disagree.
    const p = project();
    p.setEditedText(0, "แก้แล้ว");
    p.addCut({ start: 4, end: 5, tokenRange: [4, 4] });

    p.undo(); // the cut
    expect(p.edl).toHaveLength(0);
    expect(p.effectiveText(0)).toBe("แก้แล้ว"); // the edit survives

    p.undo(); // the edit
    expect(p.effectiveText(0)).toBe("หนึ่ง");
  });

  it("hiding every filler is ONE step, not one per word", () => {
    // On an hour-long file the per-word version would need hundreds of
    // presses to undo, which is the same as not being undoable.
    const p = project();
    const changed = p.excludeAllFillers();
    expect(changed).toBe(2);

    p.undo();

    expect(p.isExcluded(1)).toBe(false);
    expect(p.isExcluded(3)).toBe(false);
    expect(p.canUndo).toBe(false); // nothing left — it really was one step
  });

  it("an edit made after an undo drops the redo branch", () => {
    const p = project();
    p.setEditedText(0, "ก");
    p.undo();

    p.setEditedText(2, "ข");

    expect(p.canRedo).toBe(false);
  });
})
