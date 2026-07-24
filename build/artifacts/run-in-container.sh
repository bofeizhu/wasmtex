#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. It drives OUR maintained engine
#   build config at build/engines/ (the Makefile forked from busytex at M2 item
#   3, MIT, with per-file derived-work headers). It is the CONTAINER mirror of
#   build/artifacts/build-native.sh: the same stage sequence, offline pre-staging
#   and verify gate — but on the image's native arm64 Linux GNU userland.
#
# WasmTeX CANONICAL artifact build — container side (M3 item 4).
# =============================================================================
# Runs INSIDE the pinned arm64 toolchain image. Builds our engine config,
# UNCHANGED, but fully OFFLINE: the Makefile normally curl/bsdtar-downloads its
# sources (URL_texlive/URL_expat/URL_fontconfig and the TL 2026 ISO). We
# pre-stage those from a read-only cache mount into the exact paths the Makefile's
# download rules produce (source/<id>/ + the source/<id>.txt sentinel), so those
# rules are already satisfied and make never reaches for the network. The
# container itself runs with `--network none` (see build.sh), so any missed
# pre-stage fails loud, closed — this is the container's HARD offline enforcement,
# which is why (unlike the native driver) we do NOT blank the URL_* variables.
#
# NATIVE-vs-CONTAINER DELTA (what this driver passes vs build-native.sh's macOS
# driver). The native driver injects `macos_overrides` on every `make`; NONE of
# them apply here, because this is a Linux GNU userland, not macOS:
#   * CMAKE_native / CMAKE_wasm  += -DCMAKE_POLICY_VERSION_MINIMUM=3.5
#       NATIVE-ONLY. Homebrew cmake is 4.x, which dropped the pre-3.5 policy the
#       expat 2.5.0 build declares. The image's apt cmake is 3.22 (< 4), so the
#       old `cmake_minimum_required` is honoured as-is. Omitted here.
#   * LDFLAGS_TEXLIVE_native = -lm -pthread
#       NATIVE-ONLY. Trims the Linux static/-ldl/-lpthread/--unresolved-symbols
#       flags Apple ld rejects. Here the Makefile's DEFAULT (the full Linux
#       LDFLAGS) is exactly right. Omitted here -> default applies.
#   * OPTS_BUSYTEX_LINK_native = ... -framework CoreFoundation ... AppKit
#       NATIVE-ONLY. XeTeX's macOS CoreText/AppKit font backend needs the Apple
#       frameworks; XeTeX on Linux uses the fontconfig/freetype backend and links
#       none. The Makefile's DEFAULT OPTS_BUSYTEX_LINK_native (Linux -ldl -lm
#       -pthread ...) is right. Omitted here -> default applies.
#   * URL_texlive / URL_expat / URL_fontconfig / URL_texlive_full_iso_cache = (blank)
#       NATIVE-ONLY offline enforcement (no network namespace on the host, so a
#       missed pre-stage must fail closed rather than curl an unpinned source).
#       Here `--network none` is the enforcement; the URLs stay documentary.
# NOT a delta (folded into build/engines/Makefile itself, host-agnostic):
#   * OPTS_LIBS_wasm = AR=$(AR_wasm)  (emar for wasm archives). Fixes the
#     hollow-wasm-archive defect on a BSD-ar host; on GNU ar it is a harmless
#     no-op (GNU ar is format-agnostic). See the Makefile comment / M2 journal 3.
# And the native driver's macOS SOURCE patches (build/patches/*/*.patch) are NOT
# applied here: both current entries (zlib-macos-fdopen, libpng-macos-fp-h) are
# RETIRED (header-only, no diff) and were macOS-scoped anyway (a TARGET_OS_MAC
# false-positive that never fires on Linux). See build/patches/README.md.
#
# Mounts provided by build.sh:
#   /cache        (ro)  ~/.cache/wasmtex/sources — verified pinned inputs
#   /engines      (ro)  build/engines            — OUR engine build config
#   /glue         (ro)  build/artifacts          — these scripts + verify-engine.mjs
#   /manifest     (ro)  build/manifest           — gen-assets.mjs (asset inventory)
#   /bundles      (ro)  build/bundles            — tier scripts + licenses.mjs (audit)
#   /audit        (ro)  build/audit              — check-sizes.mjs (size-budget gate)
#   /budgets.json (ro)  build/budgets.json       — per-asset size ceilings
#   /dist         (rw)  dist/                     — assembled artifacts land here
#   /work         (vol) named docker volume       — the build tree (fast, VM-native)
#
# Usage:  run-in-container.sh <stage>
#   stage ∈ { prep native basic wasm bundle dist verify all }
#   `all` runs prep→native→basic→wasm→bundle→dist in order; `dist` ends with the
#   execution gate (`verify`, also runnable standalone).
# =============================================================================
set -euo pipefail

