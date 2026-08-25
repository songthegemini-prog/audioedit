import type { Token, TranscribeResult } from "./api";

/** Human editing state for one token. Original ASR text is never overwritten —
 * an edit lives beside it and can always be cleared. */
export interface TokenEdit {
  editedText?: string;
  excludeFromDoc?: boolean;
  /** Keep this word in the .docx even though a cut removed its audio.
   *
   * The fourth editing state, and the mirror of excludeFromDoc. It exists
   * because a cut used to be all-or-nothing: taking one back to fix the words
   * brought the audio back with it, so an editor who had cut the right sound
   * but the wrong words had no way to keep one and undo the other (asked
   * 2026-08-24). That situation is not rare — alignment can be off, and the
   * audio is what the editor SEES, so the audio is usually the correct half.
   */
  keepInDoc?: boolean;
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

/** A named position on the timeline (Sound Forge "marker"), with the note the
 * editor writes against it so it can be carried onto the cover sheet
 * (ใบปะหน้า). Markers are pure annotation: they never affect the audio, the
 * EDL, or the exported document text. */
export interface Marker {
  /** Stable across edits and re-sorts, so the note box never jumps rows. */
  id: string;
  time: number; // seconds
  note: string;
}

export interface ProjectFileV3 {
  version: 3;
  audioPath: string;
  transcription: TranscribeResult;
  edits: Record<string, TokenEdit>;
  edl: Cut[];
  markers: Marker[];
}

/** @deprecated read-only compatibility: v2 files load, but we always write v3. */
export interface ProjectFileV2 {
  version: 2;
  audioPath: string;
  transcription: TranscribeResult;
  edits: Record<string, TokenEdit>;
  edl: Cut[];
}

/** One undo step.
 *
 * Both halves together, because they are one action to the person doing it:
 * undo covered only the EDL, so a wording fix or a struck-out word could not
 * be taken back at all (reported 2026-08-24: "ตัว text ถ้ามีการแก้ไข จะย้อน
 * กลับไม่ได้ เพราะตัวย้อนกลับทำไว้แค่เสียงเท่านั้น").
 */
interface HistoryState {
  edl: Cut[];
  edits: Map<number, TokenEdit>;
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
  private markerList: Marker[] = [];
  private nextMarkerId = 1;
  private edlList: Cut[] = [];
  private undoStack: HistoryState[] = [];
  private redoStack: HistoryState[] = [];
  /** Set while a bulk action runs, so it lands as ONE undo step. */
  private batching = false;

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
    // Recompute which tokens this cut covers from the NEW bounds — otherwise a
    // resized cut keeps its old tokenRange and .docx would still omit words
    // whose audio the resize brought back (Codex review #1). A pure waveform
    // cut (no transcript) stays tokenRange=null.
    const tokenRange = cut.tokenRange === null ? null : this.tokensInSpan(start, end);
    this.edlList[index] = { ...cut, start, end, tokenRange };
    this.edlList.sort((a, b) => a.start - b.start);
    this.dirty = true;
  }

