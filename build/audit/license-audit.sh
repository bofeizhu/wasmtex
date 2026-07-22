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
#   (a) Every file under build/upstream/busytex/ (except the ours-authored
#       PROVENANCE.md manifest) carries a provenance header naming the pinned
#       upstream commit, AND the on-disk file set is exactly the set of
#       PROVENANCE.md manifest rows (bijective — no vendored file escapes the
#       manifest, no manifest row lacks a file).
#   (b) Every PROVENANCE.md "Vendored sha256" equals the file on disk. This is
#       the tamper check: a mutated vendored file (body OR provenance header)
#       changes its hash and fails here.
#   (c) Every build/patches/<name>/*.patch has a sibling HEADER.md, and each
#       patch carries the diff-context-excerpt licensing-clause reference (an
#       SPDX line plus a pointer to HEADER.md's "excerpt" clause). The sibling
#       HEADER.md must itself state that clause.
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

# Portable sha256 -> bare lowercase hex (GNU coreutils sha256sum or BSD shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

tmpd=$(mktemp -d)
trap 'rm -rf "$tmpd"' EXIT

VENDOR_DIR="build/upstream/busytex"
MANIFEST="$VENDOR_DIR/PROVENANCE.md"
PINS="build/sources/pins.lock"

# ---------------------------------------------------------------------------
# (a) + (b) Vendored busytex tree: provenance headers, manifest bijection, hashes
# ---------------------------------------------------------------------------
echo "== (a/b) vendored busytex tree =="

# Pinned upstream commit is the single source of truth in pins.lock [busytex].
PIN_COMMIT=$(awk -F= '
  /^\[/ { inblock = ($0 == "[busytex]") }
  inblock && $1 ~ /^commit[[:space:]]*$/ { gsub(/[[:space:]]/, "", $2); print $2; exit }
' "$PINS")
if ! printf '%s' "$PIN_COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
  err "could not parse a 40-hex [busytex] commit from $PINS (got: '${PIN_COMMIT:-}')"
  PIN_COMMIT=""
fi

# Parse manifest rows: "| `origin` | `upstream_sha` | `vendored_sha` | modified |".
# The header and separator rows carry no backticks, so this matches data only.
awk -F'|' '
  /^\|[[:space:]]*`[^`]+`[[:space:]]*\|/ {
    name = $2; vend = $4
    gsub(/[` ]/, "", name); gsub(/[` ]/, "", vend)
    if (name != "" && vend != "") print name, vend
  }
' "$MANIFEST" > "$tmpd/rows"

if [ ! -s "$tmpd/rows" ]; then
  err "parsed zero rows from $MANIFEST (manifest format changed?)"
fi

# Per-row: file exists, vendored sha256 matches (tamper), header names the commit.
while read -r name vend; do
  [ -n "$name" ] || continue
  f="$VENDOR_DIR/$name"
  if [ ! -f "$f" ]; then
    err "manifest lists '$name' but $f is missing on disk"
    continue
  fi
  got=$(sha256_of "$f")
  if [ "$got" != "$vend" ]; then
    err "vendored sha256 mismatch for $name (tamper?): disk=$got manifest=$vend"
  fi
  if [ -n "$PIN_COMMIT" ] && ! grep -qF "$PIN_COMMIT" "$f"; then
    err "$f lacks a provenance header naming the pinned commit $PIN_COMMIT"
  fi
done < "$tmpd/rows"

# Bijection: on-disk files (minus the ours-authored PROVENANCE.md) == manifest rows.
ls -1 "$VENDOR_DIR" | grep -v '^PROVENANCE\.md$' | sort > "$tmpd/disk"
awk '{print $1}' "$tmpd/rows" | sort > "$tmpd/man"
if ! diff "$tmpd/man" "$tmpd/disk" >/dev/null 2>&1; then
  err "vendored file set != PROVENANCE.md manifest rows (< manifest-only, > disk-only):"
  diff "$tmpd/man" "$tmpd/disk" | sed 's/^/       /' >&2 || true
else
  ok "$(wc -l < "$tmpd/man" | tr -d ' ') vendored files: headers name $PIN_COMMIT, hashes match, manifest bijective"
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
if [ "$patch_count" -eq 0 ]; then
  err "no *.patch files found under build/patches/ (expected libpng + zlib)"
else
  ok "$patch_count patch(es): each has a HEADER.md sibling and the context-excerpt clause reference"
fi

# ---------------------------------------------------------------------------
# (d) Copyleft tripwire: no GPL/AGPL SPDX identifier in runtime/ or demo/ sources
# ---------------------------------------------------------------------------
echo "== (d) copyleft tripwire (runtime/ + demo/) =="
# List tracked + untracked-but-not-ignored sources (--cached --others
# --exclude-standard): build outputs (dist/, build/out/), node_modules, and
# playwright reports are all git-ignored and excluded by construction, while a
# not-yet-committed new source is still audited by a pre-commit local run.
src=$(git ls-files --cached --others --exclude-standard runtime demo 2>/dev/null \
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
# Required types: *.sh *.mjs *.py *.html and (extensionless) Dockerfile.
# EXEMPTIONS (deliberate — not oversights):
#   build/upstream/busytex/**  vendored busytex (MIT); headers frozen at
#                              vendoring time and verified by (a)/(b) against the
#                              manifest, so they are not re-scanned here.
#   *.md / *.markdown          documentation (README/HEADER/PROVENANCE/notes).
#   *.json *.lock .gitignore   package/lock/config/data files — no comment/header
#   .editorconfig pins.lock*   convention (pins.lock does carry one, not required).
#   *.patch                    covered by check (c) (SPDX + clause), not here.
#   *.c *.h *.js under vendored only; no original build/demo files of those types.
req=$(git ls-files --cached --others --exclude-standard build demo runtime 2>/dev/null \
  | grep -E '(\.sh|\.mjs|\.py|\.html|\.ts)$|(^|/)Dockerfile$' \
  | grep -v '^build/upstream/busytex/' || true)
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
