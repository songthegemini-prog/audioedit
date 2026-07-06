import type { Token, TranscribeResult } from "./api";

/** Human editing state for one token. Original ASR text is never overwritten —
 * an edit lives beside it and can always be cleared. */
export interface TokenEdit {
  editedText?: string;
  excludeFromDoc?: boolean;
}

/** One deleted region in the edit decision list. The source audio is never
 * modified — the EDL is applied only when rendering on export. */
export interface Cut {
  start: number; // seconds
  end: number;
  /** [first, last] token indices this cut came from (for transcript display
   * and .docx export); null for pure waveform cuts. */
  tokenRange: [number, number] | null;
}

export interface ProjectFileV2 {
  version: 2;
  audioPath: string;
  transcription: TranscribeResult;
  edits: Record<string, TokenEdit>;
  edl: Cut[];
}

/** A transcription plus the user's edits; serializable to <name>.audioedit.json. */
export class Project {
  /** Mutable: when a project moves machines, the audio is re-located next to
   * the project file and this is updated to the found path. */
  audioPath: string;
  readonly transcription: TranscribeResult;
  savePath: string | null = null;
  dirty = false;

  private edits = new Map<number, TokenEdit>();
  private edlList: Cut[] = [];
  private undoStack: Cut[][] = [];
  private redoStack: Cut[][] = [];

  constructor(audioPath: string, transcription: TranscribeResult) {
    this.audioPath = audioPath;
    this.transcription = transcription;
  }

  // ---- EDL (all mutations go through history) ----

  get edl(): readonly Cut[] {
    return this.edlList;
  }

  addCut(cut: Cut): void {
    this.pushHistory();
    this.edlList.push({ ...cut });
    this.edlList.sort((a, b) => a.start - b.start);
    this.dirty = true;
  }

  removeCut(index: number): void {
    if (index < 0 || index >= this.edlList.length) return;
    this.pushHistory();
    this.edlList.splice(index, 1);
    this.dirty = true;
  }

