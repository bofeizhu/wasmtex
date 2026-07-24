#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. Intentionally boring and readable
#   (style-matched to build/toolchain/build-image.sh and build-native.sh).
#
# WasmTeX CANONICAL artifact build — host side (M3 item 4).
# =============================================================================
# Runs OUR maintained engine build config (build/engines/) inside the pinned
# CANONICAL arm64 toolchain image (build/sources/pins.lock [toolchain-image-arm64]),
# fully OFFLINE (`--network none`), against the verified source cache at
# ~/.cache/wasmtex/sources, and lands the artifacts in dist/. This is the
# container mirror of build/artifacts/build-native.sh: the SAME stage sequence
# (prep -> native -> basic -> wasm -> bundle -> dist, ending in the execution
# gate), the SAME offline pre-staging, the SAME reproducibility epoch — but on a
# native arm64 Linux GNU userland, which needs NONE of the native driver's
# macOS-specific make overrides (Apple frameworks, cmake-4 policy floor, the
# LDFLAGS trim, the URL-blank offline enforcement). See run-in-container.sh for
# the enumerated native-vs-container delta.
#
# Per DESIGN.md §9's constitutional floor, ONLY container-built, pin-verified
# artifacts are ever released; the native flow is a development vehicle. This is
# that canonical builder (DESIGN.md §9 amendment: arm64 Linux, no Rosetta).
#
# The heavy build tree lives on a named docker volume (VM-native fs, fast — a
# macOS bind mount would drag the multi-GB TL source tree + ~6.5 GB texmfrepo
# ISO staging through virtiofs). Only the small dist/ output crosses the host
# bind mount. WORK-TREE POLICY (reproducibility, M3 items 5/6): a full build
# (STAGE=all) or its first phase (STAGE=prep) WIPES and recreates the volume, so
# every build starts from a pristine tree — the build-twice repro gate must not
# be contaminated by incremental state. A single-stage resume reuses the volume.
#
# The `artifacts-container` target of the repo-root Makefile delegates here.
#
# Usage:
#   build/artifacts/build.sh                 # full pipeline (stage: all)
#   WASMTEX_STAGE=native build/artifacts/build.sh   # one stage (prep|native|
#                                                   #  basic|wasm|bundle|dist|verify|all)
# Env overrides:
#   WASMTEX_CACHE_DIR   pinned-source cache (default ~/.cache/wasmtex/sources)
#   WASMTEX_TOOLCHAIN_TAG   image tag (default wasmtex-toolchain:arm64-dev)
#   WASMTEX_JOBS        make parallelism (MAKEFLAGS=-jN); default: container nproc
#   SOURCE_DATE_EPOCH   repro epoch (default: TL 2026 freeze 2026-03-01)
#   WASMTEX_VOLUME      docker volume for the build tree (default wasmtex-work)
#   WASMTEX_ALLOW_IMAGE_MISMATCH=1  proceed even if the image id != pins.lock
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

stage="${WASMTEX_STAGE:-all}"
cache_dir="${WASMTEX_CACHE_DIR:-$HOME/.cache/wasmtex/sources}"
image_tag="${WASMTEX_TOOLCHAIN_TAG:-wasmtex-toolchain:arm64-dev}"
volume="${WASMTEX_VOLUME:-wasmtex-work}"
container_name="${WASMTEX_CONTAINER_NAME:-wasmtex-build}"
# make parallelism: native arm64 Linux has a working jobserver (the -j1
# constraint was Rosetta-x86_64-only). Left EMPTY here so run-in-container.sh
# defaults to the container's nproc; WASMTEX_JOBS overrides on either side.
jobs="${WASMTEX_JOBS:-}"
# TL 2026 freeze date, 2026-03-01T00:00:00Z = 1772323200 — the SAME epoch as the
# native driver (build-native.sh), the source tag (texlive-2026.0) and the ISO,
# so container and native artifacts are epoch-comparable (M3 items 5/6).
source_date_epoch="${SOURCE_DATE_EPOCH:-1772323200}"

engines="$repo/build/engines"
manifest="$repo/build/manifest"
bundles="$repo/build/bundles"   # OUR tier scripts (gen-profile / stage-tiers / resolver); M4 item 3
audit="$repo/build/audit"       # check-sizes.mjs — the M5 item 5 size-budget gate
budgets="$repo/build/budgets.json"  # per-asset size ceilings (checked in the dist stage)
runtime_pkg="$repo/runtime/package.json"  # the npm↔assets lockstep VERSION source (DESIGN §4, M5 item 8)
dist="$repo/dist"

