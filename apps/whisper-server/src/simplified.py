"""Normalise Chinese transcripts to simplified characters.

Whisper emits traditional characters for `zh` regardless of what the speaker
would write, because its Chinese training text skews that way. A `initial_prompt`
nudge can bias it towards simplified, but only probabilistically, and prompts are
a known source of repetition and hallucination in faster-whisper. Converting the
output afterwards is deterministic instead.

The conversion happens here rather than on the TypeScript side so the artifact in
S3 is already correct at the source — both the caption VTT and the edit
transcript are derived from this word list.
"""

from __future__ import annotations

from typing import Any, Iterable

# Languages whose Whisper output may come back in traditional characters.
# `yue` (Cantonese) is reported separately by newer models.
_CHINESE_LANGUAGES = frozenset({"zh", "yue"})

# `t2s` converts orthography only: 裡→里, 後→后. It deliberately does NOT
# substitute regional vocabulary the way `tw2sp` does (記憶體→内存), because a
# transcript must stay the words that were actually spoken.
_OPENCC_CONFIG = "t2s"

_converter: Any | None = None


def _get_converter() -> Any:
    """Build the converter once — it loads dictionaries off disk."""
    global _converter
    if _converter is None:
        from opencc import OpenCC

        _converter = OpenCC(_OPENCC_CONFIG)
    return _converter


def is_chinese(language: str | None) -> bool:
    if not language:
        return False
    # Whisper reports bare codes, but tolerate "zh-TW" style tags.
    return language.split("-")[0].lower() in _CHINESE_LANGUAGES


def to_simplified(text: str) -> str:
    if not text:
        return text
    return _get_converter().convert(text)


def simplify_words(
    words: Iterable[dict[str, Any]], language: str | None
) -> list[dict[str, Any]]:
    """Convert each word's text to simplified characters, timings untouched.

    A no-op for non-Chinese output, so an English recording never pays the cost
    of loading the conversion dictionaries.
    """
    words = list(words)
    if not is_chinese(language):
        return words

    return [{**word, "text": to_simplified(word.get("text", ""))} for word in words]
