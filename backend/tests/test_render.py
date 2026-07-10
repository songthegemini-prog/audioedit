import wave
from pathlib import Path

import numpy as np
import pytest

from app.render import apply_edl, kept_spans, render_export, stream_edl, write_wav

SR = 1000


def ramp(secs: float) -> np.ndarray:
    """Mono signal whose value equals its time in seconds — easy to assert on."""
    n = int(secs * SR)
    return (np.arange(n, dtype=np.float32) / SR)[:, None] / secs  # 0..1 ramp


def test_kept_spans_merges_and_clamps() -> None:
    spans = kept_spans([(2.0, 3.0), (2.5, 4.0), (-1.0, 0.5), (9.5, 99)], total_sec=10.0)
    assert spans == [(0.5, 2.0), (4.0, 9.5)]


def test_no_cuts_is_a_straight_copy() -> None:
    samples = ramp(2.0)
    out = apply_edl(samples, SR, [])
    assert np.array_equal(out, samples)


def test_cut_shortens_by_cut_length_minus_crossfade() -> None:
    samples = ramp(3.0)
    out = apply_edl(samples, SR, [(1.0, 2.0)], crossfade_sec=0.01)
    expected = len(samples) - 1.0 * SR - 0.01 * SR  # cut 1s, one 10ms overlap
    assert abs(len(out) - expected) <= 2


def test_crossfade_leaves_no_discontinuity() -> None:
    # loud constant signal — a hard join without crossfade would step abruptly
    samples = np.ones((3 * SR, 1), dtype=np.float32) * 0.8
    samples[SR : 2 * SR] = -0.8  # cut region has opposite sign
    out = apply_edl(samples, SR, [(1.0, 2.0)], crossfade_sec=0.01)
    diffs = np.abs(np.diff(out[:, 0]))
    assert diffs.max() < 0.2  # samples never jump more than the fade slope


def test_everything_cut_yields_empty() -> None:
    out = apply_edl(ramp(1.0), SR, [(0.0, 5.0)])
    assert len(out) == 0


def test_cut_at_file_edges() -> None:
    samples = ramp(2.0)
    out = apply_edl(samples, SR, [(0.0, 0.5), (1.5, 2.0)], crossfade_sec=0.01)
    # both cuts touch an edge — no joins at all, so no crossfade shrinkage
    assert abs(len(out) - SR) <= 2


# --- streaming EDL (Phase 9a) must match apply_edl sample-for-sample ---


def chunked(samples: np.ndarray, size: int) -> list[np.ndarray]:
    return [samples[i : i + size] for i in range(0, len(samples), size)]


def stream_result(samples: np.ndarray, cuts, chunk: int, **kw) -> np.ndarray:
    blocks = list(stream_edl(chunked(samples, chunk), SR, cuts, **kw))
    if not blocks:
        return samples[:0]
    return np.concatenate(blocks)


# chunk sizes chosen to hit the tricky paths: smaller than the crossfade,
# exactly the crossfade, typical decoder frames, and whole-file-at-once
@pytest.mark.parametrize("chunk", [3, 10, 160, 100000])
@pytest.mark.parametrize(
    "cuts",
    [
        [],
        [(1.0, 2.0)],
        [(0.0, 0.5), (1.5, 2.0)],  # cuts touching both file edges
        [(0.3, 0.4), (0.401, 0.5), (0.9, 1.1)],  # tiny kept span between cuts
        [(2.0, 3.0), (2.5, 4.0), (-1.0, 0.5), (9.5, 99)],  # overlap + out of range
        [(0.0, 99.0)],  # everything cut
    ],
)
def test_stream_edl_equals_apply_edl(chunk: int, cuts) -> None:
    rng = np.random.default_rng(42)
    samples = rng.uniform(-1, 1, size=(3 * SR, 2)).astype(np.float32)
    expected = apply_edl(samples, SR, cuts)
    got = stream_result(samples, cuts, chunk)
    assert got.shape == expected.shape
    assert np.array_equal(got, expected)


def test_stream_edl_zero_crossfade() -> None:
    samples = ramp(2.0)
    expected = apply_edl(samples, SR, [(0.5, 1.0)], crossfade_sec=0.0)
    got = stream_result(samples, [(0.5, 1.0)], 7, crossfade_sec=0.0)
    assert np.array_equal(got, expected)


def test_render_export_reports_progress_and_cancels(tmp_path: Path) -> None:
    sine = np.sin(2 * np.pi * 50 * np.arange(2 * SR) / SR).astype(np.float32)[:, None]
    src = tmp_path / "src.wav"
    write_wav(src, sine * 0.5, SR)

    seen: list[float] = []
    render_export(src, tmp_path / "out.wav", [], on_progress=seen.append)
    assert seen and seen[-1] == pytest.approx(1.0, abs=0.05)

    class Stop(Exception):
        pass

    def cancel() -> None:
        raise Stop

    with pytest.raises(Stop):
        render_export(src, tmp_path / "out2.wav", [], check_cancelled=cancel)


def test_write_and_render_roundtrip(tmp_path: Path) -> None:
    sine = np.sin(2 * np.pi * 50 * np.arange(2 * SR) / SR).astype(np.float32)[:, None]
    src = tmp_path / "src.wav"
    write_wav(src, sine * 0.5, SR)

    out = tmp_path / "out.wav"
    result = render_export(src, out, [(0.5, 1.0)])

    with wave.open(str(out)) as w:
        assert w.getframerate() == SR
        assert w.getnchannels() == 1
        frames = w.getnframes()
    assert abs(frames - (2 * SR - 0.5 * SR - 0.01 * SR)) <= 2
    assert result["sample_rate"] == SR
    # and the source is untouched
    assert src.stat().st_size > 0