# --- Reproducibility hooks (same derivation as the native driver) ------------
# SOURCE_DATE_EPOCH is the TL 2026 freeze date, 2026-03-01T00:00:00Z = 1772323200
# (passed in by build.sh; defaulted here for a standalone run). FORCE_SOURCE_DATE
# makes the TeX engines honour it when dumping .fmt files. LC_ALL is the C.UTF-8
# the image (and upstream's CI runner) already use — deterministic AND UTF-8-safe
# for install-tl/find over texmf trees. The M3 double-build is the real gate.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1772323200}"
export FORCE_SOURCE_DATE="${FORCE_SOURCE_DATE:-1}"
export TZ=UTC
export LC_ALL="${LC_ALL:-C.UTF-8}"
export LANG="${LANG:-C.UTF-8}"
umask 022

# --- Parallelism -------------------------------------------------------------
# Native arm64 Linux GNU Make: the jobserver works (the -j1 constraint was
# Rosetta-x86_64-only). Set via MAKEFLAGS (as the native driver does) so recursive
# $(MAKE) sub-builds share one jobserver rather than each forcing its own -jN.
JOBS="${WASMTEX_JOBS:-$(nproc)}"
export MAKEFLAGS="-j${JOBS}"

CACHE=/cache
ENGINES=/engines
GLUE=/glue
MANIFEST=/manifest
BUNDLES=/bundles   # OUR tier scripts (build/bundles/: gen-profile / stage-tiers / resolver); mounted ro by build.sh
AUDIT=/audit       # build/audit/ (check-sizes.mjs — the M5 item 5 size-budget gate); mounted ro by build.sh
BUDGETS=/budgets.json  # build/budgets.json (per-asset size ceilings); mounted ro by build.sh
DIST=/dist
BUILD=/work

# Cached inputs (names match build/sources/pins.lock, TL 2026 pins).
TL_SRC="$CACHE/texlive-source-2026.0.tar.gz"
EXPAT_SRC="$CACHE/expat-2.5.0.tar.gz"
FONTCONFIG_SRC="$CACHE/fontconfig-2.13.96.tar.gz"
ISO="$CACHE/texlive2026-20260301.iso"

# OUR engine build-config files the Makefile references by path (build/engines/).
machinery_files=(
  Makefile busytex.c emcc_wrapper.py normalize-lsr.py
)

