import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { Cut } from "../project";
import { pcmToWavBlob } from "./wav";

/** Height of the wavesurfer waveform canvas, in CSS px.
 * The WaveformDetail overlay MUST be sized to exactly this and NOT to its
 * container: on Windows the horizontal scrollbar reserves real layout space
 * (~15px, measured) inside #waves, while macOS overlay scrollbars reserve 0.
 * An `inset: 0` overlay therefore grew taller than the waveform on Windows
 * only, and drew the wave centred ~7px low — spilling past the black canvas
 * into the scrollbar strip (FIXES.md #34). */
export const WAVE_HEIGHT = 120;

export const MIN_PX_PER_SEC = 20;
// 48000 px/s ≈ one pixel per sample — the sample-level zoom CLAUDE.md requires
export const MAX_PX_PER_SEC = 48000;
// Long-file mode zoom cap (Phase 9e): the WaveformDetail overlay draws true
// PCM at any zoom, so the only remaining limit is the browser's maximum
// element width (~33M CSS px) for wavesurfer's scroll strip. Budget 25M px:
// 30 min ≈ 13.8k px/s (near sample level), 1 h ≈ 6.9k, 3 h ≈ 2.3k.
export const LONG_MODE_PX_BUDGET = 25_000_000;

const CUT_COLOR = "rgba(248, 81, 73, 0.28)";
const SELECTION_COLOR = "rgba(80, 140, 255, 0.28)";
const SELECTION_ID = "selection";
// Markers live in the same regions plugin as cuts and the selection, so their
// ids MUST be distinguishable: setCutRegions() clears "everything that isn't
// the selection", and cut ids are plain indices ("0", "1", …).
const MARKER_PREFIX = "marker:";
const MARKER_COLOR = "rgba(201, 162, 39, 0.9)";

/** The cut a Ctrl+K preview should audition from playhead `t`: the one `t`
 * sits inside, else the next one starting after it, else (past every cut) the
 * last one — so Ctrl+K at the end of the file still auditions something
 * instead of doing nothing. Null only when there are no cuts at all.
 * Pure, so it's unit-tested. */
export function cutToPreview(cuts: readonly Cut[], t: number): Cut | null {
  if (cuts.length === 0) return null;
  const ordered = [...cuts].sort((a, b) => a.start - b.start);
  const inside = ordered.find((c) => t >= c.start && t < c.end);
  if (inside) return inside;
  return ordered.find((c) => c.start > t) ?? ordered[ordered.length - 1];
}

/** When playback reaches time `t`, the time to jump to so cut audio is
 * skipped — or null if `t` isn't inside any cut. Jumps past the WHOLE run of
 * overlapping/adjacent cuts so no sliver of a merged cut plays for a frame,
 * matching the merged export (Codex #8). Pure, so it's unit-tested. */
export function skipTarget(cuts: readonly Cut[], t: number): number | null {
  const hit = cuts.find((c) => t >= c.start && t < c.end);
  if (!hit) return null;
  let end = hit.end;
  for (;;) {
    const next = cuts.find((c) => end >= c.start && end < c.end);
    if (!next) return end;
    end = next.end;
  }
}

/** Map a 0–100 slider value onto a log scale between MIN and MAX px/sec. */
export function sliderToPxPerSec(value: number): number {
  const clamped = Math.min(100, Math.max(0, value));
  return MIN_PX_PER_SEC * (MAX_PX_PER_SEC / MIN_PX_PER_SEC) ** (clamped / 100);
}

