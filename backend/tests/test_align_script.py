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


class TestAnchoring:
    """Script alignment used to feel its way forward with a running cursor, so
    one bad batch moved every later line with it — on the team's own programme
    the mean error was 4.8s and the worst 25.6s (reported 2026-08-24).

    Anchoring gives each line its own window, matched to an ASR pass by text.
    Same file: mean 0.40s, worst 1.0s, every line inside 2 seconds. What the
    tests pin is the property that makes that true — a line can only be placed
    where its own words were heard, and cannot move any other line.
    """

    @staticmethod
    def spans() -> list[align_script.AsrSpan]:
        return [
            align_script.AsrSpan("สวัสดีครับท่านผู้ฟัง", 10.0, 14.0),
            align_script.AsrSpan("วันนี้อากาศดีมาก", 14.0, 18.0),
            align_script.AsrSpan("ขอบคุณที่ติดตามครับ", 18.0, 22.0),
        ]

    def test_each_line_lands_in_the_time_its_words_were_heard(self) -> None:
        got = align_script.anchor_windows(
            ["สวัสดีครับท่านผู้ฟัง", "ขอบคุณที่ติดตามครับ"], self.spans()
        )

        assert got[0][0] == pytest.approx(10.0, abs=0.5)
        assert got[1][0] == pytest.approx(18.0, abs=0.5)

    def test_a_line_that_is_not_in_the_audio_anchors_to_nothing(self) -> None:
        """The cover sheet falls out for free: its page numbers and dates match
        no speech. No rule about what a cover sheet looks like is needed — and
        the editors had already warned that such a rule would be wrong."""
        got = align_script.anchor_windows(["1234", "14  2568", "สวัสดีครับท่านผู้ฟัง"], self.spans())

        assert got[0] is None
        assert got[1] is None
        assert got[2] is not None

    def test_a_bad_line_cannot_move_a_good_one(self) -> None:
        """THE property. With the cursor, an unmatchable line dragged
        everything after it out of place; here the neighbours are untouched."""
        clean = align_script.anchor_windows(
            ["สวัสดีครับท่านผู้ฟัง", "ขอบคุณที่ติดตามครับ"], self.spans()
        )
        with_junk = align_script.anchor_windows(
            ["สวัสดีครับท่านผู้ฟัง", "ZZZZZZZZ", "ขอบคุณที่ติดตามครับ"], self.spans()
        )

        assert with_junk[0] == clean[0]
        assert with_junk[2] == clean[1]  # the good line did not move

    def test_the_script_is_assumed_to_be_in_audio_order(self) -> None:
        """A documented limit, not an oversight.

        The matching is a longest-common-subsequence, so it only pairs text up
        in order. Hand a script whose lines are shuffled relative to the audio
        and at most one side of each swap can anchor. That is fine for what
        this is — a transcript of the programme, which is in the programme's
        order by definition — but it would NOT be fine as a general
        "find these paragraphs anywhere in the audio" tool, and anyone
        extending it that way needs a different matching strategy.
        """
        shuffled = align_script.anchor_windows(
            ["ขอบคุณที่ติดตามครับ", "สวัสดีครับท่านผู้ฟัง"], self.spans()
        )

        assert sum(1 for w in shuffled if w is not None) < 2

    def test_survives_a_script_the_asr_disagrees_with(self) -> None:
        """The real case: the editor has corrected the words. Matching is on
        the parts that still agree, which was 96% of characters on their file."""
        got = align_script.anchor_windows(
            ["สวัสดีคร้าบท่านผู้ฟัง", "วันนี้อากาศดีมากๆ"], self.spans()
        )

        assert got[0] is not None and got[0][0] == pytest.approx(10.0, abs=1.0)
        assert got[1] is not None and got[1][0] == pytest.approx(14.0, abs=1.5)

    def test_no_asr_means_no_anchors_rather_than_a_crash(self) -> None:
        """Without the ASR model the caller falls back to the cursor path; this
        must return cleanly rather than raise on the way there."""
        assert align_script.anchor_windows(["abc"], []) == [None]
        assert align_script.anchor_windows([], self.spans()) == []

    def test_anchored_alignment_places_every_line_it_could_anchor(self) -> None:
        lines = ["สวัสดีครับท่านผู้ฟัง", "ขอบคุณที่ติดตามครับ"]

        def fake_align(start, end, words):
            step = (end - start) / max(len(words), 1)
            return [
                WordSpan(start + i * step, start + (i + 1) * step, 0.9)
                for i in range(len(words))
            ]

        out = align_script.align_lines_anchored(lines, 30.0, self.spans(), fake_align)

        assert len(out) == 2
        assert out[0].start < out[1].start
        assert all(t.confidence and t.confidence > 0 for line in out for t in line.tokens)

    def test_an_unanchorable_line_is_flagged_not_dropped(self) -> None:
        """Same contract the cursor path already had: confidence 0, red for the
        reviewer, never fatal and never silently missing."""
        out = align_script.align_lines_anchored(
            ["1234", "สวัสดีครับท่านผู้ฟัง"], 30.0, self.spans(),
            lambda s, e, w: None,
        )

        assert len(out) == 2  # the junk line is still there
        assert all(t.confidence == 0.0 for t in out[0].tokens)
