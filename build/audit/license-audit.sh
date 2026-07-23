#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Original work authored in the WasmTeX repository (see LICENSE). Not derived
# from any third-party source.
#
# WasmTeX license / provenance audit (M0 item 7N, DESIGN.md §2 + §7).
#
# One command, run identically on the maintainer's macOS/BSD host and in CI on
# ubuntu/GNU: the .github/workflows/license-audit.yml job just invokes this
# script. It fails closed — any violation prints "FAIL: ..." and the script
# exits non-zero.
#
# Checks:
#   (a/b) Every file under build/engines/ (OUR maintained build config, forked
#       from busytex at M2 item 3) carries an SPDX MIT header AND exactly one
#       provenance marker: original WasmTeX work, or a "DERIVED WORK" header
#       naming the pinned [busytex] commit. The per-file headers ARE the record
#       (the M0 PROVENANCE.md manifest + vendored-sha256 tamper check were
#       retired when build/upstream/ was dissolved). A headerless file, a file
#       with no marker, or a derived header that omits the commit FAILS.
#   (c) Every build/patches/<name>/*.patch has a sibling HEADER.md, and each
#       patch carries the diff-context-excerpt licensing-clause reference (an
#       SPDX line plus a pointer to HEADER.md's "excerpt" clause). The sibling
#       HEADER.md must itself state that clause. Zero ACTIVE patches is allowed
#       (a patch is RETIRED when its defect is fixed upstream — e.g. both TL 2023
#       macOS patches retired at the TL 2026 rebase); a retired patch dir keeps
#       its HEADER.md as the archival record, which this check still enforces.
#   (d) No GPL/AGPL SPDX identifier appears in runtime/ or demo/ sources — the
#       copyleft-in-runtime tripwire (DESIGN.md §7). Matches only
#       "SPDX-License-Identifier:" lines, so prose that merely mentions GPL
#       (e.g. a design doc) does not trip it.
#   (e) Every original source under build/ and demo/ (sh / mjs / py / Dockerfile
#       / html) carries an SPDX MIT header. Exemptions are enumerated inline.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cd "$repo"

fail=0
err() { printf 'FAIL: %s\n' "$*" >&2; fail=1; }
ok()  { printf 'ok:   %s\n' "$*"; }

ENGINES_DIR="build/engines"
PINS="build/sources/pins.lock"

# ---------------------------------------------------------------------------
# (a/b) build/engines provenance headers.
# At M2 item 3 the M0 staging tree build/upstream/busytex/ was dissolved into
# build/engines/ as OUR maintained build config, and its PROVENANCE.md manifest
# was retired. The per-file HEADERS are now the provenance record. Every file
# under build/engines/ must carry an SPDX MIT header AND exactly one of:
#   * ORIGINAL WasmTeX work  — "Original work authored in the WasmTeX repository", or
#   * DERIVED FROM busytex    — a "DERIVED WORK" header that NAMES the pinned
#                               [busytex] commit (build/sources/pins.lock).
# A file with no SPDX MIT header, no provenance marker, or a derived header that
# does not name the commit FAILS. (This replaces the former manifest bijection +
# vendored-sha256 tamper check: with an evolving fork the headers, not frozen
# hashes, are the contract.)
# ---------------------------------------------------------------------------
echo "== (a/b) build/engines provenance headers =="

