from dataclasses import dataclass

from src.transcribe import words_from_segments


@dataclass
class FakeWord:
    start: float
    end: float
    word: str
    probability: float


@dataclass
class FakeSegment:
    words: list[FakeWord] | None


def test_flattens_segments_and_strips_whitespace():
    segments = [
        FakeSegment(words=[FakeWord(1.2, 1.45, " 你好", 0.93)]),
        FakeSegment(words=[FakeWord(1.5, 1.9, " 世界", 0.88)]),
    ]

    assert words_from_segments(segments) == [
        {"text": "你好", "start": 1.2, "end": 1.45, "confidence": 0.93},
        {"text": "世界", "start": 1.5, "end": 1.9, "confidence": 0.88},
    ]


def test_keeps_seconds_untouched():
    # 秒→毫秒的换算刻意留给 TS 侧（见接口契约），这里绝不能乘 1000
    segments = [FakeSegment(words=[FakeWord(0.5, 0.75, "hi", 0.5)])]

    result = words_from_segments(segments)

    assert result[0]["start"] == 0.5
    assert result[0]["end"] == 0.75


def test_skips_segments_without_word_timestamps():
    segments = [
        FakeSegment(words=None),
        FakeSegment(words=[FakeWord(2.0, 2.2, "ok", 0.9)]),
    ]

    assert words_from_segments(segments) == [
        {"text": "ok", "start": 2.0, "end": 2.2, "confidence": 0.9},
    ]


def test_drops_words_that_are_empty_after_stripping():
    segments = [FakeSegment(words=[FakeWord(1.0, 1.1, "   ", 0.9)])]

    assert words_from_segments(segments) == []
