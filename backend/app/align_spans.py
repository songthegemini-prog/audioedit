"""Pure span math for forced alignment — no torch imports, fully unit-testable.

The CTC aligner produces one span per *character* (Thai chars ≈ near-phoneme
granularity). These helpers fold char spans back into word-level times and
confidences, following the same word order as PyThaiNLP segmentation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class CharSpan:
    start_frame: int
    end_frame: int  # exclusive
    score: float  # 0..1


@dataclass(frozen=True)
class WordSpan:
    start: float  # seconds, absolute
    end: float
    confidence: float  # 0..1


def words_from_char_spans(
    char_spans: Sequence[CharSpan],
    kept_chars_per_word: Sequence[int],
    frame_sec: float,
    offset_sec: float,
) -> list[WordSpan | None]:
    """Fold per-char spans into per-word spans.

    kept_chars_per_word[i] = how many chars of word i made it into the CTC
    target sequence (chars missing from the model vocab are dropped). A word
    with 0 kept chars gets None — the caller keeps its rough timestamp.
    """
    if sum(kept_chars_per_word) != len(char_spans):
        raise ValueError(
            f"span/word mismatch: {len(char_spans)} char spans vs "
            f"{sum(kept_chars_per_word)} kept chars"
        )

    words: list[WordSpan | None] = []
    idx = 0
    for kept in kept_chars_per_word:
        if kept == 0:
            words.append(None)
            continue
        chunk = char_spans[idx : idx + kept]
        idx += kept
        words.append(
            WordSpan(
                start=round(offset_sec + chunk[0].start_frame * frame_sec, 3),
                end=round(offset_sec + chunk[-1].end_frame * frame_sec, 3),
                confidence=round(sum(c.score for c in chunk) / len(chunk), 3),
            )
        )
    return words
