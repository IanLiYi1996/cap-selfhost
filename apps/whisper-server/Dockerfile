FROM python:3.12-slim

# ffmpeg as a safety net for the fragmented MP4 that Cap assembles for audio;
# PyAV usually handles it, but a batch task can afford the extra layer.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./

# Install locked production dependencies; --frozen fails the build if the
# lockfile is stale rather than silently re-resolving.
RUN pip install --no-cache-dir uv \
	&& uv export --frozen --no-dev --no-emit-project -o /tmp/requirements.txt \
	&& pip install --no-cache-dir -r /tmp/requirements.txt \
	&& rm /tmp/requirements.txt

# Bake the weights in: an on-demand task must not spend cold-start time
# downloading ~1.5GB from Hugging Face on every invocation.
ARG WHISPER_MODEL=medium
ENV WHISPER_MODEL=$WHISPER_MODEL
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

# Diarization weights, ~34MB total. Pinned to the sherpa-onnx release assets so
# the build is reproducible. CAM++ over eres2net is a measured choice: it is the
# only one of the two that gets both reference clips right, and it is smaller
# (see src/diarize.py).
ARG DIARIZATION_SEGMENTATION_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
ARG DIARIZATION_EMBEDDING_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
ENV DIARIZATION_MODEL_DIR=/models/diarization
# Fetched with the stdlib rather than curl/tar: python:slim ships neither, and
# adding them would mean apt packages in an early layer purely for build-time use.
RUN python - "$DIARIZATION_SEGMENTATION_URL" "$DIARIZATION_EMBEDDING_URL" <<'PY'
import os, sys, tarfile, tempfile, urllib.request

seg_url, emb_url = sys.argv[1], sys.argv[2]
target = os.environ["DIARIZATION_MODEL_DIR"]
os.makedirs(target, exist_ok=True)

with tempfile.NamedTemporaryFile(suffix=".tar.bz2") as archive:
    urllib.request.urlretrieve(seg_url, archive.name)
    with tarfile.open(archive.name, "r:bz2") as tar:
        member = next(m for m in tar.getmembers() if m.name.endswith("/model.onnx"))
        member.name = "segmentation.onnx"
        tar.extract(member, target, filter="data")

urllib.request.urlretrieve(emb_url, os.path.join(target, "speaker-embedding.onnx"))

for name in sorted(os.listdir(target)):
    size = os.path.getsize(os.path.join(target, name))
    print(f"{name}: {size / 1e6:.1f}MB")
    assert size > 1_000_000, f"{name} looks truncated"
PY

COPY src ./src

CMD ["python", "-m", "src.main"]