banner() { printf '\n>> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# make in the build tree. NO macOS overrides (see the DELTA note in the header):
# on the Linux GNU userland the Makefile's defaults are exactly right.
run_make() { ( cd "$BUILD" && make "$@" ); }

# Faithful offline replacement for the Makefile's
#   source/<id>.txt: ; mkdir -p source/<id>; curl -L $(URL_<id>) | tar -xzf - -C source/<id> --strip-components=1; find source/<id> > source/<id>.txt
# using the pinned cached tarball instead of curl. Guarded by the .txt sentinel
# so it is idempotent and never re-extracts on a resumed build.
stage_tarball() {
  local id="$1" tarball="$2"
  if [ -f "$BUILD/source/$id.txt" ]; then
    echo "   source/$id already staged; skipping"
    return
  fi
  [ -f "$tarball" ] || { echo "!! missing pinned input: $tarball (run build/sources/fetch.sh)" >&2; exit 1; }
  echo "   staging source/$id from $(basename "$tarball")"
  mkdir -p "$BUILD/source/$id"
  tar -xzf "$tarball" -C "$BUILD/source/$id" --strip-components=1
  ( cd "$BUILD" && find "source/$id" > "source/$id.txt" )
}

do_prep() {
  banner "prep: stage config + sources (offline)"
  mkdir -p "$BUILD"

  # Sync OUR engine build-config (build/engines/) into the work tree (a build
  # sandbox). Copy only files whose content DIFFERS, so unchanged files keep their
  # mtime and make stays incremental on resume within one build. (On a fresh
  # volume — the STAGE=all/prep default — every file copies.)
  local f b
  for f in "${machinery_files[@]}"; do
    if ! cmp -s "$ENGINES/$f" "$BUILD/$f" 2>/dev/null; then
      echo "   syncing build config into work tree: $f"
      cp "$ENGINES/$f" "$BUILD/$f"
    fi
  done

  # Sync OUR tier bundle scripts (build/bundles/*.mjs, minus *.test.mjs) into the
  # work tree so the Makefile's profile/staging rules resolve them and their
  # relative imports (./tlpdb.mjs, ./tiers.mjs, ./resolve.mjs) work in-tree.
  # mtime-preserving (cmp -s) so make stays incremental on resume. M4 item 3.
  mkdir -p "$BUILD/bundles"
  for f in "$BUNDLES"/*.mjs; do
    b="$(basename "$f")"
    case "$b" in *.test.mjs) continue ;; esac
    if ! cmp -s "$f" "$BUILD/bundles/$b" 2>/dev/null; then
      echo "   syncing tier bundle script: bundles/$b"
      cp "$f" "$BUILD/bundles/$b"
    fi
  done

  # Pre-stage the three tarball sources the Makefile would curl.
  stage_tarball texlive    "$TL_SRC"
  stage_tarball expat      "$EXPAT_SRC"
  stage_tarball fontconfig "$FONTCONFIG_SRC"

  # Pre-stage the TL 2026 texmf repository from the frozen ISO. Faithful to the
  # Makefile's source/texmfrepo.txt rule (`... | bsdtar -x -C source/texmfrepo`),
  # reading the local ISO instead of the split-release cache URL. bsdtar reads the
  # ISO9660 image directly; the root carries install-tl + archive/ + tlpkg/.
  if [ ! -f "$BUILD/source/texmfrepo.txt" ]; then
    [ -f "$ISO" ] || { echo "!! missing pinned ISO: $ISO (run build/sources/fetch.sh)" >&2; exit 1; }
    echo "   staging source/texmfrepo from $(basename "$ISO") (this takes a few minutes)"
    mkdir -p "$BUILD/source/texmfrepo"
    bsdtar -x -C "$BUILD/source/texmfrepo" -f "$ISO"
    ( cd "$BUILD" && find "source/texmfrepo" > "source/texmfrepo.txt" )
  else
    echo "   source/texmfrepo already staged; skipping"
  fi

  # (No macOS source patches: build/patches/*/*.patch are macOS-scoped and
  #  currently retired — see the header DELTA note.)

  # versions.txt (upstream build-wasm.yml step). Pure text, no network.
  run_make build/versions.txt
  echo "   prep complete"
}

do_native() {
  banner "native: build native multicall busytex from source (arm64, real -j$JOBS)"
  # native = texlive.configured -> texlivedependencies -> busytexapplets ->
  # build/native/busytex (the native multicall binary install-tl's custom-bin
  # wrappers dispatch to, and whose helper tools the wasm pass reuses).
  run_make native
  echo "   native busytex: $(ls -la "$BUILD/build/native/busytex" 2>/dev/null || echo MISSING)"
}

do_basic() {
  banner "basic: install TL combined tiers tree (scheme-basic + core+academic collections) via install-tl + dump .fmt formats"
  # ONE install-tl run installs every shipped tier's collections into
  # build/texlive-tiers (profile generated from build/bundles/tiers.mjs); the
  # bundle stage then splits it into disjoint per-tier bundles.
  run_make build/texlive-tiers.txt
  echo "   formats:"; find "$BUILD/build/texlive-tiers/texmf-dist/texmf-var/web2c" -name '*.fmt' -exec ls -la {} + 2>/dev/null || true
}

do_wasm() {
  banner "wasm: build wasm multicall busytex.js/.wasm (real -j$JOBS)"
  # Reuses native-built helper tools (ctangle/otangle/web2c/icupkg/pkgdata/
  # apinames) via the CCSKIP_* wrappers — native must be complete first.
  run_make wasm
  echo "   wasm engine:"; ls -la "$BUILD/build/wasm/busytex.js" "$BUILD/build/wasm/busytex.wasm" 2>/dev/null || echo MISSING
}

do_bundle() {
  banner "bundle: stage disjoint tiers + file_packager each (core + academic: js + data)"
  # Split the pruned combined install into disjoint per-tier trees (build/stage/
  # <tier>/) via the tlpdb tier map, then file_packager each. build/stage/tiers.txt
  # lists the tiers that received files — the exact set to package (N-tier-general).
  run_make build/stage.stamp
  local tiers=() t targets=()
  while IFS= read -r t; do [ -n "$t" ] && tiers+=("$t"); done < "$BUILD/build/stage/tiers.txt"
  echo "   tiers: ${tiers[*]}"
  for t in "${tiers[@]}"; do targets+=("build/wasm/data/$t.js"); done
  run_make "${targets[@]}"
  for t in "${tiers[@]}"; do
    echo "   bundle[$t]:"; ls -la "$BUILD/build/wasm/data/$t.js" "$BUILD/build/wasm/data/$t.data" 2>/dev/null || echo MISSING
  done
}

do_dist() {
  banner "dist: assemble /dist (engine + formats + bundle + checksums)"
  # Our own assembly, byte-for-byte the same layout as build-native.sh do_dist:
  # the engine wasm/js, the standalone .fmt formats, and the texlive-basic data
  # bundle. The vendored busytex worker/pipeline glue is NOT shipped (M1 replaced
  # its role; M2 item 3 decision) — dist/ carries only WasmTeX-consumed artifacts.
  local wasm="$BUILD/build/wasm" fmtdir="$BUILD/build/texlive-tiers/texmf-dist/texmf-var/web2c"

  rm -rf "${DIST:?}"/*
  mkdir -p "$DIST/formats"

  # Engine wasm + js.
  cp "$wasm/busytex.js"   "$DIST/busytex.js"
  cp "$wasm/busytex.wasm" "$DIST/busytex.wasm"
  # Per-tier data bundles (js + data pair each), disjoint, driven by the tier map
  # (build/stage/tiers.txt). N-tier-general: whatever tiers were staged/packed.
  local t
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    cp "$wasm/data/$t.js"   "$DIST/$t.js"
    cp "$wasm/data/$t.data" "$DIST/$t.data"
  done < "$BUILD/build/stage/tiers.txt"
  # Back-compat ALIAS (M4 item 3; dropped at M5). texlive-basic.{js,data} are byte
  # copies of core.{js,data} so the demo + published 0.0.1 consumers that still
  # name the `texlive-basic` bundle keep working unchanged. texlive-basic.js loads
  # core.data internally (baked file_packager reference), so do NOT preload BOTH
  # `texlive-basic` and `core` in one session. See docs/plans/M4.md + DESIGN §6.3 note.
  cp "$wasm/data/core.js"   "$DIST/texlive-basic.js"
  cp "$wasm/data/core.data" "$DIST/texlive-basic.data"
  # Standalone engine formats (also embedded in core; surfaced per spec).
  find "$fmtdir" -name '*.fmt' -exec cp {} "$DIST/formats/" \;

  # Shipped-aggregate license INVENTORY + fail-closed AUDIT (M5 item 2). Emitted
  # BEFORE SHA256SUMS so /dist/licenses.json is hashed + cross-checked like any
  # payload file (gen-assets classifies it role "license-inventory"). The audit is
  # FAIL-CLOSED: a shipped TeX Live package whose `catalogue-license` is missing /
  # non-free / not on the free allowlist (and not resolved by the cited
  # build/bundles/license-exceptions.mjs) aborts the build here (set -e). Reads the
  # pinned tlpdb ISO-staged under source/.
  banner "dist: shipped-aggregate license inventory + fail-closed audit (licenses.json)"
  node "$BUNDLES/licenses.mjs" --tlpdb "$BUILD/source/texmfrepo/tlpkg/texlive.tlpdb" --json "$DIST/licenses.json"

  # Deterministic integrity list (sorted, relative paths). Linux: sha256sum —
  # byte-identical output format to the native driver's `shasum -a 256`, so the
  # SHA256SUMS file is comparable across the native and container builds. The two
  # gen-assets outputs (manifest.json, assets.json) are excluded (not payload; a
  # self-reference fixpoint otherwise). licenses.json IS listed (payload, above).
  ( cd "$DIST" && find . -type f ! -name SHA256SUMS ! -name manifest.json ! -name assets.json | LC_ALL=C sort | xargs sha256sum > SHA256SUMS )

  # Integrity manifest: dist/manifest.json (schemaVersion 2, DESIGN §7) + the
  # dist/assets.json v1 alias (M4 item 4). Emitted AFTER SHA256SUMS and BEFORE the
  # verify gate — a mis-classified artifact or a hash mismatch must fail the BUILD,
  # not a downstream consumer. --tiers is the stage-tiers side-channel (per-bundle
  # provides + TL snapshot id); generated=/snapshot are pinned off SOURCE_DATE_EPOCH,
  # so re-running this stage is byte-identical (and matches the native build's).
  banner "dist: generate manifest.json + assets.json (integrity manifest)"
  node "$MANIFEST/gen-assets.mjs" "$DIST" --tiers "$BUILD/build/stage/tiers.json"

  # Asset size-budget check (M5 item 5, DESIGN §8). Reads the per-file `bytes`
  # gen-assets just wrote into /dist/manifest.json (NOT re-stat'd) and compares each
  # budgeted asset against build/budgets.json's ceiling. FAIL-CLOSED, mirroring the
  # license audit above: an over-budget artifact aborts the CANONICAL build here
  # (set -e), so the strictly-budgeted PRELOAD cold-start path never grows unnoticed
  # into a release. Because it lives in the dist stage, artifacts-build.yml enforces
  # it with NO workflow edit. build/audit + build/budgets.json are mounted by build.sh.
  banner "dist: asset size-budget check (check-sizes.mjs vs budgets.json)"
  node "$AUDIT/check-sizes.mjs" --manifest "$DIST/manifest.json" --budgets "$BUDGETS"

  banner "dist inventory"
  ( cd "$DIST" && ls -la . formats && echo && cat SHA256SUMS )

  # Execution gate: a structurally-valid-but-hollow wasm must never pass. Verify
  # the assembled dist/ actually runs before declaring the stage done.
  do_verify
}

# --- Execution gate ----------------------------------------------------------
# Drive the just-built engine under node and assert it is a SOUND binary, not a
# structurally-valid hollow one (env-import sanity + a real `xetex --version`
# that must print the TeX Live 2026 banner). Shared harness with the native flow.
do_verify() {
  banner "verify: execution gate — run engine under node + env-import sanity"
  # timeout: synchronous wasm can't be interrupted in-process; a spinning engine
  # must not hang the gate at the end of a multi-hour build.
  timeout 300 node "$GLUE/verify-engine.mjs" "$DIST"
}

stage="${1:-all}"
banner "WasmTeX canonical artifacts build — container side"
echo "   stage:     $stage"
echo "   build:     $BUILD"
echo "   jobs:      MAKEFLAGS=$MAKEFLAGS   SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
echo "   emcc:      $(command -v emcc)   node: $(command -v node)"


case "$stage" in
  prep)   do_prep ;;
  native) do_native ;;
  basic)  do_basic ;;
  wasm)   do_wasm ;;
  bundle) do_bundle ;;
  dist)   do_dist ;;
  verify) do_verify ;;
  all)    do_prep; do_native; do_basic; do_wasm; do_bundle; do_dist ;;
  *) echo "unknown stage: $stage (want: prep native basic wasm bundle dist verify all)" >&2; exit 2 ;;
esac

banner "stage '$stage' done"
