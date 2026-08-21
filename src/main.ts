import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import {
  audioFileUrl,
  audioInfo,
  cancelJob,
  exportDocx,
  packProject,
  fetchPcmWindow,
  fetchPeaks,
  getJob,
  health,
  deleteModels,
  modelsStatus,
  realign,
  startAlignScript,
  startDownloadModels,
  compareAudio,
  startExportAudio,
  startPrepareAudio,
  startTranscribe,
} from "./api";
import type {
  AudioInfo,
  ExportAudioResult,
  ExportFormat,
  TranscribeResult,
} from "./api";
import { AudioPlayer, WAVE_HEIGHT, cutToPreview, sliderToPxPerSec } from "./audio/player";
import { MemorySamples, RemoteSamples, snapWithProvider } from "./audio/samples";
import type { SampleProvider } from "./audio/samples";
import { WaveformDetail } from "./audio/wavedetail";
import { clampCutBounds, snapCutPoint } from "./audio/snap";
import { SpectrogramView } from "./audio/spectrogram";
import { Project } from "./project";
import { buildSearchIndex, findMatches } from "./search";
import type { SearchMatch } from "./search";
import { TranscriptView } from "./transcript";
import { formatTime } from "./utils/time";

const HEALTH_POLL_MS = 5000;
const JOB_POLL_MS = 1000;

const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "flac", "ogg", "aac", "opus"];

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

let currentPath: string | null = null;
let project: Project | null = null;
// Bumped on every load / งานใหม่. Async jobs capture it and bail if it moved,
// so a result can never land on the wrong project — even the A→other→A reopen
// (ABA) that a path-equality check would miss (Codex re-review #2).
let loadGeneration = 0;
let backendUp = false;
let modelsReady = false;

