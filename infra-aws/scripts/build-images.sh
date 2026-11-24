#!/usr/bin/env bash
# Build cap-web and media-server images and push them to ECR.
#
# cap-web must be built with the real public web URL: NEXT_PUBLIC_WEB_URL is
# inlined at build time, and share links / embed codes are generated from it.
# Run this only after `cdk deploy` has produced the App CloudFront domain.
#
# Usage: ./scripts/build-images.sh <account-id> <web-repo> <media-repo> <web-url> [whisper-repo]
set -euo pipefail

ACCOUNT="${1:?account id required}"
WEB_REPO="${2:?web repo name required}"
MEDIA_REPO="${3:?media repo name required}"
WEB_URL="${4:?web url required, eg. https://dxxxx.cloudfront.net}"
WHISPER_REPO="${5:-}"
REGION="us-east-1"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Fargate runs these tasks on x86_64. Without --platform, Apple Silicon builds
# arm64 images and every task exits with "exec format error".

aws ecr get-login-password --region "$REGION" \
	| docker login --username AWS --password-stdin "$REGISTRY"

echo "--- building cap-web with NEXT_PUBLIC_WEB_URL=${WEB_URL}"
docker build \
	--platform linux/amd64 \
	-f "${REPO_ROOT}/apps/web/Dockerfile" \
	--build-arg "NEXT_PUBLIC_WEB_URL=${WEB_URL}" \
	-t "${REGISTRY}/${WEB_REPO}:latest" \
	"${REPO_ROOT}"
docker push "${REGISTRY}/${WEB_REPO}:latest"

echo "--- building media-server"
docker build \
	--platform linux/amd64 \
	-f "${REPO_ROOT}/apps/media-server/Dockerfile.standalone" \
	-t "${REGISTRY}/${MEDIA_REPO}:latest" \
	"${REPO_ROOT}/apps/media-server"
docker push "${REGISTRY}/${MEDIA_REPO}:latest"

if [ -n "$WHISPER_REPO" ]; then
	echo "--- building whisper"
	docker build \
	--platform linux/amd64 \
		-f "${REPO_ROOT}/apps/whisper-server/Dockerfile" \
		-t "${REGISTRY}/${WHISPER_REPO}:latest" \
		"${REPO_ROOT}/apps/whisper-server"
	docker push "${REGISTRY}/${WHISPER_REPO}:latest"
else
	echo "--- skipping whisper (no repo name supplied)"
fi

echo "--- done"
