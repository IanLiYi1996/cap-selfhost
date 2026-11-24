from src.simplified import is_chinese, simplify_words, to_simplified


def test_detects_chinese_language_codes():
    assert is_chinese("zh")
    assert is_chinese("yue")
    # Whisper reports bare codes, but a regional tag must not slip through.
    assert is_chinese("zh-TW")
    assert is_chinese("ZH")


def test_rejects_non_chinese_and_missing_languages():
    for language in ["en", "ja", "ko", "", None]:
        assert not is_chinese(language)


def test_converts_traditional_to_simplified():
    # 实际转写里出现过的片段
    assert to_simplified("我是想往裡騰") == "我是想往里腾"
    assert to_simplified("那個第七章") == "那个第七章"


def test_leaves_english_and_empty_text_alone():
    assert to_simplified("feature") == "feature"
    assert to_simplified("") == ""


def test_keeps_spoken_vocabulary_rather_than_localising_it():
    # t2s 只做字形转换。tw2sp 会把 記憶體 换成 内存 —— 那是替换说话人用的词，
    # 转写不能这么干。
    assert to_simplified("記憶體") == "记忆体"


def test_simplifies_word_text_and_leaves_timings_untouched():
    words = [
        {"text": "裡", "start": 1.2, "end": 1.45, "confidence": 0.93},
        {"text": "後", "start": 1.5, "end": 1.9, "confidence": 0.88},
    ]

    assert simplify_words(words, "zh") == [
        {"text": "里", "start": 1.2, "end": 1.45, "confidence": 0.93},
        {"text": "后", "start": 1.5, "end": 1.9, "confidence": 0.88},
    ]


def test_is_a_no_op_for_non_chinese_output():
    words = [{"text": "Hello", "start": 0.0, "end": 0.5, "confidence": 0.9}]

    assert simplify_words(words, "en") == words


def test_does_not_mutate_the_input_list():
    words = [{"text": "裡", "start": 0.0, "end": 0.5, "confidence": 0.9}]

    simplify_words(words, "zh")

    assert words[0]["text"] == "裡"


def test_handles_an_empty_word_list():
    assert simplify_words([], "zh") == []
