#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. It fetches upstream busytex (MIT)
#   and official TeX Live / TUG sources named in build/sources/pins.lock.
#
# Fetch and verify every external input pinned in build/sources/pins.lock into a
# content-addressed cache OUTSIDE the repo tree. Idempotent: an already-cached,
# already-verified file is re-verified and skipped, never re-downloaded. Refuses
# any source that is not pinned with a valid hash, and fails loudly on any
# mismatch. The only network access is to the URLs in the lock (plus the git
# clone url); nothing else is contacted.
#
# Usage:
#   build/sources/fetch.sh                 # fetch/verify everything
#   WASMTEX_CACHE_DIR=/path build/sources/fetch.sh
#
# Env:
#   WASMTEX_CACHE_DIR   cache directory (default: ~/.cache/wasmtex/sources)
#
# Portable to bash 3.2 (macOS): no associative arrays, no mapfile. The lock is
# parsed with awk (see pin_get/pin_ids). Format spec: build/sources/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${here}/pins.lock"
CACHE="${WASMTEX_CACHE_DIR:-${HOME}/.cache/wasmtex/sources}"

[ -f "$LOCK" ] || { echo "FATAL: lock not found: $LOCK" >&2; exit 1; }

# --- hashing (prefer coreutils *sum, fall back to BSD/macOS shasum) -----------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1
  else shasum -a 512 "$1" | cut -d' ' -f1; fi
}
is_sha256() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'; }
is_sha512() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{128}$'; }

# --- lock parsing (awk; bash-3.2 safe) ----------------------------------------
# pin_ids: print every block id, in file order.
pin_ids() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ { s=$0; sub(/^[[:space:]]*\[/,"",s); sub(/\][[:space:]]*$/,"",s); print s }
  ' "$LOCK"
}
# pin_get <id> <key>: print the value of <key> in block <id> (empty if absent).
pin_get() {
  awk -v want_id="$1" -v want_key="$2" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ { s=$0; sub(/^[[:space:]]*\[/,"",s); sub(/\][[:space:]]*$/,"",s); cur=s; next }
    cur==want_id {
      p=index($0,"="); if (p==0) next
      k=substr($0,1,p-1); v=substr($0,p+1)
      sub(/^[[:space:]]+/,"",k); sub(/[[:space:]]+$/,"",k)
      sub(/^[[:space:]]+/,"",v); sub(/[[:space:]]+$/,"",v)
      if (k==want_key) { print v; exit }
    }
  ' "$LOCK"
}

# --- download (resumable, retrying; immutable pinned files) -------------------
download() { # url dest
  local url="$1" dest="$2" part="$2.part"
  echo "   .. downloading $(basename "$dest")"
  # -C - resumes a partial .part across runs; the pinned files are immutable so
  # resume is safe, and the post-download hash check catches any corruption.
  curl -fL --retry 3 --retry-delay 5 --connect-timeout 30 \
       -C - -o "$part" "$url" \
    || { echo "FATAL: download failed for $url" >&2
         echo "   hint: a stale $part can break resume on non-range servers;" >&2
         echo "   remove it and re-run." >&2
         exit 1; }
  mv -f "$part" "$dest"
}

# verify_hashes <path> <sha256> <sha512> : verify every VALID hash given.
# Returns non-zero (and prints) on mismatch. A present-but-invalid value (e.g.
# a PENDING placeholder) is reported and skipped. Caller enforces "at least one".
verify_hashes() { # path sha256 sha512  -> echoes count of hashes actually checked
  local path="$1" want256="$2" want512="$3" checked=0 got
  if [ -n "$want256" ]; then
    if is_sha256 "$want256"; then
      got="$(sha256_of "$path")"
      if [ "$got" != "$want256" ]; then
        echo "MISMATCH sha256 for $(basename "$path")" >&2
        echo "   expected $want256" >&2
        echo "   actual   $got" >&2
        return 1
      fi
      checked=$((checked+1))
    else
      echo "   !! sha256 placeholder ('$want256') not a hex digest; not verified" >&2
    fi
  fi
  if [ -n "$want512" ]; then
    if is_sha512 "$want512"; then
      got="$(sha512_of "$path")"
      if [ "$got" != "$want512" ]; then
        echo "MISMATCH sha512 for $(basename "$path")" >&2
        echo "   expected $want512" >&2
        echo "   actual   $got" >&2
        return 1
      fi
      checked=$((checked+1))
    else
      echo "   !! sha512 placeholder ('$want512') not a hex digest; not verified" >&2
    fi
  fi
  printf '%s' "$checked"
}

# --- per-kind handlers --------------------------------------------------------
STATUS=""   # accumulates "id<TAB>state<TAB>detail" lines for the summary

