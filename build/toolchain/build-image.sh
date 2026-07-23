#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#
# Build a pinned WasmTeX build-toolchain image and print the resulting image
# identifier. That identifier is the "image_id" pin recorded in
# build/sources/pins.lock ([toolchain-image-arm64] for the canonical arm64
# builder; [toolchain-image] for the parked amd64 equivalence lane). One
# Dockerfile serves both arches — only --platform differs (M3 item 3).
# Intentionally boring and readable.
#
# The CANONICAL builder is arm64 Linux, built NATIVELY on the Apple-Silicon host
# (no Rosetta). The amd64 image is the equivalence-check lane (M3 item 6) and, on
# an arm64 host, builds under emulation (slow) — prefer a CI amd64 runner.
#
# Usage:
#   build/toolchain/build-image.sh                 # arm64 (canonical); tags :arm64-dev
#   build/toolchain/build-image.sh arm64           # explicit arm64
#   build/toolchain/build-image.sh amd64           # equivalence lane; tags :amd64-dev
#   WASMTEX_TOOLCHAIN_ARCH=amd64 build-image.sh     # same, via env
#   WASMTEX_TOOLCHAIN_TAG=foo:bar build-image.sh    # override the tag entirely
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

arch="${1:-${WASMTEX_TOOLCHAIN_ARCH:-arm64}}"
case "$arch" in
  arm64|aarch64) arch=arm64; platform=linux/arm64 ;;
  amd64|x86_64)  arch=amd64; platform=linux/amd64 ;;
  *) echo "!! unknown arch '$arch' (want: arm64 | amd64)" >&2; exit 2 ;;
esac

image_tag="${WASMTEX_TOOLCHAIN_TAG:-wasmtex-toolchain:${arch}-dev}"

host_arch="$(uname -m)"
note="native"
if { [ "$arch" = amd64 ] && [ "$host_arch" != x86_64 ]; } \
   || { [ "$arch" = arm64 ] && [ "$host_arch" != arm64 ] && [ "$host_arch" != aarch64 ]; }; then
  note="EMULATED (host is ${host_arch}; this is slow — prefer a CI ${arch} runner)"
fi

echo ">> Building ${image_tag} for ${platform} (${note}) from ${here}/Dockerfile"
docker build \
  --platform "${platform}" \
  --tag "${image_tag}" \
  --file "${here}/Dockerfile" \
  "${here}"

# The reproducibility anchor is the built image's content digest. For a locally
# built (never-pushed) image the stable identifier is its Image ID (the image
# config digest); a registry RepoDigest only exists after `docker push`.
image_id="$(docker image inspect --format '{{.Id}}' "${image_tag}")"
repo_digests="$(docker image inspect --format '{{join .RepoDigests " "}}' "${image_tag}")"

echo ">> Built ${image_tag} (${platform})"
if [ "$arch" = arm64 ]; then
  echo "   Image ID:      ${image_id}   <- record in pins.lock [toolchain-image-arm64]"
else
  echo "   Image ID:      ${image_id}   <- record in pins.lock [toolchain-image] (amd64 lane)"
fi
if [ -n "${repo_digests}" ]; then
  echo "   RepoDigest(s): ${repo_digests}"
else
  echo "   RepoDigest(s): (none until 'docker push'; the Image ID above pins local builds)"
fi
