"""Export format: bit depth is preserved, MP3 is a real option.

The regression these lock down (team report 2026-08-20): every export came
out 16-bit, so a 24-bit source looked altered when the editors compared it
against the original in an analyser.
"""

from __future__ import annotations

import wave

import numpy as np
import pytest

from app.audiofmt import (
    Mp3Writer,
    WavWriter,
    bits_for_codec,
    float_to_pcm_bytes,
    probe_format,
)
from app.render import render_export

SR = 8000


def sine(seconds: float = 1.0, channels: int = 1, amp: float = 0.5) -> np.ndarray:
    t = np.linspace(0, seconds, int(SR * seconds), endpoint=False)
    mono = (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    return np.repeat(mono.reshape(-1, 1), channels, axis=1)


def write_wav_bits(path, samples: np.ndarray, bits: int) -> None:
    """Test helper: write a WAV at an explicit bit depth."""
    writer = WavWriter(path, SR, samples.shape[1], bits)
    writer.write(samples)
    writer.close()


@pytest.mark.parametrize(
    ("codec", "format_bits", "expected"),
    [
        ("pcm_s16le", 16, 16),
        ("pcm_s24le", 32, 24),  # 24-bit PCM decodes into an s32 buffer
        ("pcm_s32le", 32, 32),
        ("pcm_u8", 8, 16),  # 8-bit is widened, never emitted
        ("pcm_f32le", 32, 32),
        ("mp3float", 32, 16),  # lossy has no meaningful bit depth
        ("aac", 32, 16),
        ("flac", 32, 24),
        ("flac", 16, 16),
        ("something_unknown", 32, 16),  # safe default
    ],
)
def test_bits_for_codec(codec: str, format_bits: int, expected: int) -> None:
    assert bits_for_codec(codec, format_bits) == expected


@pytest.mark.parametrize("bits", [16, 24, 32])
def test_wav_writer_round_trips_bit_depth(tmp_path, bits: int) -> None:
    src = tmp_path / f"a{bits}.wav"
    write_wav_bits(src, sine(), bits)

    with wave.open(str(src)) as f:
        assert f.getsampwidth() == bits // 8
    assert probe_format(src).bits == bits


def test_24_bit_bytes_are_three_per_sample_little_endian() -> None:
    samples = np.array([[0.0], [1.0], [-1.0]], dtype=np.float32)
    raw = float_to_pcm_bytes(samples, 24)

    assert len(raw) == 3 * 3
    assert raw[0:3] == b"\x00\x00\x00"
    assert raw[3:6] == b"\xff\xff\x7f"  # +full scale
    assert raw[6:9] == b"\x01\x00\x80"  # -full scale


def test_float_source_reports_32_bit(tmp_path) -> None:
    # pcm_f32le has no integer width; we standardise it to 32-bit int output
    assert bits_for_codec("pcm_f32le", 32) == 32


@pytest.mark.parametrize("channels", [1, 2])
def test_mp3_writer_preserves_channel_count(tmp_path, channels: int) -> None:
    """PyAV defaults an mp3 stream to stereo — a mono source must stay mono."""
    out = tmp_path / "a.mp3"
    writer = Mp3Writer(out, SR, channels)
    block = sine(seconds=1.0, channels=channels)
    for start in range(0, len(block), 1024):  # exercise the streaming path
        writer.write(block[start : start + 1024])
    writer.close()

    probed = probe_format(out)
    assert probed.channels == channels
    assert probed.lossy is True
    assert out.stat().st_size > 0


@pytest.mark.parametrize("bits", [16, 24, 32])
def test_export_keeps_source_bit_depth(tmp_path, bits: int) -> None:
    """The actual reported bug: a 24-bit source must not come back 16-bit."""
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(seconds=2.0), bits)

    result = render_export(src, out, [(0.5, 1.0)])

    assert result["bits"] == bits
    assert result["source_bits"] == bits
    with wave.open(str(out)) as f:
        assert f.getsampwidth() == bits // 8
        assert f.getframerate() == SR


def test_export_can_override_bit_depth(tmp_path) -> None:
    src = tmp_path / "src.wav"
    out = tmp_path / "out.wav"
    write_wav_bits(src, sine(), 24)

    result = render_export(src, out, [], bits=16)

    assert result["bits"] == 16
    assert result["source_bits"] == 24  # still reports what the source was


def test_lossy_source_exports_16_bit(tmp_path) -> None:
    """An mp3 source has no bit depth to preserve — 16-bit is the honest default."""
    src = tmp_path / "src.mp3"
    writer = Mp3Writer(src, SR, 1)
    writer.write(sine(seconds=2.0))
    writer.close()

    result = render_export(src, tmp_path / "out.wav", [])

    assert result["bits"] == 16
    assert result["source_codec"] in ("mp3", "mp3float")


def test_export_to_mp3(tmp_path) -> None:
    src = tmp_path / "src.wav"
    out = tmp_path / "out.mp3"
    write_wav_bits(src, sine(seconds=2.0), 24)

    result = render_export(src, out, [(0.5, 1.0)], fmt="mp3")

    assert result["format"] == "mp3"
    assert result["bits"] is None  # bit depth is meaningless for mp3
    assert out.stat().st_size > 0
    assert probe_format(out).lossy is True


def test_export_never_touches_the_source(tmp_path) -> None:
    """CLAUDE.md hard rule, re-checked on the new format paths."""
    src = tmp_path / "src.wav"
    write_wav_bits(src, sine(seconds=2.0), 24)
    before = src.read_bytes()

    render_export(src, tmp_path / "a.wav", [(0.2, 0.4)])
    render_export(src, tmp_path / "b.mp3", [(0.2, 0.4)], fmt="mp3")

    assert src.read_bytes() == before
