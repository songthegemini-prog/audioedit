import pytest

from app.align_spans import CharSpan, WordSpan, words_from_char_spans


def make_spans() -> list[CharSpan]:
    # 5 chars: word A = 2 chars, word B = 3 chars
    return [
        CharSpan(0, 5, 0.9),
        CharSpan(5, 10, 0.7),
        CharSpan(20, 25, 0.6),
        CharSpan(25, 30, 0.8),
        CharSpan(30, 40, 1.0),
    ]


def test_words_get_first_to_last_char_times() -> None:
    words = words_from_char_spans(make_spans(), [2, 3], frame_sec=0.02, offset_sec=1.0)
    assert words == [
        WordSpan(start=1.0, end=1.2, confidence=0.8),  # frames 0..10
        WordSpan(start=1.4, end=1.8, confidence=0.8),  # frames 20..40
    ]


def test_word_with_no_kept_chars_is_none() -> None:
    words = words_from_char_spans(make_spans(), [2, 0, 3], frame_sec=0.02, offset_sec=0.0)
    assert words[1] is None
    assert words[0] is not None and words[2] is not None


def test_mismatch_raises() -> None:
    with pytest.raises(ValueError):
        words_from_char_spans(make_spans(), [2, 2], frame_sec=0.02, offset_sec=0.0)


def test_confidence_is_mean_of_char_scores() -> None:
    spans = [CharSpan(0, 1, 0.2), CharSpan(1, 2, 0.4)]
    (word,) = words_from_char_spans(spans, [2], frame_sec=0.02, offset_sec=0.0)
    assert word is not None
    assert word.confidence == pytest.approx(0.3)
