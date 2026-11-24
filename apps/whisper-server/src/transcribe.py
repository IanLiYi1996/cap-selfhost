"""Whisper transcription reduced to the word list Cap needs."""

from __future__ import annotations

import re
from typing import Any, Iterable

from src.diarize import assign_speakers, diarize
from src.simplified import is_chinese, simplify_words

_LATIN_TAIL = re.compile(r"[0-9A-Za-z]$")
_LATIN_HEAD = re.compile(r"^[0-9A-Za-z]")


def merge_latin_runs(
    words: list[dict[str, Any]], language: str | None
) -> list[dict[str, Any]]:
    """Reassemble Latin words that Whisper split into sub-word tokens.

    In Chinese mode Whisper emits no inter-token spaces at all, so an embedded
    English word arrives in pieces: ``['放', 'fe', 'ature']``, and
    ``['C', 'amp', 'bell']``. Joining those with spaces produces "fe ature".

    Concatenating the raw tokens reproduces faster-whisper's own ``segment.text``
    exactly — verified against real audio — so merging a run of adjacent Latin
    tokens reproduces what Whisper transcribed rather than inventing anything.
    That is also why no timestamp heuristic is used: every token is exactly
    contiguous with its neighbour (``end`` == next ``start``), CJK included, so
    adjacency carries no information here.

    The trade-off: if a speaker says two English words in a row, Whisper's own
    text has no space between them either, so they merge into one. Matching
    Whisper's output is preferred over inventing a boundary it did not report.

    Only applies to Chinese output. In English mode tokens carry their own
    leading spaces, which mark real word boundaries.
    """
    if not is_chinese(language) or not words:
        return words

    merged: list[dict[str, Any]] = []
    for word in words:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and _LATIN_TAIL.search(previous["text"])
            and _LATIN_HEAD.match(word["text"])
        ):
            previous["text"] += word["text"]
            previous["end"] = word["end"]
            # A merged word is only as trustworthy as its least certain piece.
            confidences = [
                c
                for c in (previous.get("confidence"), word.get("confidence"))
                if c is not None
            ]
            previous["confidence"] = min(confidences) if confidences else None
            continue
        merged.append(dict(word))

    return merged


def words_from_segments(segments: Iterable[Any]) -> list[dict[str, Any]]:
    """Flatten faster-whisper segments into Cap's word list.

    Timestamps stay in seconds. The conversion to milliseconds happens on the
    TypeScript side, where it is unit-tested — see the interface contract.
    """
    words: list[dict[str, Any]] = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append(
                {
                    "text": text,
                    "start": word.start,
                    "end": word.end,
                    "confidence": word.probability,
                }
            )
    return words


def transcribe_file(
    path: str, model_name: str, language: str | None
) -> dict[str, Any]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    # Consume the segment generator before reading `info.duration`: faster-whisper
    # fills the transcription info in as it decodes.
    words = words_from_segments(segments)
    # Gate on the DETECTED language, not the requested one — the request is
    # usually "auto".
    words = merge_latin_runs(words, info.language)
    words = simplify_words(words, info.language)

    # Diarization is independent of the transcription and must never be able to
    # cost us the transcript, so `diarize` swallows its own failures and
    # `assign_speakers` is a no-op on an empty segment list.
    speaker_segments = diarize(path)
    words = assign_speakers(words, speaker_segments)

    return {
        "language": info.language,
        "model": model_name,
        "durationSeconds": info.duration,
        "speakerCount": len({segment.speaker for segment in speaker_segments}),
        "words": words,
    }
