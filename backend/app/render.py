"""Render the EDL against the source audio into a NEW file.

CLAUDE.md hard rules honored here:
- the source file is never modified — we only read it and write a new WAV
- every join gets a short crossfade (~10ms) so there is no click
- decoding happens at the source's own sample rate and channel count
  (NOT the 16k mono used for ASR/alignment)
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

CROSSFADE_SEC = 0.010


def decode_native(path: Path) -> tuple[np.ndarray, int]:
    """Decode to float32 (frames, channels) at the source rate — no resampling."""
    import av  # bundled with faster-whisper; no system ffmpeg

    container = av.open(str(path))
    stream = container.streams.audio[0]
    sample_rate = stream.rate
    chunks: list[np.ndarray] = []
    for frame in container.decode(stream):
        arr = frame.to_ndarray()
        channels = len(frame.layout.channels)
        if frame.format.name.endswith("p"):  # planar: (channels, n)
            data = arr.T
        else:  # packed/interleaved: (1, n * channels)
            data = arr.reshape(-1, channels)
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        elif data.dtype == np.int32:
            data = data.astype(np.float32) / 2147483648.0
        elif data.dtype == np.uint8:
            data = (data.astype(np.float32) - 128.0) / 128.0
        else:
            data = data.astype(np.float32)
        chunks.append(data)
    container.close()
    if not chunks:
        raise ValueError(f"no audio decoded from {path}")
    return np.concatenate(chunks), sample_rate


def kept_spans(
    cuts: list[tuple[float, float]], total_sec: float
) -> list[tuple[float, float]]:
    """Complement of the cut list: the spans of audio that survive.
    Cuts are clamped to the file, sorted, and overlapping cuts merged."""
    clamped = sorted(
        (max(0.0, start), min(end, total_sec))
        for start, end in cuts
        if end > 0 and start < total_sec and end > start
    )
    merged: list[list[float]] = []
    for start, end in clamped:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    spans: list[tuple[float, float]] = []
    position = 0.0
    for start, end in merged:
        if start > position:
            spans.append((position, start))
        position = end
    if position < total_sec:
        spans.append((position, total_sec))
    return spans


def apply_edl(
    samples: np.ndarray,
    sample_rate: int,
    cuts: list[tuple[float, float]],
    crossfade_sec: float = CROSSFADE_SEC,
) -> np.ndarray:
    """Join the kept spans with a linear crossfade at every seam."""
    total_sec = len(samples) / sample_rate
    spans = kept_spans(cuts, total_sec)
    if not spans:
        return np.zeros((0, samples.shape[1]), dtype=np.float32)

    pieces = [
        samples[int(round(start * sample_rate)) : int(round(end * sample_rate))]
        for start, end in spans
    ]
    out = pieces[0].copy()
    xf = int(round(crossfade_sec * sample_rate))
    for piece in pieces[1:]:
        n = min(xf, len(out), len(piece))
        if n > 0:
            fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
            out[-n:] = out[-n:] * (1.0 - fade_in) + piece[:n] * fade_in
            out = np.concatenate([out, piece[n:]])
        else:
            out = np.concatenate([out, piece])
    return out


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    ints = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(samples.shape[1])
        w.setsampwidth(2)  # 16-bit PCM
        w.setframerate(sample_rate)
        w.writeframes(ints.tobytes())


def render_export(
    source: Path, out_path: Path, cuts: list[tuple[float, float]]
) -> dict:
    samples, sample_rate = decode_native(source)
    rendered = apply_edl(samples, sample_rate, cuts)
    write_wav(out_path, rendered, sample_rate)
    return {
        "out_path": str(out_path),
        "duration": len(rendered) / sample_rate,
        "sample_rate": sample_rate,
        "channels": rendered.shape[1] if len(rendered) else 0,
    }
