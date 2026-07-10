"""Render the EDL against the source audio into a NEW file.

CLAUDE.md hard rules honored here:
- the source file is never modified — we only read it and write a new WAV
- every join gets a short crossfade (~10ms) so there is no click
- decoding happens at the source's own sample rate and channel count
  (NOT the 16k mono used for ASR/alignment)

Rendering is STREAMING (Phase 9a): chunks flow decode → stream_edl →
wave-file write, so peak memory stays constant no matter how long the
file is (an hour-long export used to hold ~3 full copies in RAM).
`apply_edl` is the original whole-array implementation, kept as the
golden reference the streaming path is tested against.
"""

from __future__ import annotations

import wave
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path

import numpy as np

CROSSFADE_SEC = 0.010


def _frame_to_float(frame) -> np.ndarray:
    """One PyAV frame → float32 (frames, channels) in [-1, 1]."""
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
    return data


def decode_stream(path: Path) -> tuple[Iterator[np.ndarray], int, float | None]:
    """Open for sequential decode: (chunk iterator, sample_rate, est. duration).

    Duration comes from container metadata and may be None/approximate —
    use it only for progress reporting, never for cutting.
    """
    import av  # bundled with faster-whisper; no system ffmpeg

    container = av.open(str(path))
    stream = container.streams.audio[0]
    sample_rate = stream.rate
    duration = container.duration / av.time_base if container.duration else None

    def chunks() -> Iterator[np.ndarray]:
        try:
            for frame in container.decode(stream):
                yield _frame_to_float(frame)
        finally:
            container.close()

    return chunks(), sample_rate, duration


def decode_native(path: Path) -> tuple[np.ndarray, int]:
    """Decode the WHOLE file to float32 (frames, channels) at the source rate.

    Only for short files/tests — hour-long files must use decode_stream.
    """
    chunks, sample_rate, _ = decode_stream(path)
    parts = list(chunks)
    if not parts:
        raise ValueError(f"no audio decoded from {path}")
    return np.concatenate(parts), sample_rate


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


def kept_intervals(
    cuts: list[tuple[float, float]], sample_rate: int
) -> list[tuple[int, int | None]]:
    """kept_spans in sample indices, without needing the total length:
    the last interval is open-ended (None = until EOF)."""
    positive = sorted(
        (max(0.0, start), end) for start, end in cuts if end > 0 and end > start
    )
    merged: list[list[float]] = []
    for start, end in positive:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    intervals: list[tuple[int, int | None]] = []
    position = 0
    for start, end in merged:
        start_i = int(round(start * sample_rate))
        end_i = int(round(end * sample_rate))
        if start_i > position:
            intervals.append((position, start_i))
        position = max(position, end_i)
    intervals.append((position, None))
    return intervals


