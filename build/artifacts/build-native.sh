#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. It *drives* the vendored busytex
#   (MIT) Makefile at build/upstream/busytex/ without modifying it; the make
#   targets and their order mirror the parked container flow
#   (build/artifacts/run-in-container.sh) and upstream busytex's own target
#   graph at the pinned commit. macOS incompatibilities are handled by make
#   variable overrides (below), never by editing the vendored files.
#
# WasmTeX M0 "faithful baseline" build — NATIVE arm64 macOS host (M0 item 5N).
# =============================================================================
# Per the DESIGN.md §9 revision (native-first bootstrap), this runs the vendored
# busytex build RAW on the arm64 macOS host, fully OFFLINE. The upstream Makefile
# normally curl/bsdtar-downloads its sources; we pre-stage those from the
# verified cache (~/.cache/wasmtex/sources) into the exact paths the Makefile's
# download rules produce (source/<id>/ + the source/<id>.txt sentinel), so those
# rules are already satisfied. Enforcement: pre-staging plus URL-neutralizing
# overrides (the URL_* make variables are blanked below, so a missed pre-stage
# fails loud and closed instead of silently fetching an unverified source).
# Hard network isolation (--network none) returns with the container at M3.
# This is the host mirror of run-in-container.sh's offline strategy — but
# native, no Docker, real jobserver parallelism.
#
# The build tree lives OUT OF TREE at ~/.cache/wasmtex/build/native/busytex
# (override WASMTEX_WORK_DIR), a sibling of the source/toolchain caches: the
# multi-GB TL source tree + ~4.8 GB texmfrepo staging stay off the repo volume;
# only dist/ (git-ignored) lands in the repo. build/upstream/ stays pristine —
# the vendored machinery is COPIED into the work tree and make runs there.
#
# This path is DEVELOPMENT-ONLY (DESIGN.md §9): only container-built,
# pin-verified artifacts are ever released. Source inputs stay pinned/verified.
#
# Usage:  build-native.sh <stage>          (or WASMTEX_STAGE=<stage>)
#   stage in { prep native basic wasm bundle dist verify all clean }
#   `all` runs prep->native->basic->wasm->bundle->dist in order (resumable:
#   make is incremental and the offline sentinels guard re-staging). The `dist`
#   stage ends with an execution gate (`verify`, also runnable standalone): it
#   runs the built engine under node and fails loudly on a hollow-but-valid wasm.
#
# Env overrides:
#   WASMTEX_CACHE_DIR   pinned-source cache (default ~/.cache/wasmtex/sources)
#   WASMTEX_WORK_DIR    build tree          (default ~/.cache/wasmtex/build/native/busytex)
#   WASMTEX_JOBS        make parallelism    (default: hw.ncpu)
#   SOURCE_DATE_EPOCH   repro epoch         (default: busytex pin commit date)
# =============================================================================
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

# --- Pinned native toolchain -------------------------------------------------
# Source the pinned, out-of-tree emsdk + GNU userland + repro locale. Idempotent
# and safe to re-source; it hard-verifies emcc == 3.1.43 and returns non-zero on
# any drift, so a broken toolchain fails loud here rather than mid-build. (Works
# whether or not the caller already sourced it.)
export WASMTEX_ENV_QUIET="${WASMTEX_ENV_QUIET:-1}"
# shellcheck source=/dev/null
if ! source "$repo/build/toolchain/native-env.sh"; then
  echo "!! build/toolchain/native-env.sh activation failed (see its output above)." >&2
  echo "!! set up the pinned emsdk first: build/toolchain/native-host.md." >&2
  exit 1
fi
set -e

stage="${1:-${WASMTEX_STAGE:-all}}"
cache_dir="${WASMTEX_CACHE_DIR:-$HOME/.cache/wasmtex/sources}"
work="${WASMTEX_WORK_DIR:-$HOME/.cache/wasmtex/build/native/busytex}"
dist="$repo/dist"
machinery="$repo/build/upstream/busytex"

