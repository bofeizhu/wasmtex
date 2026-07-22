#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#
# Build the pinned WasmTeX build-toolchain image for linux/amd64 and print the
# resulting image identifier. That identifier is the "container" pin recorded
# in build/sources/pins.lock (M0 item 2). Intentionally boring and readable.
#
# Usage:
#   build/toolchain/build-image.sh              # tags wasmtex-toolchain:dev
#   WASMTEX_TOOLCHAIN_TAG=foo:bar build-image.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_tag="${WASMTEX_TOOLCHAIN_TAG:-wasmtex-toolchain:dev}"

echo ">> Building ${image_tag} for linux/amd64 from ${here}/Dockerfile"
echo ">> (on an arm64 host this runs under Rosetta emulation and is slow)"
docker build \
  --platform linux/amd64 \
  --tag "${image_tag}" \
  --file "${here}/Dockerfile" \
  "${here}"

# The reproducibility anchor is the built image's content digest. For a locally
# built (never-pushed) image the stable identifier is its Image ID (the image
# config digest); a registry RepoDigest only exists after `docker push`.
image_id="$(docker image inspect --format '{{.Id}}' "${image_tag}")"
repo_digests="$(docker image inspect --format '{{join .RepoDigests " "}}' "${image_tag}")"

echo ">> Built ${image_tag}"
echo "   Image ID:      ${image_id}   <- record this in build/sources/pins.lock"
if [ -n "${repo_digests}" ]; then
  echo "   RepoDigest(s): ${repo_digests}"
else
  echo "   RepoDigest(s): (none until 'docker push'; the Image ID above pins local builds)"
fi
