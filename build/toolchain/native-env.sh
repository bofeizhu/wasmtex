#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. The pinned Emscripten/emsdk this
#   script activates is installed out-of-tree (see build/toolchain/native-host.md)
#   and carries its own licenses; see THIRD_PARTY_NOTICES.md.
#
# WasmTeX native host build environment (M0 item 4N; DESIGN.md §9 revision).
# =============================================================================
# SOURCE this file (do not execute it) to put the pinned, out-of-tree emsdk on
# PATH and present the GNU userland the vendored busytex Makefile assumes, so
# the native arm64-macOS *development* build tracks the pinned amd64 container:
#
#     source build/toolchain/native-env.sh
#     emcc --version            # -> 3.1.43
#
# What it sets up, and why:
#   * emsdk        Pinned Emscripten 3.1.43 (emsdk commit
#                  d9c66fa2c2cd78daeb672967b2ef12bf18adf842 -- the same values
#                  as build/sources/pins.lock [toolchain-image]) from an
#                  out-of-tree cache. Provides emcc/em++/emar/emmake/
#                  emconfigure/emcmake and a bundled node + python.
#   * GNU make/sed macOS ships GNU Make 3.81 (the last GPLv2 release) and BSD
#                  sed; the container runs GNU Make 4.x + GNU sed, and the
#                  vendored Makefile uses GNU-style `sed -i` on its critical
#                  path. We prepend the Homebrew "gnubin" dirs so `make` and
#                  `sed` resolve to GNU, matching the container's userland.
#                  (`gmake`/`gsed` remain available under their own names too.)
#   * cmake        Homebrew cmake (absent from a bare macOS) on PATH.
#   * hygiene      TZ=UTC and LANG=LC_ALL=C.UTF-8, matching the container's
#                  deterministic locale/time.
#
# Contract: idempotent (safe to re-source; never duplicates PATH entries),
# safe under `set -u` (nounset) and `set -e` (errexit) in the calling shell,
# and it never `exit`s the calling shell. Works when sourced from bash or zsh.
#
# NOT pinned here: the macOS / Xcode / Homebrew tool VERSIONS are documented,
# not hard-pinned, for the native bootstrap path; hard host pinning is deferred
# to M3 (DESIGN.md §9). See build/toolchain/native-host.md for the full contract.
# =============================================================================

# --- idempotent PATH prepend (POSIX; identical behaviour in bash and zsh) -----
_wt_path_prepend() {
  # $1: directory to prepend, iff it exists and is not already on PATH.
  [ -d "$1" ] || return 0
  case ":${PATH}:" in
    *":$1:"*) : ;;                 # already present -> no-op (idempotent)
    *) PATH="$1:${PATH}" ;;
  esac
  return 0
}

_wt_native_env() {
  # Resolve locations. All overridable; defaults mirror fetch.sh's cache root
  # (~/.cache/wasmtex/{sources,toolchain}).
  _wt_toolchain="${WASMTEX_TOOLCHAIN_DIR:-${HOME}/.cache/wasmtex/toolchain}"
  _wt_emsdk="${_wt_toolchain}/emsdk"
  _wt_brew="${HOMEBREW_PREFIX:-/opt/homebrew}"

  if [ ! -f "${_wt_emsdk}/emsdk_env.sh" ]; then
    printf '%s\n' "wasmtex native-env: emsdk not found at ${_wt_emsdk}" >&2
    printf '%s\n' "  Set it up first (build/toolchain/native-host.md), or export" >&2
    printf '%s\n' "  WASMTEX_TOOLCHAIN_DIR to point at an existing emsdk parent dir." >&2
    unset _wt_toolchain _wt_emsdk _wt_brew
    return 1
  fi

  # GNU userland first, so `make`/`sed` are GNU (container parity), taking
  # precedence over /usr/bin's GNU Make 3.81 and BSD sed.
  _wt_path_prepend "${_wt_brew}/opt/make/libexec/gnubin"     # GNU make  as `make`
  _wt_path_prepend "${_wt_brew}/opt/gnu-sed/libexec/gnubin"  # GNU sed   as `sed`
  _wt_path_prepend "${_wt_brew}/bin"                         # cmake, gmake, gsed

  # Activate the pinned emsdk. emsdk_env.sh is noisy and is not nounset-clean,
  # so silence it and disable nounset only across the source, then restore the
  # caller's prior nounset state exactly.
  case "$-" in *u*) _wt_had_u=1 ;; *) _wt_had_u= ;; esac
  set +u
  # shellcheck disable=SC1091
  . "${_wt_emsdk}/emsdk_env.sh" >/dev/null 2>&1 || :
  if [ -n "${_wt_had_u}" ]; then set -u; fi

  # Loud-failure contract: activation must actually have produced a working,
  # pinned emcc — a cloned-but-never-activated emsdk otherwise yields a false
  # success that 5N's scripts would trust.
  if ! command -v emcc >/dev/null 2>&1; then
    printf '%s\n' "wasmtex native-env: emsdk activation failed (emcc not on PATH); see build/toolchain/native-host.md" >&2
    unset _wt_toolchain _wt_emsdk _wt_brew _wt_had_u
    return 1
  fi
  case "$(emcc --version 2>/dev/null | head -n 1)" in
    *"3.1.43"*) : ;;
    *)
      printf '%s\n' "wasmtex native-env: emcc is not the pinned 3.1.43 (out-of-tree emsdk drifted?); see build/toolchain/native-host.md" >&2
      unset _wt_toolchain _wt_emsdk _wt_brew _wt_had_u
      return 1
      ;;
  esac

  # Deterministic locale + time, matching the container. glibc's C.UTF-8 is
  # accepted by macOS 26 (verified: no setlocale warning); it stabilises tool
  # sort order and timestamps.
  export TZ=UTC
  export LANG=C.UTF-8
  export LC_ALL=C.UTF-8

  export PATH
  export WASMTEX_TOOLCHAIN_DIR="${_wt_toolchain}"
  export WASMTEX_NATIVE_ENV=1

  if [ -z "${WASMTEX_ENV_QUIET:-}" ]; then
    printf '%s\n' "wasmtex native-env ready:" >&2
    printf '  emcc  = %s\n' "$(command -v emcc  2>/dev/null || echo MISSING)" >&2
    printf '  make  = %s\n' "$(command -v make  2>/dev/null || echo MISSING)" >&2
    printf '  sed   = %s\n' "$(command -v sed   2>/dev/null || echo MISSING)" >&2
    printf '  cmake = %s\n' "$(command -v cmake 2>/dev/null || echo MISSING)" >&2
  fi

  unset _wt_toolchain _wt_emsdk _wt_brew _wt_had_u
  return 0
}

_wt_native_env
_wt_rc=$?
unset -f _wt_native_env _wt_path_prepend 2>/dev/null || :
return "${_wt_rc}" 2>/dev/null || :
