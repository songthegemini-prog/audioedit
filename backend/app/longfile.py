"""Canonical on-disk WAV for hour-long files (Phase 9b).

Long files can't be decoded into frontend RAM, so we transcode the source
ONCE into a canonical 16-bit PCM WAV in the cache dir (streaming write,
constant memory), computing display peaks in the same pass. Everything
the frontend needs then reads from that one file:

- the media element streams it over HTTP Range (playback),
- the spectrogram / snap fetch small Float32 windows (display),
- the waveform draws the precomputed peaks.

Display and playback therefore consume the SAME PCM by construction —
the property that killed the m4a/codec-delay bugs (FIXES.md #7/#13).
"""

from __future__ import annotations

import hashlib
import json
import struct
import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np

from .config import DATA_ROOT
from .render import decode_stream

PEAK_BUCKET = 1024  # samples per min/max pair (display resolution)
CACHE_KEEP = 3  # newest prepared files kept; older ones pruned
MAX_WINDOW_SEC = 120.0  # /pcm guard: one window must stay small


def cache_dir() -> Path:
    d = DATA_ROOT / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_key(path: Path) -> str:
    """Stable per source file+version: re-prepared if the file changes."""
    st = path.stat()
    raw = f"{path.resolve()}|{st.st_mtime_ns}|{st.st_size}"
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def wav_path_for(path: Path) -> Path:
    return cache_dir() / f"{cache_key(path)}.wav"


def peaks_path_for(path: Path) -> Path:
    return cache_dir() / f"{cache_key(path)}.peaks"


def probe(path: Path) -> dict:
    """Fast metadata-only look: duration/rate/channels without decoding."""
    import av

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        duration = (
            container.duration / av.time_base if container.duration else None
        )
        return {
            "duration": duration,
            "sample_rate": stream.rate,
            "channels": len(stream.layout.channels),
            # "prepared" needs BOTH the WAV and its peaks — a crash between the
            # WAV rename and the peaks write leaves an orphan WAV that would
            # make the frontend skip prepare() and then fail on fetchPeaks
            # (Codex review #9)
            "prepared": wav_path_for(path).exists() and peaks_path_for(path).exists(),
        }


def prepare(
    path: Path,
    on_progress: Callable[[float], None] | None = None,
    check_cancelled: Callable[[], None] | None = None,
) -> dict:
    """Stream-transcode source → canonical WAV + peaks sidecar. Idempotent."""
    wav_out = wav_path_for(path)
    peaks_out = peaks_path_for(path)
    if wav_out.exists() and peaks_out.exists():
        return _info(path, wav_out, peaks_out)

    chunks, sample_rate, est_duration = decode_stream(path)
    tmp_wav = wav_out.with_suffix(".part")

    peaks: list[float] = []  # interleaved min,max per bucket (channel 0)
    leftover = np.empty(0, dtype=np.float32)
    consumed = 0
    channels = 0

    writer: wave.Wave_write | None = None
    try:
        for chunk in chunks:
            if check_cancelled is not None:
                check_cancelled()
            if writer is None:
                channels = chunk.shape[1]
                writer = wave.open(str(tmp_wav), "wb")
                writer.setnchannels(channels)
                writer.setsampwidth(2)  # 16-bit PCM
                writer.setframerate(sample_rate)
            ints = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2")
            writer.writeframes(ints.tobytes())

            # peaks from channel 0 — same channel the display windows use
            mono = np.concatenate([leftover, chunk[:, 0]])
            full = (len(mono) // PEAK_BUCKET) * PEAK_BUCKET
            if full:
                buckets = mono[:full].reshape(-1, PEAK_BUCKET)
                pair = np.empty((len(buckets), 2), dtype=np.float32)
                pair[:, 0] = buckets.min(axis=1)
                pair[:, 1] = buckets.max(axis=1)
                peaks.extend(pair.ravel().tolist())
            leftover = mono[full:]

            consumed += len(chunk)
            if on_progress is not None and est_duration:
                on_progress(min(consumed / sample_rate / est_duration, 1.0))
    except BaseException:
        if writer is not None:
            writer.close()
            writer = None
        tmp_wav.unlink(missing_ok=True)
        raise
    finally:
        if writer is not None:
            writer.close()

    if consumed == 0:
        raise ValueError(f"no audio decoded from {path}")
    if len(leftover):
        peaks.extend([float(leftover.min()), float(leftover.max())])

    # Write peaks to a temp then atomic-replace BOTH files, and use replace()
    # (not rename()) so re-preparing an orphan WAV works on Windows too, where
    # rename() fails if the destination exists (Codex re-review #4). "prepared"
    # is only ever true when both complete files are present.
    tmp_peaks = peaks_out.with_suffix(".peaks.part")
    np.asarray(peaks, dtype="<f4").tofile(tmp_peaks)
    tmp_wav.replace(wav_out)
    tmp_peaks.replace(peaks_out)
    prune_cache()
    return _info(path, wav_out, peaks_out)


def _info(path: Path, wav_out: Path, peaks_out: Path) -> dict:
    with wave.open(str(wav_out)) as w:
        frames, rate, channels = w.getnframes(), w.getframerate(), w.getnchannels()
    return {
        "wav_path": str(wav_out),
        "duration": frames / rate,
        "sample_rate": rate,
        "channels": channels,
        "peak_bucket": PEAK_BUCKET,
        "peak_pairs": peaks_out.stat().st_size // 8,  # 2 × float32
    }


def prune_cache(keep: int = CACHE_KEEP) -> None:
    """Cache WAVs are ~600MB/hour — keep only the newest few."""
    wavs = sorted(
        cache_dir().glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    for old in wavs[keep:]:
        old.unlink(missing_ok=True)
        old.with_suffix(".peaks").unlink(missing_ok=True)


def read_peaks(path: Path) -> bytes:
    return peaks_path_for(path).read_bytes()


def read_pcm_window(path: Path, start_sec: float, end_sec: float) -> tuple[bytes, int]:
    """Float32 mono (channel 0) window read straight from the canonical WAV —
    no re-decode, so it is bit-identical to what the media element plays."""
    if end_sec <= start_sec:
        raise ValueError("end must be after start")
    if end_sec - start_sec > MAX_WINDOW_SEC:
        raise ValueError(f"window too long (max {MAX_WINDOW_SEC:.0f}s)")
    wav_file = wav_path_for(path)
    with wave.open(str(wav_file)) as w:
        rate, channels, total = w.getframerate(), w.getnchannels(), w.getnframes()
        start = max(0, min(int(round(start_sec * rate)), total))
        end = max(start, min(int(round(end_sec * rate)), total))
        w.setpos(start)
        raw = w.readframes(end - start)
    ints = np.frombuffer(raw, dtype="<i2").reshape(-1, channels)
    mono = (ints[:, 0].astype(np.float32) / 32768.0).astype("<f4")
    return mono.tobytes(), rate


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """'bytes=a-b' → inclusive (start, end) clamped to size, or None."""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes=") :].split(",")[0].strip()
    if "-" not in spec:
        return None
    left, _, right = spec.partition("-")
    try:
        if left == "":  # suffix form: last N bytes
            n = int(right)
            if n <= 0:
                return None
            return max(0, size - n), size - 1
        start = int(left)
        end = int(right) if right else size - 1
    except ValueError:
        return None
    if start >= size or start < 0:
        return None
    return start, min(end, size - 1)