export interface AudioPlayerEvents {
  onReady?: (duration: number) => void;
  onTime?: (currentTime: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** A cut region's edge was dragged on the waveform. */
  onCutRegionUpdated?: (cutIndex: number, start: number, end: number) => void;
  /** The blue selection region's edge was dragged on the waveform. */
  onSelectionRegionUpdated?: (start: number, end: number) => void;
  /** The user drag-created a selection directly on the waveform (no words). */
  onWaveformSelection?: (start: number, end: number) => void;
  /** A marker flag was dragged to a new time. */
  onMarkerMoved?: (markerId: string, time: number) => void;
  /** Visible time window changed (scroll/zoom/load) — drives the spectrogram. */
  onViewport?: (startSec: number, endSec: number) => void;
}

/**
 * Wraps WaveSurfer with a spectrogram rendered in the same scroll container,
 * so waveform and spectrogram always pan/zoom together.
 */
export class AudioPlayer {
  private ws: WaveSurfer;
  private regions: RegionsPlugin;
  private loaded = false;
  private loading = false; // a loadBlob/loadStream we initiated is in flight
  private rangeEnd: number | null = null; // "ฟังช่วงที่เลือก" stop point
  private skipCuts: readonly Cut[] | null = null; // test-cut mode
  // Sound Forge Ctrl+K preview: the ONE span this playback should jump over,
  // independent of skipCuts (which is the persistent "cuts are live" mode).
  private previewSkip: { start: number; end: number } | null = null;
  // Sound Forge "region scope": a locked window the transport stays inside,
  // so plain Space auditions ONLY that span. Survives seeks and cuts until
  // the editor clears it — unlike rangeEnd, which is a one-shot stop.
  private scope: { start: number; end: number } | null = null;
  private loopScope = false;
  private pxPerSec = MIN_PX_PER_SEC;
  private events: AudioPlayerEvents;
  private decoded: AudioBuffer | null = null;
  // Long-file mode draws from precomputed peaks, which have no sample-level
  // detail — cap the zoom there (the spectrogram stays exact via /pcm).
  private maxPxPerSec = MAX_PX_PER_SEC;

