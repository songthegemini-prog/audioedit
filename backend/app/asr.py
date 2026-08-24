"""ASR behind a swappable interface (CLAUDE.md: keep the model swappable).

Whisper timestamps are rough — a forced-alignment pass (later phase) must refine
them before any cutting is allowed.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from . import config


SAMPLE_RATE = 16000

# Whisper's own window is 30s and faster-whisper refuses to decode a chunk
# longer than that (it warns and silently keeps only the first 30 seconds).
# Aim well short of it so the search below can never push an edge past the
# limit: 25 + 3 = 28s worst case.
CHUNK_TARGET_SEC = 25.0
CHUNK_SEARCH_SEC = 3.0
_ENERGY_WINDOW_SEC = 0.02
# Never cut again within this long of the previous cut, however quiet it is.
_MIN_CHUNK_SEC = 5.0


def contiguous_chunks(
    samples, sample_rate: int = SAMPLE_RATE
) -> list[dict[str, float]]:
    """Split the timeline into back-to-back chunks for batched decoding.

    Why this exists (reported 2026-08-24: "หายทุกบรรทัด ประมาณสี่ห้าคำ" —
    every line loses four or five words off its end): BatchedInferencePipeline
    decodes VAD-detected chunks INDEPENDENTLY, and its VAD is handed
    max_speech_duration_s = 30. Continuous Thai narration rarely pauses long
    enough to end a speech run, so the run hits that limit and is cut wherever
    it happens to be — mid-word — and the word straddling the cut belongs to
    neither chunk and is simply lost. The chunks are not even contiguous:
    measured 0.32s of audio that no chunk covered at all.

    Two properties fix that, and both are load-bearing:

    1. **Contiguous.** Each chunk starts exactly where the last one ended, so
       no audio can fall between them. This is what makes the loss structural
       rather than accidental.
    2. **Cut where it is quiet.** Each edge is nudged to the lowest-energy
       moment within a few seconds of the target, which in speech means a
       pause between words rather than the middle of one.

    Measured over 180s of the team's own audio, against a sequential decode
    (one pass, no seams, so nothing to lose): text missing fell from 102
    characters to 38, and the part sitting next to a seam from 24 to 8. Speed
    was unchanged at 12s — sequential decoding of the same clip took 372s, so
    simply turning batching off was never an option.
    """
    import numpy as np

    total = len(samples)
    if total == 0:
        return []
    target = int(CHUNK_TARGET_SEC * sample_rate)
    if total <= target:
        return [{"start": 0.0, "end": total / sample_rate}]

    window = max(1, int(_ENERGY_WINDOW_SEC * sample_rate))
    search = int(CHUNK_SEARCH_SEC * sample_rate)
    floor = int(_MIN_CHUNK_SEC * sample_rate)

    edges = [0]
    while total - edges[-1] > target:
        centre = edges[-1] + target
        lo = max(edges[-1] + floor, centre - search)
        hi = min(total, centre + search)
        if hi - lo < window * 2:
            edges.append(centre)
            continue
        region = samples[lo:hi]
        usable = (len(region) // window) * window
        energy = np.abs(region[:usable].reshape(-1, window)).mean(axis=1)
        edges.append(lo + int(energy.argmin()) * window)
    edges.append(total)

    return [
        {"start": edges[i] / sample_rate, "end": edges[i + 1] / sample_rate}
        for i in range(len(edges) - 1)
    ]


@dataclass(frozen=True)
class ASRSegment:
    text: str
    start: float
    end: float


@dataclass
class TranscribeStream:
    duration: float  # total audio duration in seconds, for progress reporting
    segments: Iterator[ASRSegment]


class ASREngine(Protocol):
    def transcribe(self, audio_path: Path) -> TranscribeStream: ...


class FasterWhisperEngine:
    """faster-whisper (CTranslate2) with a local model directory. Fully offline."""

    def __init__(self) -> None:
        self._pipeline = None
        # Which device we ended up on — "cuda" only after it PROVED it works.
        self.device_in_use = "cpu"
        self.gpu_error: str | None = None

    def _try_gpu(self, WhisperModel, path, want: str):
        """Build the model on the GPU and prove it can actually compute.

        Constructing the model is NOT proof. On a machine with an NVIDIA
        driver but no cuBLAS, `WhisperModel(device="cuda")` returns happily
        and the failure only surfaces later, inside `encode()`:
            RuntimeError: Library cublas64_12.dll is not found
        That would strand the user with a model that loads and then breaks on
        every transcription, so we run one tiny encode here and fall back to
        CPU if it throws. One second of silence costs milliseconds.
        """
        import numpy as np

        try:
            model = WhisperModel(
                str(path),
                device=want,
                compute_type=config.compute_type(want),
            )
            silence = np.zeros(16000, dtype=np.float32)  # 1s @ 16kHz
            list(model.transcribe(silence, language="th", beam_size=1)[0])
            self.device_in_use = want
            self.gpu_error = None
            return model
        except Exception as err:  # any failure at all means: use the CPU
            self.gpu_error = f"{type(err).__name__}: {err}"
            return None

    def _load(self):
        if self._pipeline is None:
            # Guarantee no network call even if the model dir is misconfigured.
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            from faster_whisper import (  # heavy import — keep lazy
                BatchedInferencePipeline,
                WhisperModel,
            )

            path = config.model_dir()
            if not path.is_dir():
                raise FileNotFoundError(
                    f"ASR model not found at {path} — run: "
                    ".venv/bin/python scripts/fetch_model.py"
                )
            want = config.device()
            model = None
            if want != "cpu":
                model = self._try_gpu(WhisperModel, path, want)
                if model is None:
                    self.device_in_use = "cpu"
            if model is None:
                model = WhisperModel(
                    str(path),
                    device="cpu",
                    compute_type=config.compute_type("cpu"),
                    cpu_threads=config.cpu_threads(),
                )
            # Batches VAD-detected speech chunks through the model together —
            # several times faster than sequential decoding on the same CPU.
            self._pipeline = BatchedInferencePipeline(model=model)
        return self._pipeline

    def transcribe(self, audio_path: Path) -> TranscribeStream:
        pipeline = self._load()
        # Decoded once here and cached, so the alignment pass that follows
        # does not decode the same hour of audio a second time.
        from .align import decode_audio_cached

        audio = decode_audio_cached(audio_path)
        duration = len(audio) / SAMPLE_RATE
        clips = contiguous_chunks(audio, SAMPLE_RATE)

        segments, _info = pipeline.transcribe(
            audio,
            language="th",
            # Our own chunk list REPLACES the VAD-derived one (faster-whisper
            # ignores vad_filter when clip_timestamps is given). See
            # contiguous_chunks() for why that is the point.
            clip_timestamps=clips,
            beam_size=config.beam_size(),
            batch_size=config.batch_size(),
        )
        return TranscribeStream(
            duration=duration,
            segments=(ASRSegment(s.text, s.start, s.end) for s in segments),
        )
