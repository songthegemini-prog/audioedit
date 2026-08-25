import pytest

from app import align_script
from app.align_script import (
    MAX_WINDOW_SEC,
    TARGET_BATCH_SEC,
    align_script_lines,
    batch_lines,
    estimate_duration,
    line_tokens,
    script_lines,
    window_for_batch,
)
from app.align_spans import WordSpan


def test_script_lines_skips_blanks() -> None:
    assert script_lines("บรรทัดหนึ่ง\n\n  \nบรรทัดสอง\n") == ["บรรทัดหนึ่ง", "บรรทัดสอง"]


def test_batches_group_lines_to_target_duration() -> None:
    # each line ≈ 10s (120 chars) → batches of ~4 lines (35s target)
    lines = ["ก" * 120] * 8
    batches = batch_lines(lines)
    assert sum(len(b) for b in batches) == 8
    for batch in batches[:-1]:
        assert sum(estimate_duration(line) for line in batch) >= TARGET_BATCH_SEC


def test_batch_window_is_capped_and_clamped() -> None:
    batch = ["ก" * 1200]  # 100s estimate
    start, end = window_for_batch(10.0, batch, total_sec=1000)
    assert end - start <= MAX_WINDOW_SEC
    _, clamped = window_for_batch(95.0, ["สั้น"], total_sec=100)
    assert clamped == 100  # never past the file end


def make_spans(words: list[str], base: float) -> list[WordSpan | None]:
    # each word gets 0.5s starting at `base`
    return [WordSpan(base + i * 0.5, base + i * 0.5 + 0.4, 0.9) for i in range(len(words))]


def test_lines_in_one_batch_share_one_aligner_call() -> None:
    calls: list[tuple[float, float, int]] = []

    def align_window(start: float, end: float, words: list[str]):
        calls.append((start, end, len(words)))
        return make_spans(words, start + 1.0)

    lines = ["สวัสดีครับ", "วันนี้อากาศดี"]  # short — one batch
    aligned = align_script_lines(lines, total_sec=600, align_window=align_window)

    assert len(calls) == 1  # batched: one call for both lines
    assert len(aligned) == 2  # but still one AlignedLine per script line
    assert aligned[1].start > aligned[0].end - 1e-6
    assert all(t.confidence == 0.9 for line in aligned for t in line.tokens)


def test_cursor_advances_between_batches() -> None:
    calls: list[float] = []

    def align_window(start: float, end: float, words: list[str]):
        calls.append(start)
        return make_spans(words, start + 1.0)

    # ~40s estimate each → each line is its own batch
    lines = ["ก" * 480, "ข" * 480]
    aligned = align_script_lines(lines, total_sec=6000, align_window=align_window)
    assert len(calls) == 2
    assert calls[1] == aligned[0].end  # batch 2 starts where batch 1 ended


def test_failed_batch_gets_estimated_times_and_zero_confidence() -> None:
    aligned = align_script_lines(
        ["บรรทัดที่พัง"], total_sec=600, align_window=lambda s, e, w: None
    )
    (line,) = aligned
    assert all(t.confidence == 0.0 for t in line.tokens)  # flagged for review
    assert line.end > line.start  # estimated duration, job not failed


def test_progress_reaches_one() -> None:
    seen: list[float] = []
    align_script_lines(
        ["หนึ่ง", "สอง"],
        total_sec=600,
        align_window=lambda s, e, w: make_spans(w, s),
        progress=seen.append,
    )
    assert seen[-1] == 1.0


def test_line_tokens_fallback_is_proportional_with_zero_confidence() -> None:
    tokens = line_tokens("สวัสดีครับ", 2.0, 3.0, None)
    assert tokens[0].start == 2.0
    assert tokens[-1].end == 3.0
    assert all(t.confidence == 0.0 for t in tokens)


class TestSpeechRate:
    """Window sizing is derived from how fast the narrator reads, and getting
    that wrong poisons the entire pass.

    The constant said 12.0 characters per second. The team's narrator reads at
    9.0. Every search window therefore came out a quarter too short, the
    aligner had to squeeze each batch into too little audio, and the error
    compounded: on their own programme 3 of 108 lines aligned with any
    confidence and the cursor finished 84 seconds short of the end (reported
    2026-08-24). Measuring the rate instead gave 89 of 103 and reached the end.
    """

    def test_measures_the_rate_from_the_script_and_the_audio(self) -> None:
        # Both numbers are known before alignment starts, so guessing is a
        # choice — and it was the wrong one.
        assert align_script.chars_per_sec(["ก" * 900], 100.0) == pytest.approx(9.0)

    def test_the_team_s_own_file_measures_nine_not_twelve(self) -> None:
        """The concrete case, so a future tweak that drifts back toward the
        old constant fails here rather than in someone's transcript."""
        rate = align_script.chars_per_sec(["ก" * 26936], 2989.0)

        assert rate == pytest.approx(9.0, abs=0.1)
        assert rate < align_script.CHARS_PER_SEC  # the old guess was too fast

    def test_falls_back_when_there_is_nothing_to_measure(self) -> None:
        """Never divide by zero on the path that gates a whole job."""
        assert align_script.chars_per_sec([], 100.0) == align_script.CHARS_PER_SEC
        assert align_script.chars_per_sec(["abc"], 0.0) == align_script.CHARS_PER_SEC
        assert align_script.chars_per_sec([], 0.0) == align_script.CHARS_PER_SEC

    def test_a_fragment_pasted_against_a_whole_programme_is_clamped(self) -> None:
        """Someone pastes three paragraphs and aligns them to an hour of
        audio. The measured rate would be near zero and every window would
        stretch over its neighbours — the exact drift this fixes."""
        rate = align_script.chars_per_sec(["ก" * 100], 3600.0)

        assert rate == align_script.MIN_CHARS_PER_SEC

    def test_a_script_far_longer_than_its_audio_is_clamped_too(self) -> None:
        assert align_script.chars_per_sec(["ก" * 100000], 100.0) == (
            align_script.MAX_CHARS_PER_SEC
        )

    def test_a_slower_rate_asks_for_a_longer_window(self) -> None:
        """The property that actually mattered: a slower reader needs MORE
        audio for the same words, not less."""
        batch = ["ก" * 300]
        fast = align_script.window_for_batch(0.0, batch, 3600.0, rate=12.0)
        slow = align_script.window_for_batch(0.0, batch, 3600.0, rate=9.0)

        assert (slow[1] - slow[0]) > (fast[1] - fast[0])

    def test_batching_follows_the_measured_rate(self) -> None:
        """Batches are grouped by estimated seconds, so the rate decides how
        many lines share one window."""
        lines = ["ก" * 120] * 20

        fast = align_script.batch_lines(lines, 12.0)
        slow = align_script.batch_lines(lines, 9.0)

        # slower reading = more seconds per line = fewer lines per batch
        assert len(slow[0]) < len(fast[0])
