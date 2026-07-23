#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. Style-matched to the sibling build
#   drivers (build/artifacts/build.sh, build/toolchain/build-image.sh).
#
# WasmTeX BUILD-TWICE reproducibility gate (M3 item 5, DESIGN.md §6.1).
# =============================================================================
# DESIGN.md §6.1's contract: "same inputs => byte-identical artifacts, with a CI
# check that builds twice and diffs hashes." This is that check.
#
# It runs N clean CANONICAL container builds (default 2), captures each build's
# dist/ (crucially SHA256SUMS + assets.json, the integrity oracle) into a scratch
# area, and diffs them pairwise:
#   * every artifact byte-identical across every build  -> GREEN, exit 0
#   * ANY divergence                                    -> a per-file report
#     (which artifacts differ, their sizes in each build, and the first-divergence
#      byte offset + a hex context window via cmp/od) and exit 1.
#
# A non-empty diff is NOT to be smoothed over by fuzzy comparison: it is a
# nondeterminism bug to be hunted to its source (archive member ordering, gzip
# mtimes in a .fmt, install-tl-embedded dates not covered by SOURCE_DATE_EPOCH/
# FORCE_SOURCE_DATE, locale sort, file_packager input ordering, ...) and FIXED at
# the source (our Makefile / drivers), then this gate re-run until green. The
# per-file report exists to point the hunt at the exact diverging bytes.
#
# MODES
# -----------------------------------------------------------------------------
#   (full, default)   Run N (>=2) fresh clean-volume container builds and diff
#                     them pairwise. This is the CANONICAL gate: CI and the
#                     annual-rebase acceptance use this two-build mode, so the
#                     verdict rests on NOTHING that predates the check.
#
#   --reuse-current   Pragmatic mode: treat the dist/ ALREADY on disk as build #1
#                     (snapshot it FIRST, before anything overwrites it) and run
#                     exactly ONE more clean-volume container build as build #2,
#                     then diff. Halves the wall-time (one ~34 min build instead
#                     of two) at the cost of trusting that the on-disk dist/ was
#                     itself a pin-verified container build. Use the full
#                     two-build mode wherever the whole chain must be reproduced
#                     in-run (rebase acceptance, the canonical CI gate).
#
# WHERE THIS RUNS (standing decision 2026-07-23, docs/plans/M3.md): container
# builds run on CI runners ONLY — never on the dev machine, in any mode. This
# script is CI machinery; it stays runnable locally only so CI failures can be
# reasoned about, not so it is used there.
#
# Each build delegates to build/artifacts/build.sh (STAGE=all), which enforces
# the pinned-image identity check and WIPES its docker work volume first — so
# every build starts from a pristine tree and re-running this gate is safe
# (resumable-safe: no build inherits another's incremental state).
#
# Usage:
#   build/repro-check.sh                 # 2 clean container builds, diff (canonical)
#   build/repro-check.sh --builds 3      # 3 clean builds (1-vs-2, 1-vs-3)
#   build/repro-check.sh --reuse-current # on-disk dist/ as #1 + one more build
#
# Options:
#   --builds N        number of clean container builds (default 2, min 2).
#                     Ignored under --reuse-current (which is always 1 existing
#                     + 1 new = 2 total).
#   --reuse-current   see MODES above.
#   --scratch DIR     snapshot + report area (default build/out/repro-check,
#                     git-ignored). Wiped and recreated at the start of a run.
#   --keep-going      keep running remaining builds after a build.sh failure
#                     (default: abort on the first failed build). A failed build
#                     produces no snapshot, and ANY failed build forces the
#                     verdict to INCOMPLETE (exit 1) — the surviving builds'
#                     diff is reported for information, never as a green.
#   -h | --help       this help.
#
# Env overrides are passed straight through to build/artifacts/build.sh
# (SOURCE_DATE_EPOCH, WASMTEX_TOOLCHAIN_TAG, WASMTEX_JOBS, WASMTEX_VOLUME, ...).
# This gate deliberately sets NONE of them, so it tests the real release config.
# =============================================================================
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

# --- args --------------------------------------------------------------------
builds=2
reuse_current=0
scratch="$repo/build/out/repro-check"
keep_going=0
failed_builds=""   # space-joined build numbers that failed (--keep-going mode)

while [ $# -gt 0 ]; do
  case "$1" in
    --builds)        builds="${2:-}"; shift 2 ;;
    --builds=*)      builds="${1#*=}"; shift ;;
    --reuse-current) reuse_current=1; shift ;;
    --scratch)       scratch="${2:-}"; shift 2 ;;
    --scratch=*)     scratch="${1#*=}"; shift ;;
    --keep-going)    keep_going=1; shift ;;
    # help = the whole leading comment header (however long it grows): skip the
    # shebang, print until the first non-comment line, strip the "# " prefix.
    -h|--help)       awk 'NR==1{next} !/^#/{exit} {sub(/^# ?/,""); print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "!! unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if ! printf '%s' "$builds" | grep -qE '^[0-9]+$' || [ "$builds" -lt 2 ]; then
  echo "!! --builds must be an integer >= 2 (got: '$builds')" >&2
  exit 2
