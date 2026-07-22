#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. It *drives* the vendored busytex
#   (MIT) Makefile at build/upstream/busytex/ without modifying it; the make
#   targets and their order mirror upstream .github/workflows/build-wasm.yml
#   (+ build-native.yml for the from-source native pass) at the pinned commit.
#
# WasmTeX M0 "faithful baseline" build — container side (M0 item 4).
# =============================================================================
# Runs INSIDE the pinned wasmtex-toolchain image. Reproduces what upstream
# busytex builds, UNCHANGED, but fully OFFLINE: the upstream Makefile normally
# curl/bsdtar-downloads its sources (URL_texlive/URL_expat/URL_fontconfig and
# the TL 2023 ISO). We pre-stage those from a read-only cache mount into the
# exact paths the Makefile's download rules produce (source/<id>/ + the
# source/<id>.txt sentinel), so those rules are already satisfied and make
# never reaches for the network. The container itself is run with
# `--network none` (see build.sh), so any missed pre-stage fails loud, closed.
#
# The Makefile and its helpers are NOT edited: we copy the vendored machinery
# into the /work build tree and run make there, leaving build/upstream/ pristine.
#
# Mounts provided by build.sh:
#   /cache      (ro)  ~/.cache/wasmtex/sources — verified pinned inputs
#   /machinery  (ro)  build/upstream/busytex   — vendored busytex build machinery
#   /glue       (ro)  build/artifacts          — these scripts
#   /dist       (rw)  dist/                     — assembled artifacts land here
#   /work       (vol) named docker volume       — the busytex build tree (fast)
#
# Usage:  run-in-container.sh <stage>
#   stage ∈ { prep native basic wasm bundle dist all }
#   `all` runs prep→native→basic→wasm→bundle→dist in order.
# =============================================================================
set -euo pipefail

# --- Reproducibility hooks (item 5 does the double-build diff; do not bake in
#     obvious nondeterminism here). SOURCE_DATE_EPOCH is the busytex pin commit
#     date (f2bd7b11, 2026-06-16 16:06:37 +0200 == 1781618797); see
#     docs/plans/M0-item4-journal.md for why this value. FORCE_SOURCE_DATE makes
#     the TeX engines honour it when dumping .fmt files. LC_ALL is the C.UTF-8
#     the image (and upstream's CI runner) already use — deterministic AND
#     UTF-8-safe for install-tl/find over texmf trees (a documented micro-
#     deviation from a literal LC_ALL=C; see the journal). --------------------
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1781618797}"
export FORCE_SOURCE_DATE="${FORCE_SOURCE_DATE:-1}"
export TZ=UTC
export LC_ALL="${LC_ALL:-C.UTF-8}"
export LANG="${LANG:-C.UTF-8}"
umask 022

# Parallelism: GNU Make 4.3's anonymous-pipe jobserver is UNRELIABLE under this
# host's Docker-Desktop/Rosetta x86_64 emulation. Multiple busytex sub-builds
# (the expat CMake build; zziplib's `cd ../zlib && make rebuild`) abort with
# "write jobserver: Bad file descriptor" under any -jN>1 — even though upstream's
# native-x86_64 CI builds the same tree at -j2, and this tree's own
# texlive.configured happens to survive -j4 (it is sub-make-dependent, not
# blanket). At -j1 make creates NO jobserver, so every sub-make is safe. We
# therefore default JOBS=1 on this host: correct, deterministic, no whack-a-mole.
# WASMTEX_JOBS can raise it on a real x86_64 builder (CI), where -j2 is known
# good. See docs/plans/M0-item4-journal.md "native attempt … jobserver".
JOBS="${WASMTEX_JOBS:-1}"
export MAKEFLAGS="-j${JOBS}"

CACHE=/cache
MACHINERY=/machinery
DIST=/dist
BUILD=/work/busytex

# Cached inputs (names match build/sources/pins.lock).
TL_SRC="$CACHE/texlive-source-2023.0.tar.gz"
EXPAT_SRC="$CACHE/expat-2.5.0.tar.gz"
FONTCONFIG_SRC="$CACHE/fontconfig-2.13.96.tar.gz"
ISO="$CACHE/texlive2023-20230313.iso"

# Vendored machinery files the Makefile references by path (PROVENANCE.md).
MACHINERY_FILES=(
  Makefile busytex.c packfs.c packfs.py emcc_wrapper.py cosmo_getpass.h
  ubuntu_package_preload.py busytex_pipeline.js busytex_worker.js
)

