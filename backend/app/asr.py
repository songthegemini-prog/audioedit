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
            model = WhisperModel(
                str(path),
                device=config.device(),
                compute_type=config.compute_type(),
                cpu_threads=config.cpu_threads(),
            )
            # Batches VAD-detected speech chunks through the model together —
            # several times faster than sequential decoding on the same CPU.
            self._pipeline = BatchedInferencePipeline(model=model)
        return self._pipeline

    def transcribe(self, audio_path: Path) -> TranscribeStream:
        pipeline = self._load()
        segments, info = pipeline.transcribe(
            str(audio_path),
            language="th",
            vad_filter=True,
            beam_size=config.beam_size(),
            batch_size=config.batch_size(),
        )
        return TranscribeStream(
            duration=info.duration,
            segments=(ASRSegment(s.text, s.start, s.end) for s in segments),
        )