fi

build_sh="$repo/build/artifacts/build.sh"
dist="$repo/dist"
[ -x "$build_sh" ] || { echo "!! canonical build driver not found/executable: $build_sh" >&2; exit 1; }

# --- portable helpers --------------------------------------------------------
# Size in bytes (portable: BSD/GNU stat differ; wc -c is universal).
fsize() { wc -c < "$1" | tr -d ' '; }

# Hex+ASCII context window of $1 around byte offset $2 (1-based, as cmp reports),
# width ~64 bytes, starting a little before the divergence. `hexdump -C` is the
# portable canonical dump: BOTH BSD (macOS host) and util-linux (CI) support it,
# including -s <skip> / -n <length> and the ASCII gutter — which is what makes an
# embedded date/path/gzip-mtime visible at a glance. (GNU `od -t x1z` is NOT
# portable: BSD od rejects the `z` gutter char.)
context_window() {
  local file="$1" at="$2" span=64 start
  start=$(( at - 16 )); [ "$start" -lt 0 ] && start=0
  hexdump -C -s "$start" -n "$span" "$file" | sed "s/^/      /"
}

# --- banners -----------------------------------------------------------------
banner() { printf '\n>> [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
rule()   { printf '=%.0s' $(seq 1 78); printf '\n'; }

# --- scratch layout ----------------------------------------------------------
# build-NN/     full byte-for-byte snapshot of dist/ after build NN
# build-NN.log  that build's full transcript (tee'd)
# VERDICT       one-line machine-readable result
#               (REPRODUCIBLE | DIVERGED | INCOMPLETE | aborted-build-N)
# report.txt    the full human report (also echoed to stdout)
banner "WasmTeX reproducibility gate (build-twice, DESIGN.md §6.1)"
echo "   mode:     $([ "$reuse_current" -eq 1 ] && echo '--reuse-current (on-disk dist/ = build 1, + 1 new build)' || echo "full ($builds clean container builds)")"
echo "   builds:   $([ "$reuse_current" -eq 1 ] && echo 2 || echo "$builds")"
echo "   driver:   $build_sh (STAGE=all; clean volume per build)"
echo "   scratch:  $scratch"
rm -rf "$scratch"
mkdir -p "$scratch"

# snapshot dist/ -> $scratch/build-NN  (byte-for-byte; -p not needed, bytes only)
snapshot() {
  local n="$1" dest
  dest="$(printf '%s/build-%02d' "$scratch" "$n")"
  rm -rf "$dest"; mkdir -p "$dest"
  # Copy the whole tree (SHA256SUMS, assets.json, engine, formats/, bundle).
  ( cd "$dist" && find . -type f -print0 | while IFS= read -r -d '' f; do
      mkdir -p "$dest/$(dirname "$f")"; cp "$f" "$dest/$f"
    done )
  echo "   snapshot: dist/ -> ${dest#$repo/}  ($(find "$dest" -type f | wc -l | tr -d ' ') files)"
}

# run one clean container build; tee its transcript.
run_build() {
  local n="$1" log
  log="$(printf '%s/build-%02d.log' "$scratch" "$n")"
  banner "BUILD $n/$total — clean container build (build/artifacts/build.sh, STAGE=all)"
  echo "   transcript -> ${log#$repo/}"
  set +e
  ( cd "$repo" && WASMTEX_STAGE=all "$build_sh" ) 2>&1 | tee "$log"
  local rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "!! BUILD $n FAILED (build.sh exit $rc) — see ${log#$repo/}" >&2
    if [ "$keep_going" -eq 0 ]; then
      echo "REPRO GATE ABORTED: build $n did not complete." >&2
      echo "aborted-build-$n" > "$scratch/VERDICT"
      exit 1
    fi
    # --keep-going: record the failure and tell the caller to SKIP the snapshot
    # (dist/ still holds the previous build's bytes — snapshotting it would let
    # a failed build masquerade as a reproduced one). Any recorded failure
    # forces the INCOMPLETE verdict below.
    failed_builds="$failed_builds $n"
    return 1
  fi
  return 0
}

# --- produce the snapshots ---------------------------------------------------
if [ "$reuse_current" -eq 1 ]; then
  total=2
  [ -f "$dist/SHA256SUMS" ] || {
    echo "!! --reuse-current needs an existing build in dist/ (no dist/SHA256SUMS)." >&2
    echo "   run 'make artifacts-container' first, or drop --reuse-current." >&2
    exit 1; }
  banner "BUILD 1/2 — REUSING the on-disk dist/ (snapshot BEFORE it is overwritten)"
  echo "   NOTE: trusting dist/ is a pin-verified container build (see --help)."
  snapshot 1
  if run_build 2; then snapshot 2; fi
else
  total="$builds"
  for i in $(seq 1 "$builds"); do
    if run_build "$i"; then snapshot "$i"; fi
  done
fi

# --- compare snapshots pairwise (all against build-01) -----------------------
# Byte-equality is transitive, so comparing every build to build-01 proves the
# whole set identical while keeping the report legible.
banner "DIFF — comparing every build against build 1 (byte-for-byte)"
rule

ref="$(printf '%s/build-01' "$scratch")"
diverged=0
report="$scratch/report.txt"
: > "$report"

emit() { printf '%s\n' "$*" | tee -a "$report"; }

# A failed --keep-going build has no snapshot; comparing against (or from) a
# missing snapshot dir would misreport every file — skip those pairs, and let
# the INCOMPLETE verdict below carry the failure.
have_snapshot() { [ -d "$(printf '%s/build-%02d' "$scratch" "$1")" ]; }

# Canonical integrity-oracle callout first: SHA256SUMS + assets.json.
for oracle in SHA256SUMS assets.json; do
  for n in $(seq 2 "$total"); do
    have_snapshot 1 && have_snapshot "$n" || continue
    other="$(printf '%s/build-%02d' "$scratch" "$n")"
    if cmp -s "$ref/$oracle" "$other/$oracle"; then
      emit "ok:   $oracle  build 1 == build $n"
    else
      emit "FAIL: $oracle  build 1 != build $n  (integrity oracle diverged)"
      diverged=1
    fi
  done
done
emit ""

# Full per-file comparison across the whole dist/ tree.
for n in $(seq 2 "$total"); do
  other="$(printf '%s/build-%02d' "$scratch" "$n")"
  emit "--- build 1  vs  build $n ---------------------------------------------"
  if ! have_snapshot 1 || ! have_snapshot "$n"; then
    emit "  (SKIPPED: a build in this pair FAILED and has no snapshot)"
    emit ""
    continue
  fi

  # union of relative file paths in either snapshot
  paths="$(
    { ( cd "$ref"   && find . -type f );
      ( cd "$other" && find . -type f ); } | LC_ALL=C sort -u
  )"

  pair_diffs=0
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    a="$ref/$rel"; b="$other/$rel"
    if [ ! -f "$a" ]; then emit "  ONLY in build $n : $rel"; diverged=1; pair_diffs=$((pair_diffs+1)); continue; fi
    if [ ! -f "$b" ]; then emit "  ONLY in build 1 : $rel"; diverged=1; pair_diffs=$((pair_diffs+1)); continue; fi
    if cmp -s "$a" "$b"; then continue; fi

    # divergence: sizes + first-differing byte + hex context on both sides.
    diverged=1; pair_diffs=$((pair_diffs+1))
    sa="$(fsize "$a")"; sb="$(fsize "$b")"
    # cmp prints "<a> <b> differ: byte N, line M" (GNU) or "... char N, ..." (BSD
    # macOS host) — match EITHER word and grab N. A missed match must not silently
    # dump from offset 0; guard to a valid offset. LC_ALL=C pins GNU cmp's
    # gettext-localized message so the extractor works under any host locale.
    cmpout="$(LC_ALL=C cmp "$a" "$b" 2>&1 || true)"
    at="$(printf '%s' "$cmpout" | sed -n 's/.*differ: [a-z][a-z]* \([0-9][0-9]*\).*/\1/p')"
    [ -n "$at" ] || at=1
    emit "  DIFFER: $rel"
    emit "      size:  build1=$sa B   build$n=$sb B   (Δ $((sb - sa)) B)"
    emit "      $cmpout"
    emit "      first-divergence context @ byte $at (hexdump offsets are 0-based):"
    emit "      build 1:"
    context_window "$a" "$at" | tee -a "$report"
    emit "      build $n:"
    context_window "$b" "$at" | tee -a "$report"
  done <<< "$paths"

  [ "$pair_diffs" -eq 0 ] && emit "  (identical: every file byte-for-byte equal)"
  emit ""