function setup(): void {
  const newBtn = el<HTMLButtonElement>("#new-btn");
  const openBtn = el<HTMLButtonElement>("#open-btn");
  const saveAsBtn = el<HTMLButtonElement>("#save-as-btn");
  const playBtn = el<HTMLButtonElement>("#play-btn");
  const transcribeBtn = el<HTMLButtonElement>("#transcribe-btn");
  const alignScriptBtn = el<HTMLButtonElement>("#align-script-btn");
  const exportBtn = el<HTMLButtonElement>("#export-btn");
  const packBtn = el<HTMLButtonElement>("#pack-btn");
  const cancelJobBtn = el<HTMLButtonElement>("#cancel-job-btn");
  const reviewCountEl = el<HTMLElement>("#review-count");
  const hideFillersBtn = el<HTMLButtonElement>("#hide-fillers-btn");
  const toggleExcludedBtn = el<HTMLButtonElement>("#toggle-excluded-btn");
  const saveBtn = el<HTMLButtonElement>("#save-btn");
  const timeDisplay = el<HTMLElement>("#time-display");
  const zoomSlider = el<HTMLInputElement>("#zoom-slider");
  const fileName = el<HTMLElement>("#file-name");
  const dirtyDot = el<HTMLElement>("#dirty-dot");
  const transcriptEl = el<HTMLElement>("#transcript");
  const alignNote = el<HTMLElement>("#align-note");

  const searchInput = el<HTMLInputElement>("#search-input");
  const searchPrev = el<HTMLButtonElement>("#search-prev");
  const searchNext = el<HTMLButtonElement>("#search-next");
  const searchCount = el<HTMLElement>("#search-count");
  const cutBtn = el<HTMLButtonElement>("#cut-btn");
  const playSelBtn = el<HTMLButtonElement>("#play-sel-btn");
  const testCutBtn = el<HTMLButtonElement>("#testcut-btn");
  const previewCutBtn = el<HTMLButtonElement>("#preview-cut-btn");
  const markerBtn = el<HTMLButtonElement>("#marker-btn");
  const markersPanel = el<HTMLElement>("#markers-panel");
  const markerList = el<HTMLOListElement>("#marker-list");
  const markerCount = el<HTMLElement>("#marker-count");
  const copyMarkersBtn = el<HTMLButtonElement>("#copy-markers-btn");
  const saveMarkersBtn = el<HTMLButtonElement>("#save-markers-btn");
  const scopeBtn = el<HTMLButtonElement>("#scope-btn");
  const loopBtn = el<HTMLButtonElement>("#loop-btn");
  const undoBtn = el<HTMLButtonElement>("#undo-btn");
  const redoBtn = el<HTMLButtonElement>("#redo-btn");
  const cutCount = el<HTMLElement>("#cut-count");

  const updateDirty = () => {
    dirtyDot.hidden = !(project?.dirty ?? false);
  };

  // --- search state ---
  let matches: SearchMatch[] = [];
  let matchIndex = 0;

  const runSearch = (seekToCurrent: boolean) => {
    if (!project) return;
    matches = findMatches(buildSearchIndex(project), searchInput.value);
    if (matchIndex >= matches.length) matchIndex = 0;
    searchCount.textContent = matches.length
      ? `${matchIndex + 1}/${matches.length}`
      : searchInput.value.trim()
        ? "ไม่พบ"
        : "";
    searchPrev.disabled = searchNext.disabled = matches.length === 0;
    transcript.setSearchMatches(matches, matchIndex);
    const current = matches[matchIndex];
    if (seekToCurrent && current) {
      player.seekTo(project.transcription.tokens[current.startToken].start);
    }
  };

  const gotoMatch = (delta: number) => {
    if (matches.length === 0) return;
    matchIndex = (matchIndex + delta + matches.length) % matches.length;
    runSearch(true);
  };

  let searchDebounce = 0;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      matchIndex = 0;
      runSearch(true);
    }, 200);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") gotoMatch(e.shiftKey ? -1 : 1);
    if (e.key === "Escape") searchInput.blur();
  });
  searchNext.addEventListener("click", () => gotoMatch(1));
  searchPrev.addEventListener("click", () => gotoMatch(-1));

  const transcript = new TranscriptView(transcriptEl, {
    onEditText: (i, text) => {
      project?.setEditedText(i, text);
      transcript.refresh(i);
      updateDirty();
      updateReviewCount();
      runSearch(false); // edited words must stay searchable
    },
    // แก้ทั้งวรรค: re-align the free-typed text within the segment's time range
    onSegmentText: async (segIndex, text) => {
      if (!project || !currentPath) return;
      const proj = project; // guard against a file switch during the await
      const seg = project.transcription.segments[segIndex];
      try {
        const res = await realign(currentPath, text, seg.start, seg.end);
        // if the user opened another file / งานใหม่ mid-realign, this result
        // belongs to the old project — drop it (Codex review #4)
        if (project !== proj) return;
        project.replaceSegment(segIndex, res.text, res.tokens);
        transcript.render(project);
        afterEdlChange();
        updateReviewCount();
        runSearch(false);
      } catch (err) {
        if (project !== proj) return; // stale failure for a closed project
        transcript.render(project); // restore the old segment
        fileName.textContent = `ตรึงวรรคไม่สำเร็จ: ${String(err)}`;
      }
    },
    onToggleExclude: (i) => {
      project?.toggleExclude(i);
      transcript.refresh(i);
      updateDirty();
    },
    onEditStart: () => player.pause(),
    // Text-editor model: selecting pauses audio, moves the playhead to the
    // selection start (view scrolls along), and mirrors the range on the
    // waveform. Listening is explicit — Space or "ฟังช่วงที่เลือก".
    onSelectionChange: (sel) => {
      selection = sel;
      if (sel && project) {
        player.pause();
        // Snap NOW so the blue region shows the true cut bounds (covering
        // the sound's head, not just the aligned word start) — FIXES.md #9.
        void computeSelectionBounds(sel[0], sel[1]).then((bounds) => {
          if (selection !== sel) return; // selection moved on while snapping
          player.seekTo(bounds.start);
          setSelectionBounds(bounds);
        });
      } else {
        setSelectionBounds(null);
      }
    },
  });

  // --- cutting (EDL — the source file is never touched) ---
  let selection: [number, number] | null = null;
  let selectionBounds: { start: number; end: number } | null = null;
  // PCM access for spectrogram/snap — in-memory (short) or remote (long file)
  let sampleProvider: SampleProvider | null = null;
  // Playback skips cuts by DEFAULT (cut = instantly gone from your ears,
  // exactly what export will produce). Toggle on to hear the original.
  let hearOriginal = false;

  const fineBar = el<HTMLElement>("#fine-bar");
  const fineStart = el<HTMLElement>("#fine-start");
  const fineEnd = el<HTMLElement>("#fine-end");

  const emptyTranscription = (): TranscribeResult => ({
    text: "",
    segments: [],
    tokens: [],
    timestamps: "rough",
    alignError: null,
  });

  /** Keep the spectrogram overlays + fine-tune bar in step with state. */
  const syncOverlays = () => {
    spectrogram.setOverlays(project?.edl ?? [], selectionBounds);
    fineBar.hidden = selectionBounds === null;
    if (selectionBounds) {
      fineStart.textContent = `${selectionBounds.start.toFixed(3)}s`;
      fineEnd.textContent = `${selectionBounds.end.toFixed(3)}s`;
    }
  };

  const setSelectionBounds = (bounds: { start: number; end: number } | null) => {
    selectionBounds = bounds;
    if (bounds) {
      player.setSelectionRegion(bounds.start, bounds.end);
    } else {
      player.clearSelectionRegion();
    }
    cutBtn.disabled = !bounds;
    playSelBtn.disabled = !bounds;
    // Ctrl+K auditions the selection when there is one, otherwise an existing
    // cut — so it stays live as long as either exists.
    previewCutBtn.disabled = !bounds && (project?.edl.length ?? 0) === 0;
    refreshScopeUi();
    syncOverlays();
  };

  /** Auto bounds for a token-range selection: snapped to silence/zero-cross,
   * clamped so neighbouring words keep their tails. Async because long-file
   * mode fetches a small PCM window around each boundary to snap in. */
  const computeSelectionBounds = async (a: number, b: number) => {
    const tokens = project!.transcription.tokens;
    const [start, end] = clampCutBounds(
      await snapSec(tokens[a].start),
      await snapSec(tokens[b].end),
      a > 0 ? tokens[a - 1].end : null,
      b < tokens.length - 1 ? tokens[b + 1].start : null,
      player.duration,
    );
    return { start, end };
  };

  const afterEdlChange = () => {
    if (!project) return;
    player.setCutRegions(project.edl);
    player.setSkipCuts(hearOriginal ? null : project.edl);
    transcript.refreshAll();
    undoBtn.disabled = !project.canUndo;
    redoBtn.disabled = !project.canRedo;
    testCutBtn.disabled = project.edl.length === 0 && !hearOriginal;
    previewCutBtn.disabled = project.edl.length === 0 && selectionBounds === null;
    cutCount.textContent = project.edl.length
      ? `ตัดไว้ ${project.edl.length} ช่วง (ต้นฉบับไม่ถูกแก้)`
      : "";
    syncOverlays();
    updateDirty();
  };

  /** Snap a boundary to silence/zero-crossing. Sync path for in-memory
   * audio; long-file mode snaps inside a fetched window (same PCM). */
  const snapSec = async (sec: number): Promise<number> => {
    const s = player.samples();
    if (s) return snapCutPoint(s.data, s.sampleRate, sec);
    if (sampleProvider) {
      try {
        return await snapWithProvider(sampleProvider, sec);
      } catch {
        return sec; // backend hiccup — an unsnapped bound is still usable
      }
    }
    return sec;
  };

  const cutSelection = () => {
    if (!project || !selectionBounds) return;
    // Cutting from a TOKEN selection relies on the word's time being accurate;
    // if alignment hasn't run (timestamps === "rough") those times are
    // unreliable and CLAUDE.md forbids cutting from them. A direct waveform
    // drag (selection === null) is fine — the user is looking at real audio
    // (Codex review #3).
    if (selection && project.transcription.timestamps === "rough") {
      fileName.textContent =
        "เวลาคำยังเป็นแบบหยาบ (ยังไม่ผ่าน alignment) — ตัดจากการเลือกคำยังไม่ได้ " +
        "ให้ลากเลือกบน waveform โดยตรง หรือถอดเสียง/ตรึงบทใหม่ก่อน";
      return;
    }
    // The bounds are exactly what the blue region shows — snapped, or as the
    // user dragged them (user adjustments are respected, never re-snapped).
    const { start, end } = selectionBounds;
    if (end - start < 0.01) return; // nothing meaningful to cut
    // ALWAYS derive tokenRange from the final cut bounds, never from the stale
    // token `selection` — the user may have dragged the selection edge on the
    // waveform/spectrogram after picking words, moving the bounds away from
    // those tokens. Deriving from bounds (same midpoint rule as resize) keeps
    // audio and .docx consistent on every create path (Codex re-review #1).
    const tokenRange = project.tokensInSpan(start, end);
    project.addCut({ start, end, tokenRange });
    transcript.clearSelection();
    setSelectionBounds(null);
    afterEdlChange();
  };

  cutBtn.addEventListener("click", cutSelection);

  playSelBtn.addEventListener("click", () => {
    if (!selectionBounds) return;
    player.playRange(selectionBounds.start, selectionBounds.end);
  });

  // Sound Forge Ctrl+K = "preview cut": hear the join BEFORE committing.
  // Pre/post-roll match Sound Forge's own defaults (Options > Preferences >
  // Previews there); ours are fixed until someone asks to tune them.
  const PREVIEW_PRE_ROLL_SEC = 1.5;
  const PREVIEW_POST_ROLL_SEC = 1.5;

  const previewCut = () => {
    if (!player.isLoaded) return;
    // A live selection is what the editor is about to cut — preview that.
    // With no selection, audition an existing cut instead, so Ctrl+K also
    // answers "how did the cut I already made turn out?".
    const span = selectionBounds ?? cutToPreview(project?.edl ?? [], player.currentTime);
    if (!span) return;
    player.previewCut(span.start, span.end, PREVIEW_PRE_ROLL_SEC, PREVIEW_POST_ROLL_SEC);
  };

  previewCutBtn.addEventListener("click", previewCut);

  // --- markers: annotate positions for the cover sheet (ใบปะหน้า) ---

  /** One line per marker, in the shape the editors paste into the cover
   * sheet. Exported by "คัดลอกรายการ" and appended to the .docx on export. */
  const markerLines = (p: Project): string[] =>
    p.markers.map((m) => `${formatTime(m.time)}\t${m.note}`.trimEnd());

  const renderMarkers = () => {
    const markers = project?.markers ?? [];
    markersPanel.hidden = markers.length === 0;
    markerCount.textContent = String(markers.length);
    player.setMarkerRegions(markers);
    markerList.replaceChildren(
      ...markers.map((marker) => {
        const row = document.createElement("li");
        row.className = "marker-row";

        const jump = document.createElement("button");
        jump.className = "marker-time";
        jump.textContent = formatTime(marker.time);
        jump.title = "ไปที่จุดนี้";
        jump.addEventListener("click", () => player.playFrom(marker.time));

        const note = document.createElement("input");
        note.className = "marker-note";
        note.value = marker.note;
        note.placeholder = "เขียนโน้ต… (เช่น เสียงแตก / ต้องอัดใหม่)";
        // Save on every keystroke: an editor who types a note and immediately
        // hits Ctrl+S must not lose it to a missing blur.
        note.addEventListener("input", () => {
          project?.setMarkerNote(marker.id, note.value);
          updateDirty();
        });
        // Enter commits and gets out of the way; Space inside the box must NOT
        // reach the global play/pause handler (it already guards INPUT).
        note.addEventListener("keydown", (e) => {
          if (e.key === "Enter") note.blur();
        });

        const remove = document.createElement("button");
        remove.className = "marker-remove";
        remove.textContent = "✕";
        remove.title = "ลบจุดนี้";
        remove.addEventListener("click", () => {
          if (project?.removeMarker(marker.id)) {
            renderMarkers();
            updateDirty();
          }
        });

        row.append(jump, note, remove);
        return row;
      }),
    );
  };

  const addMarkerHere = () => {
    if (!project || !player.isLoaded) return;
    const marker = project.addMarker(player.currentTime);
    renderMarkers();
    updateDirty();
    // Straight into the note box — the whole point of a marker is its note.
    const rows = markerList.querySelectorAll<HTMLInputElement>(".marker-note");
    const index = project.markers.findIndex((m) => m.id === marker.id);
    rows[index]?.focus();
  };

  markerBtn.addEventListener("click", addMarkerHere);

  /** The marker list as a STANDALONE note document for the QC reviewer.
   * Deliberately not the transcript: QC wants the list of places to check,
   * not the whole story (team workflow, 2026-08-21). The source filename is
   * included because this file travels on its own and has to say which audio
   * it belongs to. */
  const markerDocLines = (p: Project): string[] => {
    const audioName = p.audioPath.split(/[\/]/).pop() ?? p.audioPath;
    const lines = [
      "รายการจุดที่มาร์กไว้ (สำหรับตรวจงาน)",
      `ไฟล์เสียง: ${audioName}`,
      `จำนวน: ${p.markers.length} จุด`,
      "",
    ];
    p.markers.forEach((m, i) => {
      lines.push(`${i + 1}. ${formatTime(m.time)}  ${m.note}`.trimEnd());
    });
    return lines;
  };

  /** Same list as CSV so it opens straight into Excel — with many markers on
   * a long file, a spreadsheet beats a document for ticking items off. */
  const markerCsv = (p: Project): string => {
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [["ลำดับ", "เวลา", "วินาที", "โน้ต"].map(escape).join(",")];
    p.markers.forEach((m, i) => {
      rows.push(
        [String(i + 1), formatTime(m.time), m.time.toFixed(3), m.note].map(escape).join(","),
      );
    });
    // BOM: Excel reads a UTF-8 CSV as the system codepage without it and
    // renders every Thai character as mojibake.
    return "\ufeff" + rows.join("\r\n");
  };

  saveMarkersBtn.addEventListener("click", async () => {
    if (!project || project.markers.length === 0) return;
    const proj = project;
    const base = proj.audioPath.replace(/\.[^.]+$/, "");
    try {
      const target = await save({
        defaultPath: `${base}-โน้ตตรวจงาน.docx`,
        filters: [
          { name: "Word", extensions: ["docx"] },
          { name: "Text", extensions: ["txt"] },
          { name: "Excel (CSV)", extensions: ["csv"] },
        ],
      });
      if (!target) return;
      const lower = target.toLowerCase();
      if (lower.endsWith(".csv")) {
        await writeTextFile(target, markerCsv(proj));
      } else if (lower.endsWith(".txt")) {
        await writeTextFile(target, markerDocLines(proj).join("\n"));
      } else {
        await exportDocx(target, markerDocLines(proj));
      }
      fileName.textContent = `✅ บันทึกรายการมาร์ก ${proj.markers.length} จุด: ${target}`;
    } catch (err) {
      fileName.textContent = `บันทึกรายการมาร์กไม่สำเร็จ: ${String(err)}`;
    }
  });

  copyMarkersBtn.addEventListener("click", async () => {
    if (!project) return;
    await navigator.clipboard.writeText(markerLines(project).join("\n"));
    copyMarkersBtn.textContent = "✓ คัดลอกแล้ว";
    setTimeout(() => (copyMarkersBtn.textContent = "📋 คัดลอกรายการ"), 1500);
  });

  // --- region scope: lock the transport inside one span (Sound Forge habit) ---
  let loopScope = false;

  const refreshScopeUi = () => {
    const scope = player.scopeRange;
    scopeBtn.classList.toggle("active", scope !== null);
    scopeBtn.textContent = scope
      ? `⇥ กั้นไว้ ${scope.start.toFixed(2)}–${scope.end.toFixed(2)}s ✓`
      : "⇥ กั้นช่วงฟัง";
    // Looping is meaningless without a scope; drop it with the scope so the
    // button can't sit lit while doing nothing.
    loopBtn.disabled = scope === null;
    loopBtn.classList.toggle("active", loopScope && scope !== null);
    scopeBtn.disabled = scope === null && selectionBounds === null;
  };

  const toggleScope = () => {
    if (player.scopeRange) {
      player.setScope(null);
    } else if (selectionBounds) {
      player.setScope({ ...selectionBounds });
    } else {
      return;
    }
    refreshScopeUi();
  };

  scopeBtn.addEventListener("click", toggleScope);

  loopBtn.addEventListener("click", () => {
    loopScope = !loopScope;
    player.setLoopScope(loopScope);
    refreshScopeUi();
  });

  testCutBtn.addEventListener("click", () => {
    hearOriginal = !hearOriginal;
    testCutBtn.classList.toggle("active", hearOriginal);
    testCutBtn.textContent = hearOriginal ? "กำลังฟังต้นฉบับ ✓" : "ฟังต้นฉบับ";
    afterEdlChange();
  });

  undoBtn.addEventListener("click", () => {
    if (project?.undo()) afterEdlChange();
  });
  redoBtn.addEventListener("click", () => {
    if (project?.redo()) afterEdlChange();
  });

  // fine-tune bar: nudge selection edges by ±10ms/±1ms (counts as manual)
  fineBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !selectionBounds) return;
    const delta = Number(btn.dataset.delta);
    const next = { ...selectionBounds };
    if (btn.dataset.edge === "start") {
      next.start = Math.max(0, Math.min(next.start + delta, next.end - 0.001));
    } else {
      next.end = Math.min(player.duration, Math.max(next.end + delta, next.start + 0.001));
    }
    setSelectionBounds(next);
  });

  const updateTime = (current: number) => {
    // While no file is loaded (mid-teardown of งานใหม่), wavesurfer can still
    // emit stray timeupdates carrying the OLD duration — render zeros instead
    // of letting them repaint the previous file's length (FIXES.md #19)
    timeDisplay.textContent = player.isLoaded
      ? `${formatTime(current)} / ${formatTime(player.duration)}`
      : "0:00.0 / 0:00.0";
    transcript.highlightAt(current);
  };

  // --- Tab review queue: only the words the system doubts ---
  let reviewCursor = -1;

  const reviewIndices = (): number[] => {
    if (!project) return [];
    return project.transcription.tokens
      .map((t, i) => ({ t, i }))
      .filter(
        ({ t, i }) =>
          t.confidence !== null &&
          t.confidence < 0.5 &&
          !project!.isTokenCut(i) &&
          !project!.isExcluded(i),
      )
      .map(({ i }) => i);
  };

  const updateReviewCount = () => {
    const n = reviewIndices().length;
    reviewCountEl.textContent = n ? `ต้องตรวจ ${n} คำ — กด Tab ไล่ดู` : "";
  };

  const refreshButtons = () => {
    // ASR/alignment need the models; everything else works without them
    transcribeBtn.disabled = !(currentPath && player.isLoaded && backendUp && modelsReady);
    alignScriptBtn.disabled = transcribeBtn.disabled;
    const hasProject = project !== null;
    // Markers only need a loaded file — they work before transcription, and
    // without the backend (they are pure project data).
    markerBtn.disabled = !hasProject || !player.isLoaded;
    exportBtn.disabled = !hasProject || !backendUp;
    packBtn.disabled = !hasProject || !backendUp;
    saveBtn.disabled = !hasProject;
    saveAsBtn.disabled = !hasProject;
    hideFillersBtn.disabled = !hasProject;
    toggleExcludedBtn.disabled = !hasProject;
    searchInput.disabled = !hasProject;
    if (!hasProject) {
      searchInput.value = "";
      searchCount.textContent = "";
      searchPrev.disabled = searchNext.disabled = true;
      matches = [];
      matchIndex = 0;
    }
  };

  // The deep-zoom overlay is sized from this var, not from #waves (which also
  // holds wavesurfer's horizontal scrollbar — 15px on Windows, 0 on macOS).
  el("#waves").style.setProperty("--wave-height", `${WAVE_HEIGHT}px`);

  const player = new AudioPlayer(el("#waves"), {
    onReady: () => {
      playBtn.disabled = false;
      zoomSlider.disabled = false;
      updateTime(0);
      refreshButtons();
      // Short files: wrap the decoded buffer. Long files: loadAudio already
      // set a RemoteSamples provider before loading — keep it.
      const decoded = player.samples();
      if (decoded) {
        sampleProvider = new MemorySamples(decoded.data, decoded.sampleRate);
      }
      spectrogram.setProvider(sampleProvider);
      // overlay only for long-file (remote) mode — short files are exact already
      waveDetail.setProvider(decoded ? null : sampleProvider);
    },
    onTime: updateTime,
    onPlayState: (playing) => {
      playBtn.textContent = playing ? "หยุด" : "เล่น";
    },
    // Manual edge drags win verbatim — never re-snap over the user's hands
    // (FIXES.md #9). Waveform and spectrogram edit the same EDL entry.
    onCutRegionUpdated: (cutIndex, start, end) => {
      if (!project) return;
      project.updateCutBounds(cutIndex, start, end);
      afterEdlChange();
    },
    onSelectionRegionUpdated: (start, end) => {
      selectionBounds = { start, end };
      syncOverlays();
    },
    // Drag on empty waveform = select by sound, no transcript needed
    onWaveformSelection: (start, end) => {
      transcript.clearSelection(); // drops any token-based selection first
      player.pause();
      setSelectionBounds({ start, end });
    },
    onViewport: (start, end) => {
      spectrogram.setViewport(start, end);
      waveDetail.setViewport(start, end);
    },
    onMarkerMoved: (markerId, time) => {
      project?.moveMarker(markerId, time);
      // Re-render for the new time label and row order, but the drag already
      // moved the flag, so this only re-syncs the list.
      renderMarkers();
      updateDirty();
    },
  });

  // Long-file deep zoom: true-PCM waveform over the peaks view (Phase 9e).
  // Activates only with a RemoteSamples provider (main sets it below).
  const waveDetail = new WaveformDetail(
    el<HTMLCanvasElement>("#wave-detail"),
    (active) => player.setWaveHidden(active),
  );

  const spectrogram = new SpectrogramView(el<HTMLCanvasElement>("#spectrogram"), {
    onSeek: (t) => player.seekTo(t),
    onCutEdge: (cutIndex, start, end) => {
      if (!project) return;
      project.updateCutBounds(cutIndex, start, end);
      afterEdlChange();
    },
    onSelectionEdge: (start, end) => setSelectionBounds({ start, end }),
  });

  const showAlignNote = (p: Project | null) => {
    if (!p) {
      alignNote.textContent = "";
      return;
    }
    if (p.transcription.timestamps === "aligned") {
      alignNote.className = "align-ok";
      alignNote.textContent = "✓ aligned — เวลาแม่นระดับคำ คำที่ขีดแดงควรตรวจซ้ำ";
    } else {
      alignNote.className = "rough-note";
      alignNote.textContent = p.transcription.alignError
        ? `⚠ alignment ล้มเหลว (${p.transcription.alignError}) — ใช้เวลาแบบหยาบ ห้ามตัดเสียง`
        : "⚠ เวลาแบบหยาบจาก Whisper — ยังไม่ผ่าน alignment ห้ามใช้ตัดเสียง";
    }
  };

  // Files longer than this use long-file mode: audio streams from the
  // backend's canonical WAV instead of being decoded into frontend RAM.
  const LONG_FILE_MIN_SEC = 20 * 60;

  /** Poll a job to completion (prepare_audio runs inside loadAudio, so the
   * usual fire-and-forget trackJob flow doesn't fit here). */
  const waitForJob = async (jobId: string, onProgress: (p: number) => void) => {
    for (;;) {
      const job = await getJob(jobId);
      onProgress(job.progress);
      if (job.status === "done") return;
      if (job.status === "error") throw new Error(job.error ?? "job failed");
      if (job.status === "cancelled") throw new Error("ยกเลิกแล้ว");
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  // --- open: audio file or .audioedit.json project ---
  const loadAudio = async (path: string): Promise<boolean> => {
    loadGeneration++; // any in-flight job for the previous file is now stale
    fileName.textContent = "กำลังโหลดและถอดรหัสเสียง…";
    playBtn.disabled = true;
    zoomSlider.disabled = true;
    zoomSlider.value = "0";
    sampleProvider = null;
    try {
      // Ask the backend how long the file is (fast, no decode). If the
      // backend is unreachable, fall back to the in-memory path unchanged.
      let info: AudioInfo | null = null;
      try {
        await health(); // re-probe/lock the backend first — right after
        // startup apiBase() may still point at the wrong candidate port
        info = await audioInfo(path);
      } catch {
        info = null;
      }
      if (info?.duration && info.duration > LONG_FILE_MIN_SEC) {
        if (!info.prepared) {
          fileName.textContent = "ไฟล์ยาว — กำลังเตรียมครั้งแรก (ครั้งเดียวต่อไฟล์)…";
          await waitForJob(await startPrepareAudio(path), (p) => {
            fileName.textContent = `ไฟล์ยาว — กำลังเตรียมครั้งแรก… ${Math.round(p * 100)}%`;
          });
        }
        const peaks = await fetchPeaks(path);
        sampleProvider = new RemoteSamples(
          (s, e) => fetchPcmWindow(path, s, e),
          info.sample_rate,
          info.duration,
        );
        await player.loadStream(audioFileUrl(path), peaks, info.duration);
      } else {
        const bytes = await readFile(path);
        await player.loadBlob(new Blob([bytes]));
      }
      currentPath = path;
      fileName.textContent = path;
      loopScope = false; // the player dropped the scope; drop the loop with it
      player.setLoopScope(false);
      refreshScopeUi();
      return true;
    } catch (err) {
      fileName.textContent = `เปิดไฟล์ไม่สำเร็จ: ${String(err)}`;
      return false;
    }
  };

  const loadProject = async (path: string) => {
    try {
      const loaded = Project.parse(await readTextFile(path));
      if (!(await loadAudio(loaded.audioPath))) {
        // Project moved machines? Look for the audio next to the project file
        // (handoff convention: zip both files in one folder).
        const audioName = loaded.audioPath.split(/[\\/]/).pop() ?? "";
        // use whichever separator the project path itself uses (Windows: \)
        const sep = path.includes("\\") ? "\\" : "/";
        const sibling = path.slice(0, path.lastIndexOf(sep) + 1) + audioName;
        if (sibling !== loaded.audioPath && (await loadAudio(sibling))) {
          loaded.audioPath = sibling;
        } else {
          fileName.textContent =
            `หาไฟล์เสียงไม่เจอ (${loaded.audioPath}) — วางไฟล์เสียงไว้โฟลเดอร์เดียวกับไฟล์โปรเจกต์แล้วเปิดใหม่`;
          return;
        }
      }
      loaded.savePath = path;
      project = loaded;
      transcript.render(project);
      renderMarkers();
      if (project.transcription.tokens.length === 0) {
        transcriptEl.textContent =
          "โปรเจกต์นี้ยังไม่ถอดเสียง — ตัดบน waveform หรือกดถอดเสียงได้";
      }
      showAlignNote(project);
      fileName.textContent = `${loaded.audioPath} — โปรเจกต์: ${path}`;
      updateDirty();
      refreshButtons();
      afterEdlChange(); // restore saved cut regions onto the waveform
      updateReviewCount();
      reviewCursor = -1;
      project.dirty = false;
      updateDirty();
    } catch (err) {
      fileName.textContent = `เปิดโปรเจกต์ไม่สำเร็จ: ${String(err)}`;
    }
  };

  openBtn.addEventListener("click", async () => {
    if (project?.dirty && !window.confirm("มีการแก้ที่ยังไม่ได้บันทึก เปิดไฟล์ใหม่เลยไหม?")) {
      return;
    }
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "ไฟล์เสียงหรือโปรเจกต์", extensions: [...AUDIO_EXTENSIONS, "json"] },
      ],
    });
    if (typeof path !== "string") return;

    project = null;
    currentPath = null;
    transcriptEl.textContent = "ยังไม่มี transcript — กด \"ถอดเสียง (ฉบับร่าง)\" หรือเปิดไฟล์โปรเจกต์";
    showAlignNote(null);
    updateDirty();
    refreshButtons();

    if (path.endsWith(".json")) {
      await loadProject(path);
    } else if (await loadAudio(path)) {
      // A bare audio file still gets a project (empty transcription), so
      // rough waveform cutting works BEFORE transcribing — the team's
      // "ตัดหยาบก่อนถอด" first pass.
      project = new Project(path, emptyTranscription());
      transcript.render(project);
      renderMarkers();
      transcriptEl.textContent =
        "ยังไม่ถอดเสียง — ลากเลือกบน waveform เพื่อตัดหยาบได้เลย หรือกด \"ถอดเสียง (ฉบับร่าง)\"";
      showAlignNote(null);
      updateDirty();
      refreshButtons();
      afterEdlChange();
    } else {
      refreshButtons();
    }
  });

  // --- save project ---
  // forceDialog = "บันทึกเป็น": always pick a new file (keeps the old one).
  const saveProject = async (forceDialog = false) => {
    if (!project) return;
    try {
      if (!project.savePath || forceDialog) {
        const target = await save({
          defaultPath: project.savePath ?? `${project.audioPath}.audioedit.json`,
          filters: [{ name: "AudioEdit Project", extensions: ["json"] }],
        });
        if (!target) return; // user cancelled
        project.savePath = target;
      }
      await writeTextFile(project.savePath, project.serialize());
      project.dirty = false;
      updateDirty();
      // Visible confirmation on every save — a silent re-save felt like
      // "save only works once" (the file WAS being overwritten each time).
      const at = new Date().toLocaleTimeString();
      fileName.textContent = `✓ บันทึกแล้ว ${at}: ${project.savePath}`;
    } catch (err) {
      fileName.textContent = `บันทึกไม่สำเร็จ: ${String(err)}`;
    }
  };
  saveBtn.addEventListener("click", () => saveProject(false));
  saveAsBtn.addEventListener("click", () => saveProject(true));

  // --- pack: one self-contained folder that moves between machines ---
  // A bare .audioedit.json points at an ABSOLUTE audio path, so it only opens
  // on the machine that made it. Packing copies the audio next to the project
  // file and stores just the FILENAME, which loadProject's sibling lookup
  // resolves against the folder it opened from (team request 2026-08-20).
  const packProjectFolder = async () => {
    if (!project) return;
    const proj = project;
    // Windows paths use "\", so the class must cover BOTH separators or the
    // whole path ends up as the suggested folder name.
    const base = proj.audioPath.replace(/\.[^.]+$/, "").split(/[\\/]/).pop() ?? "งาน";
    const target = await save({
      title: "เลือกที่เก็บโฟลเดอร์โปรเจกต์",
      defaultPath: `${base}-project`,
    });
    if (!target) return;
    packBtn.disabled = true;
    fileName.textContent = "กำลังรวมไฟล์เข้าโฟลเดอร์โปรเจกต์…";
    try {
      const packed = await packProject(proj.audioPath, target);
      // Point the SAVED copy at the bare filename. The in-memory project
      // keeps its original absolute path, so the editor carries on against
      // the file they already have open.
      const originalPath = proj.audioPath;
      proj.audioPath = packed.audio_name;
      const json = proj.serialize();
      proj.audioPath = originalPath;
      await writeTextFile(`${packed.out_dir}/${base}.audioedit.json`, json);
      const mb = (packed.bytes / 1024 ** 2).toFixed(0);
      fileName.textContent =
        `✅ รวมเป็นโปรเจกต์แล้ว: ${packed.out_dir} ` +
        `(เสียง ${packed.audio_name} ${mb} MB + ไฟล์งาน) — ย้ายทั้งโฟลเดอร์ได้เลย`;
    } catch (err) {
      fileName.textContent = `รวมโปรเจกต์ไม่สำเร็จ: ${String(err)}`;
    } finally {
      packBtn.disabled = false;
      refreshButtons();
    }
  };

  packBtn.addEventListener("click", packProjectFolder);

  // งานใหม่: clear everything back to the empty state.
  const newProject = () => {
    if (project?.dirty && !window.confirm("มีการแก้ที่ยังไม่ได้บันทึก เริ่มงานใหม่เลยไหม?")) {
      return;
    }
    loadGeneration++; // invalidate any in-flight job's result
    project = null;
    currentPath = null;
    selection = null;
    setSelectionBounds(null);
    player.clear();
    sampleProvider = null;
    spectrogram.setProvider(null);
    waveDetail.setProvider(null);
    spectrogram.setOverlays([], null);
    playBtn.disabled = true;
    zoomSlider.disabled = true;
    zoomSlider.value = "0";
    transcript.clear();
    renderMarkers();
    // ws.empty() loads a blank URL whose "ready" never fires, so nothing
    // downstream refreshes the clock — reset it explicitly (FIXES.md #19)
    timeDisplay.textContent = "0:00.0 / 0:00.0";
    transcriptEl.textContent =
      'ยังไม่ได้เปิดไฟล์ — กด "เปิดไฟล์เสียง" เพื่อเริ่ม (เปิดไฟล์ .audioedit.json ได้ด้วย)';
    fileName.textContent = 'ยังไม่ได้เปิดไฟล์ — กด "เปิดไฟล์เสียง" เพื่อเริ่ม';
    cutCount.textContent = "";
    reviewCountEl.textContent = "";
    showAlignNote(null);
    updateDirty();
    refreshButtons();
  };
  newBtn.addEventListener("click", newProject);

  // View-only toggle (asked 2026-07-11): read the transcript as clean
  // content by hiding struck-through words; click again to review them.
  let hideExcluded = false;
  toggleExcludedBtn.addEventListener("click", () => {
    hideExcluded = !hideExcluded;
    transcriptEl.classList.toggle("hide-excluded", hideExcluded);
    toggleExcludedBtn.classList.toggle("active", hideExcluded);
    toggleExcludedBtn.textContent = hideExcluded ? "โชว์คำที่ไม่ใช้" : "ซ่อนคำที่ไม่ใช้";
  });

  hideFillersBtn.addEventListener("click", () => {
    if (!project) return;
    const changed = project.excludeAllFillers();
    transcript.refreshAll();
    updateDirty();
    // Silent no-op looked broken when the file simply had no fillers —
    // always tell the user what happened (reported 2026-07-11)
    fileName.textContent = changed
      ? `ซ่อนคำ filler แล้ว ${changed} คำ (ขีดทิ้งในบท — เสียงยังอยู่ ไม่ไปอยู่ในเอกสารตอน export)`
      : "ไม่พบคำ filler (อ่า/อืม/เอ่อ ฯลฯ) เพิ่มในบทนี้ — คำที่เคยซ่อนแล้วยังซ่อนอยู่";
  });

  // --- playback + keyboard ---
  playBtn.addEventListener("click", () => player.playPause());
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      toggleScope();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      previewCut();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey ? project?.redo() : project?.undo()) afterEdlChange();
      return;
    }
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    // Space must ALWAYS toggle playback (like every audio editor) EXCEPT while
    // typing text. Handle it before the button guard below, and blur any
    // focused button so it can't swallow the key — after clicking a toolbar
    // button, focus sat on it and Space stopped playing (FIXES.md #22).
    if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      // Sound Forge muscle memory: Shift+Space auditions the selection
      if (e.shiftKey && selectionBounds) {
        player.playRange(selectionBounds.start, selectionBounds.end);
      } else {
        player.playPause();
      }
      return;
    }
    if (target && ["INPUT", "TEXTAREA", "BUTTON"].includes(tag ?? "")) return;
    // Tab review queue: jump to the next doubtful word, play it, open its editor
    if (e.key === "Tab" && project) {
      const list = reviewIndices();
      if (list.length === 0) return;
      e.preventDefault();
      const next = e.shiftKey
        ? [...list].reverse().find((i) => i < reviewCursor) ?? list[list.length - 1]
        : list.find((i) => i > reviewCursor) ?? list[0];
      reviewCursor = next;
      const token = project.transcription.tokens[next];
      transcript.selectToken(next); // pauses + scrolls both views
      player.playRange(token.start, token.end); // hear the doubtful word once
      transcript.editToken(next); // fingers straight to the fix
      return;
    }
    if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      addMarkerHere();
      return;
    }
    // Cut whatever is selected. Guarded on selectionBounds, NOT on the token
    // selection: dragging the blue band straight on the waveform sets bounds
    // and deliberately CLEARS the token selection, so keying off `selection`
    // made Delete silently do nothing for exactly the Sound Forge workflow
    // this is meant to serve (select the band, hit a key).
    if ((e.key === "Delete" || e.key === "Backspace") && selectionBounds) {
      e.preventDefault();
      cutSelection();
      return;
    }

    // --- Sound Forge selection keys ---------------------------------------
    // Arrows move the cursor by ONE SCREEN PIXEL, so the step scales with
    // zoom exactly as Sound Forge does: coarse zoomed out, sample-fine zoomed
    // in. Shift extends the selection instead of moving.
    if (player.isLoaded && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const back = e.key === "ArrowLeft";
      const pixel = 1 / Math.max(player.pixelsPerSecond, 1);
      const step = (e.ctrlKey || e.metaKey ? 1 : pixel) * (back ? -1 : 1);
      const clamp = (t: number) => Math.max(0, Math.min(player.duration, t));
      if (e.shiftKey) {
        // Grow/shrink from the playhead, like dragging the band's far edge.
        const anchor = selectionBounds ?? { start: player.currentTime, end: player.currentTime };
        const moved = clamp(anchor.end + step);
        transcript.clearSelection();
        setSelectionBounds(
          moved <= anchor.start
            ? { start: moved, end: anchor.start }
            : { start: anchor.start, end: moved },
        );
      } else {
        player.seekTo(clamp(player.currentTime + step));
      }
      return;
    }
    if (player.isLoaded && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      player.seekTo(e.key === "Home" ? 0 : player.duration);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && player.isLoaded) {
      e.preventDefault();
      transcript.clearSelection();
      setSelectionBounds({ start: 0, end: player.duration });
      return;
    }
    // keyboard editing: click selects a word, Enter opens the edit box
    if (e.key === "Enter" && selection) {
      e.preventDefault();
      transcript.editToken(selection[0]);
    }
    if (e.key === "Escape") {
      transcript.clearSelection();
    }
  });

  // --- zoom ---
  const applyZoom = () => player.zoom(sliderToPxPerSec(Number(zoomSlider.value)));
  zoomSlider.addEventListener("input", applyZoom);
  // Sound Forge muscle memory: the bare wheel zooms. This used to require
  // Ctrl/Cmd, which silently made the feature Mac-only — a trackpad pinch on
  // macOS synthesises ctrlKey=true, so pinching "just worked" there, while a
  // Windows mouse wheel sends no modifier and nothing happened (FIXES.md #35).
  // Ctrl/Cmd+wheel still zooms so the Mac pinch keeps working.
  // Shift+wheel (and a horizontal wheel/trackpad swipe) pans instead.
  el(".waves-scroll").addEventListener(
    "wheel",
    (e) => {
      const we = e as WheelEvent;
      if (!player.isLoaded) return;
      // Alt+wheel keeps the panel's own vertical scroll reachable: waveform +
      // spectrogram are ~325px tall and overflow this panel on a normal
      // window, so hijacking EVERY wheel for zoom would strand the
      // spectrogram off-screen with no keyboard way back.
      if (we.altKey) return;
      const horizontal = we.shiftKey || Math.abs(we.deltaX) > Math.abs(we.deltaY);
      we.preventDefault();
      if (horizontal) {
        player.panBy(we.shiftKey ? we.deltaY || we.deltaX : we.deltaX);
        return;
      }
      zoomSlider.value = String(Number(zoomSlider.value) + (we.deltaY < 0 ? 4 : -4));
      applyZoom();
    },
    { passive: false },
  );

  // --- transcription + script alignment (share one job-tracking path) ---
  const adoptResult = (gen: number, audioPath: string, result: TranscribeResult) => {
    // A transcription/align job that finishes AFTER the user opened another
    // file or hit งานใหม่ must not land on the current project. Compare the
    // load generation captured when the job started, not just the path — that
    // also rejects the A→other→A reopen case (Codex re-review #2).
    if (gen !== loadGeneration || currentPath !== audioPath) return;
    // carry rough pre-transcription cuts (as pure time cuts) forward
    const carriedCuts = project && project.audioPath === audioPath ? [...project.edl] : [];
    project = new Project(audioPath, result);
    for (const cut of carriedCuts) {
      project.addCut({ ...cut, tokenRange: null });
    }
    reviewCursor = -1;
    transcript.render(project);
    renderMarkers();
    showAlignNote(project);
    refreshButtons();
    afterEdlChange();
    updateReviewCount();
    project.dirty = true; // fresh result not saved yet
    updateDirty();
  };

  let activeJobId: string | null = null;

  const trackJob = (
    jobId: string,
    btn: HTMLButtonElement,
    idleLabel: string,
    verb: string,
    progressEl: HTMLElement,
    onDone: (result: NonNullable<import("./api").JobState["result"]>) => void,
  ) => {
    activeJobId = jobId;
    cancelJobBtn.hidden = false;
    let finished = false; // setInterval(async) can overlap ticks — fire once
    const finish = () => {
      finished = true;
      activeJobId = null;
      cancelJobBtn.hidden = true;
      btn.textContent = idleLabel;
      refreshButtons();
    };
    const poll = window.setInterval(async () => {
      if (finished) {
        window.clearInterval(poll);
        return;
      }
      try {
        const job = await getJob(jobId);
        if (finished) return; // a sibling tick already finished this job (#6)
        if (job.status === "queued" || job.status === "running") {
          const pct = Math.round(job.progress * 100);
          progressEl.textContent = `กำลัง${verb}… ${pct}%`;
          btn.textContent = `กำลัง${verb}… ${pct}%`;
          return;
        }
        window.clearInterval(poll);
        finish();
        if (job.status === "cancelled") {
          progressEl.textContent = `${verb}ถูกยกเลิกแล้ว`;
          return;
        }
        if (job.status === "error" || !job.result) {
          progressEl.textContent = `${verb}ไม่สำเร็จ: ${job.error ?? "ไม่ทราบสาเหตุ"}`;
          return;
        }
        onDone(job.result);
      } catch (err) {
        window.clearInterval(poll);
        finish();
        progressEl.textContent = `ตามสถานะงานไม่ได้: ${String(err)}`;
      }
    }, JOB_POLL_MS);
  };

  cancelJobBtn.addEventListener("click", () => {
    if (activeJobId) void cancelJob(activeJobId);
  });

  transcribeBtn.addEventListener("click", async () => {
    if (!currentPath) return;
    const audioPath = currentPath;
    const gen = loadGeneration;
    transcribeBtn.disabled = true;
    transcriptEl.textContent = "กำลังส่งงานถอดเสียง…";
    try {
      const jobId = await startTranscribe(audioPath);
      trackJob(jobId, transcribeBtn, "ถอดเสียง (ฉบับร่าง)", "ถอดเสียง", transcriptEl, (r) =>
        adoptResult(gen, audioPath, r as TranscribeResult),
      );
    } catch (err) {
      transcriptEl.textContent = `ถอดเสียงไม่สำเร็จ: ${String(err)}`;
      refreshButtons();
    }
  });

  alignScriptBtn.addEventListener("click", async () => {
    if (!currentPath) return;
    const audioPath = currentPath;
    const gen = loadGeneration;
    const scriptPath = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "ไฟล์บท", extensions: ["txt", "docx"] }],
    });
    if (typeof scriptPath !== "string") return;
    alignScriptBtn.disabled = true;
    transcriptEl.textContent = "กำลังตรึงบทกับเสียง…";
    try {
      const jobId = await startAlignScript(audioPath, scriptPath);
      trackJob(jobId, alignScriptBtn, "ตรึงบท (มีบทแล้ว)", "ตรึงบท", transcriptEl, (r) =>
        adoptResult(gen, audioPath, r as TranscribeResult),
      );
    } catch (err) {
      transcriptEl.textContent = `ตรึงบทไม่สำเร็จ: ${String(err)}`;
      refreshButtons();
    }
  });

  // --- export: render EDL to a new WAV (+ optional matching .docx) ---
  // Save the edited script (.docx or .txt) — shared by both export paths.
  const exportScript = async (proj: Project, base: string): Promise<string | null> => {
    const scriptOut = await save({
      defaultPath: `${base}-edited.docx`,
      filters: [
        { name: "Word", extensions: ["docx"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    if (!scriptOut) return null;
    // Markers ride along at the end, under a heading, so the editor can lift
    // them straight onto the cover sheet (ใบปะหน้า) without a second export.
    // exportLines() stays the clean CONTENT — CLAUDE.md's rule that the doc
    // and the audio tell the same story is untouched by an appended section.
    const lines = [...proj.exportLines()];
    if (proj.markers.length > 0) {
      lines.push("", "— จุดที่มาร์กไว้ —", ...markerLines(proj));
    }
    if (scriptOut.toLowerCase().endsWith(".txt")) {
      await writeTextFile(scriptOut, lines.join("\n"));
    } else {
      await exportDocx(scriptOut, lines);
    }
    return scriptOut;
  };

  // "จะ export อะไรบ้าง?" — native <dialog>, resolves both/doc/cancel
  const exportDialog = el<HTMLDialogElement>("#export-dialog");
  const askExportChoice = (): Promise<string> =>
    new Promise((resolve) => {
      exportDialog.returnValue = "cancel";
      const done = () => {
        exportDialog.removeEventListener("close", done);
        resolve(exportDialog.returnValue || "cancel");
      };
      exportDialog.addEventListener("close", done);
      exportDialog.showModal();
    });
  for (const btn of exportDialog.querySelectorAll("button")) {
    btn.addEventListener("click", () => exportDialog.close(btn.value));
  }

  const verifyCheck = el<HTMLInputElement>("#export-verify-check");

  /** Compare the export against the source's KEPT regions and describe the
   * result in one line. This is the check the editors were running in a
   * separate analyser (team feedback 2026-08-20). Never throws: a failed
   * verification must not make a successful export look failed. */
  const verifyLoudness = async (proj: Project, outPath: string): Promise<string> => {
    try {
      const cmp = await compareAudio(
        proj.audioPath,
        outPath,
        proj.edl.map((c) => ({ start: c.start, end: c.end })),
      );
      const rms = cmp.rms_delta_db.toFixed(2);
      const peak = cmp.peak_delta_db.toFixed(2);
      const detail = `RMS ${rms} dB, peak ${peak} dB`;
      if (cmp.unchanged) {
        // Say WHY the peak moved when the source was over full scale, or the
        // editor sees a lower peak in their analyser and doubts the verdict.
        const note = cmp.source_over_full_scale
          ? ` — ต้นฉบับพีคเกินเต็มสเกล (${cmp.source_peak_dbfs_raw.toFixed(2)} dBFS) ` +
            "จึงถูกจำกัดที่ 0 dBFS ตามข้อจำกัดของ PCM ไม่ใช่การบีบอัด"
          : " — ไม่มีการบีบอัดหรือปรับความดัง";
        return `🔎 ตรวจแล้ว: พลังเสียงไม่เปลี่ยน (${detail})${note}`;
      }
      const reasons: string[] = [];
      if (!cmp.sample_rate_match) reasons.push("sample rate ไม่ตรง");
      if (!cmp.channels_match) reasons.push("จำนวนช่องไม่ตรง");
      if (cmp.new_clipping) reasons.push("มีเสียงคลิป (เกินสเกล) ที่ต้นฉบับไม่มี");
      if (Math.abs(cmp.rms_delta_db) > cmp.rms_tolerance_db) reasons.push(`RMS ต่างไป ${rms} dB`);
      if (Math.abs(cmp.peak_delta_db) > cmp.peak_tolerance_db) reasons.push(`peak ต่างไป ${peak} dB`);
      return `⚠️ ตรวจแล้ว: พลังเสียงเปลี่ยน — ${reasons.join(", ")}`;
    } catch (err) {
      return `(ตรวจพลังเสียงไม่สำเร็จ: ${String(err)} — ตัวไฟล์ export สำเร็จแล้ว)`;
    }
  };

  exportBtn.addEventListener("click", async () => {
    if (!project) return;
    const proj = project;
    const base = proj.audioPath.replace(/\.[^.]+$/, "");

    const choice = await askExportChoice();
    if (choice === "cancel") return;

    if (choice === "doc") {
      // Doc-only: no audio render, no rough-timestamp warning (text content
      // doesn't depend on word times — only cut boundaries do).
      try {
        const out = await exportScript(proj, base);
        if (out) fileName.textContent = `✅ Export บทแล้ว: ${out}`;
      } catch (err) {
        fileName.textContent = `Export ไม่สำเร็จ: ${String(err)}`;
      }
      return;
    }

    if (
      proj.transcription.tokens.length > 0 &&
      proj.transcription.timestamps === "rough" &&
      !window.confirm(
        "เวลาคำยังเป็นแบบหยาบ (ยังไม่ผ่าน alignment) — ขอบตัดอาจไม่แม่น ยืนยัน export?",
      )
    ) {
      return;
    }
    const format: ExportFormat = choice === "mp3" ? "mp3" : "wav";
    const extension = format === "mp3" ? "mp3" : "wav";
    const audioPath = await save({
      defaultPath: `${base}-edited.${extension}`,
      filters: [{ name: format.toUpperCase(), extensions: [extension] }],
    });
    if (!audioPath) return;
    const verify = verifyCheck.checked;
    exportBtn.disabled = true;
    try {
      const jobId = await startExportAudio(
        proj.audioPath,
        audioPath,
        proj.edl.map((c) => ({ start: c.start, end: c.end })),
        format,
      );
      trackJob(jobId, exportBtn, "Export", "Export เสียง", fileName, async (result) => {
        const r = result as ExportAudioResult;
        const depth = r.bits === null ? "MP3 192kbps" : `${r.bits}-bit`;
        let message = `✅ Export เสียงแล้ว: ${r.out_path} (${formatTime(r.duration)}, ${depth})`;
        const scriptOut = await exportScript(proj, base);
        if (scriptOut) message += ` + ${scriptOut}`;
        fileName.textContent = message;
        if (verify) {
          fileName.textContent = `${message} — กำลังตรวจพลังเสียง…`;
          fileName.textContent = `${message} · ${await verifyLoudness(proj, r.out_path)}`;
        }
      });
    } catch (err) {
      fileName.textContent = `Export ไม่สำเร็จ: ${String(err)}`;
      refreshButtons();
    }
  });

  // WebKit audio unlock: resume the AudioContext on every user gesture —
  // it can flip back to suspended/interrupted between gestures (FIXES.md #13)
  window.addEventListener("pointerdown", () => player.ensureAudioRunning(), true);
  window.addEventListener("keydown", () => player.ensureAudioRunning(), true);

  // dev-only debug handle (see declaration at file end)
  window.__audioedit = {
    player,
    loadFile: async (url: string) => {
      const blob = await (await fetch(url)).blob();
      await player.loadBlob(new Blob([await blob.arrayBuffer()]));
      return player.duration;
    },
    ctxState: () =>
      (
        (player as unknown as { ws: { getMediaElement(): unknown } }).ws.getMediaElement() as {
          audioContext?: AudioContext;
        }
      ).audioContext?.state,
    time: () => player.currentTime,
    // long-file mode is pure HTTP (no Tauri fs), so it's testable in a browser
    loadPath: (path: string) => loadAudio(path),
  };

  // --- first-run: AI models installer ---
  const modelsBanner = el<HTMLElement>("#models-banner");
  const modelsBannerText = el<HTMLElement>("#models-banner-text");
  const downloadModelsBtn = el<HTMLButtonElement>("#download-models-btn");

  const gpuInfo = el<HTMLElement>("#gpu-info");
  const modelsInfo = el<HTMLElement>("#models-info");
  const modelsInfoText = el<HTMLElement>("#models-info-text");
  const deleteModelsBtn = el<HTMLButtonElement>("#delete-models-btn");

  const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

  const checkModels = async () => {
    const status = await modelsStatus();
    modelsReady = status !== null && status.asr && status.align;
    modelsBanner.hidden = modelsReady || status === null;
    // Say out loud that the models are installed, how big they are, and where
    // — uninstalling the app leaves them behind on purpose (so updates don't
    // re-download 4.4GB) and the team only found that out by accident
    // (feedback 2026-08-20).
    // GPU line: measured 10.4x faster than CPU on an RTX 5060, so the user
    // should be able to see at a glance which one they are getting — and,
    // when they have a card but no add-on, what to do about it.
    const gpu = status?.gpu;
    gpuInfo.hidden = !modelsReady || !gpu;
    if (gpu) {
      if (gpu.device === "cuda") {
        gpuInfo.textContent = "⚡ ใช้การ์ดจอ";
        gpuInfo.className = "gpu-info gpu-on";
        gpuInfo.title =
          "ถอดเสียงด้วยการ์ดจอ เร็วกว่าซีพียูราว 10 เท่า\n" +
          "ครั้งแรกหลังเปิดโปรแกรมจะช้ากว่าปกติ (เตรียมโค้ดให้เข้ากับการ์ด) — หลังจากนั้นเร็วตลอด";
      } else if (gpu.devices > 0 && !gpu.libraries_found) {
        // The actionable case: the hardware is there, the add-on is not.
        gpuInfo.textContent = "🖥️ มีการ์ดจอ แต่ยังไม่ได้เปิดใช้";
        gpuInfo.className = "gpu-info gpu-off";
        gpuInfo.title =
          `พบการ์ดจอ NVIDIA ${gpu.devices} ตัว แต่ยังไม่มีไฟล์เสริม\n` +
          `ก๊อปโฟลเดอร์ "gpu-เสริม" (${gpu.required_dlls.join(", ")}) ` +
          "ไปวางในโฟลเดอร์ที่ติดตั้งโปรแกรม แล้วเปิดใหม่ → ถอดเสียงเร็วขึ้นราว 10 เท่า";
      } else {
        gpuInfo.hidden = true; // no NVIDIA card: nothing useful to say
      }
    }
    modelsInfo.hidden = !modelsReady || status === null;
    if (modelsReady && status) {
      modelsInfoText.textContent = `โมเดล AI ${formatGb(status.modelsBytes)} · ${status.modelsDir}`;
      modelsInfoText.title =
        "โมเดลไม่ถูกลบตอน uninstall แอป (ตั้งใจ — จะได้ไม่ต้องโหลดใหม่ทุกครั้งที่อัปเดต) " +
        `ลบเองได้ด้วยปุ่มนี้\nโฟลเดอร์: ${status.modelsDir}`;
    }
    refreshButtons();
  };

  deleteModelsBtn.addEventListener("click", async () => {
    const status = await modelsStatus();
    const size = status ? formatGb(status.modelsBytes) : "";
    if (
      !window.confirm(
        `ลบโมเดล AI (${size}) ออกจากเครื่อง?\n\n` +
          'หลังลบแล้ว ปุ่ม "ถอดเสียง" และ "ตรึงบท" จะใช้ไม่ได้ ' +
          "จนกว่าจะกดติดตั้งโมเดลใหม่ (ต้องต่อเน็ตและโหลดใหม่ทั้งหมด)\n\n" +
          "งานที่บันทึกไว้ ไฟล์เสียง และการตัดทั้งหมด ไม่ได้รับผลกระทบ",
      )
    ) {
      return;
    }
    deleteModelsBtn.disabled = true;
    try {
      const res = await deleteModels();
      fileName.textContent = res.deleted
        ? `✅ ลบโมเดลแล้ว คืนพื้นที่ ${formatGb(res.freedBytes)}`
        : "ไม่พบโมเดลที่จะลบ";
      await checkModels();
    } catch (err) {
      fileName.textContent = `ลบโมเดลไม่สำเร็จ: ${String(err)}`;
    } finally {
      deleteModelsBtn.disabled = false;
    }
  });

  downloadModelsBtn.addEventListener("click", async () => {
    downloadModelsBtn.disabled = true;
    try {
      const jobId = await startDownloadModels();
      trackJob(
        jobId,
        downloadModelsBtn,
        "ติดตั้งโมเดล",
        "ดาวน์โหลดโมเดล",
        modelsBannerText,
        async () => {
          downloadModelsBtn.disabled = false;
          await checkModels();
        },
      );
    } catch (err) {
      modelsBannerText.textContent = `ดาวน์โหลดไม่สำเร็จ: ${String(err)}`;
      downloadModelsBtn.disabled = false;
    }
  });

  // --- backend status ---
  const statusEl = el<HTMLElement>("#backend-status");
  const statusTextEl = el<HTMLElement>("#backend-status-text");
  const check = async () => {
    const info = await health();
    backendUp = info !== null;
    if (info) {
      statusEl.className = "status status-ok";
      statusTextEl.textContent = `backend: connected (v${info.version})`;
      // Keep polling models until they're ready — a single early check can
      // race the sidecar's boot; latching that stale "missing" left the
      // banner stuck even when models were present (FIXES.md #16). Once
      // ready, models don't vanish, so we stop re-checking. A download in
      // progress owns the banner, so don't fight it.
      if (!modelsReady && activeJobId === null) {
        await checkModels();
      }
    } else {
      statusEl.className = "status status-down";
      statusTextEl.textContent = "backend: not running";
    }
    refreshButtons();
  };
  check();
  setInterval(check, HEALTH_POLL_MS);
}

window.addEventListener("DOMContentLoaded", setup);

// Debug hooks for driving the player outside Tauri (dev diagnosis only).
declare global {
  interface Window {
    __audioedit?: Record<string, unknown>;
  }
}
