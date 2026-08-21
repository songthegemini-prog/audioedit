"""Loudness comparison: prove an export did not change the audio's energy.

This is the check the editors run in an external analyser (team feedback
2026-08-20). The meaningful comparison is the source WITH THE EDL APPLIED
against the export — comparing against the whole source would always differ,
because the export is deliberately shorter.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.analyze import SILENCE_FLOOR_DB, compare, measure, to_dbfs
from app.render import render_export
from tests.test_audiofmt import SR, sine, write_wav_bits


def test_to_dbfs_full_scale_is_zero() -> None:
    assert to_dbfs(1.0) == pytest.approx(0.0)
    assert to_dbfs(0.5) == pytest.approx(-6.02, abs=0.01)


def test_to_dbfs_floors_silence_instead_of_returning_negative_infinity() -> None:
    """-inf would serialise as "-Infinity" and break the JSON the UI reads."""
    assert to_dbfs(0.0) == SILENCE_FLOOR_DB
    assert np.isfinite(to_dbfs(0.0))


def test_measure_reports_known_levels(tmp_path) -> None:
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(seconds=2.0, amp=0.5), 24)

    result = measure(src)

    assert result.peak == pytest.approx(0.5, abs=0.01)
    assert result.peak_dbfs == pytest.approx(-6.02, abs=0.1)
    # RMS of a sine at amplitude a is a/sqrt(2)
    assert result.rms == pytest.approx(0.5 / np.sqrt(2), abs=0.01)
    assert result.duration == pytest.approx(2.0, abs=0.01)
    assert result.sample_rate == SR
    assert result.channels == 1
    assert result.clipped_samples == 0


def test_measure_with_edl_matches_the_export(tmp_path) -> None:
    """The core promise: source+EDL and the rendered export agree."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=3.0, amp=0.5), 24)
    cuts = [(0.5, 1.0), (2.0, 2.25)]

    render_export(src, out, cuts)
    verdict = compare(measure(src, cuts), measure(out))

    assert verdict["unchanged"] is True
    assert verdict["rms_delta_db"] == pytest.approx(0.0, abs=0.5)
    assert verdict["peak_delta_db"] == pytest.approx(0.0, abs=0.5)
    assert verdict["sample_rate_match"] is True
    assert verdict["channels_match"] is True
    assert verdict["new_clipping"] is False


def test_measuring_against_the_whole_source_is_what_looks_wrong(tmp_path) -> None:
    """Guards the reason `cuts` exists: without it the durations disagree."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=3.0), 24)
    cuts = [(0.0, 1.5)]

    render_export(src, out, cuts)
    naive = compare(measure(src), measure(out))  # no EDL — the wrong comparison

    assert naive["source"]["duration"] > naive["edited"]["duration"]


def test_compare_flags_a_gain_change(tmp_path) -> None:
    """A halved export must NOT be reported as unchanged."""
    src = tmp_path / "src.wav"
    quiet = tmp_path / "quiet.wav"
    write_wav_bits(src, sine(seconds=1.0, amp=0.5), 24)
    write_wav_bits(quiet, sine(seconds=1.0, amp=0.25), 24)  # -6 dB

    verdict = compare(measure(src), measure(quiet))

    assert verdict["unchanged"] is False
    assert verdict["rms_delta_db"] == pytest.approx(-6.02, abs=0.1)


def test_compare_flags_new_clipping(tmp_path) -> None:
    src = tmp_path / "src.wav"
    hot = tmp_path / "hot.wav"
    write_wav_bits(src, sine(seconds=1.0, amp=0.5), 24)
    write_wav_bits(hot, sine(seconds=1.0, amp=1.0), 24)

    verdict = compare(measure(src), measure(hot))

    assert verdict["new_clipping"] is True
    assert verdict["unchanged"] is False


def test_stereo_is_measured_across_both_channels(tmp_path) -> None:
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(seconds=1.0, channels=2, amp=0.5), 24)

    result = measure(src)

    assert result.channels == 2
    assert result.rms == pytest.approx(0.5 / np.sqrt(2), abs=0.01)


def test_mp3_export_loses_a_little_but_stays_within_tolerance(tmp_path) -> None:
    """MP3 is lossy by definition — the verdict should still say 'unchanged'
    for a normal signal, so offering mp3 does not cry wolf on every export."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.mp3"
    write_wav_bits(src, sine(seconds=2.0, amp=0.5), 16)

    render_export(src, out, [], fmt="mp3")
    verdict = compare(measure(src), measure(out))

    assert verdict["rms_delta_db"] == pytest.approx(0.0, abs=0.5)


def test_over_full_scale_source_is_not_reported_as_changed(tmp_path) -> None:
    """A decoded MP3 routinely peaks ABOVE full scale (the team's own file hits
    +0.68 dBFS). Integer PCM cannot store that, so every honest export clamps
    to 0 dBFS — that must NOT read as "the app changed my audio"."""
    from app.analyze import Loudness, to_dbfs

    hot_source = Loudness(
        peak=1.081,  # +0.68 dBFS, exactly what the real mp3 measured
        peak_dbfs=to_dbfs(1.081),
        rms=0.168,
        rms_dbfs=to_dbfs(0.168),
        duration=2988.55,
        sample_rate=44100,
        channels=2,
        frames=131795055,
        clipped_samples=640,
    )
    clamped_export = Loudness(
        peak=0.99997,  # what 16-bit PCM can actually hold
        peak_dbfs=to_dbfs(0.99997),
        rms=0.168,
        rms_dbfs=to_dbfs(0.168),
        duration=2988.28,
        sample_rate=44100,
        channels=2,
        frames=131783148,
        clipped_samples=638,
    )

    verdict = compare(hot_source, clamped_export)

    assert verdict["unchanged"] is True
    assert verdict["source_over_full_scale"] is True
    assert abs(verdict["peak_delta_db"]) < 0.01  # measured against full scale
    assert verdict["source_peak_dbfs_raw"] == pytest.approx(0.68, abs=0.01)


def test_a_genuinely_quieter_export_is_still_caught_when_source_clips(tmp_path) -> None:
    """The over-full-scale allowance must not become a blanket excuse."""
    from app.analyze import Loudness, to_dbfs

    def loud(peak: float, rms: float) -> Loudness:
        return Loudness(
            peak=peak,
            peak_dbfs=to_dbfs(peak),
            rms=rms,
            rms_dbfs=to_dbfs(rms),
            duration=10.0,
            sample_rate=44100,
            channels=2,
            frames=441000,
            clipped_samples=0,
        )

    verdict = compare(loud(1.08, 0.5), loud(0.5, 0.25))  # -6 dB export

    assert verdict["unchanged"] is False
    assert verdict["rms_delta_db"] == pytest.approx(-6.02, abs=0.1)


def test_normal_source_peak_comparison_is_unaffected(tmp_path) -> None:
    """Nothing changes for a source that never exceeded full scale."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=2.0, amp=0.5), 24)

    render_export(src, out, [(0.5, 1.0)])
    verdict = compare(measure(src, [(0.5, 1.0)]), measure(out))

    assert verdict["source_over_full_scale"] is False
    assert verdict["unchanged"] is True
