"""Broadcast-standard loudness: LUFS (ITU-R BS.1770-4) and true peak.

Why this exists (team question 2026-08-23): the editors do not edit in iZotope
RX or SpectraLayers -- they only MEASURE there. So our numbers have to be
comparable with theirs, and plain RMS is not: RX's headline figures are
K-weighted loudness in LUFS and an oversampled true peak, both of which read
differently from the unweighted sample-domain numbers in analyze.py.

Two things this module gets right that a naive implementation does not:

1. **No scipy.** An IIR biquad is a sequential recursion, and a Python-level
   loop over an hour of 44.1kHz audio (158M samples) is hopeless. Instead the
   cascaded K-weighting filter is converted ONCE into an impulse response
   (a short 8192-step recursion) and then applied by overlap-add convolution,
   which numpy does at C speed. Verified against the direct recursion.

2. **Filters are redesigned for the file's own sample rate.** BS.1770 tabulates
   coefficients at 48kHz only. Using those numbers at 44.1kHz -- which is what
   the team's mp3 sources actually are -- shifts both filter corners and biases
   the result. The analog prototype is re-warped per rate instead.

Everything is streaming: blocks go in, state is carried, memory is constant.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

# BS.1770-4 gating. A 400ms window stepped by 100ms (75% overlap), an absolute
# gate at -70 LUFS to drop silence, then a relative gate 10 LU below the
# ungated mean so that quiet passages do not drag a programme's figure down.
BLOCK_SEC = 0.400
STEP_SEC = 0.100
ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = -10.0

# The -0.691 dB offset in BS.1770 that makes a 0 dBFS 1kHz sine read 0 LUFS.
LOUDNESS_OFFSET = -0.691

# Taps for the K-weighting impulse response. The RLB high-pass (38Hz, Q~0.5)
# is the slow part: its envelope decays with tau = Q/(pi*f0) ~ 4.2ms, so 8192
# taps is over 170ms at 48kHz -- far below the precision anyone reads off
# a meter.
IR_TAPS = 8192

# BS.1770 requires at least 4x oversampling to estimate the true peak.
TRUE_PEAK_OVERSAMPLE = 4
TRUE_PEAK_TAPS_PER_PHASE = 24

SILENCE_FLOOR_LUFS = -144.0


def _shelf_biquad(sample_rate: int) -> tuple[list[float], list[float]]:
    """Stage 1 of K-weighting: the ~+4dB high shelf standing in for the head.

    Constants are the analog prototype from BS.1770-4, bilinear-transformed at
    `sample_rate` rather than assuming 48kHz.
    """
    f0 = 1681.974450955533
    gain_db = 3.999843853973347
    q = 0.7071752369554196

    k = math.tan(math.pi * f0 / sample_rate)
    vh = 10.0 ** (gain_db / 20.0)
    vb = vh**0.4996667741545416

    denom = 1.0 + k / q + k * k
    b = [
        (vh + vb * k / q + k * k) / denom,
        2.0 * (k * k - vh) / denom,
        (vh - vb * k / q + k * k) / denom,
    ]
    a = [1.0, 2.0 * (k * k - 1.0) / denom, (1.0 - k / q + k * k) / denom]
    return b, a


def _highpass_biquad(sample_rate: int) -> tuple[list[float], list[float]]:
    """Stage 2 of K-weighting: the RLB high-pass that discards rumble."""
    f0 = 38.13547087602444
    q = 0.5003270373238773

    k = math.tan(math.pi * f0 / sample_rate)
    denom = 1.0 + k / q + k * k
    b = [1.0, -2.0, 1.0]
    a = [1.0, 2.0 * (k * k - 1.0) / denom, (1.0 - k / q + k * k) / denom]
    return b, a


def _biquad_impulse(b: list[float], a: list[float], taps: int) -> np.ndarray:
    """Impulse response of one biquad, by direct recursion.

    Only `taps` iterations, once per file -- the cost that matters is the
    per-sample filtering, which happens by convolution afterwards.
    """
    out = np.zeros(taps, dtype=np.float64)
    x1 = x2 = y1 = y2 = 0.0
    for n in range(taps):
        x0 = 1.0 if n == 0 else 0.0
        y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        out[n] = y0
        x2, x1 = x1, x0
        y2, y1 = y1, y0
    return out


def k_weighting_impulse(sample_rate: int, taps: int = IR_TAPS) -> np.ndarray:
    """Combined impulse response of both K-weighting stages, cascaded."""
    shelf_b, shelf_a = _shelf_biquad(sample_rate)
    hp_b, hp_a = _highpass_biquad(sample_rate)
    first = _biquad_impulse(shelf_b, shelf_a, taps)
    # Cascading = convolving the two responses, then truncating back to `taps`.
    second = _biquad_impulse(hp_b, hp_a, taps)
    return np.convolve(first, second)[:taps]


# Overlap-add transform size. Direct convolution is not an option: np.convolve
# is O(samples x taps), which for an 8192-tap kernel over a 50-minute stereo
# file measured at SIX MINUTES per pass. The same work by FFT takes 13 seconds
# (measured 2026-08-23), which is the difference between a usable button and
# an abandoned one.
FFT_SIZE = 32768


class _OverlapAddFilter:
    """Streaming FIR convolution by overlap-add FFT.

    Output is emitted in order and in full, but NOT necessarily aligned with
    the input blocks: a call may return fewer samples than it was given, with
    the remainder released by later calls or by `flush()`. Callers here only
    accumulate energy, so alignment does not matter -- but forgetting to
    flush would silently drop the end of the file.
    """

    def __init__(self, impulse: np.ndarray, channels: int) -> None:
        if len(impulse) >= FFT_SIZE:
            raise ValueError("impulse longer than the transform")
        self.taps = len(impulse)
        self.step = FFT_SIZE - self.taps + 1
        # float32 buffers: half the memory for a 50-minute stereo file, and
        # the accuracy cost is nil -- the largest deviation from a float64
        # direct IIR recursion measured 9.1e-07, about -120 dBFS, against a
        # meter read to 0.01 dB. (It buys no SPEED: numpy's FFT promotes to
        # double internally, so the transform costs the same either way.)
        self.kernel_f = np.fft.rfft(impulse.astype(np.float32), FFT_SIZE)
        self.channels = channels
        self.tail = np.zeros((self.taps - 1, channels), dtype=np.float32)
        self.pending = np.zeros((0, channels), dtype=np.float32)

    def process(self, block: np.ndarray) -> np.ndarray:
        if block.size:
            self.pending = (
                np.concatenate([self.pending, block.astype(np.float32)])
                if len(self.pending)
                else block.astype(np.float32)
            )
        pieces = []
        while len(self.pending) >= self.step:
            pieces.append(self._transform(self.pending[: self.step]))
            self.pending = self.pending[self.step :]
        if not pieces:
            return np.zeros((0, self.channels), dtype=np.float32)
        return np.concatenate(pieces)

    def flush(self) -> np.ndarray:
        """Filter whatever is left, then the convolution tail itself."""
        pieces = []
        if len(self.pending):
            pieces.append(self._transform(self.pending))
            self.pending = np.zeros((0, self.channels), dtype=np.float32)
        pieces.append(self.tail)
        self.tail = np.zeros((self.taps - 1, self.channels), dtype=np.float32)
        return np.concatenate(pieces)

    def _transform(self, piece: np.ndarray) -> np.ndarray:
        n = len(piece)
        spectrum = np.fft.rfft(piece, FFT_SIZE, axis=0)
        full = np.fft.irfft(spectrum * self.kernel_f[:, None], FFT_SIZE, axis=0)
        full[: self.taps - 1] += self.tail
        self.tail = full[n : n + self.taps - 1].copy()
        return full[:n]


def _true_peak_kernels() -> np.ndarray:
    """Polyphase windowed-sinc kernels for 4x upsampling.

    Row p reconstructs the sample sitting p/4 of the way between two input
    samples; taking the max over all four phases estimates the peak of the
    underlying continuous waveform, which is what a converter actually has to
    reproduce and what RX reports as "true peak".
    """
    taps = TRUE_PEAK_TAPS_PER_PHASE
    phases = TRUE_PEAK_OVERSAMPLE
    centre = taps // 2
    kernels = np.zeros((phases, taps), dtype=np.float64)
    for p in range(phases):
        offset = p / phases
        for t in range(taps):
            x = t - centre - offset
            sinc = 1.0 if x == 0 else math.sin(math.pi * x) / (math.pi * x)
            # Blackman-Harris keeps the stopband low enough that the window
            # itself does not invent peaks.
            w = 2.0 * math.pi * (t + 0.5) / taps
            window = (
                0.35875
                - 0.48829 * math.cos(w)
                + 0.14128 * math.cos(2 * w)
                - 0.01168 * math.cos(3 * w)
            )
            kernels[p, t] = sinc * window
        # Unity DC gain per phase, so a constant signal is not scaled.
        total = kernels[p].sum()
        if total != 0:
            kernels[p] /= total
    return kernels


class TruePeakMeter:
    """Running maximum of the 4x-oversampled absolute sample value."""

    def __init__(self, channels: int) -> None:
        kernels = _true_peak_kernels()
        # Phase 0 reproduces the input samples, which are already peak
        # candidates on their own; only the three intermediate phases need
        # reconstructing.
        self.kernels = kernels[1:]
        # No interpolated sample can exceed the largest input sample it was
        # built from by more than the kernel's absolute gain. That bound is
        # what lets most of the file be skipped: a block whose loudest sample,
        # multiplied by this, still cannot beat the peak found so far, cannot
        # contain the true peak either. Skipping it is not an approximation.
        self.gain_bound = float(np.abs(self.kernels).sum(axis=1).max())
        self.channels = channels
        self.carry = np.zeros(
            (TRUE_PEAK_TAPS_PER_PHASE - 1, channels), dtype=np.float32
        )
        self.peak = 0.0
        self.blocks_seen = 0
        self.blocks_interpolated = 0

    def process(self, block: np.ndarray) -> None:
        if block.size == 0:
            return
        self.blocks_seen += 1
        block_peak = float(np.abs(block).max())
        # The recorded samples are peak candidates in their own right.
        if block_peak > self.peak:
            self.peak = block_peak

        keep = TRUE_PEAK_TAPS_PER_PHASE - 1
        if block_peak * self.gain_bound > self.peak:
            self.blocks_interpolated += 1
            joined = np.concatenate([self.carry, block.astype(np.float32)])
            if len(joined) >= TRUE_PEAK_TAPS_PER_PHASE:
                for ch in range(self.channels):
                    column = joined[:, ch]
                    for kernel in self.kernels:
                        local = float(
                            np.abs(np.convolve(column, kernel, mode="valid")).max()
                        )
                        if local > self.peak:
                            self.peak = local
        # The carry is maintained whether or not this block was interpolated,
        # so a skipped block still supplies context to the next one.
        tail = block[-keep:] if len(block) >= keep else block
        self.carry = np.concatenate([self.carry, tail.astype(np.float32)])[-keep:]

    def flush(self) -> None:  # nothing is buffered beyond the carry
        return None


@dataclass(frozen=True)
class LoudnessResult:
    """The figures RX and SpectraLayers put on screen, for the same audio."""

    lufs: float  # integrated, gated, ITU-R BS.1770-4
    true_peak: float  # linear
    true_peak_dbtp: float
    gated_blocks: int  # how many 400ms windows survived both gates
    total_blocks: int

    def as_dict(self) -> dict:
        return asdict(self)


class LoudnessMeter:
    """Streaming integrated-loudness meter.

    Feed it the same blocks analyze.measure() already walks; it costs one
    convolution per block on top, and constant memory.
    """

    def __init__(self, sample_rate: int, channels: int) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.filter = _OverlapAddFilter(k_weighting_impulse(sample_rate), channels)
        self.true_peak = TruePeakMeter(channels)
        self.step = max(1, int(round(STEP_SEC * sample_rate)))
        self.blocks_per_window = int(round(BLOCK_SEC / STEP_SEC))  # 4
        # Mean square of each finished 100ms step, per channel.
        self.step_means: list[np.ndarray] = []
        self._pending = np.zeros((0, channels), dtype=np.float64)
        self._flushed = False

    @staticmethod
    def channel_weights(channels: int) -> np.ndarray:
        """BS.1770 G_i. Mono and stereo are unweighted; surrounds get +1.5dB.

        Nothing this project handles is surround, but a 5.1 source must not be
        silently mismeasured if one ever arrives.
        """
        weights = np.ones(channels, dtype=np.float64)
        if channels >= 5:
            weights[3:5] = 1.41
        return weights

    def process(self, block: np.ndarray) -> None:
        if block.size == 0:
            return
        self.true_peak.process(block)
        self._accumulate(self.filter.process(block))

    def _accumulate(self, filtered: np.ndarray) -> None:
        data = (
            np.concatenate([self._pending, filtered])
            if len(self._pending)
            else filtered
        )
        whole = len(data) // self.step
        if whole:
            usable = data[: whole * self.step]
            shaped = usable.reshape(whole, self.step, self.channels)
            # Mean square per 100ms step per channel -- the only thing the
            # gating needs, so nothing else is retained.
            self.step_means.extend(np.mean(shaped**2, axis=1))
        self._pending = data[whole * self.step :]

    def _finish(self) -> None:
        """Drain both filters. Idempotent, so result() can be called twice."""
        if self._flushed:
            return
        self._flushed = True
        self.true_peak.flush()
        self._accumulate(self.filter.flush())

    def result(self) -> LoudnessResult:
        self._finish()
        weights = self.channel_weights(self.channels)
        windows = self._window_powers(weights)
        true_peak = self.true_peak.peak
        if not len(windows):
            return LoudnessResult(
                lufs=SILENCE_FLOOR_LUFS,
                true_peak=true_peak,
                true_peak_dbtp=_to_db(true_peak),
                gated_blocks=0,
                total_blocks=0,
            )

        loudness = LOUDNESS_OFFSET + 10.0 * np.log10(np.maximum(windows, 1e-30))
        # Absolute gate first, then a relative gate referenced to what survived
        # it -- the order is specified, and swapping it changes the answer.
        passes_absolute = loudness > ABSOLUTE_GATE_LUFS
        above_absolute = windows[passes_absolute]
        if not len(above_absolute):
            return LoudnessResult(
                lufs=SILENCE_FLOOR_LUFS,
                true_peak=true_peak,
                true_peak_dbtp=_to_db(true_peak),
                gated_blocks=0,
                total_blocks=len(windows),
            )
        threshold = (
            LOUDNESS_OFFSET
            + 10.0 * math.log10(max(float(np.mean(above_absolute)), 1e-30))
            + RELATIVE_GATE_LU
        )
        kept = windows[passes_absolute & (loudness > threshold)]
        if not len(kept):
            kept = above_absolute
        lufs = LOUDNESS_OFFSET + 10.0 * math.log10(max(float(np.mean(kept)), 1e-30))
        return LoudnessResult(
            lufs=max(SILENCE_FLOOR_LUFS, lufs),
            true_peak=true_peak,
            true_peak_dbtp=_to_db(true_peak),
            gated_blocks=len(kept),
            total_blocks=len(windows),
        )

    def _window_powers(self, weights: np.ndarray) -> np.ndarray:
        """Weighted power of every overlapping 400ms window."""
        count = len(self.step_means) - self.blocks_per_window + 1
        if count <= 0:
            return np.zeros(0, dtype=np.float64)
        steps = np.array(self.step_means)  # (n_steps, channels)
        # A 400ms window is the mean of 4 consecutive 100ms step means.
        cumulative = np.cumsum(
            np.vstack([np.zeros(self.channels), steps]), axis=0
        )
        window_means = (
            cumulative[self.blocks_per_window :]
            - cumulative[: -self.blocks_per_window]
        ) / self.blocks_per_window
        return window_means @ weights


def _to_db(amplitude: float) -> float:
    if amplitude <= 0:
        return SILENCE_FLOOR_LUFS
    return max(SILENCE_FLOOR_LUFS, 20.0 * math.log10(amplitude))