# --- Reproducibility hooks (same derivation as the container flow) -----------
# SOURCE_DATE_EPOCH is the busytex pin commit date (f2bd7b11, 1781618797);
# FORCE_SOURCE_DATE makes the TeX engines honour it when dumping .fmt formats.
# native-env.sh already exports TZ=UTC and LC_ALL=LANG=C.UTF-8; re-assert for
# safety under a caller that unset them. The M3 double-build is the real gate.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1781618797}"
export FORCE_SOURCE_DATE="${FORCE_SOURCE_DATE:-1}"
export TZ=UTC
export LC_ALL="${LC_ALL:-C.UTF-8}"
export LANG="${LANG:-C.UTF-8}"
umask 022

# --- Parallelism -------------------------------------------------------------
# Native arm64 GNU Make 4.4.1: the jobserver works here (the -j1 constraint was
# Rosetta-only). Set via MAKEFLAGS (as the container flow does) so recursive
# $(MAKE) sub-builds share one jobserver rather than each forcing its own -jN.
jobs="${WASMTEX_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
export MAKEFLAGS="-j${jobs}"

# --- macOS make-variable overrides -------------------------------------------
# The vendored Makefile assumes a Linux/GNU userland. Each override below is a
# _native-scoped (or native-only-tool) variable; passed on the make command line
# they propagate to every recursive sub-make (MAKEOVERRIDES) and leave the
# wasm/basic/bundle sub-builds untouched. Rationale in docs/plans/M0-item4-journal.md
# "Native build (5N)". Vendored files are NOT edited (no build/patches entry
# needed for the native pass).
macos_overrides=(
  "NM_native=true"                                   # macOS nm has no -D; rule use is diagnostic-only
  "CMAKE_native=cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5"  # expat 2.5.0 wants cmake<3.5; cmake 4.4 dropped it
  "CMAKE_wasm=emcmake cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5"  # same policy floor for the wasm expat build
  "LDFLAGS_TEXLIVE_native=-lm -pthread"              # drop Linux static/-ldl/--unresolved-symbols
  # Final multicall link: Apple-ld equiv of --unresolved-symbols=ignore-all, plus
  # the Apple frameworks XeTeX's macOS CoreText/AppKit font backend
  # (XeTeXFontMgr_Mac.mm, selected by TL configure on darwin) references — the
  # same frameworks a normal MacTeX xetex links. Without them the binary won't
  # even load (dyld: NSFontManager not found in flat namespace).
  "OPTS_BUSYTEX_LINK_native=-lm -pthread -Wl,-undefined,dynamic_lookup -framework CoreFoundation -framework CoreGraphics -framework CoreText -framework Foundation -framework AppKit"
  # Force the WASM library archives to use emar (the wasm twin of the upstream
  # OPTS_LIBS_native at Makefile:206). Several libs/ archives (harfbuzz, libpng,
  # zlib, graphite2, teckit, xpdf, libpaper, zziplib) don't use libtool, so their
  # configure-generated Makefiles HARDCODE `AR = ar` (libpng Makefile:118). The
  # wasm archive rule (Makefile:288) passes $(OPTS_LIBS_wasm), which upstream
  # never defines — so nothing overrides that hardcoded `ar` on the sub-make
  # command line, and `emmake`'s exported AR=emar loses to the Makefile
  # assignment. On Linux `ar` is GNU ar (format-agnostic) so the wasm objects
  # archive fine and the bug is invisible upstream; on macOS `/usr/bin/ar` is
  # BSD ar, which auto-ranlibs and DROPS every non-Mach-O member ("archive member
  # 'X.o' not a mach-o file") with exit 0 — producing 96-byte archives holding
  # only __.SYMDEF and zero members. The link's -Wl,--unresolved-symbols=ignore-all
  # then stubbed all 363 now-missing dependency symbols to abort(-1) (the 5N/6N
  # defect). Passing AR=emar on the sub-make command line beats the Makefile's
  # `AR = ar`; libtool libs (pplib, freetype, …) already got emar via configure
  # and are unaffected. Upstream-able as `OPTS_LIBS_wasm = AR=$(AR_wasm)`.
  "OPTS_LIBS_wasm=AR=emar"
  # Offline enforcement: blank every source URL so a missed pre-stage makes
  # curl fail loud (closed) rather than fetch bytes that bypass pins.lock.
  "URL_texlive="
  "URL_expat="
  "URL_fontconfig="
  "URL_texlive_full_iso_cache="
)

