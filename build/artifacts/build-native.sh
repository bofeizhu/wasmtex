#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. It drives OUR maintained engine
#   build config at build/engines/ (the Makefile forked from busytex at M2 item
#   3, MIT, with per-file derived-work headers). macOS incompatibilities that
#   are genuinely host-specific (Apple ld frameworks, cmake 4.x policy floor,
#   offline URL enforcement) are handled by make-variable overrides below; the
#   generic-but-formerly-missing ones (AR=emar for the wasm archives) are now
#   folded INTO build/engines/Makefile (OPTS_LIBS_wasm) since the config is ours.
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
# The build tree lives OUT OF TREE at ~/.cache/wasmtex/build/native/busytex-2026
# (override WASMTEX_WORK_DIR), a sibling of the source/toolchain caches: the
# multi-GB TL source tree + ~6 GB texmfrepo staging stay off the repo volume;
# only dist/ (git-ignored) lands in the repo. build/engines/ is the source of
# truth — its files are SYNCED into the work tree (below) and make runs there.
#
# TL 2026 REBASE (M2 item 4): the default work dir is a FRESH sibling
# (`busytex-2026`, was `busytex` for the TL 2023 build). Reason: the 2023 tree's
# configure caches (native/wasm-texlive.cache), staged 2023 source/, dumped
# .fmt formats and texmfrepo ISO staging must NOT contaminate the 2026 build.
# Keeping them in separate dirs (rather than wiping) also leaves the known-good
# TL 2023 tree intact as a fallback until the rebase is accepted — the same
# additive discipline as the pins.lock 2023/2026 coexistence (M2 item 2).
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
#   WASMTEX_WORK_DIR    build tree          (default ~/.cache/wasmtex/build/native/busytex-2026)
#   WASMTEX_JOBS        make parallelism    (default: hw.ncpu)
#   SOURCE_DATE_EPOCH   repro epoch         (default: TL 2026 freeze 2026-03-01)
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
work="${WASMTEX_WORK_DIR:-$HOME/.cache/wasmtex/build/native/busytex-2026}"
dist="$repo/dist"
machinery="$repo/build/engines"
bundles="$repo/build/bundles"   # OUR tier scripts (gen-profile / stage-tiers / resolver)

# --- Reproducibility hooks (same derivation as the container flow) -----------
# SOURCE_DATE_EPOCH is the TL 2026 freeze date, 2026-03-01T00:00:00Z = 1772323200
# (M2 item 4 cutover; was the busytex pin commit date 1781618797 for the TL 2023
# build). Rationale: the build machinery is OURS now (forked at M2 item 3), so the
# busytex commit is a frozen fork-point reference, not a property of the artifacts.
# 2026-03-01 is the coherent epoch for a TL-2026 build — it is the SAME freeze
# point as BOTH the source tag (texlive-2026.0 @ r78235, committed 2026-03-01) and
# the ISO (texlive2026-20260301.iso). Tying the epoch to the TL freeze date makes
# each annual build self-descriptive (the stamp tracks the sources, not the fork
# point). FORCE_SOURCE_DATE makes the TeX engines honour it when dumping .fmt
# formats. native-env.sh already exports TZ=UTC and LC_ALL=LANG=C.UTF-8; re-assert
# for safety under a caller that unset them. The M3 double-build is the real gate.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1772323200}"
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
  "CMAKE_native=cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5"  # expat 2.5.0 wants cmake<3.5; cmake 4.4 dropped it
  "CMAKE_wasm=emcmake cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5"  # same policy floor for the wasm expat build
  "LDFLAGS_TEXLIVE_native=-lm -pthread"              # drop Linux static/-ldl/--unresolved-symbols
  # Final multicall link: Apple-ld equiv of --unresolved-symbols=ignore-all, plus
  # the Apple frameworks XeTeX's macOS CoreText/AppKit font backend
  # (XeTeXFontMgr_Mac.mm, selected by TL configure on darwin) references — the
  # same frameworks a normal MacTeX xetex links. Without them the binary won't
  # even load (dyld: NSFontManager not found in flat namespace).
  "OPTS_BUSYTEX_LINK_native=-lm -pthread -Wl,-undefined,dynamic_lookup -framework CoreFoundation -framework CoreGraphics -framework CoreText -framework Foundation -framework AppKit"
  # (The former OPTS_LIBS_wasm=AR=emar override is now folded into
  #  build/engines/Makefile as `OPTS_LIBS_wasm = AR=$(AR_wasm)` — see that
  #  file's comment and docs/plans/M2-journal.md item 3. It fixes the hollow-
  #  wasm-archive defect for every host, not just this macOS driver, so it
  #  belongs in the config now that the config is ours.)
  # Offline enforcement: blank every source URL so a missed pre-stage makes
  # curl fail loud (closed) rather than fetch bytes that bypass pins.lock.
  "URL_texlive="
  "URL_expat="
  "URL_fontconfig="
  "URL_texlive_full_iso_cache="
)

