"""Align a known script against (possibly hour-long) audio, line by line.

The "มีบทอยู่แล้ว" mode: no ASR involved. Each script line is force-aligned
inside a search window that starts where the previous line ended, so memory
stays bounded no matter how long the file is. Lines that refuse to align
(script/audio mismatch) get estimated times with confidence 0 — flagged red
for the reviewer, never fatal.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from .align_spans import WordSpan
from .tokens import Token, segment_to_tokens, segment_words

CHARS_PER_SEC = 12.0  # rough Thai narration speed, only for window sizing
WINDOW_SLACK_SEC = 5.0
MAX_WINDOW_SEC = 60.0  # bounds wav2vec2 memory per call
# Lines are aligned in ~35s batches: forced alignment spreads the target over
# the WHOLE window, so a window must contain (almost) exactly the words being
# aligned — aligning line-by-line with loose windows stretches each line over
# its neighbours' audio and the cursor runs away.
TARGET_BATCH_SEC = 35.0


def read_script(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        from docx import Document  # python-docx

        return "\n".join(p.text for p in Document(str(path)).paragraphs)
    return path.read_text(encoding="utf-8")


def script_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def estimate_duration(line: str) -> float:
    return len(line) / CHARS_PER_SEC


def batch_lines(lines: list[str]) -> list[list[str]]:
    """Group consecutive lines into ~TARGET_BATCH_SEC batches (by estimate)."""
    batches: list[list[str]] = []
    current: list[str] = []
    acc = 0.0
    for line in lines:
        current.append(line)
        acc += estimate_duration(line)
        if acc >= TARGET_BATCH_SEC:
            batches.append(current)
            current = []
            acc = 0.0
    if current:
        batches.append(current)
    return batches


def window_for_batch(
    cursor: float, batch: list[str], total_sec: float, widen: float = 1.0
) -> tuple[float, float]:
    """Search window for a batch starting at the running cursor."""
    # keep the window tight: extra slack lets the aligner latch onto
    # neighbouring (or repeated) content and drift
    est = sum(estimate_duration(line) for line in batch)
    length = min((est * 1.2 + WINDOW_SLACK_SEC) * widen, MAX_WINDOW_SEC)
    return cursor, min(cursor + length, total_sec)


def line_tokens(
    text: str,
    fallback_start: float,
    fallback_end: float,
    spans: list[WordSpan | None] | None,
) -> list[Token]:
    """Tokens for one line: aligned times where available, proportional
    fallback (confidence 0) where not. Shared with the /realign endpoint."""
    rough = segment_to_tokens(text, fallback_start, fallback_end)
    if spans is None:
        return [replace(t, confidence=0.0) for t in rough]
    refined: list[Token] = []
    for token, span in zip(rough, spans):
        if span is None:
            refined.append(replace(token, confidence=0.0))
        else:
            refined.append(
                replace(token, start=span.start, end=span.end, confidence=span.confidence)
            )
    return refined


@dataclass
class AlignedLine:
    text: str
    start: float
    end: float
    tokens: list[Token]


AlignWindowFn = Callable[[float, float, list[str]], "list[WordSpan | None] | None"]


def align_script_lines(
    lines: list[str],
    total_sec: float,
    align_window: AlignWindowFn,
    progress: Callable[[float], None] | None = None,
) -> list[AlignedLine]:
    """Align batches of consecutive lines; the cursor advances batch by batch."""
    out: list[AlignedLine] = []
    cursor = 0.0
    done = 0
    for batch in batch_lines(lines):
        words_per_line = [segment_words(line) for line in batch]
        all_words = [w for words in words_per_line for w in words]

        spans: list[WordSpan | None] | None = None
        if all_words:
            for widen in (1.0, 1.6):  # retry once with a wider window
                w_start, w_end = window_for_batch(cursor, batch, total_sec, widen)
                try:
                    got = align_window(w_start, w_end, all_words)
                except Exception:
                    got = None
                if got is not None and any(s is not None for s in got):
                    spans = got
                    break

        # split the batch's spans back into per-line tokens
        offset = 0
        for line, words in zip(batch, words_per_line):
            done += 1
            if not words:
                continue
            line_spans = spans[offset : offset + len(words)] if spans else None
            offset += len(words)
            est_end = min(cursor + estimate_duration(line), total_sec)
            tokens = line_tokens(line, cursor, est_end, line_spans)
            out.append(
                AlignedLine(text=line, start=tokens[0].start, end=tokens[-1].end, tokens=tokens)
            )
            cursor = max(tokens[-1].end, cursor)
            if progress:
                progress(done / len(lines))
    return out
