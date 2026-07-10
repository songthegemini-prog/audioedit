import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { Cut } from "../project";
import { pcmToWavBlob } from "./wav";

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
  private rangeEnd: number | null = null; // "ฟังช่วงที่เลือก" stop point
  private skipCuts: readonly Cut[] | null = null; // test-cut mode
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
      height: 120,
      waveColor: "#5b8dbb",
      progressColor: "#8ab4f8",
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
    this.regions.enableDragSelection({ color: SELECTION_COLOR });
    this.regions.on("region-created", (region: Region) => {
      // addRegion() also fires this — only adopt regions born from dragging
      const isOurs = region.id === SELECTION_ID || /^\d+$/.test(region.id);
      if (isOurs) return;
      events.onWaveformSelection?.(region.start, region.end);
      region.remove(); // main re-adds it as the canonical selection region
    });
    this.regions.on("region-updated", (region: Region) => {
      if (region.id === SELECTION_ID) {
        events.onSelectionRegionUpdated?.(region.start, region.end);
        return;
      }
      const cutIndex = Number(region.id);
      if (Number.isInteger(cutIndex)) {
        events.onCutRegionUpdated?.(cutIndex, region.start, region.end);
      }
    });

    this.ws.on("ready", (duration) => {
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
      if (this.rangeEnd !== null && t >= this.rangeEnd) {
        this.rangeEnd = null;
        this.ws.pause();
      }
      if (this.skipCuts && this.ws.isPlaying()) {
        const hit = this.skipCuts.find((c) => t >= c.start && t < c.end);
        if (hit) {
          const target = hit.end + 0.001;
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

  /** Reset to the empty state (New project): stop, drop audio, clear regions. */
  clear(): void {
    this.loaded = false;
    this.rangeEnd = null;
    this.skipCuts = null;
    this.decoded = null;
    this.regions.clearRegions();
    this.ws.empty();
  }

  async loadBlob(blob: Blob): Promise<void> {
    this.loaded = false;
    this.rangeEnd = null;
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
    this.rangeEnd = null;
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
    void this.ws.playPause();
  }

  pause(): void {
    if (this.loaded) this.ws.pause();
  }

  zoom(pxPerSec: number): void {
    if (this.loaded) this.ws.zoom(Math.min(pxPerSec, this.maxPxPerSec));
  }

  /** Deep-zoom overlay active: hide wavesurfer's own (blocky) bars so only
   * the true-PCM waveform shows. Regions/cursor are DOM and stay visible. */
  setWaveHidden(hidden: boolean): void {
    this.ws.setOptions(
      hidden
        ? { waveColor: "transparent", progressColor: "transparent" }
        : { waveColor: "#5b8dbb", progressColor: "#8ab4f8" },
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

  /** Red, edge-draggable regions for every cut in the EDL (id = cut index). */
  setCutRegions(cuts: readonly Cut[]): void {
    if (!this.loaded) return;
    for (const region of [...this.regions.getRegions()]) {
      if (region.id !== SELECTION_ID) region.remove();
    }
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
  }

  /** Decoded mono samples for snap/spectrogram (channel 0 of OUR buffer). */
  samples(): { data: Float32Array; sampleRate: number } | null {
    if (!this.decoded) return null;
    return { data: this.decoded.getChannelData(0), sampleRate: this.decoded.sampleRate };
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
