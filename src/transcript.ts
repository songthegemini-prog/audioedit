import type { Project } from "./project";
import type { SearchMatch } from "./search";

export const LOW_CONFIDENCE = 0.5;

export interface TranscriptCallbacks {
  onEditText: (index: number, text: string) => void;
  onToggleExclude: (index: number) => void;
  /** Entering inline edit — host should pause playback. */
  onEditStart: () => void;
  /** Word-range selection changed (null = cleared). Selecting never plays —
   * the host pauses audio and moves the playhead to the selection start. */
  onSelectionChange: (selection: [number, number] | null) => void;
  /** แก้ทั้งวรรค committed — host re-aligns the text then re-renders. */
  onSegmentText: (segIndex: number, text: string) => void;
}

/** Clickable, editable transcript bound to a Project.
 * - click: seek   - double-click: fix spelling   - right-click: toggle "not content"
 * Fillers, low-confidence words, edits, and exclusions are all visually flagged;
 * nothing is ever auto-deleted. */
export class TranscriptView {
  private project: Project | null = null;
  private spans: HTMLSpanElement[] = [];
  private activeIndex = -1;
  private editing = false;
  private searchTokens = new Set<number>();
  private currentSearchTokens = new Set<number>();
  private anchor: number | null = null; // last plain-clicked token (shift+click end)
  private selection: [number, number] | null = null;
  private dragFrom: number | null = null;
  private dragMoved = false;

  constructor(
    private container: HTMLElement,
    private callbacks: TranscriptCallbacks,
  ) {
    window.addEventListener("mouseup", () => {
      this.dragFrom = null;
    });

    // Event DELEGATION (Phase 9d): five listeners on the container instead of
    // five per word — an hour-long transcript (tens of thousands of tokens)
    // would otherwise carry ~100k listeners. Token spans are identified by
    // data-ti; clicks on segment ✎ buttons/editors simply don't match.
    const tokenAt = (e: Event): number | null => {
      const hit = (e.target as HTMLElement).closest?.("[data-ti]");
      return hit ? Number((hit as HTMLElement).dataset.ti) : null;
    };
    this.container.addEventListener("click", (e) => {
      const i = tokenAt(e);
      if (i === null || this.editing) return;
      if (this.dragMoved) {
        this.dragMoved = false; // this click ended a drag-selection
        return;
      }
      if (e.shiftKey && this.anchor !== null) {
        this.setSelection(this.anchor, i);
        return;
      }
      this.anchor = i;
      this.setSelection(i, i);
    });
    this.container.addEventListener("mousedown", (e) => {
      const i = tokenAt(e);
      if (i !== null && !this.editing) this.dragFrom = i;
    });
    // mouseover bubbles (mouseenter does not) — spans are flat text so the
    // target is always the span itself
    this.container.addEventListener("mouseover", (e) => {
      const i = tokenAt(e);
      if (
        i !== null &&
        this.dragFrom !== null &&
        ((e as MouseEvent).buttons & 1) === 1 &&
        i !== this.dragFrom
      ) {
        this.dragMoved = true;
        this.setSelection(this.dragFrom, i);
      }
    });
    this.container.addEventListener("dblclick", (e) => {
      const i = tokenAt(e);
      if (i !== null) this.startEdit(i, this.spans[i]);
    });
    this.container.addEventListener("contextmenu", (e) => {
      const i = tokenAt(e);
      if (i === null) return;
      e.preventDefault();
      this.callbacks.onToggleExclude(i);
    });
  }

