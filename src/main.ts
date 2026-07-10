import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import {
  audioFileUrl,
  audioInfo,
  cancelJob,
  exportDocx,
  fetchPcmWindow,
  fetchPeaks,
  getJob,
  health,
  modelsStatus,
  realign,
  startAlignScript,
  startDownloadModels,
  startExportAudio,
  startPrepareAudio,
  startTranscribe,
} from "./api";
import type { AudioInfo, ExportAudioResult, TranscribeResult } from "./api";
import { AudioPlayer, sliderToPxPerSec } from "./audio/player";
import { MemorySamples, RemoteSamples, snapWithProvider } from "./audio/samples";
import type { SampleProvider } from "./audio/samples";
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
  const cancelJobBtn = el<HTMLButtonElement>("#cancel-job-btn");
  const reviewCountEl = el<HTMLElement>("#review-count");
  const hideFillersBtn = el<HTMLButtonElement>("#hide-fillers-btn");
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
      const seg = project.transcription.segments[segIndex];
      try {
        const res = await realign(currentPath, text, seg.start, seg.end);
        project.replaceSegment(segIndex, res.text, res.tokens);
        transcript.render(project);
        afterEdlChange();
        updateReviewCount();
        runSearch(false);
      } catch (err) {
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
    // The bounds are exactly what the blue region shows — snapped, or as the
    // user dragged them (user adjustments are respected, never re-snapped).
    const { start, end } = selectionBounds;
    if (end - start < 0.01) return; // nothing meaningful to cut
    // token range: the words selected, else whichever words the time range covers
    let tokenRange: [number, number] | null = selection;
    if (!tokenRange) {
      const tokens = project.transcription.tokens;
      const covered = tokens
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.start >= start - 0.005 && t.end <= end + 0.005);
      tokenRange = covered.length
        ? [covered[0].i, covered[covered.length - 1].i]
        : null;
    }
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
    timeDisplay.textContent = `${formatTime(current)} / ${formatTime(player.duration)}`;
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
    exportBtn.disabled = !hasProject || !backendUp;
    saveBtn.disabled = !hasProject;
    saveAsBtn.disabled = !hasProject;
    hideFillersBtn.disabled = !hasProject;
    searchInput.disabled = !hasProject;
    if (!hasProject) {
      searchInput.value = "";
      searchCount.textContent = "";
      searchPrev.disabled = searchNext.disabled = true;
      matches = [];
      matchIndex = 0;
    }
  };

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
    onViewport: (start, end) => spectrogram.setViewport(start, end),
  });

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

  // งานใหม่: clear everything back to the empty state.
  const newProject = () => {
    if (project?.dirty && !window.confirm("มีการแก้ที่ยังไม่ได้บันทึก เริ่มงานใหม่เลยไหม?")) {
      return;
    }
    project = null;
    currentPath = null;
    selection = null;
    setSelectionBounds(null);
    player.clear();
    sampleProvider = null;
    spectrogram.setProvider(null);
    spectrogram.setOverlays([], null);
    playBtn.disabled = true;
    zoomSlider.disabled = true;
    zoomSlider.value = "0";
    transcript.clear();
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

  hideFillersBtn.addEventListener("click", () => {
    if (!project) return;
    project.excludeAllFillers();
    transcript.refreshAll();
    updateDirty();
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey ? project?.redo() : project?.undo()) afterEdlChange();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      // Sound Forge muscle memory: Shift+Space auditions the selection
      if (e.shiftKey && selectionBounds) {
        player.playRange(selectionBounds.start, selectionBounds.end);
      } else {
        player.playPause();
      }
    }
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
    if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      cutSelection();
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
  el(".waves-scroll").addEventListener(
    "wheel",
    (e) => {
      const we = e as WheelEvent;
      if (!we.ctrlKey && !we.metaKey) return;
      we.preventDefault();
      if (!player.isLoaded) return;
      zoomSlider.value = String(Number(zoomSlider.value) + (we.deltaY < 0 ? 4 : -4));
      applyZoom();
    },
    { passive: false },
  );

  // --- transcription + script alignment (share one job-tracking path) ---
  const adoptResult = (audioPath: string, result: TranscribeResult) => {
    // carry rough pre-transcription cuts (as pure time cuts) forward
    const carriedCuts = project && project.audioPath === audioPath ? [...project.edl] : [];
    project = new Project(audioPath, result);
    for (const cut of carriedCuts) {
      project.addCut({ ...cut, tokenRange: null });
    }
    reviewCursor = -1;
    transcript.render(project);
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
    const finish = () => {
      activeJobId = null;
      cancelJobBtn.hidden = true;
      btn.textContent = idleLabel;
      refreshButtons();
    };
    const poll = window.setInterval(async () => {
      try {
        const job = await getJob(jobId);
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
    transcribeBtn.disabled = true;
    transcriptEl.textContent = "กำลังส่งงานถอดเสียง…";
    try {
      const jobId = await startTranscribe(audioPath);
      trackJob(jobId, transcribeBtn, "ถอดเสียง (ฉบับร่าง)", "ถอดเสียง", transcriptEl, (r) =>
        adoptResult(audioPath, r as TranscribeResult),
      );
    } catch (err) {
      transcriptEl.textContent = `ถอดเสียงไม่สำเร็จ: ${String(err)}`;
      refreshButtons();
    }
  });

  alignScriptBtn.addEventListener("click", async () => {
    if (!currentPath) return;
    const audioPath = currentPath;
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
        adoptResult(audioPath, r as TranscribeResult),
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
    if (scriptOut.toLowerCase().endsWith(".txt")) {
      await writeTextFile(scriptOut, proj.exportLines().join("\n"));
    } else {
      await exportDocx(scriptOut, proj.exportLines());
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
    const wavPath = await save({
      defaultPath: `${base}-edited.wav`,
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    if (!wavPath) return;
    exportBtn.disabled = true;
    try {
      const jobId = await startExportAudio(
        proj.audioPath,
        wavPath,
        proj.edl.map((c) => ({ start: c.start, end: c.end })),
      );
      trackJob(jobId, exportBtn, "Export", "Export เสียง", fileName, async (result) => {
        const r = result as ExportAudioResult;
        let message = `✅ Export เสียงแล้ว: ${r.out_path} (${formatTime(r.duration)})`;
        const scriptOut = await exportScript(proj, base);
        if (scriptOut) message += ` + ${scriptOut}`;
        fileName.textContent = message;
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

  const checkModels = async () => {
    const status = await modelsStatus();
    modelsReady = status !== null && status.asr && status.align;
    modelsBanner.hidden = modelsReady || status === null;
    refreshButtons();
  };

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
