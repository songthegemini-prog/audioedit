/** Custom visible-window spectrogram (replaces the wavesurfer plugin).
 *
 * The old plugin computed one FFT pass for the whole file and stretched the
 * bitmap when zooming — blurry at depth and slow to load (FIXES.md #2).
 * This renderer computes exactly one FFT column per visible pixel, every time
 * the viewport changes, so it is crisp at every zoom level and starts
 * instantly. Cut/selection overlays share the same time axis and their edges
 * are draggable — both views edit the same EDL entry (CLAUDE.md rule). */

import type { Cut } from "../project";
import { hannWindow, powerSpectrumDb } from "./fft";

const F_MIN = 60; // Hz, bottom of the log-frequency axis
const DB_RANGE = 70; // dynamic range below the loudest visible bin
const EDGE_HIT_PX = 6;
const CUT_FILL = "rgba(248, 81, 73, 0.30)";
const CUT_EDGE = "#f85149";
const SEL_FILL = "rgba(80, 140, 255, 0.30)";
const SEL_EDGE = "#4a90d9";

// ---- pure helpers (unit-tested) ----

/** Analysis window: at least 2x the hop for continuity, clamped 256..4096. */
export function chooseFftSize(hopSamples: number): number {
  let size = 256;
  while (size < hopSamples * 2 && size < 4096) size <<= 1;
  return size;
}

/** Map a canvas row (0 = top) to an FFT bin on a log-frequency axis. */
export function rowToBin(
  row: number,
  rows: number,
  fftSize: number,
  sampleRate: number,
): number {
  const fMax = sampleRate / 2;
  const frac = 1 - row / Math.max(rows - 1, 1); // top row = fMax
  const freq = F_MIN * (fMax / F_MIN) ** frac;
  return Math.min(fftSize / 2 - 1, Math.max(0, Math.round((freq / fMax) * (fftSize / 2))));
}

/** 256-entry RGB lookup table (magma-like). */
export function buildColormap(): Uint8ClampedArray {
  const anchors = [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * (anchors.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, anchors.length - 1);
    const t = pos - lo;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = anchors[lo][c] * (1 - t) + anchors[hi][c] * t;
    }
  }
  return lut;
}

// ---- renderer ----

export interface SpectrogramCallbacks {
  onSeek: (timeSec: number) => void;
  /** Fired ONCE on drag release with the cut's final bounds. */
  onCutEdge: (cutIndex: number, start: number, end: number) => void;
  /** Fired ONCE on drag release with the selection's final bounds. */
  onSelectionEdge: (start: number, end: number) => void;
}

type DragTarget =
  | { kind: "cut"; index: number; edge: "start" | "end" }
  | { kind: "sel"; edge: "start" | "end" };

export class SpectrogramView {
  private samples: Float32Array | null = null;
  private sampleRate = 16000;
  private viewStart = 0;
  private viewEnd = 0;
  private cuts: readonly Cut[] = [];
  private selection: { start: number; end: number } | null = null;

  private lut = buildColormap();
  private windowCache = new Map<number, Float32Array>();
  private base: ImageData | null = null;
  private baseDirty = true;
  private raf = 0;