  render(project: Project): void {
    this.project = project;
    this.spans = [];
    this.activeIndex = -1;
    this.searchTokens.clear();
    this.currentSearchTokens.clear();
    this.anchor = null;
    this.selection = null;
    this.dragFrom = null;
    this.dragMoved = false;
    this.container.textContent = "";
    const frag = document.createDocumentFragment();
    const segments = project.transcription.segments;
    const tokens = project.transcription.tokens;
    let segPointer = 0;
    let blockSeg = -1;
    let wordsWrap: HTMLElement | null = null;
    tokens.forEach((_token, i) => {
      // advance to the segment this token belongs to (both are time-sorted)
      while (
        segPointer + 1 < segments.length &&
        tokens[i].start >= segments[segPointer + 1].start - 1e-6
      ) {
        segPointer++;
      }
      if (segPointer !== blockSeg || wordsWrap === null) {
        blockSeg = segPointer;
        const made = this.makeSegmentBlock(segPointer);
        frag.appendChild(made.block);
        wordsWrap = made.wrap;
      }
      const span = document.createElement("span");
      // Text-editor model (chosen by the user, FIXES.md #8): click = SELECT
      // that word (silent, playhead moves to it), Shift+click extends, drag
      // sweeps. Listening is explicit: Space or "ฟังช่วงที่เลือก".
      // All handled by the delegated container listeners (constructor) —
      // the span only carries its token index.
      span.dataset.ti = String(i);
      this.spans.push(span);
      wordsWrap!.appendChild(span);
      this.refresh(i);
    });
    this.container.appendChild(frag);
  }

  private makeSegmentBlock(segIndex: number): { block: HTMLElement; wrap: HTMLElement } {
    const block = document.createElement("div");
    block.className = "segment";
    const editBtn = document.createElement("button");
    editBtn.className = "segment-edit";
    editBtn.textContent = "✎";
    editBtn.title = "แก้ทั้งวรรค — พิมพ์ใหม่อิสระแล้ว Enter ระบบจะตรึงเวลาให้ใหม่";
    editBtn.addEventListener("click", () => this.startSegmentEdit(segIndex, block));
    block.appendChild(editBtn);
    const wrap = document.createElement("span");
    wrap.className = "segment-words";
    block.appendChild(wrap);
    return { block, wrap };
  }

  private startSegmentEdit(segIndex: number, block: HTMLElement): void {
    if (!this.project || this.editing) return;
    this.editing = true;
    this.callbacks.onEditStart();

    const textarea = document.createElement("textarea");
    textarea.className = "segment-input";
    textarea.value = this.project.segmentEffectiveText(segIndex);
    block.textContent = "";
    block.appendChild(textarea);
    textarea.focus();

    const finish = (commit: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      const value = textarea.value.trim();
      if (commit && value) {
        block.textContent = "กำลังตรึงวรรคกับเสียงใหม่…";
        this.callbacks.onSegmentText(segIndex, value);
      } else if (this.project) {
        this.render(this.project); // cancelled — restore the block
      }
    };
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
  }

  /** Select one token programmatically (Tab review queue). */
  selectToken(i: number): void {
    this.anchor = i;
    this.setSelection(i, i);
    this.spans[i]?.scrollIntoView({ block: "nearest" });
  }

  /** Selection state: pass (null, null) to clear. */
  private setSelection(a: number | null, b: number | null): void {
    const prev = this.selection;
    this.selection =
      a === null || b === null ? null : [Math.min(a, b), Math.max(a, b)];
    // restyle everything previously or newly selected
    const touch = new Set<number>();
    if (prev) for (let i = prev[0]; i <= prev[1]; i++) touch.add(i);
    if (this.selection) {
      for (let i = this.selection[0]; i <= this.selection[1]; i++) touch.add(i);
    }
    touch.forEach((i) => this.refresh(i));
    this.callbacks.onSelectionChange(this.selection);
  }

  clearSelection(): void {
    if (this.selection) this.setSelection(null, null);
  }

  /** งานใหม่: drop the rendered transcript and all internal state. */
  clear(): void {
    this.project = null;
    this.spans = [];
    this.activeIndex = -1;
    this.selection = null;
    this.anchor = null;
    this.searchTokens.clear();
    this.currentSearchTokens.clear();
    this.container.textContent = "";
  }

  getSelection(): [number, number] | null {
    return this.selection;
  }