# Pinned upstream commit is the single source of truth in pins.lock [busytex].
PIN_COMMIT=$(awk -F= '
  /^\[/ { inblock = ($0 == "[busytex]") }
  inblock && $1 ~ /^commit[[:space:]]*$/ { gsub(/[[:space:]]/, "", $2); print $2; exit }
' "$PINS")
if ! printf '%s' "$PIN_COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
  err "could not parse a 40-hex [busytex] commit from $PINS (got: '${PIN_COMMIT:-}')"
  PIN_COMMIT="__unparsed_commit__"
fi

ab_fail_before=$fail
# Tracked + untracked-but-not-ignored files under build/engines/ (a new,
# not-yet-committed engine file is audited by a pre-commit local run).
engine_files=$(git ls-files --cached --others --exclude-standard "$ENGINES_DIR" 2>/dev/null || true)
if [ -z "$engine_files" ]; then
  err "no files found under $ENGINES_DIR/ (expected the forked Makefile + helpers)"
fi
engine_n=0; engine_derived=0; engine_original=0
for f in $engine_files; do
  [ -f "$f" ] || continue
  engine_n=$((engine_n + 1))
  hdr=$(head -n 40 "$f")
  if ! printf '%s\n' "$hdr" | grep -qF 'SPDX-License-Identifier: MIT'; then
    err "$f lacks an 'SPDX-License-Identifier: MIT' header"
    continue
  fi
  # Derived-wins ordering: a file carrying BOTH markers must satisfy the
  # stricter DERIVED WORK requirements (commit named), not slip through as
  # original because boilerplate appears earlier in the header.
  if printf '%s\n' "$hdr" | grep -qF 'DERIVED WORK'; then
    if printf '%s\n' "$hdr" | grep -qF "$PIN_COMMIT"; then
      engine_derived=$((engine_derived + 1))
    else
      err "$f has a DERIVED WORK header but does not name the pinned [busytex] commit $PIN_COMMIT"
    fi
  elif printf '%s\n' "$hdr" | grep -qF 'Original work authored in the WasmTeX repository'; then
    engine_original=$((engine_original + 1))
  else
    err "$f carries no provenance marker (need 'Original work authored in the WasmTeX repository' OR a 'DERIVED WORK' header naming commit $PIN_COMMIT)"
  fi
done
if [ "$fail" -eq "$ab_fail_before" ]; then
  ok "$engine_n build/engines file(s): $engine_derived derived-from-busytex (commit named), $engine_original original WasmTeX — all SPDX MIT"
fi

# ---------------------------------------------------------------------------
# (c) Patches: HEADER.md sibling + diff-context-excerpt licensing clause
# ---------------------------------------------------------------------------
echo "== (c) build/patches =="
patch_count=0
for pf in build/patches/*/*.patch; do
  [ -e "$pf" ] || continue          # nullglob-safe (literal glob if no match)
  patch_count=$((patch_count + 1))
  dir=$(dirname "$pf")
  hdr="$dir/HEADER.md"
  if [ ! -f "$hdr" ]; then
    err "$pf has no sibling HEADER.md"
  elif ! grep -qi 'excerpt' "$hdr"; then
    err "$hdr lacks the diff-context-excerpt licensing clause"
  fi
  # The patch file itself must reference the clause: SPDX line + HEADER.md pointer
  # + the clause's key term. `patch` ignores this leading comment (verified).
  if ! grep -qF 'SPDX-License-Identifier: MIT' "$pf"; then
    err "$pf lacks an 'SPDX-License-Identifier: MIT' header line"
  fi
  if ! grep -qF 'HEADER.md' "$pf" || ! grep -qi 'excerpt' "$pf"; then
    err "$pf lacks the diff-context-excerpt licensing-clause reference (HEADER.md + excerpt)"
  fi
done
# Retired patches: a build/patches/<name>/ dir with a HEADER.md but no *.patch
# (its defect was fixed upstream). Allowed, but the archival HEADER.md must be
# present — enforce that so a retired dir is a real record, not a broken shell.
retired_count=0
for hdr in build/patches/*/HEADER.md; do
  [ -e "$hdr" ] || continue
  dir=$(dirname "$hdr")
  if ! ls "$dir"/*.patch >/dev/null 2>&1; then
    retired_count=$((retired_count + 1))
    if ! grep -qi 'retired' "$hdr"; then
      err "$hdr is a retired patch dir (no *.patch) but its HEADER.md does not record the retirement"
    fi
    # Retired HEADERs carry the third-party source excerpts now (old + new
    # upstream blocks quoted as evidence) — the excerpt clause remains
    # license-load-bearing after retirement.
    if ! grep -qi 'excerpt' "$hdr"; then
      err "$hdr (retired) lacks the diff-context-excerpt licensing clause"
    fi
  fi
done
# Losing the archival records entirely is a failure: the excerpt clauses and
# retirement evidence must remain in-tree even when zero patches are active.
if [ $((patch_count + retired_count)) -eq 0 ]; then
  err "build/patches/ has neither active patches nor retired HEADER.md records"
fi
if [ "$patch_count" -eq 0 ]; then
  # Zero active patches is legitimate: every macOS source patch was retired when
  # its defect was fixed upstream at the TL 2026 rebase (see the retired HEADER.md
  # records). Not a failure.
  ok "no active patches — all $retired_count retired upstream (see build/patches/*/HEADER.md)"
else
  ok "$patch_count active patch(es): each has a HEADER.md sibling and the context-excerpt clause reference ($retired_count retired)"
fi

# ---------------------------------------------------------------------------
# (d) Copyleft tripwire: no GPL/AGPL SPDX identifier in runtime/ or demo/ sources
# ---------------------------------------------------------------------------
echo "== (d) copyleft tripwire (runtime/ + demo/) =="
# List tracked + untracked-but-not-ignored sources (--cached --others
# --exclude-standard): build outputs (dist/, build/out/), node_modules, and
# playwright reports are all git-ignored and excluded by construction, while a
# not-yet-committed new source is still audited by a pre-commit local run.
src=$(git ls-files --cached --others --exclude-standard runtime demo conformance 2>/dev/null \
  | grep -E '\.(sh|mjs|js|cjs|py|ts|tsx|html|c|h)$' || true)
copyleft=""
if [ -n "$src" ]; then
  copyleft=$(printf '%s\n' "$src" | tr '\n' '\0' \
    | xargs -0 grep -InE 'SPDX-License-Identifier:.*(GPL|AGPL)' 2>/dev/null || true)
fi
if [ -n "$copyleft" ]; then
  err "GPL/AGPL SPDX identifier found in runtime/ or demo/ sources:"
  printf '%s\n' "$copyleft" | sed 's/^/       /' >&2
else
  ok "no GPL/AGPL SPDX identifier in runtime/ or demo/ sources"
fi

# ---------------------------------------------------------------------------
# (e) SPDX MIT header on every original build/ and demo/ source
# ---------------------------------------------------------------------------
echo "== (e) SPDX MIT headers (build/ + demo/ originals) =="
# Required types: *.sh *.mjs *.py *.html *.ts and (extensionless) Dockerfile.
# build/engines/ files ARE scanned here where they match (emcc_wrapper.py) — its
# SPDX MIT header is also required by (a/b), so double coverage is intended; the
# Makefile and busytex.c are not matched by the type filter and rely on (a/b).
# EXEMPTIONS (deliberate — not oversights):
#   *.md / *.markdown          documentation (README/HEADER/notes).
#   *.json *.lock .gitignore   package/lock/config/data files — no comment/header
#   .editorconfig pins.lock*   convention (pins.lock does carry one, not required).
#   *.patch                    covered by check (c) (SPDX + clause), not here.
#   *.c / Makefile             carried by (a/b) provenance headers, not this scan.
req=$(git ls-files --cached --others --exclude-standard build demo runtime conformance 2>/dev/null \
  | grep -E '(\.sh|\.mjs|\.py|\.html|\.ts)$|(^|/)Dockerfile$' || true)
missing_e=0
for f in $req; do
  if ! head -n 15 "$f" | grep -qF 'SPDX-License-Identifier: MIT'; then
    err "$f lacks an 'SPDX-License-Identifier: MIT' header"
    missing_e=$((missing_e + 1))
  fi
done
if [ "$missing_e" -eq 0 ]; then
  ok "$(printf '%s\n' "$req" | grep -c . | tr -d ' ') original build/demo sources carry an SPDX MIT header"
fi

# ---------------------------------------------------------------------------
echo
if [ "$fail" -ne 0 ]; then
  echo "license-audit: FAILED" >&2
  exit 1
fi
echo "license-audit: all checks passed"
