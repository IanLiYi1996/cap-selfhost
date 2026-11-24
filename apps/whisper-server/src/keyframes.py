"""Keyframe extraction for the visual timeline and the Ask tab's look_at tool.

Screen recordings change rarely and then all at once (a slide flips, a page
loads), so a cheap model-free change detector on tiny grayscale samples finds
the moments worth describing. A coarse time grid on top gives look_at something
to show for any time range, even where the screen never changed.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np

INDEX_VERSION = 1

SAMPLE_WIDTH = 64
SAMPLE_HEIGHT = 36
OUTPUT_WIDTH = 1280
JPEG_QUALITY = 4
GRID_SECONDS = 10.0
GRID_MIN_DISTANCE = 2.0


@dataclass(frozen=True)
class Selected:
    t: float
    novelty: float
    reason: str


def _distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def _select_at(
    frames: np.ndarray,
    threshold: float,
    min_gap: float,
    max_gap: float,
    settle: float,
    max_settle: int,
) -> list[Selected]:
    count = len(frames)
    kept = [Selected(0.0, 0.0, "first")]
    last = 0
    i = 1
    while i < count:
        novelty = _distance(frames[i], frames[last])
        if novelty >= threshold and i - last >= min_gap:
            j = i
            while (
                j + 1 < count
                and j - i < max_settle
                and _distance(frames[j + 1], frames[j]) > settle
            ):
                j += 1
            kept.append(Selected(float(j), _distance(frames[j], frames[last]), "change"))
            last = j
            i = j + 1
            continue
        if i - last >= max_gap:
            kept.append(Selected(float(i), novelty, "coverage"))
            last = i
        i += 1
    return kept


def select_keyframes(
    frames: np.ndarray,
    *,
    threshold: float = 0.02,
    min_gap: float = 2,
    max_gap: float = 90,
    settle: float = 0.005,
    max_settle: int = 3,
    max_keyframes: int = 200,
) -> list[Selected]:
    """Pick keyframes from one sample per second (`frames[i]` is second `i`).

    Raises the change threshold until the selection fits `max_keyframes`, so a
    busy recording (scrolling, video playback) degrades to its biggest changes
    instead of blowing the description budget.
    """
    if len(frames) == 0:
        return []

    current = threshold
    while True:
        selection = _select_at(frames, current, min_gap, max_gap, settle, max_settle)
        if len(selection) <= max_keyframes:
            return selection
        if current >= 1.0:
            picks = np.linspace(0, len(selection) - 1, max_keyframes).round().astype(int)
            return [selection[index] for index in sorted(set(picks.tolist()))]
        current = min(1.0, current * 1.5)


def grid_times(
    duration: float,
    *,
    every: float = GRID_SECONDS,
    existing: list[float],
    min_distance: float = GRID_MIN_DISTANCE,
) -> list[float]:
    times = []
    t = every
    while t < duration:
        if all(abs(t - other) >= min_distance for other in existing):
            times.append(t)
        t += every
    return times


def frame_key(prefix: str, t: float) -> str:
    return f"{prefix}{round(t * 1000):09d}.jpg"


def probe_duration(path: str) -> float:
    output = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
        ],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(output)


def sample_frames(path: str) -> np.ndarray:
    raw = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", path,
            "-vf", f"fps=1,scale={SAMPLE_WIDTH}:{SAMPLE_HEIGHT},format=gray",
            "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        check=True, capture_output=True,
    ).stdout
    size = SAMPLE_WIDTH * SAMPLE_HEIGHT
    count = len(raw) // size
    samples = np.frombuffer(raw[: count * size], dtype=np.uint8)
    return samples.reshape(count, SAMPLE_HEIGHT, SAMPLE_WIDTH).astype(np.float32) / 255.0


def extract_jpeg(path: str, t: float, output: str) -> None:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", path,
            "-frames:v", "1", "-vf", f"scale='min({OUTPUT_WIDTH},iw)':-2",
            "-q:v", str(JPEG_QUALITY), "-y", output,
        ],
        check=True, capture_output=True,
    )


def run(s3, bucket: str, input_key: str, output_key: str, frames_prefix: str) -> dict:
    with tempfile.TemporaryDirectory() as workdir:
        video = os.path.join(workdir, "source.mp4")
        s3.download_file(bucket, input_key, video)

        duration = probe_duration(video)
        keyframes = select_keyframes(sample_frames(video))
        keyframes = [frame for frame in keyframes if frame.t < duration]
        grid = grid_times(duration, existing=[frame.t for frame in keyframes])

        planned = [
            {"t": frame.t, "keyframe": True, "reason": frame.reason, "novelty": round(frame.novelty, 4)}
            for frame in keyframes
        ] + [{"t": t, "keyframe": False, "reason": "grid", "novelty": 0.0} for t in grid]
        planned.sort(key=lambda frame: frame["t"])

        def extract_and_upload(frame: dict) -> dict | None:
            local = os.path.join(workdir, f"{round(frame['t'] * 1000):09d}.jpg")
            try:
                extract_jpeg(video, frame["t"], local)
            except subprocess.CalledProcessError as error:
                print(f"warning: no frame at {frame['t']}s: {error.stderr!r}")
                return None
            if not os.path.exists(local) or os.path.getsize(local) == 0:
                return None
            key = frame_key(frames_prefix, frame["t"])
            s3.upload_file(local, bucket, key, ExtraArgs={"ContentType": "image/jpeg"})
            os.remove(local)
            return {**frame, "key": key}

        with ThreadPoolExecutor(max_workers=4) as pool:
            frames = [frame for frame in pool.map(extract_and_upload, planned) if frame]

    index = {
        "version": INDEX_VERSION,
        "sourceKey": input_key,
        "durationSeconds": duration,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "frames": frames,
    }
    # Written last: the web workflow polls for this object as the completion signal.
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(index).encode("utf-8"),
        ContentType="application/json",
    )
    return index