def stream_edl(
    chunks: Iterable[np.ndarray],
    sample_rate: int,
    cuts: list[tuple[float, float]],
    crossfade_sec: float = CROSSFADE_SEC,
) -> Iterator[np.ndarray]:
    """Pure streaming version of apply_edl: consume decoded chunks in order,
    drop the cut regions, crossfade every seam. Holds at most ~2 crossfade
    lengths of audio, so memory is O(chunk), not O(file).

    Matches apply_edl sample-for-sample (see the equivalence test)."""
    intervals = kept_intervals(cuts, sample_rate)
    xf = max(0, int(round(crossfade_sec * sample_rate)))

    tail: np.ndarray | None = None  # withheld last ≤xf frames of the output
    head: np.ndarray | None = None  # buffered start of a just-entered span
    current: int | None = None  # interval index being consumed

    def emit(arr: np.ndarray) -> np.ndarray:
        """Push frames into the output stream, withholding the trailing xf
        frames (they may still be blended with the next span's head)."""
        nonlocal tail
        if tail is not None and len(tail):
            arr = np.concatenate([tail, arr])
        keep = min(xf, len(arr))
        tail = arr[len(arr) - keep :]
        return arr[: len(arr) - keep]

    def join_head() -> np.ndarray:
        """Crossfade the buffered head into the withheld tail (one seam).
        n mirrors apply_edl: min(xf, output so far, span length)."""
        nonlocal tail, head
        buffered = head
        head = None
        assert buffered is not None
        tail_len = len(tail) if tail is not None else 0
        n = min(xf, tail_len, len(buffered))
        if n > 0:
            assert tail is not None
            fade_in = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
            blended = tail[-n:] * (1.0 - fade_in) + buffered[:n] * fade_in
            joined = np.concatenate([tail[:-n], blended, buffered[n:]])
        elif tail is not None and len(tail):
            joined = np.concatenate([tail, buffered])
        else:
            joined = buffered
        tail = None  # joined re-enters the stream through emit()
        return emit(joined)

    def head_ready() -> bool:
        # blend size is min(xf, len(tail)); once the head has that many
        # frames the blend result can't change, so join immediately
        tail_len = len(tail) if tail is not None else 0
        return head is not None and len(head) >= min(xf, tail_len)

    position = 0
    for chunk in chunks:
        n = len(chunk)
        for idx, (start, end) in enumerate(intervals):
            span_end = end if end is not None else position + n
            lo = max(start, position)
            hi = min(span_end, position + n)
            if hi <= lo:
                continue
            frag = chunk[lo - position : hi - position]
            if current is None:  # very first span: no seam, straight through
                current = idx
                out = emit(frag)
            elif idx == current and head is None:
                out = emit(frag)
            elif idx == current:  # still buffering this span's head
                head = np.concatenate([head, frag])  # type: ignore[arg-type]
                out = join_head() if head_ready() else frag[:0]
            else:  # entering a new span → seam
                out = frag[:0]
                if head is not None:  # previous span ended tiny, join it first
                    out = join_head()
                current = idx
                head = frag
                if head_ready():
                    more = join_head()
                    out = np.concatenate([out, more]) if len(out) else more
            if len(out):
                yield out
        position += n

    if head is not None:  # stream ended while buffering a span head
        out = join_head()
        if len(out):
            yield out
    if tail is not None and len(tail):
        yield tail


def apply_edl(
    samples: np.ndarray,
    sample_rate: int,
    cuts: list[tuple[float, float]],
    crossfade_sec: float = CROSSFADE_SEC,
) -> np.ndarray:
    """Whole-array reference implementation (golden for tests; fine for
    short files). Join the kept spans with a linear crossfade at every seam."""
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


def _to_int16(samples: np.ndarray) -> np.ndarray:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(samples.shape[1])
        w.setsampwidth(2)  # 16-bit PCM
        w.setframerate(sample_rate)
        w.writeframes(_to_int16(samples).tobytes())


def render_export(
    source: Path,
    out_path: Path,
    cuts: list[tuple[float, float]],
    on_progress: Callable[[float], None] | None = None,
    check_cancelled: Callable[[], None] | None = None,
) -> dict:
    """Stream source → EDL → 16-bit WAV with constant memory."""
    chunks, sample_rate, est_duration = decode_stream(source)

    consumed = 0  # input frames seen, for progress

    def tracked() -> Iterator[np.ndarray]:
        nonlocal consumed
        for chunk in chunks:
            if check_cancelled is not None:
                check_cancelled()
            consumed += len(chunk)
            if on_progress is not None and est_duration:
                on_progress(min(consumed / sample_rate / est_duration, 1.0))
            yield chunk

    frames_written = 0
    channels = 0
    writer: wave.Wave_write | None = None
    try:
        for block in stream_edl(tracked(), sample_rate, cuts):
            if writer is None:
                channels = block.shape[1]
                writer = wave.open(str(out_path), "wb")
                writer.setnchannels(channels)
                writer.setsampwidth(2)  # 16-bit PCM
                writer.setframerate(sample_rate)
            writer.writeframes(_to_int16(block).tobytes())
            frames_written += len(block)
        if writer is None:  # everything cut — still produce a valid empty WAV
            if consumed == 0:
                raise ValueError(f"no audio decoded from {source}")
            writer = wave.open(str(out_path), "wb")
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(sample_rate)
    finally:
        if writer is not None:
            writer.close()

    return {
        "out_path": str(out_path),
        "duration": frames_written / sample_rate,
        "sample_rate": sample_rate,
        "channels": channels,
    }