  constructor(container: HTMLElement, events: AudioPlayerEvents = {}) {
    this.events = events;
    this.ws = WaveSurfer.create({
      container,
      height: WAVE_HEIGHT,
      waveColor: "#5b8dbb",
      // progress === wave: an editor must NOT paint the played region a
      // different (pale blue) colour — that "progress bar to the cursor"
      // looked like a stuck full-width selection (FIXES.md #18). The white
      // cursor line alone shows the playhead.
      progressColor: "#5b8dbb",
      cursorColor: "#f0f0f0",
      minPxPerSec: MIN_PX_PER_SEC,
      autoScroll: true,
      // scale the waveform to the file's own peak — quiet recordings stay readable
      normalize: true,
      // Playback uses the default media element, fed with a WAV re-encoded
      // from the SAME decoded buffer the display uses (loadBlob below):
      // display/audio stay in sync by construction (FIXES.md #7) without
      // WebKit's unreliable WebAudio playback path (FIXES.md #13).
    });

    // (The wavesurfer Spectrogram plugin is gone — src/audio/spectrogram.ts
    // renders a crisp visible-window spectrogram from onViewport events.)

    this.regions = this.ws.registerPlugin(RegionsPlugin.create());
    // Drag-to-select is implemented BY US, not the plugin's
    // enableDragSelection: its mid-drag math misfires on WKWebView (the
    // packaged app) and ballooned the region to the end of the file on
    // every drag (FIXES.md #18). Same handler pattern as the spectrogram.
    this.initDragSelection();
    this.regions.on("region-updated", (region: Region) => {
      if (region.id === SELECTION_ID) {
        events.onSelectionRegionUpdated?.(region.start, region.end);
        return;
      }
      if (region.id.startsWith(MARKER_PREFIX)) {
        events.onMarkerMoved?.(region.id.slice(MARKER_PREFIX.length), region.start);
        return;
      }
      const cutIndex = Number(region.id);
      if (Number.isInteger(cutIndex)) {
        events.onCutRegionUpdated?.(cutIndex, region.start, region.end);
      }
    });

    this.ws.on("ready", (duration) => {
      // Only a load WE started counts: ws.empty() (used by clear/งานใหม่)
      // also emits "ready", and accepting it would flip the player back to
      // "loaded" with the previous file's duration (FIXES.md #19).
      if (!this.loading) return;
      this.loading = false;
      this.loaded = true;
      events.onReady?.(duration);
      this.emitViewport();
    });
    this.ws.on("scroll", (visibleStart, visibleEnd) => {
      events.onViewport?.(visibleStart, visibleEnd);
    });
    this.ws.on("zoom", (pxPerSec) => {
      this.pxPerSec = pxPerSec;
      // wait one frame so the renderer has applied the new scroll position
      requestAnimationFrame(() => this.emitViewport());
    });
    this.ws.on("timeupdate", (t) => {
      // Ctrl+K preview: jump the one previewed span BEFORE the range-end
      // check, or a preview whose post-roll is short would pause inside the
      // span it is supposed to skip.
      const preview = this.previewSkip;
      if (preview && this.ws.isPlaying() && t >= preview.start && t < preview.end) {
        if (preview.end >= this.duration - 0.02) {
          this.previewSkip = null;
          this.rangeEnd = null;
          this.ws.pause(); // nothing after the cut — don't seek past the end
        } else {
          this.ws.setTime(preview.end);
        }
        return;
      }
      if (this.rangeEnd !== null && t >= this.rangeEnd) {
        this.rangeEnd = null;
        this.previewSkip = null;
        this.ws.pause();
      }
      // Scope boundary. Checked AFTER rangeEnd so a one-shot "ฟังช่วงที่เลือก"
      // inside a scope still stops where it was asked to.
      const scope = this.scope;
      if (scope && this.ws.isPlaying() && t >= scope.end) {
        if (this.loopScope) {
          this.ws.setTime(scope.start);
        } else {
          this.ws.pause();
        }
        return;
      }
      if (this.skipCuts && this.ws.isPlaying()) {
        const skipTo = skipTarget(this.skipCuts, t);
        if (skipTo !== null) {
          const target = skipTo + 0.001;
          if (target >= this.duration - 0.02) {
            // the cut reaches the file end — stop here instead of seeking past
            // the end (which flips the player to "ended" and the next play
            // restarts from zero)
            this.ws.pause();
          } else {
            this.ws.setTime(target);
          }
        }
      }
      events.onTime?.(t);
    });
    this.ws.on("play", () => events.onPlayState?.(true));
    this.ws.on("pause", () => events.onPlayState?.(false));
    this.ws.on("finish", () => events.onPlayState?.(false));
  }

  /** Our own drag-to-select on the waveform (replaces the plugin's
   * enableDragSelection — see the note in the constructor / FIXES.md #18).
   * Times come from ONE formula we control: pointer x as a fraction of the
   * wrapper's width (the wrapper spans the whole file), so a drag can never
   * compute times beyond where the mouse actually is. */
  private initDragSelection(): void {
    const wrapper = this.ws.getWrapper();
    let from: { x: number; time: number; pointerId: number } | null = null;
    let moved = false;

    const timeAt = (clientX: number): number | null => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width <= 0 || this.duration <= 0) return null;
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return frac * this.duration;
    };

