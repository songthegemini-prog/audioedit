"""Pure token logic: Thai word segmentation + rough per-word timing.

Core data structure per CLAUDE.md: token = {text, start, end, isFiller, docCharRange}.
Timestamps produced here are ROUGH (proportional split of whisper segment times)
and must never be used to cut audio before a forced-alignment pass.
"""

from __future__ import annotations

from dataclasses import dataclass

from pythainlp.tokenize import syllable_tokenize, word_tokenize

# newmm's longest-match can glue compounds/unknown spans into one big chunk
# ("เงินทุกบาททุกสตางค์" as 1-2 tokens) — too coarse to select for cutting.
# Chunks longer than this get re-split into syllables; the CTC aligner then
# times each piece precisely on its own.
MAX_TOKEN_CHARS = 9

# เสียงลังเล/คำอุทานที่มักไม่อยู่ใน .docx ที่แก้แล้ว
DEFAULT_FILLER_WORDS = frozenset(
    {"อ่า", "อ้า", "อือ", "อืม", "อึม", "เอ่อ", "เอ้อ", "เออ", "เอิ่ม", "ฮึม", "อ๋อ", "เอ่", "อะ"}
)


@dataclass(frozen=True)
class Token:
    text: str
    start: float
    end: float
    is_filler: bool
    doc_char_range: tuple[int, int] | None = None
    confidence: float | None = None  # alignment confidence; None = not aligned yet

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "isFiller": self.is_filler,
            "docCharRange": self.doc_char_range,
            "confidence": self.confidence,
        }


def _split_long_chunk(word: str) -> list[str]:
    if len(word) <= MAX_TOKEN_CHARS:
        return [word]
    # engine="dict" ships with pythainlp (default han_solo needs pycrfsuite)
    parts = [p for p in syllable_tokenize(word, engine="dict") if p.strip()]
    return parts if len(parts) > 1 else [word]


def segment_words(text: str) -> list[str]:
    """Thai-aware word segmentation (newmm). Whitespace is NOT a word boundary.
    Overlong dictionary chunks are re-split into syllables for cut granularity."""
    words = [w for w in word_tokenize(text.strip(), engine="newmm") if w.strip()]
    return [part for word in words for part in _split_long_chunk(word)]


def segment_to_tokens(
    text: str,
    start: float,
    end: float,
    fillers: frozenset[str] = DEFAULT_FILLER_WORDS,
) -> list[Token]:
    """Split a whisper segment into word tokens, distributing [start, end]
    across words proportionally to their character length."""
    words = segment_words(text)
    if not words:
        return []

    duration = max(end - start, 0.0)
    total_chars = sum(len(w) for w in words)
    tokens: list[Token] = []
    cursor = start
    for i, word in enumerate(words):
        if i == len(words) - 1:
            word_end = end  # snap the last word exactly to the segment end
        else:
            word_end = cursor + duration * (len(word) / total_chars)
        tokens.append(
            Token(
                text=word,
                start=round(cursor, 3),
                end=round(word_end, 3),
                is_filler=word in fillers,
            )
        )
        cursor = word_end
    return tokens