banner() { printf '\n>> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Faithful offline replacement for the Makefile's
#   `source/<id>.txt: ; mkdir -p source/<id>; curl -L $(URL_<id>) | tar -xzf - -C source/<id> --strip-components=1; find source/<id> > source/<id>.txt`
# using the pinned cached tarball instead of curl. Guarded by the .txt sentinel
# so it is idempotent and never re-extracts on a resumed build.
stage_tarball() {
  local id="$1" tarball="$2"
  if [ -f "$BUILD/source/$id.txt" ]; then
    echo "   source/$id already staged; skipping"
    return
  fi
  echo "   staging source/$id from $(basename "$tarball")"
  mkdir -p "$BUILD/source/$id"
  tar -xzf "$tarball" -C "$BUILD/source/$id" --strip-components=1
  ( cd "$BUILD" && find "source/$id" > "source/$id.txt" )
}

do_prep() {
  banner "prep: stage machinery + sources (offline)"
  mkdir -p "$BUILD"

  # Copy the vendored build machinery into the work tree (build/upstream/ stays
  # pristine). Only on first prep, so we do not churn mtimes on resume.
  if [ ! -f "$BUILD/Makefile" ]; then
    echo "   copying vendored busytex machinery into $BUILD"
    local f
    for f in "${MACHINERY_FILES[@]}"; do
      cp "$MACHINERY/$f" "$BUILD/$f"
    done
  else
    echo "   machinery already present; skipping copy"
  fi

  # Pre-stage the three tarball sources the Makefile would curl.
  stage_tarball texlive    "$TL_SRC"
  stage_tarball expat      "$EXPAT_SRC"
  stage_tarball fontconfig "$FONTCONFIG_SRC"

  # Pre-stage the TL 2023 texmf repository from the frozen ISO. Faithful to the
  # Makefile's `source/texmfrepo.txt` rule (`... | bsdtar -x -C source/texmfrepo`),
  # reading the local ISO instead of the split-release cache URL. bsdtar reads
  # the ISO9660 image directly; the root carries install-tl + archive/ + tlpkg/.
  if [ ! -f "$BUILD/source/texmfrepo.txt" ]; then
    echo "   staging source/texmfrepo from $(basename "$ISO") (this takes a few minutes)"
    mkdir -p "$BUILD/source/texmfrepo"
    bsdtar -x -C "$BUILD/source/texmfrepo" -f "$ISO"
    ( cd "$BUILD" && find "source/texmfrepo" > "source/texmfrepo.txt" )
  else
    echo "   source/texmfrepo already staged; skipping"
  fi

  # versions.txt (upstream build-wasm.yml step). Pure text, no network.
  ( cd "$BUILD" && make build/versions.txt )
  echo "   prep complete"
}

do_native() {
  banner "native: build native multicall busytex from source (Rosetta — slow)"
  # Upstream CI shortcuts this with prebuilt release binaries (download-native);
  # per build/sources/README.md we build from source in the pinned container.
  # `native` = texlive.configured -> texlivedependencies -> busytexapplets ->
  # build/native/busytex (the native multicall binary install-tl's custom-bin
  # wrappers dispatch to).
  ( cd "$BUILD" && make native )
  echo "   native busytex: $(ls -la "$BUILD/build/native/busytex")"
}

do_basic() {
  banner "basic: install TL 'texlive-basic' via install-tl + dump .fmt formats"
  # build/texlive-basic.txt runs the native busytex through install-tl against
  # the offline repo, builds the texlive-basic TDS tree, dumps and prunes the
  # engine .fmt files (retains pdflatex/xelatex/luahblatex).
  ( cd "$BUILD" && make build/texlive-basic.txt )
  echo "   formats:"; find "$BUILD/build/texlive-basic/texmf-dist/texmf-var/web2c" -name '*.fmt' -exec ls -la {} +
}

do_wasm() {
  banner "wasm: build wasm multicall busytex.js/.wasm (Rosetta — slow)"
  # Reuses native-built helper tools (ctangle/otangle/web2c/icupkg/pkgdata/
  # apinames) via the CCSKIP_* wrappers — native must be complete first.
  ( cd "$BUILD" && make wasm )
  echo "   wasm engine:"; ls -la "$BUILD/build/wasm/busytex.js" "$BUILD/build/wasm/busytex.wasm"
}

do_bundle() {
  banner "bundle: pack texlive-basic data bundle (file_packager: js + data)"
  ( cd "$BUILD" && make build/wasm/texlive-basic.js )
  echo "   bundle:"; ls -la "$BUILD/build/wasm/texlive-basic.js" "$BUILD/build/wasm/texlive-basic.data"
}

do_dist() {
  banner "dist: assemble /dist (engine + glue + formats + bundle + checksums)"
  # Our own assembly (equivalent to upstream `dist-wasm`, plus the worker/
  # pipeline glue and the standalone .fmt formats the acceptance spec lists).
  local wasm="$BUILD/build/wasm" fmtdir="$BUILD/build/texlive-basic/texmf-dist/texmf-var/web2c"

  rm -rf "${DIST:?}"/*
  mkdir -p "$DIST/formats"

  # Engine wasm + js.
  cp "$wasm/busytex.js"  "$DIST/busytex.js"
  cp "$wasm/busytex.wasm" "$DIST/busytex.wasm"
  # Worker / pipeline glue the demo loads (vendored busytex, MIT).
  cp "$MACHINERY/busytex_pipeline.js" "$DIST/busytex_pipeline.js"
  cp "$MACHINERY/busytex_worker.js"   "$DIST/busytex_worker.js"
  # Data bundle (js + data pair).
  cp "$wasm/texlive-basic.js"   "$DIST/texlive-basic.js"
  cp "$wasm/texlive-basic.data" "$DIST/texlive-basic.data"
  # Standalone engine formats (also embedded in the bundle; surfaced per spec).
  find "$fmtdir" -name '*.fmt' -exec cp {} "$DIST/formats/" \;

  # Deterministic integrity list (sorted, relative paths).
  ( cd "$DIST" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs sha256sum > SHA256SUMS )

  banner "dist inventory"
  ( cd "$DIST" && ls -la . formats && echo && cat SHA256SUMS )
}

stage="${1:-all}"
case "$stage" in
  prep)   do_prep ;;
  native) do_native ;;
  basic)  do_basic ;;
  wasm)   do_wasm ;;
  bundle) do_bundle ;;
  dist)   do_dist ;;
  all)    do_prep; do_native; do_basic; do_wasm; do_bundle; do_dist ;;
  *) echo "unknown stage: $stage (want: prep native basic wasm bundle dist all)" >&2; exit 2 ;;
esac

banner "stage '$stage' done"