    wrapper.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || !this.loaded) return;
      // presses on an existing region (body or resize handle) belong to the
      // plugin's resize logic — only empty-waveform presses start a selection
      if ((e.target as HTMLElement).closest?.('[part*="region"]')) return;
      const time = timeAt(e.clientX);
      if (time === null) return;
      // ALWAYS adopt the new press — if a previous drag's pointerup got lost
      // (multi-touch, focus steal) a stale `from` must not block drags forever
      from = { x: e.clientX, time, pointerId: e.pointerId };
      moved = false;
    });

    window.addEventListener("pointermove", (e: PointerEvent) => {
      if (!from || e.pointerId !== from.pointerId) return;
      if (!moved && Math.abs(e.clientX - from.x) < 3) return; // click, not drag
      moved = true;
      const time = timeAt(e.clientX);
      if (time === null) return;
      // live preview while dragging — same blue canonical selection region
      this.setSelectionRegion(Math.min(from.time, time), Math.max(from.time, time));
    });

    const endDrag = (e: PointerEvent) => {
      if (!from || e.pointerId !== from.pointerId) return;
      const start = from.time;
      const wasDrag = moved;
      from = null;
      moved = false;
      if (!wasDrag) return; // plain click — wavesurfer's click-to-seek handles it
      // a drag must not ALSO seek: swallow the click that follows pointerup
      const swallow = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
      const time = timeAt(e.clientX);
      if (time === null) return;
      const lo = Math.min(start, time);
      const hi = Math.max(start, time);
      if (hi - lo > 0.01) this.events.onWaveformSelection?.(lo, hi);
    };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  /** Reset to the empty state (New project): stop, drop audio, clear regions. */
  clear(): void {
    this.loaded = false;
    this.loading = false;
    this.rangeEnd = null;
    this.previewSkip = null;
    this.scope = null; // a different file — the old scope is meaningless
    this.skipCuts = null;
    this.decoded = null;
    this.regions.clearRegions();
    this.sweepOrphanRegions();
    // ws.empty() alone leaves the previous audio attached to the media
    // element (old duration, old sound) — detach it for real (FIXES.md #19)
    const media = this.ws.getMediaElement();
    media.pause();
    media.removeAttribute("src");
    media.load();
    this.ws.empty();
  }

  async loadBlob(blob: Blob): Promise<void> {
    this.loaded = false;
    this.loading = true;
    this.rangeEnd = null;
    this.previewSkip = null;
    this.scope = null; // a different file — the old scope is meaningless
    this.skipCuts = null;
    this.maxPxPerSec = MAX_PX_PER_SEC;
    this.regions.clearRegions();
    // Decode ONCE; both the display and the playback wav come from this
    // buffer, so they cannot drift apart (m4a codec-delay class of bugs).
    const ctx = new AudioContext();
    try {
      this.decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      void ctx.close();
    }
    await this.ws.loadBlob(pcmToWavBlob(this.decoded));
    // reset zoom so it matches the zoom slider (which main resets to 0)
    this.pxPerSec = MIN_PX_PER_SEC;
    this.ws.zoom(MIN_PX_PER_SEC);
  }

  /** Long-file mode: stream from the backend's canonical WAV over HTTP Range.
   * `peaks` are interleaved min,max pairs computed by the backend from the
   * SAME file the media element plays — display and playback stay same-PCM
   * (FIXES #7/#13) while the frontend never holds the audio in memory. */
  async loadStream(url: string, peaks: Float32Array, duration: number): Promise<void> {
    this.loaded = false;
    this.loading = true;
    this.rangeEnd = null;
    this.previewSkip = null;
    this.scope = null; // a different file — the old scope is meaningless
    this.skipCuts = null;
    this.decoded = null;
    this.maxPxPerSec = Math.min(MAX_PX_PER_SEC, LONG_MODE_PX_BUDGET / duration);
    this.regions.clearRegions();
    // one symmetric display value per bucket — wavesurfer mirrors it
    const display = new Float32Array(peaks.length / 2);
    for (let i = 0; i < display.length; i++) {
      display[i] = Math.max(Math.abs(peaks[2 * i]), Math.abs(peaks[2 * i + 1]));
    }
    // peaks + duration provided → wavesurfer skips its own decode entirely
    await this.ws.load(url, [display], duration);
    this.pxPerSec = MIN_PX_PER_SEC;
    this.ws.zoom(MIN_PX_PER_SEC);
  }

  /** WebKit suspends AudioContexts created before the first user gesture,
   * and wavesurfer's WebAudio player never calls resume() itself — without
   * this, playback is silent and time never advances (FIXES.md #13).
   * WebKit can also report the non-standard "interrupted" state, so resume
   * on anything that isn't "running". Public: main.ts calls it on the first
   * user gesture of the session as a global audio unlock. */
  ensureAudioRunning(): void {
    const media = this.ws.getMediaElement() as unknown as {
      audioContext?: AudioContext;
    };
    const ctx = media?.audioContext;
    if (ctx && ctx.state !== "running") {
      void ctx.resume();
    }
  }

  playPause(): void {
    if (!this.loaded) return;
    this.ensureAudioRunning();
    this.rangeEnd = null; // stale range stops killed normal playback (FIXES.md #11)
    this.previewSkip = null;
    // Starting play from outside a locked scope would immediately run to the
    // scope end and stop, which reads as "Space is broken". Snap in first.
    if (this.scope && !this.ws.isPlaying()) {
      const t = this.ws.getCurrentTime();
      if (t < this.scope.start || t >= this.scope.end) this.ws.setTime(this.scope.start);
    }
    void this.ws.playPause();
  }

  /** Lock playback to [start, end] ("กั้นหน้ากั้นหลัง"); null clears it. */
  setScope(scope: { start: number; end: number } | null): void {
    this.scope = scope;
  }

  /** Loop the locked scope instead of stopping at its end. */
  setLoopScope(loop: boolean): void {
    this.loopScope = loop;
  }

  get scopeRange(): { start: number; end: number } | null {
    return this.scope;
  }

  pause(): void {
    if (this.loaded) this.ws.pause();
  }

  zoom(pxPerSec: number): void {
    if (this.loaded) this.ws.zoom(Math.min(pxPerSec, this.maxPxPerSec));
  }

  /** Scroll the waveform sideways by `pixels` (Shift+wheel pan). */
  panBy(pixels: number): void {
    if (!this.loaded) return;
    this.ws.setScroll(Math.max(0, this.ws.getScroll() + pixels));
  }

  /** Deep-zoom overlay active: hide wavesurfer's own (blocky) bars so only
   * the true-PCM waveform shows. Regions/cursor are DOM and stay visible. */
  setWaveHidden(hidden: boolean): void {
    this.ws.setOptions(
      hidden
        ? { waveColor: "transparent", progressColor: "transparent" }
        : { waveColor: "#5b8dbb", progressColor: "#5b8dbb" },
    );
  }

  private emitViewport(): void {
    if (!this.loaded) return;
    const startSec = this.ws.getScroll() / this.pxPerSec;
    const viewportPx = this.ws.getWrapper().parentElement?.clientWidth ?? 0;
    const endSec = Math.min(startSec + viewportPx / this.pxPerSec, this.duration);
    this.events.onViewport?.(startSec, endSec);
  }

  seekTo(seconds: number): void {
    if (!this.loaded) return;
    this.rangeEnd = null; // a manual seek always cancels the play-range stop
    this.previewSkip = null;
    this.ws.setTime(seconds);
    // The renderer only auto-scrolls while playing — when paused, scroll the
    // viewport ourselves so the cursor is visible (with 1s of lead-in context).
    if (!this.ws.isPlaying()) {
      this.ws.setScrollTime(Math.max(0, seconds - 1));
    }
  }

  /** Seek and start playing — clicking a word should be audible immediately. */
  playFrom(seconds: number): void {
    if (!this.loaded) return;
    this.ensureAudioRunning();
    this.rangeEnd = null;
    this.previewSkip = null;
    this.seekTo(seconds);
    if (!this.ws.isPlaying()) void this.ws.play();
  }

  /** Play [start, end] then pause ("ฟังช่วงที่เลือก"). */
  playRange(start: number, end: number): void {
    if (!this.loaded) return;
    this.ensureAudioRunning();
    this.seekTo(start); // clears any stale rangeEnd — set ours after
    this.rangeEnd = end;
    if (!this.ws.isPlaying()) void this.ws.play();
  }

  /** Test-cut mode: playback skips these regions. Pass null to hear the original. */
  setSkipCuts(cuts: readonly Cut[] | null): void {
    this.skipCuts = cuts;
  }

  /** Sound Forge's Ctrl+K "preview cut": play `preRoll` seconds of lead-in,
   * jump over [start, end], then play `postRoll` seconds of the audio that
   * follows — so the editor hears exactly how the join will sound BEFORE
   * committing the cut. Nothing is modified; this is playback only. */
  previewCut(start: number, end: number, preRoll: number, postRoll: number): void {
    if (!this.loaded) return;
    this.ensureAudioRunning();
    this.seekTo(Math.max(0, start - preRoll)); // clears rangeEnd/previewSkip
    this.previewSkip = { start, end };
    this.rangeEnd = Math.min(this.duration, end + postRoll);
    if (!this.ws.isPlaying()) void this.ws.play();
  }

  /** The regions plugin appends a drag-created region's element to the DOM at
   * drag START but only registers it in its tracked list on a clean drag END.
   * If the end never fires (a second trackpad touch mid-drag, focus loss, …)
   * that element is orphaned: it stays visible forever and no clearRegions()
   * can reach it — seen as a stuck blue bar across the file (FIXES.md #18).
   * Sweep the container and drop any region element we don't know about. */
  private sweepOrphanRegions(): void {
    const container = (
      this.regions as unknown as { regionsContainer?: HTMLElement }
    ).regionsContainer;
    if (!container) return;
    const live = new Set(
      this.regions.getRegions().map((r) => (r as unknown as { element?: Element }).element),
    );
    for (const child of [...container.children]) {
      if (!live.has(child)) child.remove();
    }
  }

  /** Red, edge-draggable regions for every cut in the EDL (id = cut index). */
  setCutRegions(cuts: readonly Cut[]): void {
    if (!this.loaded) return;
    for (const region of [...this.regions.getRegions()]) {
      if (region.id !== SELECTION_ID && !region.id.startsWith(MARKER_PREFIX)) region.remove();
    }
    this.sweepOrphanRegions();
    cuts.forEach((cut, i) => {
      this.regions.addRegion({
        id: String(i),
        start: cut.start,
        end: cut.end,
        color: CUT_COLOR,
        drag: false,
        resize: true,
      });
    });
  }

  /** Draw the project's markers as draggable flags on the waveform. */
  setMarkerRegions(markers: readonly { id: string; time: number }[]): void {
    if (!this.loaded) return;
    for (const region of [...this.regions.getRegions()]) {
      if (region.id.startsWith(MARKER_PREFIX)) region.remove();
    }
    for (const marker of markers) {
      this.regions.addRegion({
        id: `${MARKER_PREFIX}${marker.id}`,
        start: marker.time, // zero-width: the plugin renders it as a flag
        color: MARKER_COLOR,
        drag: true,
        resize: false,
      });
    }
  }

  /** Blue candidate-selection region (not in the EDL until the user cuts).
   * Edges are user-draggable so the exact cut bounds can be fine-tuned. */
  setSelectionRegion(start: number, end: number): void {
    if (!this.loaded) return;
    this.clearSelectionRegion();
    this.regions.addRegion({
      id: SELECTION_ID,
      start,
      end,
      color: SELECTION_COLOR,
      drag: false,
      resize: true,
    });
  }

  clearSelectionRegion(): void {
    for (const region of [...this.regions.getRegions()]) {
      if (region.id === SELECTION_ID) region.remove();
    }
    this.sweepOrphanRegions();
  }

  /** Decoded mono samples for snap/spectrogram (channel 0 of OUR buffer). */
  samples(): { data: Float32Array; sampleRate: number } | null {
    if (!this.decoded) return null;
    return { data: this.decoded.getChannelData(0), sampleRate: this.decoded.sampleRate };
  }

  /** Current horizontal zoom. Sound Forge's arrow keys move by one screen
   * pixel, so the step scales with zoom: coarse when zoomed out, sample-fine
   * when zoomed in. Exposed so main.ts can do the same. */
  get pixelsPerSecond(): number {
    return this.pxPerSec;
  }

  get duration(): number {
    return this.ws.getDuration();
  }

  get currentTime(): number {
    return this.ws.getCurrentTime();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  destroy(): void {
    this.ws.destroy();
  }
}
