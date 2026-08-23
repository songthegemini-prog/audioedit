"""LUFS and true peak, checked against the published compliance signals.

The whole point of this module is that our numbers can be read straight across
to iZotope RX and SpectraLayers, which is where the team verifies our work
(asked 2026-08-23). "Looks about right" is worth nothing for that: either the
figures match the standard the other tools implement, or the team is comparing
two different things without knowing it. So the tests here are the EBU Tech
3341 cases, with the tolerance the standard itself specifies.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.loudness import (
    LoudnessMeter,
    TruePeakMeter,
    _highpass_biquad,
    _OverlapAddFilter,
    _shelf_biquad,
    k_weighting_impulse,
)

# EBU Tech 3341 allows +/-0.1 LU for an integrated-loudness meter.
EBU_TOLERANCE = 0.1


def sine(freq: float, dbfs: float, seconds: float, rate: int, channels: int = 2):
    amplitude = 10 ** (dbfs / 20.0)
    t = np.arange(int(seconds * rate)) / rate
    wave = (amplitude * np.sin(2 * math.pi * freq * t)).astype(np.float32)
    return np.tile(wave[:, None], (1, channels))


def integrated(signal, rate: int, chunk: int = 7919):
    """Deliberately fed in an awkward, non-power-of-two block size.

    Real decoded audio arrives in ~1150-frame mp3 frames, never in neat
    multiples of the 100ms gating step or the FFT size, so the seams between
    blocks are exactly where a streaming meter breaks.
    """
    meter = LoudnessMeter(rate, signal.shape[1])
    for i in range(0, len(signal), chunk):
        meter.process(signal[i : i + chunk])
    return meter.result()


def test_overlap_add_matches_the_direct_iir_recursion() -> None:
    """The FFT path has to be the same filter, not merely a similar one.

    Direct convolution was measured at SIX MINUTES for one pass over a
    50-minute file, so the fast path is not optional -- which makes this
    equivalence the thing holding the accuracy up.
    """
    rate = 48000
    signal = np.random.default_rng(0).standard_normal((20000, 1))

    def biquad(data, b, a):
        out = np.zeros_like(data)
        x1 = x2 = y1 = y2 = 0.0
        for n, x0 in enumerate(data):
            y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            out[n] = y0
            x2, x1 = x1, x0
            y2, y1 = y1, y0
        return out

    direct = biquad(
        biquad(signal[:, 0], *_shelf_biquad(rate)), *_highpass_biquad(rate)
    )
    filt = _OverlapAddFilter(k_weighting_impulse(rate), 1)
    pieces = [filt.process(signal[i : i + 3001]) for i in range(0, len(signal), 3001)]
    pieces.append(filt.flush())
    streamed = np.concatenate([p for p in pieces if len(p)])[: len(signal), 0]

    # float32 buffers: 1e-5 is about -100 dBFS, against a meter read to 0.01 dB
    assert np.abs(direct - streamed).max() < 1e-5


def test_forgetting_to_flush_would_lose_the_end_of_the_file() -> None:
    """process() may return nothing at all -- the guard on a silent data loss.

    The overlap-add buffer holds up to a full transform of input, so a file
    shorter than that produces NO output until flush(). An early version of
    result() did not flush and reported silence for short clips.
    """
    filt = _OverlapAddFilter(k_weighting_impulse(48000), 1)
    fed = np.ones((5000, 1), dtype=np.float32)

    assert filt.process(fed).shape[0] == 0  # nothing emitted yet
    assert filt.flush().shape[0] > 0


@pytest.mark.parametrize("level", [-23.0, -33.0])
def test_ebu_3341_steady_tone(level: float) -> None:
    """Cases 1 and 2: a 1kHz tone must read its own dBFS level in LUFS."""
    result = integrated(sine(1000, level, 20, 48000), 48000)

    assert result.lufs == pytest.approx(level, abs=EBU_TOLERANCE)


def test_the_filters_are_redesigned_for_the_actual_sample_rate() -> None:
    """BS.1770 tabulates coefficients at 48kHz, but the team's sources are
    44.1kHz mp3s. Reusing the 48k numbers there would shift both filter
    corners and bias every reading."""
    result = integrated(sine(1000, -23.0, 20, 44100), 44100)

    assert result.lufs == pytest.approx(-23.0, abs=EBU_TOLERANCE)


def test_ebu_3341_gating_ignores_the_quiet_passages() -> None:
    """Case 3: -36 dBFS for 10s, -23 dBFS for 60s, -36 dBFS for 10s -> -23.

    This is the case that proves the relative gate is implemented, and the
    durations are load-bearing: with equal 10/10/10 lengths the quiet parts
    sit ABOVE the relative threshold and the answer is legitimately -27.3.
    """
    rate = 48000
    sequence = np.concatenate(
        [
            sine(1000, -36, 10, rate),
            sine(1000, -23, 60, rate),
            sine(1000, -36, 10, rate),
        ]
    )

    result = integrated(sequence, rate)

    assert result.lufs == pytest.approx(-23.0, abs=EBU_TOLERANCE)
    assert result.gated_blocks < result.total_blocks  # something WAS gated out


def test_silence_reports_a_floor_rather_than_negative_infinity() -> None:
    """log10(0) rendered as "-Infinity" in JSON and broke the panel."""
    result = integrated(np.zeros((48000, 2), dtype=np.float32), 48000)

    assert result.lufs <= -100.0
    assert math.isfinite(result.lufs)


def test_true_peak_sees_what_sample_peak_misses() -> None:
    """The reason RX shows a higher number than a sample-domain meter.

    A tone at a quarter of the sample rate, phase-shifted 45 degrees, never
    lands on its own crest: every sample reads -3 dBFS while the waveform
    itself reaches full scale. An editor comparing our old sample peak with
    RX's true peak would have seen a 3 dB discrepancy and mistrusted us.
    """
    rate = 48000
    n = np.arange(rate * 2)
    wave = np.sin(2 * math.pi * (rate / 4) * n / rate + math.pi / 4).astype(np.float32)
    signal = np.tile(wave[:, None], (1, 2))

    result = integrated(signal, rate)

    assert result.true_peak_dbtp > 20 * math.log10(float(np.abs(signal).max())) + 2.5
    assert result.true_peak_dbtp == pytest.approx(0.0, abs=0.5)


def test_skipping_quiet_blocks_cannot_hide_the_true_peak() -> None:
    """Most of a file is skipped for speed; the bound has to make that exact.

    A block is only interpolated when its loudest sample, multiplied by the
    kernel's absolute gain, could still beat the peak found so far. Here a
    loud burst arrives AFTER a long quiet stretch has already set a running
    peak -- the case where a careless threshold loses the real maximum.
    """
    rate = 48000
    quiet = (0.01 * np.ones((rate, 2))).astype(np.float32)
    n = np.arange(1000)
    burst = np.sin(2 * math.pi * (rate / 4) * n / rate + math.pi / 4).astype(np.float32)
    signal = np.concatenate([quiet, np.tile(burst[:, None], (1, 2)), quiet])

    gated = TruePeakMeter(2)
    for i in range(0, len(signal), 4096):
        gated.process(signal[i : i + 4096])

    exhaustive = TruePeakMeter(2)
    exhaustive.gain_bound = float("inf")  # never skip
    for i in range(0, len(signal), 4096):
        exhaustive.process(signal[i : i + 4096])

    assert gated.peak == pytest.approx(exhaustive.peak, rel=1e-9)
    assert gated.blocks_interpolated < gated.blocks_seen  # and it DID skip


def test_a_gain_change_moves_lufs_by_exactly_that_much() -> None:
    """What the verification is ultimately for: catching a level shift."""
    rate = 48000
    signal = sine(1000, -23, 10, rate)

    quiet = integrated((signal * 10 ** (-6.0 / 20.0)).astype(np.float32), rate)
    loud = integrated(signal, rate)

    assert quiet.lufs - loud.lufs == pytest.approx(-6.0, abs=0.05)
