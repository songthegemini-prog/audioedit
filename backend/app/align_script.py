"""Align a known script against (possibly hour-long) audio, line by line.

The "มีบทอยู่แล้ว" mode. The editor's own words are always what gets kept; the
only question is how each line finds the audio it belongs to. There are two
ways, and which one runs depends on whether the ASR model is installed:

**Anchored** (preferred). A quick ASR pass says WHERE things are said — its
text is never shown to anyone — and the script is matched against it character
by character, so every line gets its own window. Measured on the team's own
programme: mean error 0.40s, worst 1.0s, all 103 lines within 2 seconds.

**Cursor** (fallback, no ASR model). Each line is aligned in a window starting
where the previous line ended. It works, but a line that aligns badly moves
the cursor wrongly and everything after it inherits the error: mean 4.8s,
worst 25.6s on the same file. Every constant it depends on is calibrated
together — read the comments on them before touching any of them.

Either way, memory stays bounded no matter how long the file is, and lines
that refuse to align get estimated times with confidence 0 — flagged red for
the reviewer, never fatal.
"""

from __future__ import annotations

import difflib
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


# Slack around an anchored window. Small on purpose: the anchor already says
# where the line is, and a loose window is what lets forced alignment wander
# onto the neighbours' audio.
ANCHOR_PAD_SEC = 1.0


@dataclass(frozen=True)
class AsrSpan:
    """One ASR segment: its text and the time range it was heard in."""

    text: str
    start: float
    end: float


def anchor_windows(
    lines: list[str], asr: list[AsrSpan]
) -> list[tuple[float, float] | None]:
    """A time window per script line, read off the ASR segments it matches.

    This is the fix for script alignment drifting (reported 2026-08-24:
    "ตรึงบทไม่ถูกเลย ... มีถูกเป็นบางบรรทัด"). Transcription has never had that
    problem because Whisper hands it a time range per segment, so each piece is
    aligned inside a window that is already correct. Script alignment starts
    with no timing at all and feels its way forward with a cursor — and one bad
    batch moves the cursor wrongly, so everything after it is wrong too.

    Matching the script against ASR text character by character gives every
    line its own window, from which no other line can be harmed. Measured on
    the team's hand-corrected script against their own programme: mean error
    from 4.8s to 0.40s, worst case from 25.6s to 1.0s, and every one of 103
    lines within 2 seconds.

    A line that matches nothing gets None — which is the right answer for the
    cover sheet, whose page numbers and dates are not in the audio at all. It
    falls out of the matching for free, with no rule about what a cover sheet
    looks like (a rule the editors had already told us would be wrong).
    """
    if not lines or not asr:
        return [None] * len(lines)

    asr_text = "".join(span.text for span in asr)
    script_text = "".join(lines)

    # ASR char offset -> time, interpolated inside the segment it falls in
    bounds: list[tuple[int, int, float, float]] = []
    pos = 0
    for span in asr:
        bounds.append((pos, pos + len(span.text), span.start, span.end))
        pos += len(span.text)

    def time_at(offset: int) -> float:
        for lo, hi, start, end in bounds:
            if offset < hi:
                width = max(hi - lo, 1)
                return start + ((offset - lo) / width) * (end - start)
        return asr[-1].end

    matcher = difflib.SequenceMatcher(None, script_text, asr_text, autojunk=False)
    to_asr: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                to_asr[i1 + k] = j1 + k

    windows: list[tuple[float, float] | None] = []
    cursor = 0
    for line in lines:
        lo, hi = cursor, cursor + len(line)
        hits = [to_asr[k] for k in range(lo, hi) if k in to_asr]
        windows.append((time_at(min(hits)), time_at(max(hits))) if hits else None)
        cursor = hi
    return windows


def align_lines_anchored(
    lines: list[str],
    total_sec: float,
    asr: list[AsrSpan],
    align_window: AlignWindowFn,
    progress: Callable[[float], None] | None = None,
) -> list[AlignedLine]:
    """Align each line inside its own anchored window — no running cursor.

    Lines that could not be anchored keep proportional times and confidence 0,
    the same treatment any unalignable line already gets: flagged for review,
    never fatal.
    """
    windows = anchor_windows(lines, asr)
    out: list[AlignedLine] = []
    for done, (line, window) in enumerate(zip(lines, windows), start=1):
        words = segment_words(line)
        if not words:
            continue
        if window is None:
            tokens = line_tokens(line, 0.0, 0.0, None)
        else:
            start = max(window[0] - ANCHOR_PAD_SEC, 0.0)
            end = min(window[1] + ANCHOR_PAD_SEC, total_sec)
            spans = None
            try:
                got = align_window(start, end, words)
            except Exception:
                got = None
            if got is not None and any(s is not None for s in got):
                spans = got
            tokens = line_tokens(line, start, end, spans)
        out.append(
            AlignedLine(text=line, start=tokens[0].start, end=tokens[-1].end, tokens=tokens)
        )
        if progress:
            progress(done / len(lines))
    return out


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
