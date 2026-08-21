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

    def as_dict(self) -> dict:
        return asdict(self)


def measure(path: Path, cuts: list[tuple[float, float]] | None = None) -> Loudness:
    """Stream `path` (optionally through `cuts`) and report its loudness.

    Pass the project's EDL as `cuts` when measuring the SOURCE, and nothing
    when measuring an already-rendered export: both then describe the same
    audio and are directly comparable.
    """
    chunks, sample_rate, _ = decode_stream(path)
    blocks = stream_edl(chunks, sample_rate, cuts) if cuts else chunks

    peak = 0.0
    sum_squares = 0.0
    frames = 0
    channels = 0
    clipped = 0
    for block in blocks:
        if block.size == 0:
            continue
        channels = block.shape[1]
        frames += len(block)
        absolute = np.abs(block)
        block_peak = float(absolute.max())
        if block_peak > peak:
            peak = block_peak
        # float64 accumulator: an hour of float32 sums loses precision badly
        sum_squares += float(np.sum(block.astype(np.float64) ** 2))
        clipped += int(np.count_nonzero(absolute >= CLIP_THRESHOLD))

    total_samples = frames * channels
    rms = math.sqrt(sum_squares / total_samples) if total_samples else 0.0
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
    )


# A 10ms crossfade at each seam dips energy slightly, and a lossy source
# decodes a hair differently each time. Anything inside this is "unchanged".
RMS_TOLERANCE_DB = 0.5
PEAK_TOLERANCE_DB = 0.5


def compare(source: Loudness, edited: Loudness) -> dict:
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
    unchanged = (
        abs(rms_delta) <= RMS_TOLERANCE_DB
        and abs(peak_delta) <= PEAK_TOLERANCE_DB
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
    }