handle_file() { # id
  local id="$1"
  local url file want256 want512 dest checked
  url="$(pin_get "$id" url)"
  file="$(pin_get "$id" file)"
  want256="$(pin_get "$id" sha256)"
  want512="$(pin_get "$id" sha512)"
  [ -n "$url" ]  || { echo "FATAL [$id]: missing url" >&2; exit 1; }
  [ -n "$file" ] || { echo "FATAL [$id]: missing file" >&2; exit 1; }
  # Refuse unpinned: need at least one VALID content hash.
  if ! is_sha256 "$want256" && ! is_sha512 "$want512"; then
    echo "FATAL [$id]: refusing unpinned source (no valid sha256/sha512 in lock)" >&2
    exit 1
  fi
  dest="$CACHE/$file"
  if [ -f "$dest" ]; then
    echo ">> [$id] cached; verifying $file"
    checked="$(verify_hashes "$dest" "$want256" "$want512")" \
      || { echo "   hint: cached file is corrupt or the pin changed;" >&2
           echo "   remove '$dest' and re-run to refetch." >&2
           exit 1; }
    echo "   ok ($checked hash(es) verified, $(wc -c <"$dest" | tr -d ' ') bytes)"
    STATUS="${STATUS}${id}\tskip\t$(basename "$dest")\n"
    return
  fi
  echo ">> [$id] fetching $file"
  download "$url" "$dest"
  checked="$(verify_hashes "$dest" "$want256" "$want512")" || { rm -f "$dest"; exit 1; }
  echo "   ok ($checked hash(es) verified, $(wc -c <"$dest" | tr -d ' ') bytes)"
  STATUS="${STATUS}${id}\tfetched\t$(basename "$dest")\n"
}

handle_git() { # id
  local id="$1"
  local url commit archive want256 gitdir arc head got
  url="$(pin_get "$id" url)"
  commit="$(pin_get "$id" commit)"
  archive="$(pin_get "$id" archive)"
  want256="$(pin_get "$id" archive_sha256)"
  [ -n "$url" ]     || { echo "FATAL [$id]: missing url" >&2; exit 1; }
  [ -n "$commit" ]  || { echo "FATAL [$id]: missing commit" >&2; exit 1; }
  [ -n "$archive" ] || { echo "FATAL [$id]: missing archive" >&2; exit 1; }
  # The commit is the integrity anchor; a valid archive_sha256 is also required
  # so the emitted archive is pinned (refuse unpinned).
  is_sha256 "$want256" || { echo "FATAL [$id]: refusing unpinned git source (archive_sha256 not a sha256)" >&2; exit 1; }

  gitdir="$CACHE/git/$id"
  arc="$CACHE/$archive"

  # Idempotent fast path: archive present + matches AND checkout at the commit.
  if [ -f "$arc" ] && [ -d "$gitdir/.git" ]; then
    head="$(git -C "$gitdir" rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$head" = "$commit" ]; then
      got="$(sha256_of "$arc")"
      if [ "$got" = "$want256" ]; then
        echo ">> [$id] cached; HEAD==$commit, archive ok"
        STATUS="${STATUS}${id}\tskip\t$archive\n"
        return
      fi
    fi
  fi

  echo ">> [$id] cloning/verifying $url @ $commit"
  if [ ! -d "$gitdir/.git" ]; then
    mkdir -p "$(dirname "$gitdir")"
    git clone --quiet "$url" "$gitdir"
  else
    git -C "$gitdir" fetch --quiet --all --tags || true
  fi
  git -C "$gitdir" checkout --quiet "$commit"
  head="$(git -C "$gitdir" rev-parse HEAD)"
  if [ "$head" != "$commit" ]; then
    echo "FATAL [$id]: HEAD $head != pinned $commit" >&2; exit 1
  fi
  echo "   HEAD matches pinned commit"
  # Deterministic archive: uncompressed git-archive tar (see README).
  git -C "$gitdir" archive --format=tar --prefix="${archive%.tar}/" "$commit" > "$arc.part"
  mv -f "$arc.part" "$arc"
  got="$(sha256_of "$arc")"
  if [ "$got" != "$want256" ]; then
    echo "MISMATCH archive_sha256 for $archive" >&2
    echo "   expected $want256" >&2
    echo "   actual   $got" >&2
    echo "   (commit IS verified; a mismatch here is typically a git-version" >&2
    echo "    archive-framing difference -- see build/sources/README.md)" >&2
    rm -f "$arc"; exit 1
  fi
  echo "   archive ok ($(wc -c <"$arc" | tr -d ' ') bytes)"
  STATUS="${STATUS}${id}\tfetched\t$archive\n"
}

# --- main ---------------------------------------------------------------------
echo ">> WasmTeX source fetch"
echo "   lock:  $LOCK"
echo "   cache: $CACHE"
mkdir -p "$CACHE"

# The lock promises unique block ids; duplicates would silently resolve to the
# first block's values, so refuse them outright.
dups="$(pin_ids | sort | uniq -d)"
[ -z "$dups" ] || { echo "FATAL: duplicate block id(s) in lock: $dups" >&2; exit 1; }

for id in $(pin_ids); do
  kind="$(pin_get "$id" kind)"
  case "$kind" in
    file)      handle_file "$id" ;;
    git)       handle_git  "$id" ;;
    container) echo ">> [$id] recorded (container pin; not fetched)"
               STATUS="${STATUS}${id}\trecorded\t(container)\n" ;;
    meta)      : ;;  # bookkeeping only
    "")        echo "FATAL [$id]: missing 'kind'" >&2; exit 1 ;;
    *)         echo "FATAL [$id]: unknown kind '$kind'" >&2; exit 1 ;;
  esac
done

echo
echo ">> All pinned sources present and verified."
echo "   ID                STATE     FILE"
printf "%b" "$STATUS" | while IFS="$(printf '\t')" read -r id state detail; do
  [ -n "$id" ] || continue
  printf "   %-16s  %-8s  %s\n" "$id" "$state" "$detail"
done
# Total cache size (portable: du -k -> KiB).
total_k="$(du -sk "$CACHE" 2>/dev/null | cut -f1 || true)"
if [ -n "${total_k:-}" ]; then
  echo "   cache total: $(awk -v k="$total_k" 'BEGIN{printf "%.2f GiB (%d KiB)", k/1024/1024, k}')"
fi
