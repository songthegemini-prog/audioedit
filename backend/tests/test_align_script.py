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
