#!/usr/bin/env bash
set -euo pipefail

# Read the version from package.json (first "version": "x" match).
version=$(awk -F'"' '/"version": ".+"/{ print $4; exit; }' ./package.json)

if [ -z "${version:-}" ]; then
  echo "Could not determine version from package.json" >&2
  exit 1
fi

export VERSION="$version"

IMAGE="mikaelx/bm-bluetooth"

echo "Building ${IMAGE}:${VERSION} for linux/amd64"
podman build --platform=linux/amd64 -f ./Dockerfile -t "${IMAGE}:${VERSION}" .

echo "Pushing ${IMAGE}:${VERSION}"
podman push "${IMAGE}:${VERSION}"

echo "Tagging and pushing ${IMAGE}:latest"
podman tag "${IMAGE}:${VERSION}" "${IMAGE}:latest"
export VERSION="latest"
podman push "${IMAGE}:latest"

echo "Done."
# Webhook to auto-deploy (uncomment and set the URL when ready):
curl -X POST https://portainer.almiro.se/api/webhooks/2fedf374-fa45-4418-beb5-cc4d5b987a0b
