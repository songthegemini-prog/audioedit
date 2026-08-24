"""Chunking for batched ASR — the guard against words vanishing at the seams.

The bug this encodes (reported 2026-08-24, "หายทุกบรรทัด ประมาณสี่ห้าคำ"):
BatchedInferencePipeline decodes VAD chunks independently, its VAD is capped
at 30s, and continuous Thai narration never pauses long enough to end a speech
run — so the run was cut mid-word and the word straddling the cut was lost.
The chunks were not even contiguous: 0.32s of audio belonged to none of them.

Every test here is about a property the decoder depends on, not about the
particular numbers: full coverage, no gaps, and never handing faster-whisper a
chunk it will silently truncate.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.asr import (
    CHUNK_SEARCH_SEC,
    CHUNK_TARGET_SEC,
    SAMPLE_RATE,
    contiguous_chunks,
)

# What faster-whisper will silently truncate to, warning only to the log.
WHISPER_WINDOW_SEC = 30.0


def speech_like(seconds: float, seed: int = 0) -> np.ndarray:
    """Continuous sound with brief quiet dips — the shape of narration.

    Uniform noise would let the energy search pick any point at all, which
    would prove nothing about whether the split lands somewhere sensible.
    """
    rng = np.random.default_rng(seed)
    samples = rng.standard_normal(int(seconds * SAMPLE_RATE)).astype(np.float32) * 0.2
    for start in np.arange(1.5, seconds, 3.1):  # a pause every ~3s
        lo = int(start * SAMPLE_RATE)
        samples[lo : lo + int(0.12 * SAMPLE_RATE)] *= 0.01
    return samples


@pytest.mark.parametrize("seconds", [26, 61, 180, 600, 3600])
def test_chunks_are_contiguous(seconds: int) -> None:
    """THE property. A gap between chunks is audio nobody transcribes, and
    that is exactly how words went missing."""
    chunks = contiguous_chunks(speech_like(seconds), SAMPLE_RATE)

    for earlier, later in zip(chunks, chunks[1:]):
        assert later["start"] == pytest.approx(earlier["end"], abs=1e-9)


@pytest.mark.parametrize("seconds", [26, 61, 180, 600, 3600])
def test_chunks_cover_the_whole_file(seconds: int) -> None:
    chunks = contiguous_chunks(speech_like(seconds), SAMPLE_RATE)

    assert chunks[0]["start"] == 0.0
    assert chunks[-1]["end"] == pytest.approx(seconds, abs=1e-6)


@pytest.mark.parametrize("seconds", [26, 61, 180, 600, 3600])
def test_no_chunk_can_be_silently_truncated(seconds: int) -> None:
    """faster-whisper keeps only the first 30s of an over-long chunk and says
    so only in the log — losing far MORE than the bug being fixed. A 28s
    target with a 3s search would breach this, which is why the target is 25."""
    chunks = contiguous_chunks(speech_like(seconds), SAMPLE_RATE)

    assert max(c["end"] - c["start"] for c in chunks) < WHISPER_WINDOW_SEC


def test_the_target_leaves_room_for_the_search() -> None:
    """Stated as arithmetic so a later tweak to either constant trips here
    rather than in a user's transcript."""
    assert CHUNK_TARGET_SEC + CHUNK_SEARCH_SEC < WHISPER_WINDOW_SEC


def test_short_audio_stays_in_one_piece() -> None:
    """No seam means no seam loss — do not invent one."""
    assert len(contiguous_chunks(speech_like(10), SAMPLE_RATE)) == 1


def test_empty_audio_produces_no_chunks() -> None:
    assert contiguous_chunks(np.zeros(0, dtype=np.float32), SAMPLE_RATE) == []


def test_splits_land_in_the_quiet_parts() -> None:
    """The quality half: a cut in a pause costs nothing, a cut mid-word costs
    a word. Compare each chosen edge against the loudness of the audio around
    it rather than asserting exact positions."""
    samples = speech_like(120)
    chunks = contiguous_chunks(samples, SAMPLE_RATE)
    window = int(0.02 * SAMPLE_RATE)

    overall = float(np.abs(samples).mean())
    for chunk in chunks[:-1]:  # the final edge is the end of the file
        at = int(chunk["end"] * SAMPLE_RATE)
        edge = float(np.abs(samples[at : at + window]).mean())
        assert edge < overall * 0.5


def test_a_late_quiet_moment_is_preferred_over_the_bare_target() -> None:
    """A concrete case: silence sits 2s after the target, nowhere else near.
    The edge must move to it instead of cutting at the target."""
    seconds = CHUNK_TARGET_SEC + 12
    rng = np.random.default_rng(1)
    samples = rng.standard_normal(int(seconds * SAMPLE_RATE)).astype(np.float32) * 0.2
    hush = int((CHUNK_TARGET_SEC + 2.0) * SAMPLE_RATE)
    samples[hush : hush + int(0.3 * SAMPLE_RATE)] = 0.0

    first_edge = contiguous_chunks(samples, SAMPLE_RATE)[0]["end"]

    assert first_edge == pytest.approx(CHUNK_TARGET_SEC + 2.0, abs=0.35)


def test_a_run_of_chunks_never_drifts_below_a_usable_length() -> None:
    """The search must not keep snapping backwards onto the same pause and
    emit a stream of tiny chunks — that would multiply the seams it exists to
    reduce."""
    chunks = contiguous_chunks(speech_like(600), SAMPLE_RATE)

    assert min(c["end"] - c["start"] for c in chunks[:-1]) >= 5.0
