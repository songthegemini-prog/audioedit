/** Minimal radix-2 FFT — pure, dependency-free, unit-tested.
 * Powers the visible-window spectrogram (src/audio/spectrogram.ts). */

/** In-place iterative radix-2 FFT. Lengths must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("fft: length must be a power of two");
  }

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return win;
}

/** Windowed power spectrum in dB (size/2 bins). Reusable scratch buffers can
 * be passed to avoid per-column allocation in the render loop. */
export function powerSpectrumDb(
  frame: Float32Array,
  window: Float32Array,
  scratchRe?: Float32Array,
  scratchIm?: Float32Array,
  out?: Float32Array,
): Float32Array {
  const n = window.length;
  const re = scratchRe ?? new Float32Array(n);
  const im = scratchIm ?? new Float32Array(n);
  im.fill(0);
  for (let i = 0; i < n; i++) {
    re[i] = (frame[i] ?? 0) * window[i];
  }
  fft(re, im);
  const bins = out ?? new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    bins[k] = 10 * Math.log10(power + 1e-12);
  }
  return bins;
}
