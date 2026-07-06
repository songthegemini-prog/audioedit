"""Forced alignment behind a swappable interface (MFA is a future drop-in).

CTCAligner: Thai char-level CTC (wav2vec2) + torchaudio forced_align.
Each whisper segment is aligned independently against its newmm words, so long
files stay memory-bounded (segments are ≤ ~30s).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from . import config
from .align_spans import CharSpan, WordSpan, words_from_char_spans

SAMPLE_RATE = 16000
PAD_SEC = 0.25  # slack around each segment so edge words aren't clipped

_decode_cache: dict[tuple[str, float], "object"] = {}


def decode_audio_cached(audio_path: Path):
    """Decoded 16k mono samples, cached by (path, mtime) — per-line alignment
    and /realign calls must not re-decode a one-hour file every time."""
    from faster_whisper.audio import decode_audio  # PyAV — no system ffmpeg

    key = (str(audio_path), audio_path.stat().st_mtime)
    if key not in _decode_cache:
        _decode_cache.clear()  # keep at most one file in memory
        _decode_cache[key] = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)
    return _decode_cache[key]


def audio_duration(audio_path: Path) -> float:
    return len(decode_audio_cached(audio_path)) / SAMPLE_RATE


@dataclass(frozen=True)
class SegmentWords:
    start: float
    end: float
    words: list[str]


class Aligner(Protocol):
    def align(
        self, audio_path: Path, segments: list[SegmentWords]
    ) -> Iterator[list[WordSpan | None]]:
        """Yield word spans for each segment, in order. None = keep rough time."""
        ...


class CTCAligner:
    def __init__(self) -> None:
        self._model = None
        self._vocab: dict[str, int] | None = None
        self._blank_id = 0

    def _load(self) -> None:
        if self._model is not None:
            return
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor  # lazy, heavy

        path = config.align_model_dir()
        if not path.is_dir():
            raise FileNotFoundError(
                f"alignment model not found at {path} — run: "
                ".venv/bin/python scripts/fetch_model.py"
            )
        processor = Wav2Vec2Processor.from_pretrained(str(path))
        self._model = Wav2Vec2ForCTC.from_pretrained(str(path)).eval()
        self._vocab = processor.tokenizer.get_vocab()
        self._blank_id = processor.tokenizer.pad_token_id

    def align(
        self, audio_path: Path, segments: list[SegmentWords]
    ) -> Iterator[list[WordSpan | None]]:
        self._load()
        import torch

        audio = decode_audio_cached(audio_path)
        total_sec = len(audio) / SAMPLE_RATE

        for seg in segments:
            slice_start = max(seg.start - PAD_SEC, 0.0)
            slice_end = min(seg.end + PAD_SEC, total_sec)
            chunk = audio[int(slice_start * SAMPLE_RATE) : int(slice_end * SAMPLE_RATE)]
            if len(chunk) == 0:
                yield [None] * len(seg.words)
                continue
            yield self._align_chunk(torch.from_numpy(chunk), seg.words, slice_start)

    def _align_chunk(
        self, waveform, words: list[str], offset_sec: float
    ) -> list[WordSpan | None]:
        import torch
        import torchaudio.functional as F

        assert self._model is not None and self._vocab is not None
        target_ids: list[int] = []
        kept_per_word: list[int] = []
        for word in words:
            kept = 0
            for ch in word:
                token_id = self._vocab.get(ch)
                if token_id is not None:
                    target_ids.append(token_id)
                    kept += 1
            kept_per_word.append(kept)
        if not target_ids:
            return [None] * len(words)

        with torch.inference_mode():
            emission = self._model(waveform.unsqueeze(0)).logits.log_softmax(dim=-1)

        try:
            aligned, scores = F.forced_align(
                emission,
                torch.tensor([target_ids], dtype=torch.int32),
                blank=self._blank_id,
            )
        except RuntimeError:
            # target longer than emission frames (e.g. hallucinated text) —
            # let these words keep their rough times
            return [None] * len(words)

        token_spans = F.merge_tokens(aligned[0], scores[0].exp(), blank=self._blank_id)
        char_spans = [CharSpan(s.start, s.end, float(s.score)) for s in token_spans]
        frame_sec = (len(waveform) / SAMPLE_RATE) / emission.shape[1]
        return words_from_char_spans(char_spans, kept_per_word, frame_sec, offset_sec)