# OUR engine build-config files the Makefile references by path (build/engines/).
# The dropped helpers (packfs.c/.py, cosmo_getpass.h, ubuntu_package_preload.py)
# and the retired worker/pipeline glue are no longer forked or copied.
machinery_files=(
  Makefile busytex.c emcc_wrapper.py normalize-lsr.py
)

# Cached inputs (names match build/sources/pins.lock). TL 2026 cutover (M2 item
# 4): the TL source tarball + ISO filenames switch to the 2026 pins
# ([texlive-source-2026] / [texlive-iso-2026]); expat/fontconfig are unchanged
# (deliberately NOT re-pinned for 2026 — see pins.lock + M2-journal item 2).
tl_src="$cache_dir/texlive-source-2026.0.tar.gz"
expat_src="$cache_dir/expat-2.5.0.tar.gz"
fontconfig_src="$cache_dir/fontconfig-2.13.96.tar.gz"
iso="$cache_dir/texlive2026-20260301.iso"

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
# resume against an already-patched tree) is a no-op. Our build config in
# build/engines/ is untouched — only the extracted TL work copy is patched here.
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

  # Sync OUR engine build-config (build/engines/) into the work tree, which is a
  # build sandbox. Copy only files whose content DIFFERS, so unchanged files keep
  # their mtime and make stays incremental on resume — while an edited config
  # (the M2 fork, or a future rebase) always re-syncs into the tree.
  local f b
  for f in "${machinery_files[@]}"; do
    if ! cmp -s "$machinery/$f" "$work/$f" 2>/dev/null; then
      echo "   syncing build config into work tree: $f"
      cp "$machinery/$f" "$work/$f"
    fi
  done

  # Sync OUR tier bundle scripts (build/bundles/*.mjs, minus *.test.mjs) into the
  # work tree so the Makefile's profile/staging rules resolve them and their
  # relative imports (./tlpdb.mjs, ./tiers.mjs, ./resolve.mjs) work in-tree.
  # mtime-preserving (cmp -s): an unchanged tier definition keeps make incremental
  # on resume; an edited tiers.mjs re-syncs and reinstalls/re-stages through the
  # Makefile prerequisites. M4 item 3.
  mkdir -p "$work/bundles"
  for f in "$bundles"/*.mjs; do
    b="$(basename "$f")"
    case "$b" in *.test.mjs) continue ;; esac
    if ! cmp -s "$f" "$work/bundles/$b" 2>/dev/null; then
      echo "   syncing tier bundle script: bundles/$b"
      cp "$f" "$work/bundles/$b"
    fi
  done

  # Pre-stage the three tarball sources the Makefile would curl.
  stage_tarball texlive    "$tl_src"
  stage_tarball expat      "$expat_src"
  stage_tarball fontconfig "$fontconfig_src"

  # Pre-stage the TL 2026 texmf repository from the frozen ISO. Faithful to the
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
  banner "basic: install TL combined tiers tree (scheme-basic + core+academic collections) via install-tl + dump .fmt formats"
  # ONE install-tl run installs every shipped tier's collections into
  # build/texlive-tiers (profile generated from build/bundles/tiers.mjs); the
  # bundle stage then splits it into disjoint per-tier bundles. Longer than the
  # former basic-only install (academic's ~2400-package closure).
  run_make build/texlive-tiers.txt
  echo "   formats:"; find "$work/build/texlive-tiers/texmf-dist/texmf-var/web2c" -name '*.fmt' -exec ls -la {} + 2>/dev/null || true
}

do_wasm() {
  banner "wasm: build wasm multicall busytex.js/.wasm (real -j$jobs)"
  # Reuses native-built helper tools (ctangle/otangle/web2c/icupkg/pkgdata/
  # apinames) via the CCSKIP_* wrappers — native must be complete first.
  run_make wasm
  echo "   wasm engine:"; ls -la "$work/build/wasm/busytex.js" "$work/build/wasm/busytex.wasm" 2>/dev/null || echo MISSING
}

do_bundle() {
  banner "bundle: stage disjoint tiers + file_packager each (core + academic: js + data)"
  # Split the pruned combined install into disjoint per-tier trees (build/stage/
  # <tier>/) via the tlpdb tier map, then file_packager each. build/stage/tiers.txt
  # lists the tiers that received files — the exact set to package (N-tier-general).
  run_make build/stage.stamp
  local tiers=() t targets=()
  while IFS= read -r t; do [ -n "$t" ] && tiers+=("$t"); done < "$work/build/stage/tiers.txt"
  echo "   tiers: ${tiers[*]}"
  for t in "${tiers[@]}"; do targets+=("build/wasm/data/$t.js"); done
  run_make "${targets[@]}"
  for t in "${tiers[@]}"; do
    echo "   bundle[$t]:"; ls -la "$work/build/wasm/data/$t.js" "$work/build/wasm/data/$t.data" 2>/dev/null || echo MISSING
  done
}

do_dist() {
  banner "dist: assemble $dist (engine + formats + bundle + checksums)"
  # Our own assembly: the engine wasm/js, the standalone .fmt formats, and the
  # texlive-basic data bundle. The vendored busytex worker/pipeline glue is NO
  # LONGER shipped — the M1 runtime replaced its role and M2 makes the config
  # ours, so dist/ carries only WasmTeX-consumed artifacts (M2 item 3 decision).
  local wasm="$work/build/wasm" fmtdir="$work/build/texlive-tiers/texmf-dist/texmf-var/web2c"

  rm -rf "${dist:?}"/*
  mkdir -p "$dist/formats"

  # Engine wasm + js.
  cp "$wasm/busytex.js"   "$dist/busytex.js"
  cp "$wasm/busytex.wasm" "$dist/busytex.wasm"
  # Per-tier data bundles (js + data pair each), disjoint, driven by the tier map
  # (build/stage/tiers.txt). N-tier-general: whatever tiers were staged/packed.
  local t
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    cp "$wasm/data/$t.js"   "$dist/$t.js"
    cp "$wasm/data/$t.data" "$dist/$t.data"
  done < "$work/build/stage/tiers.txt"
  # Back-compat ALIAS (M4 item 3; dropped at M5). texlive-basic.{js,data} are byte
  # copies of core.{js,data} so the demo + published 0.0.1 consumers that still
  # name the `texlive-basic` bundle keep working unchanged. Consequence:
  # texlive-basic.js loads core.data internally (its baked file_packager
  # reference), so do NOT preload BOTH `texlive-basic` and `core` in one session
  # (that would mount core.data twice). See docs/plans/M4.md risks + DESIGN §6.3 note.
  cp "$wasm/data/core.js"   "$dist/texlive-basic.js"
  cp "$wasm/data/core.data" "$dist/texlive-basic.data"
  # Standalone engine formats (also embedded in core; surfaced per spec).
  find "$fmtdir" -name '*.fmt' -exec cp {} "$dist/formats/" \;

  # Shipped-aggregate license INVENTORY + fail-closed AUDIT (M5 item 2). Emitted
  # BEFORE SHA256SUMS so dist/licenses.json is hashed + cross-checked like any
  # payload file (gen-assets classifies it role "license-inventory"). The audit is
  # FAIL-CLOSED: a shipped TeX Live package whose `catalogue-license` is missing /
  # non-free / not on the free allowlist (and not resolved by the cited
  # build/bundles/license-exceptions.mjs) aborts the build here (set -e), never a
  # downstream consumer. Reads the pinned tlpdb ISO-staged under source/.
  banner "dist: shipped-aggregate license inventory + fail-closed audit (licenses.json)"
  node "$here/../bundles/licenses.mjs" --tlpdb "$work/source/texmfrepo/tlpkg/texlive.tlpdb" --json "$dist/licenses.json"

  # Deterministic integrity list (sorted, relative paths). macOS: shasum -a 256.
  # The two gen-assets outputs (manifest.json, assets.json) are excluded — they are
  # not payload, and listing them would be a self-reference fixpoint. licenses.json
  # IS listed (it is payload, emitted just above, before this list).
  ( cd "$dist" && find . -type f ! -name SHA256SUMS ! -name manifest.json ! -name assets.json | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS )

  # Integrity manifest: dist/manifest.json (schemaVersion 2, DESIGN §7) + the
  # dist/assets.json v1 alias (M4 item 4). Emitted AFTER SHA256SUMS (so the
  # generator cross-checks every payload file's hash against it — catching a stale
  # dist) and BEFORE the verify gate (so a mis-/unclassified artifact or a hash
  # mismatch fails the BUILD, not a downstream consumer). Neither output is in
  # SHA256SUMS (self-reference fixpoint); SHA256SUMS itself IS listed in the
  # manifest (role "checksums"). --tiers is the stage-tiers side-channel (per-bundle
  # provides + TL snapshot id); generated=/snapshot are pinned off SOURCE_DATE_EPOCH,
  # so re-running this stage is byte-identical.
  banner "dist: generate manifest.json + assets.json (integrity manifest)"
  node "$here/../manifest/gen-assets.mjs" "$dist" --tiers "$work/build/stage/tiers.json"

  # Asset size-budget check (M5 item 5, DESIGN §8). Reads the per-file `bytes`
  # gen-assets just wrote into dist/manifest.json (NOT re-stat'd) and compares each
  # budgeted asset against build/budgets.json's ceiling. FAIL-CLOSED, mirroring the
  # license audit above: an over-budget artifact aborts the build here (set -e), so
  # the strictly-budgeted PRELOAD cold-start path never grows unnoticed into a
  # release. Runs after gen-assets (needs the manifest) and before the verify gate.
  banner "dist: asset size-budget check (check-sizes.mjs vs build/budgets.json)"
  node "$here/../audit/check-sizes.mjs" --manifest "$dist/manifest.json" --budgets "$repo/build/budgets.json"

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
#      TeX Live 2026 banner (WebAssembly.validate + a size check cannot: they
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