  updateCutBounds(index: number, start: number, end: number): void {
    const cut = this.edlList[index];
    if (!cut) return;
    this.pushHistory();
    this.edlList[index] = { ...cut, start, end };
    this.edlList.sort((a, b) => a.start - b.start);
    this.dirty = true;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.edlList);
    this.edlList = prev;
    this.dirty = true;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.edlList);
    this.edlList = next;
    this.dirty = true;
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  isTokenCut(i: number): boolean {
    return this.edlList.some(
      (c) => c.tokenRange !== null && i >= c.tokenRange[0] && i <= c.tokenRange[1],
    );
  }

  private pushHistory(): void {
    this.undoStack.push(this.edlList.map((c) => ({ ...c })));
    this.redoStack = [];
  }

  /** Text to display/export for token i: the human's fix, else ASR text. */
  effectiveText(i: number): string {
    return this.edits.get(i)?.editedText ?? this.transcription.tokens[i].text;
  }

  isEdited(i: number): boolean {
    return this.edits.get(i)?.editedText !== undefined;
  }

  isExcluded(i: number): boolean {
    return this.edits.get(i)?.excludeFromDoc === true;
  }

  /** Set the corrected spelling. Empty text or the original text clears the fix. */
  setEditedText(i: number, text: string): void {
    const edit = { ...this.edits.get(i) };
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === this.transcription.tokens[i].text) {
      delete edit.editedText;
    } else {
      edit.editedText = trimmed;
    }
    this.storeEdit(i, edit);
  }

  /** Flip "not content": token leaves the exported doc, audio stays untouched. */
  toggleExclude(i: number): void {
    const edit = { ...this.edits.get(i) };
    if (edit.excludeFromDoc) {
      delete edit.excludeFromDoc;
    } else {
      edit.excludeFromDoc = true;
    }
    this.storeEdit(i, edit);
  }

  /** Token index range [first, endExclusive) belonging to segment segIndex,
   * derived from time order (tokens and segments are both time-sorted). */
  segmentTokenRange(segIndex: number): [number, number] {
    const segs = this.transcription.segments;
    const tokens = this.transcription.tokens;
    const seg = segs[segIndex];
    const nextStart = segIndex + 1 < segs.length ? segs[segIndex + 1].start : Infinity;
    let first = tokens.length;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].start >= seg.start - 1e-6) {
        first = i;
        break;
      }
    }
    let end = first;
    while (end < tokens.length && tokens[end].start < nextStart - 1e-6) end++;
    return [first, end];
  }

  /** The segment's text as the human sees it (word fixes applied). */
  segmentEffectiveText(segIndex: number): string {
    const [first, end] = this.segmentTokenRange(segIndex);
    let text = "";
    for (let i = first; i < end; i++) text += this.effectiveText(i);
    return text;
  }

  /** แก้ทั้งวรรค: swap a segment's tokens for freshly re-aligned ones.
   * Token count changes, so indices after the segment shift:
   * - word edits inside the segment are dropped (superseded by the new text),
   *   edits after it shift by the delta
   * - EDL tokenRanges overlapping the segment become null (cut TIMES stay
   *   valid — the cut itself is never lost), later ranges shift
   * - the EDL undo history is cleared (its snapshots hold stale indices) */
  replaceSegment(segIndex: number, newText: string, newTokens: Token[]): void {
    const [first, endEx] = this.segmentTokenRange(segIndex);
    const delta = newTokens.length - (endEx - first);
    this.transcription.tokens.splice(first, endEx - first, ...newTokens);

    const seg = this.transcription.segments[segIndex];
    seg.text = newText;
    if (newTokens.length > 0) {
      seg.start = newTokens[0].start;
      seg.end = newTokens[newTokens.length - 1].end;
    }

    const remapped = new Map<number, TokenEdit>();
    for (const [i, edit] of this.edits) {
      if (i < first) remapped.set(i, edit);
      else if (i >= endEx) remapped.set(i + delta, edit);
    }
    this.edits = remapped;

    this.edlList = this.edlList.map((cut) => {
      if (!cut.tokenRange) return cut;
      const [a, b] = cut.tokenRange;
      if (b < first) return cut;
      if (a >= endEx) {
        return { ...cut, tokenRange: [a + delta, b + delta] as [number, number] };
      }
      return { ...cut, tokenRange: null };
    });
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = true;
  }

  /** Token audibly removed: covered by a cut via tokenRange OR by time
   * (waveform-only cuts have tokenRange null but still silence the words). */
  isTokenRemoved(i: number): boolean {
    if (this.isTokenCut(i)) return true;
    const t = this.transcription.tokens[i];
    return this.edlList.some(
      (c) => t.start >= c.start - 0.005 && t.end <= c.end + 0.005,
    );
  }

  /** CLAUDE.md export rule: editedText where present; excluded and cut tokens
   * are omitted so the .docx tells the same story as the exported audio.
   * One paragraph per segment; segments emptied by cuts disappear. */
  exportLines(): string[] {
    const lines: string[] = [];
    for (let s = 0; s < this.transcription.segments.length; s++) {
      const [first, end] = this.segmentTokenRange(s);
      let line = "";
      for (let i = first; i < end; i++) {
        if (this.isExcluded(i) || this.isTokenRemoved(i)) continue;
        line += this.effectiveText(i);
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines;
  }

  /** Mark every filler token as not-content. Returns how many changed. */
  excludeAllFillers(): number {
    let changed = 0;
    this.transcription.tokens.forEach((token, i) => {
      if (token.isFiller && !this.isExcluded(i)) {
        this.toggleExclude(i);
        changed += 1;
      }
    });
    return changed;
  }

  serialize(): string {
    const edits: Record<string, TokenEdit> = {};
    for (const [i, edit] of this.edits) edits[String(i)] = edit;
    const file: ProjectFileV2 = {
      version: 2,
      audioPath: this.audioPath,
      transcription: this.transcription,
      edits,
      edl: this.edlList.map((c) => ({ ...c })),
    };
    return JSON.stringify(file, null, 1);
  }

  static parse(json: string): Project {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error("ไฟล์โปรเจกต์ไม่ใช่ JSON ที่ถูกต้อง");
    }
    const file = raw as {
      version?: number;
      audioPath?: string;
      transcription?: TranscribeResult;
      edits?: Record<string, TokenEdit>;
      edl?: Cut[];
    };
    if (file.version !== 1 && file.version !== 2) {
      throw new Error(`ไฟล์โปรเจกต์เวอร์ชันไม่รองรับ: ${String(file.version)}`);
    }
    if (typeof file.audioPath !== "string" || !Array.isArray(file.transcription?.tokens)) {
      throw new Error("ไฟล์โปรเจกต์ขาดข้อมูลจำเป็น (audioPath/transcription)");
    }
    const project = new Project(file.audioPath, file.transcription as TranscribeResult);
    for (const [key, edit] of Object.entries(file.edits ?? {})) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < project.transcription.tokens.length) {
        project.edits.set(i, edit);
      }
    }
    // v1 files have no EDL — they load with an empty cut list
    for (const cut of file.edl ?? []) {
      if (Number.isFinite(cut?.start) && Number.isFinite(cut?.end) && cut.start < cut.end) {
        project.edlList.push({
          start: cut.start,
          end: cut.end,
          tokenRange: cut.tokenRange ?? null,
        });
      }
    }
    project.edlList.sort((a, b) => a.start - b.start);
    return project;
  }

  private storeEdit(i: number, edit: TokenEdit): void {
    if (Object.keys(edit).length === 0) {
      this.edits.delete(i);
    } else {
      this.edits.set(i, edit);
    }
    this.dirty = true;
  }
}
