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

# Fallback only. The real rate is measured per file — see chars_per_sec().
CHARS_PER_SEC = 12.0
# A measured rate outside this range means the script does not describe this
# audio (a fragment pasted against a whole programme, or the wrong file), so
# the guess is safer than the measurement.
MIN_CHARS_PER_SEC = 4.0
MAX_CHARS_PER_SEC = 20.0
WINDOW_SLACK_SEC = 5.0
# Bounds wav2vec2 memory per call — and, not by design, keeps the window close
# to the length of the words in it. A batch of two lines needs ~58s of audio at
# a 9 char/sec read, and this cap trims the 1.2x headroom back to ~60s, which
# is the tightness forced alignment wants. Loosening it is not an improvement:
# raising it to 90s dropped the team's file from 77 of 103 lines to 7, and
# splitting into smaller batches (40s window for 29s of words) gave 3. A sweep
# of the multiplier was not even monotonic — 1.05 scored 58, 1.10 scored 13.
# Treat these three numbers as one calibrated set and re-measure end to end if
# any of them changes (2026-08-24).
MAX_WINDOW_SEC = 60.0
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


def chars_per_sec(lines: list[str], total_sec: float) -> float:
    """How fast this narrator actually reads, in characters per second.

    Everything about the search windows is derived from this, and a wrong
    value poisons the whole pass: the constant said 12.0 while the team's
    narrator reads at 9.0, so every window came out a quarter too short, the
    aligner had to squeeze each batch of words into too little audio, and the
    error compounded down the file. Measured on their own programme, 3 of 108
    lines aligned with any confidence and the cursor finished 84 seconds short
    of the end (reported 2026-08-24: "ตรึงบทไม่ถูกเลย ... มีถูกเป็นบางบรรทัด").
    Measuring the rate instead: 89 of 103, and it reaches the end.

    Both numbers are known before alignment starts, so there is no reason to
    guess. The clamp catches the case where they do not describe each other —
    a few pasted paragraphs against an hour of audio would otherwise compute
    an absurdly slow rate and stretch every window over its neighbours.
    """
    chars = sum(len(line) for line in lines)
    if total_sec <= 0 or chars == 0:
        return CHARS_PER_SEC
    measured = chars / total_sec
    return min(max(measured, MIN_CHARS_PER_SEC), MAX_CHARS_PER_SEC)


def estimate_duration(line: str, rate: float = CHARS_PER_SEC) -> float:
    return len(line) / rate


def batch_lines(lines: list[str], rate: float = CHARS_PER_SEC) -> list[list[str]]:
    """Group consecutive lines into ~TARGET_BATCH_SEC batches (by estimate)."""
    batches: list[list[str]] = []
    current: list[str] = []
    acc = 0.0
    for line in lines:
        current.append(line)
        acc += estimate_duration(line, rate)
        if acc >= TARGET_BATCH_SEC:
            batches.append(current)
            current = []
            acc = 0.0
    if current:
        batches.append(current)
    return batches


def window_for_batch(
    cursor: float,
    batch: list[str],
    total_sec: float,
    widen: float = 1.0,
    rate: float = CHARS_PER_SEC,
) -> tuple[float, float]:
    """Search window for a batch starting at the running cursor."""
    # keep the window tight: extra slack lets the aligner latch onto
    # neighbouring (or repeated) content and drift
    est = sum(estimate_duration(line, rate) for line in batch)
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
    # Measured from THIS script against THIS audio; see chars_per_sec().
    rate = chars_per_sec(lines, total_sec)
    out: list[AlignedLine] = []
    cursor = 0.0
    done = 0
    for batch in batch_lines(lines, rate):
        words_per_line = [segment_words(line) for line in batch]
        all_words = [w for words in words_per_line for w in words]

        spans: list[WordSpan | None] | None = None
        if all_words:
            for widen in (1.0, 1.6):  # retry once with a wider window
                w_start, w_end = window_for_batch(
                    cursor, batch, total_sec, widen, rate
                )
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
            est_end = min(cursor + estimate_duration(line, rate), total_sec)
            tokens = line_tokens(line, cursor, est_end, line_spans)
            out.append(
                AlignedLine(text=line, start=tokens[0].start, end=tokens[-1].end, tokens=tokens)
            )
            cursor = max(tokens[-1].end, cursor)
            if progress:
                progress(done / len(lines))
    return out
