"""Output format for exports: bit depth preservation + encoders.

Why this module exists (team feedback 2026-08-20): the editors verify our
work by comparing the source against the export in an audio analyser, checking
that we did not change the audio's energy or compress it. Rendering everything
to 16-bit made a 24-bit source come back "different" and cost them trust, even
though the samples were untouched. So: an export keeps the source's own bit
depth, and any conversion is a deliberate, documented choice.

PyAV does NOT report bit depth reliably — `bits_per_raw_sample` is None and
`format.bits` says 32 for a 24-bit file (24-bit PCM decodes into an s32
buffer). The codec NAME is exact (`pcm_s24le`), so that is what we read.
"""

from __future__ import annotations

import re
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Lossy codecs have no meaningful "bit depth" — the samples were reconstructed
# from a compressed representation. 16-bit is the honest container for them.
LOSSY_CODECS = frozenset(
    {
        "mp3",
        "mp3float",
        "aac",
        "ac3",
        "eac3",
        "vorbis",
        "opus",
        "wmav1",
        "wmav2",
        "amrnb",
        "amrwb",
    }
)

_PCM_INT = re.compile(r"^pcm_[su](\d+)(le|be)?$")


@dataclass(frozen=True)
class SourceFormat:
    """What the source file natively is — the target an export should match."""

    sample_rate: int
    channels: int
    bits: int  # 16 / 24 / 32, the width an export should be written at
    codec: str
    lossy: bool

    @property
    def sample_width(self) -> int:
        """Bytes per sample for the `wave` module."""
        return self.bits // 8


def bits_for_codec(codec_name: str, format_bits: int) -> int:
    """Bit depth an export should use for a source in `codec_name`.

    Integer PCM keeps its own width (8-bit is widened to 16 — nothing writes
    8-bit masters and `wave` handles 8-bit as unsigned, a needless trap).
    Float PCM becomes 32-bit int: we clip to [-1, 1] on write anyway, and the
    `wave` module cannot emit WAVE_FORMAT_IEEE_FLOAT.
    """
    if codec_name in LOSSY_CODECS:
        return 16
    m = _PCM_INT.match(codec_name)
    if m:
        bits = int(m.group(1))
        if bits <= 16:
            return 16
        return 24 if bits == 24 else 32
    if codec_name.startswith("pcm_f"):  # pcm_f32le / pcm_f64le
        return 32
    if codec_name in ("flac", "alac", "wavpack", "tta"):
        # lossless but not PCM: the decode format is trustworthy here
        return 24 if format_bits > 16 else 16
    return 16  # unknown → the safe, universally readable default


def probe_format(path: Path) -> SourceFormat:
    """Read the source's native rate/channels/bit depth without decoding it."""
    import av  # bundled with faster-whisper; no system ffmpeg

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        cc = stream.codec_context
        codec = cc.name
        return SourceFormat(
            sample_rate=stream.rate,
            channels=cc.layout.nb_channels,
            bits=bits_for_codec(codec, cc.format.bits),
            codec=codec,
            lossy=codec in LOSSY_CODECS,
        )


def float_to_pcm_bytes(samples: np.ndarray, bits: int) -> bytes:
    """float32 (frames, channels) in [-1, 1] → interleaved little-endian PCM.

    24-bit has no numpy dtype, so it is written as the low 3 bytes of each
    int32 sample (little-endian: bytes 0..2).
    """
    clipped = np.clip(samples, -1.0, 1.0)
    if bits == 16:
        return (clipped * 32767.0).astype("<i2").tobytes()
    if bits == 24:
        as32 = (clipped * 8388607.0).astype("<i4")
        return as32.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    if bits == 32:
        return (clipped * 2147483647.0).astype("<i4").tobytes()
    raise ValueError(f"unsupported bit depth: {bits}")


class WavWriter:
    """Streaming WAV writer at an explicit bit depth."""

    def __init__(self, path: Path, sample_rate: int, channels: int, bits: int) -> None:
        self.bits = bits
        self._w = wave.open(str(path), "wb")
        self._w.setnchannels(channels)
        self._w.setsampwidth(bits // 8)
        self._w.setframerate(sample_rate)

    def write(self, block: np.ndarray) -> None:
        self._w.writeframes(float_to_pcm_bytes(block, self.bits))

    def close(self) -> None:
        self._w.close()


class Mp3Writer:
    """Streaming MP3 writer (libmp3lame, bundled with PyAV).

    MP3 is an intentionally lossy delivery format — it is offered because the
    team asked to hand off small files, NOT as a master. The bit-depth
    preservation above does not apply: everything is fed to the encoder as
    16-bit, which is what libmp3lame consumes.
    """

    def __init__(
        self, path: Path, sample_rate: int, channels: int, bitrate: int = 192_000
    ) -> None:
        import av

        self.channels = channels
        # format="mp3" is REQUIRED, not a nicety: render_export writes to a
        # unique "<name>.<hex>.part" temp and renames on success, and PyAV
        # cannot infer a container from a ".part" extension.
        self._container = av.open(str(path), "w", format="mp3")
        # The layout MUST be passed to add_stream: PyAV defaults an mp3 stream
        # to stereo, which silently turned a mono source into a 2-channel
        # export (caught by the round-trip test below).
        self._layout = "mono" if channels == 1 else "stereo"
        self._stream = self._container.add_stream(
            "mp3", rate=sample_rate, layout=self._layout
        )
        self._stream.bit_rate = bitrate

    def write(self, block: np.ndarray) -> None:
        import av

        pcm = (np.clip(block, -1.0, 1.0) * 32767.0).astype("<i2")
        # PyAV wants (channels, samples) for packed s16 as a single plane:
        # interleaved samples in one row.
        frame = av.AudioFrame.from_ndarray(
            pcm.reshape(1, -1), format="s16", layout=self._layout
        )
        frame.rate = self._stream.rate
        for packet in self._stream.encode(frame):
            self._container.mux(packet)

    def close(self) -> None:
        for packet in self._stream.encode(None):  # flush the encoder
            self._container.mux(packet)
        self._container.close()