  /** Re-read one token's state from the project and restyle its span. */
  refresh(i: number): void {
    const project = this.project;
    const span = this.spans[i];
    if (!project || !span) return;
    const token = project.transcription.tokens[i];
    span.textContent = project.effectiveText(i);

    const classes = ["token"];
    if (token.isFiller) classes.push("token-filler");
    if (token.confidence !== null && token.confidence < LOW_CONFIDENCE) {
      classes.push("token-low-conf");
    }
    if (project.isEdited(i)) classes.push("token-edited");
    if (project.isExcluded(i)) classes.push("token-excluded");
    if (project.isTokenCut(i)) classes.push("token-cut");
    if (this.selection && i >= this.selection[0] && i <= this.selection[1]) {
      classes.push("token-selected");
    }
    if (i === this.activeIndex) classes.push("token-active");
    if (this.searchTokens.has(i)) classes.push("token-search");
    if (this.currentSearchTokens.has(i)) classes.push("token-search-current");
    span.className = classes.join(" ");

    const conf = token.confidence === null ? "" : ` ~${Math.round(token.confidence * 100)}%`;
    const parts = [`${token.start.toFixed(2)}–${token.end.toFixed(2)} วินาที${conf}`];
    if (project.isEdited(i)) parts.push(`ASR เดิม: ${token.text}`);
    if (project.isExcluded(i)) parts.push("ไม่ใช่เนื้อหา (เสียงยังอยู่)");
    span.title = parts.join(" | ");
  }

  refreshAll(): void {
    for (let i = 0; i < this.spans.length; i++) this.refresh(i);
  }

  /** Highlight the token being spoken at `time` (binary search over starts). */
  highlightAt(time: number): void {
    const tokens = this.project?.transcription.tokens ?? [];
    let lo = 0;
    let hi = tokens.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].start <= time) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx >= 0 && time >= tokens[idx].end) idx = -1;
    if (idx === this.activeIndex) return;
    const prev = this.activeIndex;
    this.activeIndex = idx;
    if (prev >= 0) this.refresh(prev);
    if (idx >= 0) {
      this.refresh(idx);
      this.spans[idx].scrollIntoView({ block: "nearest" });
    }
  }

  /** Mark all search matches; the current one gets a stronger style + scroll. */
  setSearchMatches(matches: SearchMatch[], currentIndex: number): void {
    const nextAll = new Set<number>();
    for (const m of matches) {
      for (let i = m.startToken; i <= m.endToken; i++) nextAll.add(i);
    }
    const nextCurrent = new Set<number>();
    const current = matches[currentIndex];
    if (current) {
      for (let i = current.startToken; i <= current.endToken; i++) nextCurrent.add(i);
    }
    const affected = new Set([
      ...this.searchTokens,
      ...this.currentSearchTokens,
      ...nextAll,
    ]);
    this.searchTokens = nextAll;
    this.currentSearchTokens = nextCurrent;
    affected.forEach((i) => this.refresh(i));
    if (current) this.spans[current.startToken]?.scrollIntoView({ block: "nearest" });
  }

  /** Open inline edit for token i (keyboard path: select word → Enter). */
  editToken(i: number): void {
    const span = this.spans[i];
    if (span) this.startEdit(i, span);
  }

  private startEdit(i: number, span: HTMLSpanElement): void {
    if (!this.project || this.editing) return;
    this.editing = true;
    this.callbacks.onEditStart();

    const input = document.createElement("input");
    input.className = "token-input";
    input.value = this.project.effectiveText(i);
    input.style.width = `${Math.max(input.value.length + 2, 4)}ch`;
    span.textContent = "";
    span.appendChild(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      if (commit) this.callbacks.onEditText(i, input.value);
      this.refresh(i); // restores the span content in both cases
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
      if (e.key === "Tab") {
        e.preventDefault(); // commit; the next Tab advances the review queue
        finish(true);
      }
      e.stopPropagation(); // keep spacebar from toggling playback while typing
    });
    input.addEventListener("blur", () => finish(true));
  }
}