done

rule
# A failed build means NO reproducibility claim can be made, whatever the
# surviving snapshots say — an identical pair could simply be a build that
# never ran. This check must precede the green path (reviewer finding, M3
# item 5: --keep-going previously could report a false GREEN).
if [ -n "$failed_builds" ]; then
  emit "REPRO VERDICT: INCOMPLETE — build(s)$failed_builds FAILED; no reproducibility claim."
  emit "  See the per-build transcripts in $scratch. Fix the failure and re-run."
  echo "INCOMPLETE" > "$scratch/VERDICT"
  banner "reproducibility gate: RED (incomplete — failed build(s):$failed_builds)"
  exit 1
elif [ "$diverged" -eq 0 ]; then
  emit "REPRO VERDICT: REPRODUCIBLE — all $total build(s) produced byte-identical dist/."
  emit "  SHA256SUMS (shared by every build):"
  sed 's/^/      /' "$ref/SHA256SUMS" | tee -a "$report"
  echo "REPRODUCIBLE" > "$scratch/VERDICT"
  banner "reproducibility gate: GREEN"
  exit 0
else
  emit "REPRO VERDICT: DIVERGED — builds are NOT byte-identical (see per-file report above)."
  emit "  This is a nondeterminism bug. Hunt each divergence to its source and fix it"
  emit "  in the Makefile/driver (DESIGN.md §6.1) — never by loosening this gate."
  echo "DIVERGED" > "$scratch/VERDICT"
  banner "reproducibility gate: RED (diverged)"
  exit 1
fi
