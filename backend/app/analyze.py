"""Loudness measurement, so an editor can prove an export was not altered.

Why this exists (team feedback 2026-08-20): the editors check our work by
loading the source and the export into an analyser and comparing energy, to
confirm nothing was gain-shifted or compressed. This gives them that check
inside the app instead of a second program.

The comparison that actually means something is NOT "whole source vs export"
— the export is deliberately shorter, so its totals differ by construction.
It is "the KEPT regions of the source vs the export": run the same EDL over
the source, measure that, and the two should agree to within the crossfade
error at the seams. `measure()` takes an optional EDL for exactly that.

Everything streams, so an hour-long file costs the same memory as a short one.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .loudness import LoudnessMeter
from .render import decode_stream, stream_edl

# Below this, a float sample is silence for reporting purposes; log10(0) = -inf
# would otherwise render as "-Infinity" in JSON and break the UI.
SILENCE_FLOOR_DB = -144.0

# A sample that hit full scale in integer PCM never reads back as exactly 1.0:
# the positive maximum is (2**(n-1) - 1) / 2**(n-1), i.e. 0.99997 at 16-bit and
# 0.99999988 at 24-bit. Testing `>= 1.0` therefore detected nothing at all.
CLIP_THRESHOLD = 0.9999


def to_dbfs(amplitude: float) -> float:
    """Linear amplitude (1.0 = full scale) → dBFS, floored at SILENCE_FLOOR_DB."""
    if amplitude <= 0:
        return SILENCE_FLOOR_DB
    return max(SILENCE_FLOOR_DB, 20.0 * math.log10(amplitude))


@dataclass(frozen=True)
class Loudness:
    """What an analyser would show for one file (or one EDL applied to one)."""

    peak: float  # linear, 0..1+
    peak_dbfs: float
    rms: float  # linear
    rms_dbfs: float
    duration: float  # seconds
    sample_rate: int
    channels: int
    frames: int
    clipped_samples: int  # samples at/over CLIP_THRESHOLD — a real red flag
    # Broadcast-standard figures, so the numbers can be read straight across
    # to iZotope RX / SpectraLayers, which is where the team actually checks
    # our work. See loudness.py for why plain RMS is not comparable.
    # Defaulted so a Loudness can still be built from levels alone when the
    # broadcast figures are not what is under test; measure() always sets them.
    lufs: float = SILENCE_FLOOR_DB  # integrated, gated, ITU-R BS.1770-4
    true_peak: float = 0.0  # linear, 4x oversampled
    true_peak_dbtp: float = SILENCE_FLOOR_DB

    def as_dict(self) -> dict:
        return asdict(self)


# The decoder hands back roughly one mp3 frame at a time -- about 1,150
# samples, i.e. 114,000 blocks for a 50-minute file. Every block costs a fixed
# overhead in each numpy call that touches it, and at that size the overhead
# dominates the arithmetic. Regrouping into ~0.25M-frame batches first cuts the
# number of calls by 50x for the same work: 88s -> 37s on the team's own
# 50-minute file, with every reported figure unchanged (measured 2026-08-23).
# Larger batches were no faster and cost proportionally more memory.
BATCH_FRAMES = 1 << 16


def _batched(blocks, frames: int = BATCH_FRAMES):
    """Regroup a stream of small decoded blocks into large ones."""
    held: list[np.ndarray] = []
    held_frames = 0
    for block in blocks:
        if block.size == 0:
            continue
        held.append(block)
        held_frames += len(block)
        if held_frames >= frames:
            yield np.concatenate(held) if len(held) > 1 else held[0]
            held, held_frames = [], 0
    if held:
        yield np.concatenate(held) if len(held) > 1 else held[0]


def measure(path: Path, cuts: list[tuple[float, float]] | None = None) -> Loudness:
    """Stream `path` (optionally through `cuts`) and report its loudness.

    Pass the project's EDL as `cuts` when measuring the SOURCE, and nothing
    when measuring an already-rendered export: both then describe the same
    audio and are directly comparable.
    """
    chunks, sample_rate, _ = decode_stream(path)
    blocks = _batched(stream_edl(chunks, sample_rate, cuts) if cuts else chunks)

    peak = 0.0
    sum_squares = 0.0
    frames = 0
    channels = 0
    clipped = 0
    # Built on the first block, because the channel count is not known until
    # then; a file with no decodable audio leaves it None and reports silence.
    meter: LoudnessMeter | None = None
    for block in blocks:
        if block.size == 0:
            continue
        channels = block.shape[1]
        if meter is None:
            meter = LoudnessMeter(sample_rate, channels)
        frames += len(block)
        absolute = np.abs(block)
        block_peak = float(absolute.max())
        if block_peak > peak:
            peak = block_peak
        # float64 accumulator: an hour of float32 sums loses precision badly.
        # einsum accumulates in float64 without ever materialising a float64
        # copy of the block, which at a quarter-million frames is 4MB saved
        # per batch and measurably faster than astype(...) ** 2.
        sum_squares += float(np.einsum("ij,ij->", block, block, dtype=np.float64))
        clipped += int(np.count_nonzero(absolute >= CLIP_THRESHOLD))
        meter.process(block)

    total_samples = frames * channels
    rms = math.sqrt(sum_squares / total_samples) if total_samples else 0.0
    broadcast = meter.result() if meter is not None else None
    return Loudness(
        peak=peak,
        peak_dbfs=to_dbfs(peak),
        rms=rms,
        rms_dbfs=to_dbfs(rms),
        duration=frames / sample_rate if sample_rate else 0.0,
        sample_rate=sample_rate,
        channels=channels,
        frames=frames,
        clipped_samples=clipped,
        lufs=broadcast.lufs if broadcast else SILENCE_FLOOR_DB,
        true_peak=broadcast.true_peak if broadcast else 0.0,
        true_peak_dbtp=broadcast.true_peak_dbtp if broadcast else SILENCE_FLOOR_DB,
    )


# A 10ms crossfade at each seam dips energy slightly, and a lossy source
# decodes a hair differently each time. Anything inside this is "unchanged".
RMS_TOLERANCE_DB = 0.5
PEAK_TOLERANCE_DB = 0.5
# LUFS is gated and K-weighted, so the crossfade seams move it even less than
# they move RMS; the same tolerance is comfortably generous.
LUFS_TOLERANCE_DB = 0.5


def compare(
    source: Loudness, edited: Loudness, *, source_through_cuts: bool = True
) -> dict:
    """Verdict on whether `edited` preserved `source`'s energy.

    `unchanged` is what the editors are actually asking: did the app leave the
    audio alone? It is False when levels moved beyond the crossfade tolerance,
    or when the export introduced clipping the source did not have.

    Peaks are compared against min(source peak, full scale), NOT the raw source
    peak. A decoded MP3 routinely reconstructs samples ABOVE full scale — the
    team's own file peaks at +0.68 dBFS — and integer PCM cannot represent
    that, so every honest export clamps to 0 dBFS. Comparing against the raw
    peak flagged a bit-for-bit faithful export as "changed" purely because the
    source was an mp3 (caught by testing against the real file, 2026-08-20).
    """
    rms_delta = edited.rms_dbfs - source.rms_dbfs
    # What the export COULD have peaked at, given the format it was written to.
    reachable_peak_dbfs = to_dbfs(min(source.peak, 1.0))
    peak_delta = edited.peak_dbfs - reachable_peak_dbfs
    source_over_full_scale = source.peak > 1.0
    new_clipping = edited.clipped_samples > source.clipped_samples
    lufs_delta = edited.lufs - source.lufs
    true_peak_delta = edited.true_peak_dbtp - to_dbfs(min(source.true_peak, 1.0))
    unchanged = (
        abs(rms_delta) <= RMS_TOLERANCE_DB
        and abs(peak_delta) <= PEAK_TOLERANCE_DB
        and abs(lufs_delta) <= LUFS_TOLERANCE_DB
        and not new_clipping
    )
    return {
        "source": source.as_dict(),
        "edited": edited.as_dict(),
        "rms_delta_db": rms_delta,
        "peak_delta_db": peak_delta,
        # True when the source itself exceeded full scale (normal for lossy
        # sources): the export's peak being lower is expected, not a defect.
        "source_over_full_scale": source_over_full_scale,
        "source_peak_dbfs_raw": source.peak_dbfs,
        "sample_rate_match": source.sample_rate == edited.sample_rate,
        "channels_match": source.channels == edited.channels,
        "new_clipping": new_clipping,
        "unchanged": unchanged,
        "rms_tolerance_db": RMS_TOLERANCE_DB,
        "peak_tolerance_db": PEAK_TOLERANCE_DB,
        # Broadcast figures, directly comparable with RX / SpectraLayers.
        "lufs_delta_db": lufs_delta,
        "true_peak_delta_db": true_peak_delta,
        "lufs_tolerance_db": LUFS_TOLERANCE_DB,
        # THE caveat the team has to know about (asked 2026-08-23). When this
        # is True the "source" figures describe only the KEPT regions, not the
        # whole source file — that is what makes them comparable with the
        # export at all. An editor who opens the untouched original in RX and
        # compares whole-file numbers will see a difference caused purely by
        # the removed material, and would wrongly read it as processing.
        "source_measured_through_cuts": source_through_cuts,
    }