  /** [first, last] token indices this cut removes from the .docx, or null.
   * A token counts as cut when its MIDPOINT falls inside [start, end] — i.e.
   * the cut removes the majority of its audio. Whole-token-inside was wrong:
   * nudging a cut edge 10ms into a word dropped the token entirely, so the
   * word reappeared in the .docx while ~all its audio was gone (Codex re-review
   * #1). Midpoint keeps the doc consistent with which words the audio loses.
   * Cuts are contiguous in time, so the matched indices stay contiguous. */
  tokensInSpan(start: number, end: number): [number, number] | null {
    const tokens = this.transcription.tokens;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < tokens.length; i++) {
      const mid = (tokens[i].start + tokens[i].end) / 2;
      if (mid >= start && mid <= end) {
        if (lo === -1) lo = i;
        hi = i;
      }
    }
    return lo === -1 ? null : [lo, hi];
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    this.dirty = true;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
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
    if (this.batching) return; // a bulk action already pushed its one step
    this.undoStack.push(this.snapshot());
    this.redoStack = [];
  }

  private snapshot(): HistoryState {
    return {
      edl: this.edlList.map((c) => ({ ...c })),
      edits: new Map([...this.edits].map(([i, e]) => [i, { ...e }])),
    };
  }

  private restore(state: HistoryState): void {
    this.edlList = state.edl;
    this.edits = state.edits;
  }

  /** Run a bulk change as ONE undo step.
   *
   * Without this, "ซ่อน filler" on an hour-long file pushes one step per word
   * and undoing it means hundreds of presses.
   */
  private asOneStep(run: () => void): void {
    if (this.batching) {
      run();
      return;
    }
    this.pushHistory();
    this.batching = true;
    try {
      run();
    } finally {
      this.batching = false;
    }
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

  /** Kept in the .docx despite its audio being cut. */
  isKeptInDoc(i: number): boolean {
    return this.edits.get(i)?.keepInDoc === true;
  }

  /** Flip "keep the words, drop the sound".
   *
   * Only meaningful for a token a cut covers; on any other token it is stored
   * but has no effect, which is harmless and keeps the toggle stateless.
   * Clears excludeFromDoc, because the two say opposite things about the same
   * word and holding both would make the export depend on check order.
   */
  toggleKeepInDoc(i: number): void {
    this.pushHistory();
    const edit = { ...this.edits.get(i) };
    if (edit.keepInDoc) {
      delete edit.keepInDoc;
    } else {
      edit.keepInDoc = true;
      delete edit.excludeFromDoc;
    }
    this.storeEdit(i, edit);
  }

  /** Set the corrected spelling. Empty text or the original text clears the fix. */
  setEditedText(i: number, text: string): void {
    this.pushHistory();
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
    this.pushHistory();
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
   * - the SAME remapping is applied to every undo/redo snapshot, so the
   *   history survives (see below) */
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

    const shiftCuts = (cuts: Cut[]): Cut[] =>
      cuts.map((cut) => {
        if (!cut.tokenRange) return cut;
        const [a, b] = cut.tokenRange;
        if (b < first) return cut;
        if (a >= endEx) {
          return { ...cut, tokenRange: [a + delta, b + delta] as [number, number] };
        }
        return { ...cut, tokenRange: null };
      });

    this.edlList = shiftCuts(this.edlList);
    // The history used to be thrown away here, on the grounds that its
    // snapshots hold token indices that this splice just invalidated. True —
    // but the cure was worse: the editor cuts a few things, fixes a wording
    // with ✎, and the undo button goes dead with no explanation. Reported
    // 2026-08-24 as "ปุ่มย้อนกลับก็กดไม่ได้", which is exactly what it
    // looks like from the outside.
    //
    // Remapping the snapshots the same way the live EDL is remapped keeps
    // them consistent instead. Cut TIMES are never touched by a re-align, so
    // an undone snapshot still describes the same audio; a range that
    // overlapped the replaced segment becomes null there too, and null ranges
    // already fall back to a time comparison (isTokenRemoved).
    // The edit indices in a snapshot shift exactly the way the live ones did.
    const shiftState = (state: HistoryState): HistoryState => {
      const moved = new Map<number, TokenEdit>();
      for (const [i, edit] of state.edits) {
        if (i < first) moved.set(i, edit);
        else if (i >= endEx) moved.set(i + delta, edit);
        // edits inside the replaced span are dropped, same as the live ones
      }
      return { edl: shiftCuts(state.edl), edits: moved };
    };
    this.undoStack = this.undoStack.map(shiftState);
    this.redoStack = this.redoStack.map(shiftState);
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
        if (this.isExcluded(i)) continue;
        // A cut normally takes the words with it — unless the editor said
        // to keep this one, having judged the audio right and the words wrong.
        if (this.isTokenRemoved(i) && !this.isKeptInDoc(i)) continue;
        line += this.effectiveText(i);
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines;
  }

  /** Mark every filler token as not-content. Returns how many changed. */
  excludeAllFillers(): number {
    let changed = 0;
    this.asOneStep(() => {
      this.transcription.tokens.forEach((token, i) => {
        if (token.isFiller && !this.isExcluded(i)) {
          this.toggleExclude(i);
          changed += 1;
        }
      });
    });
    return changed;
  }

  // ---- markers (annotation only — never touches audio or the EDL) ----

  get markers(): readonly Marker[] {
    return this.markerList;
  }

  /** Drop a marker at `time`; returns it so the caller can focus its note. */
  addMarker(time: number, note = ""): Marker {
    const marker: Marker = { id: `m${this.nextMarkerId++}`, time, note };
    this.markerList.push(marker);
    this.markerList.sort((a, b) => a.time - b.time);
    this.dirty = true;
    return marker;
  }

  setMarkerNote(id: string, note: string): void {
    const marker = this.markerList.find((m) => m.id === id);
    if (!marker || marker.note === note) return;
    marker.note = note;
    this.dirty = true;
  }

  moveMarker(id: string, time: number): void {
    const marker = this.markerList.find((m) => m.id === id);
    if (!marker || marker.time === time) return;
    marker.time = time;
    this.markerList.sort((a, b) => a.time - b.time);
    this.dirty = true;
  }

  removeMarker(id: string): boolean {
    const before = this.markerList.length;
    this.markerList = this.markerList.filter((m) => m.id !== id);
    if (this.markerList.length === before) return false;
    this.dirty = true;
    return true;
  }

  serialize(): string {
    const edits: Record<string, TokenEdit> = {};
    for (const [i, edit] of this.edits) edits[String(i)] = edit;
    const file: ProjectFileV3 = {
      version: 3,
      audioPath: this.audioPath,
      transcription: this.transcription,
      edits,
      edl: this.edlList.map((c) => ({ ...c })),
      markers: this.markerList.map((m) => ({ ...m })),
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
      markers?: Marker[];
    };
    if (file.version !== 1 && file.version !== 2 && file.version !== 3) {
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
    // v1/v2 files have no markers — they load with an empty list.
    for (const marker of file.markers ?? []) {
      if (!Number.isFinite(marker?.time)) continue;
      project.markerList.push({
        // Re-mint ids rather than trusting the file: a hand-edited or merged
        // project with duplicate ids would make note edits hit the wrong row.
        id: `m${project.nextMarkerId++}`,
        time: marker.time,
        note: typeof marker.note === "string" ? marker.note : "",
      });
    }
    project.markerList.sort((a, b) => a.time - b.time);
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
