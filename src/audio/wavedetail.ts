/** Deep-zoom waveform for long-file mode (Phase 9e).
 *
 * Long files draw their waveform from precomputed peaks (~23ms buckets),
 * which turns blocky once you zoom past that resolution. This overlay sits
 * on TOP of the wavesurfer canvas (pointer-events: none, transparent
 * background) and, while the viewport fits inside one fetchable PCM window,
 * draws true min/max-per-pixel audio from the same SampleProvider the
 * spectrogram uses. main.ts hides wavesurfer's own bars while the overlay
 * is active, so regions/cursor (DOM elements) stay visible and draggable.
 * Short files never activate it — their wavesurfer view is already exact.
 */

import type { SampleProvider, SampleWindow } from "./samples";

const WAVE_COLOR = "#8ab4f8"; // matches the app's progress-side waveform blue
const CENTER_LINE = "rgba(138, 180, 248, 0.35)";

/** min/max per pixel column, relative to a window that starts at
 * dataStartSec. Columns outside the data keep NaN (drawn as nothing). */
export function minMaxColumns(
  data: Float32Array,
  dataStartSec: number,
  sampleRate: number,
  viewStart: number,
  viewEnd: number,
  width: number,
): Float32Array {
  const out = new Float32Array(width * 2).fill(Number.NaN);
  const span = viewEnd - viewStart;
  if (span <= 0 || width <= 0 || data.length === 0) return out;
  for (let x = 0; x < width; x++) {
    const t0 = viewStart + (x / width) * span;
    const t1 = viewStart + ((x + 1) / width) * span;
    let from = Math.floor((t0 - dataStartSec) * sampleRate);
    let to = Math.ceil((t1 - dataStartSec) * sampleRate);
    from = Math.max(0, from);
    to = Math.min(data.length, Math.max(to, from + 1));
    if (from >= data.length || to <= from) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[x * 2] = lo;
    out[x * 2 + 1] = hi;
  }
  return out;
}

export class WaveformDetail {
  private provider: SampleProvider | null = null;
  private window: SampleWindow | null = null;
  private fetchGen = 0;
  private viewStart = 0;
  private viewEnd = 0;
  private active = false;
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private onActiveChange: (active: boolean) => void,
  ) {
    // the canvas tracks the window size — redraw when it changes
    window.addEventListener("resize", () => this.requestRender());
  }

  /** Only RemoteSamples providers activate the overlay — pass null for
   * short in-memory files so this stays completely inert. */
  setProvider(provider: SampleProvider | null): void {
    this.provider = provider;
    this.window = null;
    this.fetchGen++;
    this.requestRender();
  }

  setViewport(startSec: number, endSec: number): void {
    if (startSec === this.viewStart && endSec === this.viewEnd) return;
    this.viewStart = startSec;
    this.viewEnd = endSec;
    this.requestRender();
  }

  private setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.onActiveChange(active);
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
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const provider = this.provider;
    const span = this.viewEnd - this.viewStart;
    if (!provider || span <= 0 || span > provider.maxWindowSec) {
      this.setActive(false);
      return;
    }
    if (!this.ensureWindow()) return; // fetching — stay in current state
    this.setActive(true);

    const win = this.window!;
    const cols = minMaxColumns(
      win.data,
      win.startSec,
      win.sampleRate,
      this.viewStart,
      this.viewEnd,
      width,
    );
    // normalize like wavesurfer (normalize: true): scale to the loudest
    // visible sample so quiet passages stay readable
    let peak = 0;
    for (let i = 0; i < cols.length; i++) {
      const a = Math.abs(cols[i]);
      if (!Number.isNaN(a) && a > peak) peak = a;
    }
    const scale = peak > 0 ? 1 / peak : 1;
    const mid = height / 2;

    ctx.strokeStyle = CENTER_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    ctx.fillStyle = WAVE_COLOR;
    for (let x = 0; x < width; x++) {
      const lo = cols[x * 2];
      const hi = cols[x * 2 + 1];
      if (Number.isNaN(lo)) continue;
      const y1 = mid - hi * scale * (mid - 1);
      const y2 = mid - lo * scale * (mid - 1);
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  /** Same gating pattern as SpectrogramView.ensureWindow. */
  private ensureWindow(): boolean {
    const provider = this.provider!;
    const needFrom = Math.max(0, this.viewStart);
    const needTo = Math.min(provider.durationSec, this.viewEnd);
    const w = this.window;
    if (
      w &&
      w.startSec <= needFrom + 1e-6 &&
      w.startSec + w.data.length / w.sampleRate >= needTo - 1e-6
    ) {
      return true;
    }
    const gen = ++this.fetchGen;
    void provider.getWindow(needFrom, needTo).then(
      (win) => {
        if (gen !== this.fetchGen) return;
        this.window = win;
        this.requestRender();
      },
      () => undefined,
    );
    return false;
  }
}
