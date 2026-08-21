"""API surface for the format + verification work (team feedback 2026-08-20)."""

from __future__ import annotations

import time
import wave

import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from tests.test_audiofmt import SR, sine, write_wav_bits

client = TestClient(app)


def wait_for_done(job_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/jobs/{job_id}").json()
        if body["status"] in ("done", "error", "cancelled"):
            return body
        time.sleep(0.02)
    raise AssertionError("job did not finish in time")


def start_export(src, out, edl=None, **extra) -> dict:
    payload = {"path": str(src), "out_path": str(out), "edl": edl or [], **extra}
    res = client.post("/export_audio", json=payload)
    assert res.status_code == 200, res.text
    return wait_for_done(res.json()["job_id"])


def test_export_defaults_to_the_source_bit_depth(tmp_path) -> None:
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=2.0), 24)

    body = start_export(src, out, [{"start": 0.5, "end": 1.0}])

    assert body["status"] == "done", body
    assert body["result"]["bits"] == 24
    with wave.open(str(out)) as f:
        assert f.getsampwidth() == 3


def test_export_mp3_through_the_api(tmp_path) -> None:
    src = tmp_path / "src.wav"
    out = tmp_path / "out.mp3"
    write_wav_bits(src, sine(seconds=2.0), 16)

    body = start_export(src, out, format="mp3")

    assert body["status"] == "done", body
    assert body["result"]["format"] == "mp3"
    assert out.stat().st_size > 0


def test_export_rejects_an_unknown_format(tmp_path) -> None:
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(), 16)

    res = client.post(
        "/export_audio",
        json={
            "path": str(src),
            "out_path": str(tmp_path / "out.ogg"),
            "edl": [],
            "format": "ogg",
        },
    )

    assert res.status_code == 422  # Literal["wav","mp3"] rejects it


def test_analyze_audio_reports_levels(tmp_path) -> None:
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(seconds=1.0, amp=0.5), 24)

    res = client.post("/analyze_audio", json={"path": str(src)})

    assert res.status_code == 200, res.text
    body = res.json()
    assert abs(body["peak_dbfs"] - (-6.02)) < 0.1
    assert abs(body["rms"] - 0.5 / np.sqrt(2)) < 0.01
    assert body["sample_rate"] == SR


def test_analyze_audio_404s_on_a_missing_file(tmp_path) -> None:
    res = client.post("/analyze_audio", json={"path": str(tmp_path / "nope.wav")})
    assert res.status_code == 404


def test_compare_audio_says_unchanged_for_a_real_export(tmp_path) -> None:
    """The end-to-end check the editors actually want."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=3.0, amp=0.5), 24)
    edl = [{"start": 0.5, "end": 1.0}]

    assert start_export(src, out, edl)["status"] == "done"
    res = client.post(
        "/compare_audio",
        json={"source_path": str(src), "edited_path": str(out), "edl": edl},
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["unchanged"] is True
    assert body["sample_rate_match"] is True
    assert body["channels_match"] is True
    assert abs(body["rms_delta_db"]) < 0.5


def test_compare_audio_catches_a_quieter_export(tmp_path) -> None:
    src = tmp_path / "src.wav"
    quiet = tmp_path / "quiet.wav"
    write_wav_bits(src, sine(seconds=1.0, amp=0.5), 24)
    write_wav_bits(quiet, sine(seconds=1.0, amp=0.25), 24)

    res = client.post(
        "/compare_audio",
        json={"source_path": str(src), "edited_path": str(quiet), "edl": []},
    )

    assert res.json()["unchanged"] is False


def test_export_still_refuses_to_overwrite_the_source(tmp_path) -> None:
    """CLAUDE.md hard rule — re-checked now that format options exist."""
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(), 16)

    res = client.post(
        "/export_audio",
        json={"path": str(src), "out_path": str(src), "edl": [], "format": "mp3"},
    )

    assert res.status_code == 400
