from src.transcribe import merge_latin_runs


def w(text, start, end, confidence=0.9):
    return {"text": text, "start": start, "end": end, "confidence": confidence}


def test_reassembles_a_split_english_word():
    # 实测 token：'放', 'fe', 'ature', '但是' —— Whisper 中文模式不带空格
    words = [
        w("放", 6.000, 6.140, 0.8),
        w("fe", 6.140, 6.400, 0.5),
        w("ature", 6.400, 7.060, 0.7),
        w("但是", 7.060, 7.880, 0.9),
    ]

    assert merge_latin_runs(words, "zh") == [
        w("放", 6.000, 6.140, 0.8),
        {"text": "feature", "start": 6.140, "end": 7.060, "confidence": 0.5},
        w("但是", 7.060, 7.880, 0.9),
    ]


def test_reassembles_a_run_of_more_than_two_tokens():
    # 实测：'C', 'amp', 'bell'
    words = [w("C", 1.0, 1.1), w("amp", 1.1, 1.2), w("bell", 1.2, 1.4)]

    merged = merge_latin_runs(words, "zh")

    assert [x["text"] for x in merged] == ["Campbell"]
    assert merged[0]["start"] == 1.0
    assert merged[0]["end"] == 1.4


def test_takes_the_lowest_confidence_of_the_pieces():
    words = [w("P", 1.0, 1.1, 0.9), w("erson", 1.1, 1.2, 0.3), w("a", 1.2, 1.3, 0.8)]

    assert merge_latin_runs(words, "zh")[0]["confidence"] == 0.3


def test_never_merges_across_a_chinese_boundary():
    words = [w("写", 1.0, 1.1), w("fe", 1.1, 1.2), w("ature", 1.2, 1.3), w("我", 1.3, 1.4)]

    assert [x["text"] for x in merge_latin_runs(words, "zh")] == [
        "写",
        "feature",
        "我",
    ]


def test_leaves_chinese_tokens_alone():
    # 逐字时间戳要保留 —— 播放器的逐词高亮依赖它
    words = [w("我是", 1.0, 1.2), w("想", 1.2, 1.3), w("往", 1.3, 1.4)]

    assert merge_latin_runs(words, "zh") == words


def test_is_a_no_op_for_english_output():
    # 英文模式下每个词自带前导空格，那是真实词边界，绝不能合并
    words = [w("Hello", 0.0, 0.5), w("world", 0.5, 1.0)]

    assert merge_latin_runs(words, "en") == words


def test_does_not_mutate_the_input():
    words = [w("fe", 1.0, 1.1), w("ature", 1.1, 1.2)]

    merge_latin_runs(words, "zh")

    assert [x["text"] for x in words] == ["fe", "ature"]


def test_handles_digits_and_an_empty_list():
    assert merge_latin_runs([], "zh") == []
    assert [x["text"] for x in merge_latin_runs([w("H", 0, 1), w("264", 1, 2)], "zh")] == [
        "H264"
    ]
