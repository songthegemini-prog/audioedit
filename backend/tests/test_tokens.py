from app.tokens import DEFAULT_FILLER_WORDS, Token, segment_to_tokens, segment_words


def test_thai_segmentation_without_spaces() -> None:
    # Thai has no spaces between words — newmm must split anyway
    assert segment_words("สวัสดีครับ") == ["สวัสดี", "ครับ"]


def test_overlong_chunks_are_split_for_cut_granularity() -> None:
    # dictionary compounds / unknown spans must not stay as one giant token
    words = segment_words("กรุงเทพมหานคร")
    assert len(words) > 1
    assert "".join(words) == "กรุงเทพมหานคร"


def test_short_words_are_not_over_split() -> None:
    assert segment_words("ภาษาไทย") == ["ภาษาไทย"] or len(segment_words("ภาษาไทย")) <= 2


def test_tokens_cover_segment_range() -> None:
    tokens = segment_to_tokens("สวัสดีครับ", start=1.0, end=2.0)
    assert tokens[0].start == 1.0
    assert tokens[-1].end == 2.0
    # boundaries are contiguous
    for a, b in zip(tokens, tokens[1:]):
        assert a.end == b.start


def test_time_split_is_proportional_to_char_length() -> None:
    # "สวัสดี" (6 chars) vs "ครับ" (4 chars) over 1 second
    tokens = segment_to_tokens("สวัสดีครับ", start=0.0, end=1.0)
    assert abs((tokens[0].end - tokens[0].start) - 0.6) < 0.01
    assert abs((tokens[1].end - tokens[1].start) - 0.4) < 0.01


def test_filler_is_marked_not_dropped() -> None:
    assert "อ่า" in DEFAULT_FILLER_WORDS
    tokens = segment_to_tokens("อ่าสวัสดี", start=0.0, end=1.0)
    texts = [t.text for t in tokens]
    assert "อ่า" in texts  # kept as a token, never auto-deleted
    by_text = {t.text: t for t in tokens}
    assert by_text["อ่า"].is_filler is True
    assert by_text["สวัสดี"].is_filler is False


def test_empty_and_whitespace_text() -> None:
    assert segment_to_tokens("", 0.0, 1.0) == []
    assert segment_to_tokens("   ", 0.0, 1.0) == []


def test_to_dict_matches_core_schema() -> None:
    token = Token(text="คำ", start=0.5, end=0.9, is_filler=False)
    assert token.to_dict() == {
        "text": "คำ",
        "start": 0.5,
        "end": 0.9,
        "isFiller": False,
        "docCharRange": None,
        "confidence": None,
    }