  private drag: DragTarget | null = null;
  private dragPreview: { start: number; end: number } | null = null;
  private downX = -1;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: SpectrogramCallbacks,
  ) {
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
  }

  setAudio(samples: Float32Array | null, sampleRate: number): void {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.invalidateBase();
  }

  setViewport(startSec: number, endSec: number): void {
    if (startSec === this.viewStart && endSec === this.viewEnd) return;
    this.viewStart = startSec;
    this.viewEnd = endSec;
    this.invalidateBase();
  }

  setOverlays(cuts: readonly Cut[], selection: { start: number; end: number } | null): void {
    this.cuts = cuts;
    this.selection = selection;
    this.requestRender(); // overlays only — the cached base image is reused
  }

  private invalidateBase(): void {
    this.baseDirty = true;
    this.requestRender();
  }

  private requestRender(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.baseDirty = true;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    if (this.baseDirty) {
      this.base = this.computeBase(width, height);
      this.baseDirty = false;
    }
    if (this.base) {
      ctx.putImageData(this.base, 0, 0);
    } else {
      ctx.fillStyle = "#101014";
      ctx.fillRect(0, 0, width, height);
    }
    this.drawOverlays(ctx, width, height);
  }

  private computeBase(width: number, height: number): ImageData | null {
    const samples = this.samples;
    const span = this.viewEnd - this.viewStart;
    if (!samples || span <= 0) return null;

    const sr = this.sampleRate;
    const hop = (span * sr) / width;
    const fftSize = chooseFftSize(hop);
    let win = this.windowCache.get(fftSize);
    if (!win) {
      win = hannWindow(fftSize);
      this.windowCache.set(fftSize, win);
    }

    const bins = fftSize / 2;
    const columns = new Float32Array(width * bins);
    const frame = new Float32Array(fftSize);
    const scratchRe = new Float32Array(fftSize);
    const scratchIm = new Float32Array(fftSize);
    const colBuf = new Float32Array(bins);
    let maxDb = -Infinity;

    for (let x = 0; x < width; x++) {
      const centerSec = this.viewStart + ((x + 0.5) / width) * span;
      const from = Math.round(centerSec * sr) - fftSize / 2;
      frame.fill(0);
      const copyFrom = Math.max(0, from);
      const copyTo = Math.min(samples.length, from + fftSize);
      if (copyTo > copyFrom) {
        frame.set(samples.subarray(copyFrom, copyTo), copyFrom - from);
      }
      const col = powerSpectrumDb(frame, win, scratchRe, scratchIm, colBuf);
      for (let k = 0; k < bins; k++) {
        const db = col[k];
        columns[x * bins + k] = db;
        if (db > maxDb) maxDb = db;
      }
    }

    const rowBin = new Int32Array(height);
    for (let row = 0; row < height; row++) {
      rowBin[row] = rowToBin(row, height, fftSize, sr);
    }

    const image = new ImageData(width, height);
    const floor = maxDb - DB_RANGE;
    for (let row = 0; row < height; row++) {
      const bin = rowBin[row];
      for (let x = 0; x < width; x++) {
        const db = columns[x * bins + bin];
        const v = Math.max(0, Math.min(255, Math.round(((db - floor) / DB_RANGE) * 255)));
        const px = (row * width + x) * 4;
        image.data[px] = this.lut[v * 3];
        image.data[px + 1] = this.lut[v * 3 + 1];
        image.data[px + 2] = this.lut[v * 3 + 2];
        image.data[px + 3] = 255;
      }
    }
    return image;
  }

  // ---- overlays + interaction ----

  private timeToX(sec: number): number {
    return ((sec - this.viewStart) / (this.viewEnd - this.viewStart)) * this.canvas.clientWidth;
  }

  private xToTime(x: number): number {
    return this.viewStart + (x / this.canvas.clientWidth) * (this.viewEnd - this.viewStart);
  }

  private overlayRects(): { start: number; end: number; kind: "cut" | "sel"; index: number }[] {
    const rects: { start: number; end: number; kind: "cut" | "sel"; index: number }[] =
      this.cuts.map((c, index) => {
      const preview =
        this.drag?.kind === "cut" && this.drag.index === index ? this.dragPreview : null;
        return { start: preview?.start ?? c.start, end: preview?.end ?? c.end, kind: "cut" as const, index };
      });
    if (this.selection) {
      const preview = this.drag?.kind === "sel" ? this.dragPreview : null;
      rects.push({
        start: preview?.start ?? this.selection.start,
        end: preview?.end ?? this.selection.end,
        kind: "sel",
        index: -1,
      });
    }
    return rects;
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    for (const rect of this.overlayRects()) {
      const x1 = this.timeToX(rect.start);
      const x2 = this.timeToX(rect.end);
      if (x2 < 0 || x1 > width) continue;
      ctx.fillStyle = rect.kind === "cut" ? CUT_FILL : SEL_FILL;
      ctx.fillRect(x1, 0, x2 - x1, height);
      ctx.strokeStyle = rect.kind === "cut" ? CUT_EDGE : SEL_EDGE;
      ctx.lineWidth = 2;
      for (const x of [x1, x2]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }
  }

  private hitTestEdge(x: number): DragTarget | null {
    // selection edges win over cut edges when overlapping
    if (this.selection) {
      if (Math.abs(x - this.timeToX(this.selection.start)) <= EDGE_HIT_PX) {
        return { kind: "sel", edge: "start" };
      }
      if (Math.abs(x - this.timeToX(this.selection.end)) <= EDGE_HIT_PX) {
        return { kind: "sel", edge: "end" };
      }
    }
    for (let i = 0; i < this.cuts.length; i++) {
      if (Math.abs(x - this.timeToX(this.cuts[i].start)) <= EDGE_HIT_PX) {
        return { kind: "cut", index: i, edge: "start" };
      }
      if (Math.abs(x - this.timeToX(this.cuts[i].end)) <= EDGE_HIT_PX) {
        return { kind: "cut", index: i, edge: "end" };
      }
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    const x = e.offsetX;
    this.downX = x;
    const target = this.hitTestEdge(x);
    if (target) {
      this.drag = target;
      const bounds =
        target.kind === "sel" ? this.selection! : this.cuts[target.index];
      this.dragPreview = { start: bounds.start, end: bounds.end };
      this.canvas.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || !this.dragPreview) {
      this.canvas.style.cursor = this.hitTestEdge(e.offsetX) ? "ew-resize" : "default";
      return;
    }
    const t = Math.max(this.viewStart, Math.min(this.viewEnd, this.xToTime(e.offsetX)));
    if (this.drag.edge === "start") {
      this.dragPreview.start = Math.min(t, this.dragPreview.end - 0.001);
    } else {
      this.dragPreview.end = Math.max(t, this.dragPreview.start + 0.001);
    }
    this.requestRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && this.dragPreview) {
      const { start, end } = this.dragPreview;
      const drag = this.drag;
      this.drag = null;
      this.dragPreview = null;
      if (drag.kind === "cut") {
        this.cb.onCutEdge(drag.index, start, end);
      } else {
        this.cb.onSelectionEdge(start, end);
      }
      return;
    }
    // plain click (no drag) = seek
    if (Math.abs(e.offsetX - this.downX) <= 3) {
      this.cb.onSeek(this.xToTime(e.offsetX));
    }
    this.drag = null;
    this.dragPreview = null;
  }
}