# Vendored machinery files the Makefile references by path (PROVENANCE.md).
machinery_files=(
  Makefile busytex.c packfs.c packfs.py emcc_wrapper.py cosmo_getpass.h
  ubuntu_package_preload.py busytex_pipeline.js busytex_worker.js
)

# Cached inputs (names match build/sources/pins.lock).
tl_src="$cache_dir/texlive-source-2023.0.tar.gz"
expat_src="$cache_dir/expat-2.5.0.tar.gz"
fontconfig_src="$cache_dir/fontconfig-2.13.96.tar.gz"
iso="$cache_dir/texlive2023-20230313.iso"

banner() { printf '\n>> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# make in the work tree, with the macOS overrides + parallelism.
run_make() { ( cd "$work" && make "${macos_overrides[@]}" "$@" ); }

# Faithful offline replacement for the Makefile's
#   source/<id>.txt: ; mkdir -p source/<id>; curl -L $(URL_<id>) | tar -xzf - -C source/<id> --strip-components=1; find source/<id> > source/<id>.txt
# using the pinned cached tarball instead of curl. Guarded by the .txt sentinel
# so it is idempotent and never re-extracts on a resumed build.
stage_tarball() {
  local id="$1" tarball="$2"
  if [ -f "$work/source/$id.txt" ]; then
    echo "   source/$id already staged; skipping"
    return
  fi
  [ -f "$tarball" ] || { echo "!! missing pinned input: $tarball (run build/sources/fetch.sh)" >&2; exit 1; }
  echo "   staging source/$id from $(basename "$tarball")"
  mkdir -p "$work/source/$id"
  tar -xzf "$tarball" -C "$work/source/$id" --strip-components=1
  ( cd "$work" && find "source/$id" > "source/$id.txt" )
}

# Apply our macOS source patches (build/patches/<name>/*.patch) to the staged TL
# work copy. Each patch applies with `patch -p1` from source/texlive/. Idempotent:
# a patch that already reverses cleanly is skipped, so re-running prep (or a
# resume against an already-patched tree) is a no-op. Vendored files under
# build/upstream/ are never touched — only the extracted work copy here.
apply_macos_patches() {
  local pf tldir="$work/source/texlive"
  shopt -s nullglob
  for pf in "$repo"/build/patches/*/*.patch; do
    if ( cd "$tldir" && patch -p1 --reverse --dry-run --force <"$pf" >/dev/null 2>&1 ); then
      echo "   patch already applied, skipping: ${pf#$repo/}"
      continue
    fi
    echo "   applying patch: ${pf#$repo/}"
    ( cd "$tldir" && patch -p1 --forward <"$pf" )
  done
  shopt -u nullglob
}

do_prep() {
  banner "prep: stage machinery + sources (offline)"
  mkdir -p "$work"

  # Copy the vendored build machinery into the work tree (build/upstream/ stays
  # pristine). Only on first prep, so we do not churn mtimes on resume.
  if [ ! -f "$work/Makefile" ]; then
    echo "   copying vendored busytex machinery into $work"
    local f
    for f in "${machinery_files[@]}"; do
      cp "$machinery/$f" "$work/$f"
    done
  else
    echo "   machinery already present; skipping copy"
  fi

  # Pre-stage the three tarball sources the Makefile would curl.
  stage_tarball texlive    "$tl_src"
  stage_tarball expat      "$expat_src"
  stage_tarball fontconfig "$fontconfig_src"

  # Pre-stage the TL 2023 texmf repository from the frozen ISO. Faithful to the
  # Makefile's source/texmfrepo.txt rule (`... | bsdtar -x -C source/texmfrepo`),
  # reading the local ISO instead of the split-release cache URL. macOS bsdtar
  # reads the ISO9660 image directly; the root carries install-tl + archive/ + tlpkg/.
  if [ ! -f "$work/source/texmfrepo.txt" ]; then
    [ -f "$iso" ] || { echo "!! missing pinned ISO: $iso (run build/sources/fetch.sh)" >&2; exit 1; }
    echo "   staging source/texmfrepo from $(basename "$iso") (this takes a few minutes)"
    mkdir -p "$work/source/texmfrepo"
    bsdtar -x -C "$work/source/texmfrepo" -f "$iso"
    ( cd "$work" && find "source/texmfrepo" > "source/texmfrepo.txt" )
  else
    echo "   source/texmfrepo already staged; skipping"
  fi

  # macOS source patches (documented in build/patches/, applied to the work copy).
  apply_macos_patches

  # versions.txt (upstream build-wasm.yml step). Pure text, no network.
  run_make build/versions.txt
  echo "   prep complete"
}

do_native() {
  banner "native: build native multicall busytex from source (arm64, real -j$jobs)"
  # native = texlive.configured -> texlivedependencies -> busytexapplets ->
  # build/native/busytex (the native multicall binary install-tl's custom-bin
  # wrappers dispatch to, and whose helper tools the wasm pass reuses).
  run_make native
  echo "   native busytex: $(ls -la "$work/build/native/busytex" 2>/dev/null || echo MISSING)"
}

do_basic() {
  banner "basic: install TL 'texlive-basic' via install-tl + dump .fmt formats"
  run_make build/texlive-basic.txt
  echo "   formats:"; find "$work/build/texlive-basic/texmf-dist/texmf-var/web2c" -name '*.fmt' -exec ls -la {} + 2>/dev/null || true
}

do_wasm() {
  banner "wasm: build wasm multicall busytex.js/.wasm (real -j$jobs)"
  # Reuses native-built helper tools (ctangle/otangle/web2c/icupkg/pkgdata/
  # apinames) via the CCSKIP_* wrappers — native must be complete first.
  run_make wasm
  echo "   wasm engine:"; ls -la "$work/build/wasm/busytex.js" "$work/build/wasm/busytex.wasm" 2>/dev/null || echo MISSING
}

do_bundle() {
  banner "bundle: pack texlive-basic data bundle (file_packager: js + data)"
  run_make build/wasm/texlive-basic.js
  echo "   bundle:"; ls -la "$work/build/wasm/texlive-basic.js" "$work/build/wasm/texlive-basic.data" 2>/dev/null || echo MISSING
}

do_dist() {
  banner "dist: assemble $dist (engine + glue + formats + bundle + checksums)"
  # Our own assembly (equivalent to upstream `dist-wasm`, plus the worker/
  # pipeline glue and the standalone .fmt formats the acceptance spec lists).
  local wasm="$work/build/wasm" fmtdir="$work/build/texlive-basic/texmf-dist/texmf-var/web2c"

  rm -rf "${dist:?}"/*
  mkdir -p "$dist/formats"

  # Engine wasm + js.
  cp "$wasm/busytex.js"   "$dist/busytex.js"
  cp "$wasm/busytex.wasm" "$dist/busytex.wasm"
  # Worker / pipeline glue the demo loads (vendored busytex, MIT).
  cp "$machinery/busytex_pipeline.js" "$dist/busytex_pipeline.js"
  cp "$machinery/busytex_worker.js"   "$dist/busytex_worker.js"
  # Data bundle (js + data pair).
  cp "$wasm/texlive-basic.js"   "$dist/texlive-basic.js"
  cp "$wasm/texlive-basic.data" "$dist/texlive-basic.data"
  # Standalone engine formats (also embedded in the bundle; surfaced per spec).
  find "$fmtdir" -name '*.fmt' -exec cp {} "$dist/formats/" \;

  # Deterministic integrity list (sorted, relative paths). macOS: shasum -a 256.
  ( cd "$dist" && find . -type f ! -name SHA256SUMS ! -name assets.json | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS )

  # Data-driven asset inventory: dist/assets.json (M1 item 4). Emitted AFTER
  # SHA256SUMS (so the generator can cross-check every payload file's hash
  # against it — catching a stale dist) and BEFORE the verify gate (so a
  # mis-/unclassified artifact or a hash mismatch fails the BUILD, not a
  # downstream consumer). assets.json is deliberately NOT in SHA256SUMS (it
  # would be a self-reference fixpoint); SHA256SUMS itself IS listed in
  # assets.json (role "checksums"). generated= is pinned off SOURCE_DATE_EPOCH,
  # so re-running this stage yields a byte-identical assets.json.
  banner "dist: generate assets.json (data-driven inventory)"
  node "$here/../manifest/gen-assets.mjs" "$dist"

  banner "dist inventory"
  ( cd "$dist" && ls -la . formats && echo && cat SHA256SUMS )

  # Execution gate (M0 item 5N, reopened): a structurally-valid-but-hollow wasm
  # (empty dependency archives swallowed by --unresolved-symbols=ignore-all) must
  # never pass again. Verify the assembled dist/ actually runs before declaring
  # the stage done.
  do_verify
}

# --- Execution gate --------------------------------------------------------
# Drive the just-built engine under node and assert it is a SOUND binary, not a
# structurally-valid hollow one. Two checks, both fail the build loudly (the
# harness exits non-zero and `set -e` aborts):
#   1. env-import sanity — a correctly linked busytex.wasm imports a few dozen
#      legitimate emscripten JS helpers; the empty-archive defect produced 363
#      (every unresolved dependency symbol stubbed to abort(-1)). Cheap, and
#      catches this exact regression class directly.
#   2. real execution — `xetex --version` runs to exit 0 and emits the
#      TeX Live 2023 banner (WebAssembly.validate + a size check cannot: they
#      were both true for the hollow artifact that shipped in the first 5N run).
do_verify() {
  banner "verify: execution gate — run engine under node + env-import sanity"
  # timeout: synchronous wasm can't be interrupted in-process; a spinning
  # engine must not hang the gate at the end of a multi-hour build.
  timeout 300 node "$here/verify-engine.mjs" "$dist"
}

do_clean() {
  banner "clean: remove work tree $work and dist/"
  rm -rf "$work"
  rm -rf "${dist:?}"/*
  echo "   clean complete"
}

banner "WasmTeX M0 native artifacts build (5N)"
echo "   stage:     $stage"
echo "   work:      $work"
echo "   cache:     $cache_dir"
echo "   dist:      $dist"
echo "   jobs:      MAKEFLAGS=$MAKEFLAGS   SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
echo "   emcc:      $(command -v emcc)"

case "$stage" in
  prep)   do_prep ;;
  native) do_native ;;
  basic)  do_basic ;;
  wasm)   do_wasm ;;
  bundle) do_bundle ;;
  dist)   do_dist ;;
  verify) do_verify ;;
  clean)  do_clean ;;
  all)    do_prep; do_native; do_basic; do_wasm; do_bundle; do_dist ;;
  *) echo "unknown stage: $stage (want: prep native basic wasm bundle dist verify all clean)" >&2; exit 2 ;;
esac

banner "stage '$stage' done"
