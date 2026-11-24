"""Speaker diarization for the transcript word list.

Whisper produces no speaker information at all, so a multi-person recording
transcribes as one undifferentiated wall of text — which also degrades the AI
summary, since that is generated from the caption VTT.

Runs pyannote's segmentation model plus a speaker-embedding model through
ONNX Runtime (already present for faster-whisper's VAD), so no PyTorch is
pulled in: about 34MB of extra weights against the ~2GB torch would have cost.

Model and threshold choices are measured, not assumed — see
`tests/test_diarize.py` and the note on THRESHOLD below.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any, Iterable

MODEL_DIR = os.environ.get("DIARIZATION_MODEL_DIR", "/models/diarization")
SEGMENTATION_MODEL = os.path.join(MODEL_DIR, "segmentation.onnx")
EMBEDDING_MODEL = os.path.join(MODEL_DIR, "speaker-embedding.onnx")

# Measured on the sherpa-onnx reference clips (4-speaker zh, 2-speaker en) by
# sweeping 0.40-0.90 against two embedding models:
#
#   embedding                              zh (want 4)     en (want 2)
#   3dspeaker eres2net zh-cn               never 4 unless threshold collapses en to 1
#   3dspeaker CAM++ zh-cn                  4 across 0.55-0.75, en correct throughout
#
# CAM++ is both more accurate here and smaller (28MB vs 40MB). 0.65 is the
# middle of its correct plateau rather than an edge of it, so small acoustic
# differences do not flip the speaker count.
THRESHOLD = float(os.environ.get("DIARIZATION_THRESHOLD", "0.65"))

# Below these, pyannote's segmentation emits speech/silence slivers that are too
# short to embed reliably.
MIN_DURATION_ON = float(os.environ.get("DIARIZATION_MIN_DURATION_ON", "0.3"))
MIN_DURATION_OFF = float(os.environ.get("DIARIZATION_MIN_DURATION_OFF", "0.5"))

# Speaker labels follow AssemblyAI's convention (A, B, C...), which is the shape
# the rest of the pipeline already expects for `speaker`.
_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# A word whose interval does not overlap any speech segment is still attributed
# if a segment is this close — diarization boundaries and word boundaries are
# derived independently and disagree by tens of milliseconds routinely.
NEAREST_TOLERANCE_SECONDS = 0.5

# Above this, the clustering is not believable and the whole result is discarded.
#
# Diarization degrades with length by INVENTING speakers rather than by failing:
# measured against a known 4 participants, a 31-minute meeting produced 24
# clusters and a 50-minute one 62-80.
#
# Before changing this, read the diarization section of
# `design/notes/aws-deployment-runbook.md`. Four repairs were measured and all
# rejected, including replacing this clusterer with scikit-learn agglomerative
# clustering over our own embeddings, which came out worse (91/5/4/0 at n=4).
#
# The cause is not the clustering. On a single room microphone the embeddings
# cluster by distance-to-mic rather than by speaker: the only cleanly separated
# cluster was the loudest one, and the three further-away participants merged
# into a single cluster holding 91% of the speech. Fixing that needs a different
# capture setup, not a different algorithm.
#
# Discarding beats emitting it: "Speaker S82" in the captions is worse than no
# labels at all, because the captions are also what the AI summary reads.
MAX_BELIEVABLE_SPEAKERS = int(os.environ.get("DIARIZATION_MAX_SPEAKERS", "10"))


def is_enabled() -> bool:
    return os.environ.get("DIARIZATION_ENABLED", "1") not in ("0", "false", "no")



@dataclass(frozen=True)
class SpeakerSegment:
    start: float
    end: float
    speaker: str


def is_believable(segments: list[SpeakerSegment]) -> bool:
    return len({segment.speaker for segment in segments}) <= MAX_BELIEVABLE_SPEAKERS


def normalise_speakers(
    raw: Iterable[tuple[float, float, int]],
) -> list[SpeakerSegment]:
    """Relabel cluster ids as A, B, C... in order of first appearance.

    The clusterer returns sparse, arbitrary ids (0, 1, 2, 4 for four speakers),
    which would surface as "speaker 4" in a three-speaker recording.
    """
    segments = sorted(raw, key=lambda item: item[0])
    labels: dict[int, str] = {}
    out: list[SpeakerSegment] = []
    for start, end, cluster in segments:
        if cluster not in labels:
            index = len(labels)
            # Past Z, fall back to a numeric suffix rather than crashing.
            labels[cluster] = (
                _LABELS[index] if index < len(_LABELS) else f"S{index + 1}"
            )
        out.append(SpeakerSegment(start, end, labels[cluster]))
    return out


def diarize(path: str) -> list[SpeakerSegment]:
    """Speech segments with speaker labels, or [] when unavailable.

    Never raises: a transcript without speaker labels is far better than no
    transcript, and this runs inside the same task as the transcription.
    """
    if not is_enabled():
        return []
    for model in (SEGMENTATION_MODEL, EMBEDDING_MODEL):
        if not os.path.exists(model):
            print(
                f"warning: diarization model missing at {model}; "
                "continuing without speaker labels",
                file=sys.stderr,
            )
            return []

    try:
        import sherpa_onnx as so

        config = so.OfflineSpeakerDiarizationConfig(
            segmentation=so.OfflineSpeakerSegmentationModelConfig(
                pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=SEGMENTATION_MODEL
                )
            ),
            embedding=so.SpeakerEmbeddingExtractorConfig(model=EMBEDDING_MODEL),
            # num_clusters=-1: the speaker count is unknown, so it is inferred
            # from THRESHOLD rather than fixed.
            clustering=so.FastClusteringConfig(num_clusters=-1, threshold=THRESHOLD),
            min_duration_on=MIN_DURATION_ON,
            min_duration_off=MIN_DURATION_OFF,
        )
        diarizer = so.OfflineSpeakerDiarization(config)
        samples = _read_mono_16k(path, diarizer.sample_rate)
        result = diarizer.process(samples).sort_by_start_time()
        segments = normalise_speakers(
            (segment.start, segment.end, segment.speaker) for segment in result
        )
        if not is_believable(segments):
            found = len({segment.speaker for segment in segments})
            print(
                f"warning: diarization found {found} speakers, above the "
                f"believable maximum of {MAX_BELIEVABLE_SPEAKERS}; dropping "
                "speaker labels for this recording",
                file=sys.stderr,
            )
            return []
        return segments
    except Exception as error:  # noqa: BLE001 - see docstring
        print(f"warning: diarization failed ({error!r})", file=sys.stderr)
        return []


def _read_mono_16k(path: str, sample_rate: int):
    """Decode to the mono float samples the diarizer expects."""
    import av
    import numpy as np

    with av.open(path) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=sample_rate)
        chunks: list[Any] = []
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().reshape(-1))
        for resampled in resampler.resample(None):
            chunks.append(resampled.to_ndarray().reshape(-1))

    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def assign_speakers(
    words: list[dict[str, Any]], segments: list[SpeakerSegment]
) -> list[dict[str, Any]]:
    """Attach a speaker label to each word.

    Chooses the segment with the greatest temporal overlap, which is more stable
    than testing the word's midpoint: Chinese words are often a single character
    lasting ~100ms and can sit right on a speaker boundary.
    """
    if not segments:
        return words

    out: list[dict[str, Any]] = []
    for word in words:
        start = word["start"]
        end = word["end"]

        best: str | None = None
        best_overlap = 0.0
        nearest: str | None = None
        nearest_distance = float("inf")

        for segment in segments:
            overlap = min(end, segment.end) - max(start, segment.start)
            if overlap > best_overlap:
                best_overlap = overlap
                best = segment.speaker
            if overlap <= 0:
                distance = max(segment.start - end, start - segment.end)
                if distance < nearest_distance:
                    nearest_distance = distance
                    nearest = segment.speaker

        if best is None and nearest_distance <= NEAREST_TOLERANCE_SECONDS:
            best = nearest

        out.append({**word, "speaker": best})
    return out