# --- Preflight: pinned inputs + config + image identity ----------------------
# Existence check only: content integrity is fetch-time (fetch.sh verifies every
# hash), not build-time — re-hashing the 6.5 GiB ISO per build is not worth it.
# Run build/sources/fetch.sh to (re)verify the cache. Names track the TL 2026
# pins ([texlive-source-2026] / [texlive-iso-2026]); expat/fontconfig serve both
# TL years (pins.lock).
required_inputs=(
  texlive-source-2026.0.tar.gz expat-2.5.0.tar.gz
  fontconfig-2.13.96.tar.gz texlive2026-20260301.iso
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

if [ ! -f "$engines/Makefile" ]; then
  echo "!! engine build config not found at $engines/Makefile" >&2
  exit 1
fi

# The size-budget gate runs in the dist stage (run-in-container.sh -> check-sizes.mjs).
# Its script + the budget file are bind-mounted below; a single-file mount of a
# MISSING host file would make Docker create a directory at the mount point, so
# fail loud here instead (mirrors the $engines/Makefile check above).
if [ ! -f "$audit/check-sizes.mjs" ]; then
  echo "!! size-budget checker not found at $audit/check-sizes.mjs" >&2
  exit 1
fi
if [ ! -f "$budgets" ]; then
  echo "!! size budget file not found at $budgets" >&2
  exit 1
fi
# runtime/package.json is bind-mounted read-only so the dist stage can stamp the
# lockstep manifest.version from it (read with node INSIDE the container, so the
# host needs no node — the artifacts-build runner has none). Same single-file
# mount hazard as budgets.json: fail loud if it is missing.
if [ ! -f "$runtime_pkg" ]; then
  echo "!! runtime/package.json (the lockstep version source) not found at $runtime_pkg" >&2
  exit 1
fi

# Released artifacts must come from the pinned CANONICAL image. Compare the local
# image id against build/sources/pins.lock [toolchain-image-arm64]. A missing lock
# file must fail loud, not degrade to accepting any image.
lock="$repo/build/sources/pins.lock"
[ -r "$lock" ] || { echo "!! $lock missing/unreadable — cannot verify image pin" >&2; exit 1; }
pinned_id="$(awk -F= '/^\[/{s=$0} s=="[toolchain-image-arm64]" && $1 ~ /^ *image_id *$/ {gsub(/ /,"",$2); print $2; exit}' "$lock" || true)"
# Empty pinned_id (renamed block, dropped key, awk drift at a future re-pin)
# must fail loud, not degrade to accepting any image on the canonical builder.
if [ -z "$pinned_id" ]; then
  echo "!! image_id not found in [toolchain-image-arm64] ($lock) — cannot verify image pin" >&2
  [ "${WASMTEX_ALLOW_IMAGE_MISMATCH:-0}" = "1" ] || exit 1
  echo "   WASMTEX_ALLOW_IMAGE_MISMATCH=1 set; proceeding UNVERIFIED." >&2
fi
local_id="$(docker image inspect --format '{{.Id}}' "$image_tag" 2>/dev/null || true)"
if [ -z "$local_id" ]; then
  echo "!! image $image_tag not found — build it with build/toolchain/build-image.sh arm64" >&2
  exit 1
fi
if [ -n "$pinned_id" ] && [ "$local_id" != "$pinned_id" ]; then
  echo "!! image id mismatch:" >&2
  echo "     local:  $local_id" >&2
  echo "     pinned: $pinned_id  (build/sources/pins.lock [toolchain-image-arm64])" >&2
  if [ "${WASMTEX_ALLOW_IMAGE_MISMATCH:-0}" != "1" ]; then
    echo "   set WASMTEX_ALLOW_IMAGE_MISMATCH=1 to proceed anyway." >&2
    exit 1
  fi
  echo "   WASMTEX_ALLOW_IMAGE_MISMATCH=1 set; proceeding." >&2
fi

mkdir -p "$dist"

# Reclaim any prior container FIRST (a kept post-mortem container holds the
# volume open, so the wipe below would fail otherwise).
docker rm -f "$container_name" >/dev/null 2>&1 || true

# Work-tree policy (see header): a full build or its prep phase starts from a
# pristine volume; a single-stage resume reuses the in-progress one.
case "$stage" in
  all|prep)
    docker volume rm "$volume" >/dev/null 2>&1 || true
    docker volume create "$volume" >/dev/null
    ;;
  verify)
    # verify only reads /dist — no work volume required.
    docker volume create "$volume" >/dev/null 2>&1 || true
    ;;
  *)
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
      echo "!! work volume $volume not found — run STAGE=prep (or STAGE=all) first" >&2
      exit 1
    fi
    ;;
esac

echo ">> WasmTeX canonical artifacts build (arm64 container)"
echo "   stage:       $stage"
echo "   image:       $image_tag ($local_id)"
echo "   container:   $container_name  (kept on exit for post-mortem)"
echo "   cache:       $cache_dir  (mounted ro, --network none)"
echo "   config:      $engines  (build/engines, mounted ro)"
echo "   bundles:     $bundles  (build/bundles tier scripts, mounted ro)"
echo "   audit:       $audit  (check-sizes.mjs size-budget gate) + budgets.json, mounted ro"
echo "   version src:  $runtime_pkg  (lockstep manifest.version), mounted ro"
echo "   work volume: $volume  ($([ "$stage" = all ] || [ "$stage" = prep ] && echo 'fresh (clean per build)' || echo 'reused (resume)'))"
echo "   dist:        $dist"
echo "   jobs:        MAKEFLAGS=-j${jobs:-<nproc>}   SOURCE_DATE_EPOCH=$source_date_epoch"

# --- Run the pipeline inside the pinned container, offline -------------------
# bash -l sources the emsdk env (per the Dockerfile's login-shell profile), so
# emcc/emar/node are on PATH. No --rm: on a multi-hour build a crashed stage must
# leave its container so its logs survive (`docker logs $container_name`); the
# rm -f above reclaims it next run. The foreground `docker run` below IS the
# blocking completion signal.
docker run \
  --name "$container_name" \
  --platform linux/arm64 \
  --network none \
  -e "SOURCE_DATE_EPOCH=$source_date_epoch" \
  -e "FORCE_SOURCE_DATE=1" \
  ${jobs:+-e "WASMTEX_JOBS=$jobs"} \
  -v "$cache_dir":/cache:ro \
  -v "$engines":/engines:ro \
  -v "$here":/glue:ro \
  -v "$manifest":/manifest:ro \
  -v "$bundles":/bundles:ro \
  -v "$audit":/audit:ro \
  -v "$budgets":/budgets.json:ro \
  -v "$runtime_pkg":/runtime-package.json:ro \
  -v "$dist":/dist \
  -v "$volume":/work \
  "$image_tag" \
  bash -lc "bash /glue/run-in-container.sh '$stage'"

echo ">> stage '$stage' finished; artifacts (if produced) are in $dist"
