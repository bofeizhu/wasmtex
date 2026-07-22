#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. Intentionally boring and readable
#   (style-matched to build/toolchain/build-image.sh).
#
# WasmTeX M0 "faithful baseline" build — host side (M0 item 4).
# =============================================================================
# Runs the vendored busytex build inside the pinned wasmtex-toolchain image,
# fully OFFLINE (`--network none`), against the verified cache at
# ~/.cache/wasmtex/sources, and lands the artifacts in dist/. The heavy build
# tree lives on a named docker volume (VM-native fs, fast under Rosetta); only
# the small dist/ output crosses the host bind mount.
#
# The `artifacts` target of the repo-root Makefile delegates here.
#
# Usage:
#   build/artifacts/build.sh                 # full pipeline (stage: all)
#   WASMTEX_STAGE=native build/artifacts/build.sh   # one stage (prep|native|
#                                                   #  basic|wasm|bundle|dist|all)
# Env overrides:
#   WASMTEX_CACHE_DIR   pinned-source cache (default ~/.cache/wasmtex/sources)
#   WASMTEX_TOOLCHAIN_TAG   image tag (default wasmtex-toolchain:dev)
#   WASMTEX_JOBS        make parallelism (MAKEFLAGS=-jN) in the container (def 2)
#   SOURCE_DATE_EPOCH   repro epoch (default: busytex pin commit date)
#   WASMTEX_VOLUME      docker volume for the build tree (default wasmtex-m0-work)
#   WASMTEX_ALLOW_IMAGE_MISMATCH=1  proceed even if the image id != pins.lock
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

stage="${WASMTEX_STAGE:-all}"
cache_dir="${WASMTEX_CACHE_DIR:-$HOME/.cache/wasmtex/sources}"
image_tag="${WASMTEX_TOOLCHAIN_TAG:-wasmtex-toolchain:dev}"
volume="${WASMTEX_VOLUME:-wasmtex-m0-work}"
# Default -j1: GNU Make's pipe jobserver is unreliable under this host's
# Rosetta x86_64 emulation (aborts with "write jobserver: Bad file descriptor"
# for -jN>1); -j1 uses no jobserver and is safe. Raise WASMTEX_JOBS on a real
# x86_64 builder. Supplied to make as env MAKEFLAGS inside the container, never
# a command-line -jN. See the journal's "native attempt … jobserver" notes.
jobs="${WASMTEX_JOBS:-1}"
container_name="${WASMTEX_CONTAINER_NAME:-wasmtex-m0-build}"
# busytex pin commit date (f2bd7b11, 2026-06-16 16:06:37 +0200); see the journal.
source_date_epoch="${SOURCE_DATE_EPOCH:-1781618797}"

machinery="$repo/build/upstream/busytex"
dist="$repo/dist"

# --- Preflight: pinned inputs + image identity -------------------------------
# Existence check only: content integrity is fetch-time (fetch.sh verifies
# every hash), not build-time — re-hashing the 4.8 GiB ISO per build is not
# worth it. Run build/sources/fetch.sh to (re)verify the cache.
required_inputs=(
  texlive-source-2023.0.tar.gz expat-2.5.0.tar.gz
  fontconfig-2.13.96.tar.gz texlive2023-20230313.iso
)
missing=0
for f in "${required_inputs[@]}"; do
  if [ ! -f "$cache_dir/$f" ]; then
    echo "!! missing pinned input: $cache_dir/$f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "!! run build/sources/fetch.sh first (it downloads + verifies the pins)." >&2
  exit 1
fi

if [ ! -f "$machinery/Makefile" ]; then
  echo "!! vendored busytex machinery not found at $machinery" >&2
  exit 1
fi

# Faithful-baseline builds must use the pinned toolchain image. Compare the
# local image id against build/sources/pins.lock [toolchain-image]. A missing
# lock file must fail loud, not degrade to accepting any image.
lock="$repo/build/sources/pins.lock"
[ -r "$lock" ] || { echo "!! $lock missing/unreadable — cannot verify image pin" >&2; exit 1; }
pinned_id="$(awk -F= '/^\[/{s=$0} s=="[toolchain-image]" && $1 ~ /^ *image_id *$/ {gsub(/ /,"",$2); print $2; exit}' "$lock" || true)"
local_id="$(docker image inspect --format '{{.Id}}' "$image_tag" 2>/dev/null || true)"
if [ -z "$local_id" ]; then
  echo "!! image $image_tag not found — build it with build/toolchain/build-image.sh" >&2
  exit 1
fi
if [ -n "$pinned_id" ] && [ "$local_id" != "$pinned_id" ]; then
  echo "!! image id mismatch:" >&2
  echo "     local:  $local_id" >&2
  echo "     pinned: $pinned_id  (build/sources/pins.lock)" >&2
  if [ "${WASMTEX_ALLOW_IMAGE_MISMATCH:-0}" != "1" ]; then
    echo "   set WASMTEX_ALLOW_IMAGE_MISMATCH=1 to proceed anyway." >&2
    exit 1
  fi
  echo "   WASMTEX_ALLOW_IMAGE_MISMATCH=1 set; proceeding." >&2
fi

mkdir -p "$dist"
docker volume create "$volume" >/dev/null

# Reuse a single fixed container name; remove any prior instance so a failed
# stage's container (kept for post-mortem — no --rm) does not block the rerun.
docker rm -f "$container_name" >/dev/null 2>&1 || true

echo ">> WasmTeX M0 artifacts build"
echo "   stage:       $stage"
echo "   image:       $image_tag ($local_id)"
echo "   container:   $container_name  (kept on exit for post-mortem)"
echo "   cache:       $cache_dir  (mounted ro, --network none)"
echo "   work volume: $volume"
echo "   dist:        $dist"
echo "   jobs:        MAKEFLAGS=-j$jobs   SOURCE_DATE_EPOCH=$source_date_epoch"

# --- Run the pipeline inside the pinned container, offline -------------------
# bash -l sources the emsdk env (per the Dockerfile's login-shell profile).
# No --rm: on a multi-hour build a crashed stage must leave its container so its
# logs survive (`docker logs $container_name`); the rm -f above reclaims it next
# run. `docker wait $container_name` gives a clean blocking completion signal.
docker run \
  --name "$container_name" \
  --platform linux/amd64 \
  --network none \
  -e "SOURCE_DATE_EPOCH=$source_date_epoch" \
  -e "FORCE_SOURCE_DATE=1" \
  -e "WASMTEX_JOBS=$jobs" \
  -v "$cache_dir":/cache:ro \
  -v "$machinery":/machinery:ro \
  -v "$here":/glue:ro \
  -v "$dist":/dist \
  -v "$volume":/work \
  "$image_tag" \
  bash -lc "bash /glue/run-in-container.sh '$stage'"

echo ">> stage '$stage' finished; artifacts (if produced) are in $dist"
