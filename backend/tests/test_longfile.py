"""Phase 9b: canonical cache WAV + peaks + PCM windows for hour-long files."""

import time
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import longfile
from app.main import app
from app.render import write_wav

SR = 8000


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(longfile, "DATA_ROOT", tmp_path / "data")


def make_src(tmp_path: Path, secs: float = 2.0, channels: int = 2) -> Path:
    t = np.arange(int(secs * SR), dtype=np.float32) / SR
    sig = 0.5 * np.sin(2 * np.pi * 220 * t)
    samples = np.stack([sig] * channels, axis=1)
    src = tmp_path / "src.wav"
    write_wav(src, samples, SR)
    return src


def test_prepare_creates_wav_and_peaks(tmp_path: Path) -> None:
    src = make_src(tmp_path)
    seen: list[float] = []
    info = longfile.prepare(src, on_progress=seen.append)
    assert Path(info["wav_path"]).exists()
    assert info["sample_rate"] == SR
    assert info["channels"] == 2
    assert info["duration"] == pytest.approx(2.0, abs=0.01)
    expected_pairs = -(-int(2.0 * SR) // longfile.PEAK_BUCKET)  # ceil
    assert info["peak_pairs"] == expected_pairs
    assert seen and seen[-1] == pytest.approx(1.0, abs=0.05)
    # idempotent: second call reuses the cache
    again = longfile.prepare(src)
    assert again["wav_path"] == info["wav_path"]


def test_peaks_values_on_known_signal(tmp_path: Path) -> None:
    # constant blocks: bucket 0 is all +0.25, bucket 1 all -0.5
    b = longfile.PEAK_BUCKET
    samples = np.concatenate(
        [np.full(b, 0.25, np.float32), np.full(b, -0.5, np.float32)]
    )[:, None]
    src = tmp_path / "blocks.wav"
    write_wav(src, samples, SR)
    longfile.prepare(src)
    peaks = np.frombuffer(longfile.read_peaks(src), dtype="<f4").reshape(-1, 2)
    assert len(peaks) == 2
    assert peaks[0] == pytest.approx([0.25, 0.25], abs=1e-3)
    assert peaks[1] == pytest.approx([-0.5, -0.5], abs=1e-3)


def test_pcm_window_matches_canonical_wav(tmp_path: Path) -> None:
    src = make_src(tmp_path)
    longfile.prepare(src)
    data, rate = longfile.read_pcm_window(src, 0.5, 1.0)
    got = np.frombuffer(data, dtype="<f4")
    assert rate == SR
    with wave.open(str(longfile.wav_path_for(src))) as w:
        w.setpos(int(0.5 * SR))
        raw = w.readframes(int(0.5 * SR))
    expected = (
        np.frombuffer(raw, dtype="<i2").reshape(-1, 2)[:, 0].astype(np.float32)
        / 32768.0
    )
    assert np.array_equal(got, expected)


def test_pcm_window_guards(tmp_path: Path) -> None:
    src = make_src(tmp_path)
    longfile.prepare(src)
    with pytest.raises(ValueError):
        longfile.read_pcm_window(src, 1.0, 0.5)
    with pytest.raises(ValueError):
        longfile.read_pcm_window(src, 0.0, longfile.MAX_WINDOW_SEC + 1)


def test_probe_not_prepared_if_peaks_missing(tmp_path: Path) -> None:
    # orphan WAV (crash between rename and peaks write) must read as NOT
    # prepared, so the frontend re-runs prepare instead of failing on peaks
    src = make_src(tmp_path)
    longfile.prepare(src)
    longfile.peaks_path_for(src).unlink()  # simulate the missing peaks
    assert longfile.probe(src)["prepared"] is False


def test_cache_key_tracks_file_changes(tmp_path: Path) -> None:
    src = make_src(tmp_path)
    key1 = longfile.cache_key(src)
    time.sleep(0.01)
    src.touch()
    assert longfile.cache_key(src) != key1


def test_prune_keeps_newest(tmp_path: Path) -> None:
    d = longfile.cache_dir()
    for i in range(5):
        (d / f"f{i}.wav").write_bytes(b"x")
        (d / f"f{i}.peaks").write_bytes(b"x")
        time.sleep(0.01)
    longfile.prune_cache(keep=2)
    left = sorted(p.name for p in d.glob("*.wav"))
    assert left == ["f3.wav", "f4.wav"]


def test_parse_range() -> None:
    assert longfile.parse_range("bytes=0-99", 1000) == (0, 99)
    assert longfile.parse_range("bytes=100-", 1000) == (100, 999)
    assert longfile.parse_range("bytes=-100", 1000) == (900, 999)
    assert longfile.parse_range("bytes=0-9999", 1000) == (0, 999)
    assert longfile.parse_range("bytes=1000-", 1000) is None  # past EOF
    assert longfile.parse_range(None, 1000) is None
    assert longfile.parse_range("garbage", 1000) is None


# --- endpoints ---


def test_audio_info_and_pcm_endpoints(tmp_path: Path) -> None:
    client = TestClient(app)
    src = make_src(tmp_path)

    info = client.get("/audio_info", params={"path": str(src)}).json()
    assert info["sample_rate"] == SR
    assert info["prepared"] is False

    assert client.get("/peaks", params={"path": str(src)}).status_code == 404

    longfile.prepare(src)
    info = client.get("/audio_info", params={"path": str(src)}).json()
    assert info["prepared"] is True

    res = client.get("/pcm", params={"path": str(src), "start": 0.0, "end": 0.5})
    assert res.status_code == 200
    assert len(res.content) == int(0.5 * SR) * 4
    assert res.headers["x-sample-rate"] == str(SR)

    too_long = client.get(
        "/pcm", params={"path": str(src), "start": 0, "end": 999}
    )
    assert too_long.status_code == 400


def test_audio_file_range_requests(tmp_path: Path) -> None:
    client = TestClient(app)
    src = make_src(tmp_path)
    longfile.prepare(src)
    size = longfile.wav_path_for(src).stat().st_size

    full = client.get("/audio_file", params={"path": str(src)})
    assert full.status_code == 200
    assert full.headers["accept-ranges"] == "bytes"
    assert len(full.content) == size

    part = client.get(
        "/audio_file",
        params={"path": str(src)},
        headers={"Range": "bytes=100-199"},
    )
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 100-199/{size}"
    assert part.content == full.content[100:200]
