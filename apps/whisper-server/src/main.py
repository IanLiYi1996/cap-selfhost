"""Entry point for the on-demand Whisper ECS task."""

from __future__ import annotations

import json
import os
import sys
import tempfile

import boto3

from src.transcribe import transcribe_file


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def run_keyframes(bucket: str, input_key: str, output_key: str) -> None:
    from src.keyframes import run

    index = run(
        boto3.client("s3"),
        bucket,
        input_key,
        output_key,
        require("FRAMES_PREFIX"),
    )
    keyframes = sum(1 for frame in index["frames"] if frame["keyframe"])
    print(
        f"wrote {len(index['frames'])} frames ({keyframes} keyframes) "
        f"for {index['durationSeconds']:.0f}s to s3://{bucket}/{output_key}"
    )


def run_render_pages(bucket: str, input_key: str, output_key: str) -> None:
    from src.render_pages import run

    index = run(
        boto3.client("s3"),
        bucket,
        input_key,
        output_key,
        require("PAGES_PREFIX"),
    )
    print(
        f"rendered {len(index['pages'])} of {index['pageCount']} pages "
        f"to s3://{bucket}/{output_key}"
    )


def main() -> None:
    bucket = require("INPUT_BUCKET")
    input_key = require("INPUT_KEY")
    output_key = require("OUTPUT_KEY")
    mode = os.environ.get("TASK_MODE")
    if mode == "keyframes":
        run_keyframes(bucket, input_key, output_key)
        return
    if mode == "render-pages":
        run_render_pages(bucket, input_key, output_key)
        return
    model_name = os.environ.get("WHISPER_MODEL") or "medium"
    language = os.environ.get("LANGUAGE", "auto")

    s3 = boto3.client("s3")

    with tempfile.NamedTemporaryFile(suffix=".mp4") as audio:
        s3.download_fileobj(bucket, input_key, audio)
        audio.flush()
        result = transcribe_file(
            audio.name,
            model_name,
            None if language in ("", "auto") else language,
        )

    if not result["words"]:
        print("warning: transcription yielded 0 words", file=sys.stderr)

    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    print(f"wrote {len(result['words'])} words to s3://{bucket}/{output_key}")


if __name__ == "__main__":
    main()
