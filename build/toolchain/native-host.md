<!--
SPDX-License-Identifier: MIT
Provenance: original work authored in the WasmTeX repository (see LICENSE).
  Not derived from any third-party source. Prerequisite enumeration consulted
  only the vendored upstream busytex Makefile (MIT, build/upstream/busytex/)
  and this repo's own container definition; no GPL/AGPL sources were opened.
-->

# Native host build contract (arm64 macOS)

Status: M0 item 4N (DESIGN.md §9 revision, native-first bootstrap).

This document is the contract for the **native arm64 macOS development host**
that drives the WasmTeX bootstrap build. Per the DESIGN.md §9 revision, dev
builds run raw on this host (no container) to maximise iteration speed toward
the runtime MVP. This path is **development-only**: the constitutional floor is
unchanged — *only container-built, pin-verified artifacts are ever released*
(DESIGN.md §9). Per the 2026-07-22 §9 amendment, the canonical builder from
M3 onward is a pinned **arm64** Linux container; the parked amd64 image in
this directory survives at most as a free CI verification lane.

The companion sourceable script is [`native-env.sh`](./native-env.sh); the
parked container contract is in [`README.md`](./README.md).

---

## 1. What is pinned HARD

The one artifact-affecting input on this path is the Emscripten toolchain, and
it is pinned to **exactly the same values** as the container, recorded in
`build/sources/pins.lock` `[toolchain-image]`:

| Pin | Value |
| --- | --- |
| Emscripten | `3.1.43` |
| emsdk commit | `d9c66fa2c2cd78daeb672967b2ef12bf18adf842` (git tag `3.1.43`) |

The emsdk checkout is **hard-verified** at setup: `git rev-parse HEAD` must
equal the pinned commit (the setup aborts otherwise), mirroring the container's
`Dockerfile` check. At the pinned emsdk commit, `emsdk install 3.1.43` resolves
to emscripten-releases build `bf3c159888633d232c0507f4c76cc156a43c32dc` and
downloads the **darwin-arm64** LLVM/clang + node for it — the same release the
container resolves, differing only in platform binaries (linux-amd64 there).
This is what "mirror the container's pin exactly on darwin binaries" means.

emsdk lives out-of-tree at `~/.cache/wasmtex/toolchain/emsdk` (sibling of the
fetch.sh source cache `~/.cache/wasmtex/sources`), never committed to the repo.

---

## 2. What is documented, NOT pinned

The macOS SDK, the Xcode/Clang host compiler, and the Homebrew build tools are
**documented here but not hard-pinned** on the native path. This is a
deliberate M0 decision: hard host pinning (exact tool versions, a reproducible
host bootstrap) is **deferred to M3** ("build logistics & CI"), where the
native-vs-container output-equivalence check and the reproducibility gate live.
For M0 the native build only has to prove the toolchain, not reproduce bytes.

Snapshot on the authoring host (2026-07-22):

| Tool | Version | Origin | Disposition |
| --- | --- | --- | --- |
| macOS | 26.4.1 (build 25E253), arm64 | — | host |
| Xcode | 26.6 (build 17F113) | `/Applications/Xcode.app` | provides clang/make/git/perl/curl/bsdtar |
| Apple clang | 21.0.0 (clang-2100.1.1.101) | Xcode | **native compiler** for the build's helper tools |
| Homebrew | 6.0.x | `/opt/homebrew` | package manager |
| cmake | 4.4.0 | **`brew install cmake`** | installed by 4N (absent on bare macOS) |
| GNU sed | 4.10 | **`brew install gnu-sed`** | installed by 4N (`gsed`; `sed` via gnubin) |
| GNU make | 4.4.1 | **`brew install make`** | installed by 4N (`gmake`; `make` via gnubin) |
| git | 2.48.1 | Homebrew (pre-present) | present |
| perl | 5.34.1 | `/usr/bin/perl` (system) | present; runs `install-tl` |
| curl | 8.7.1 | `/usr/bin/curl` (system) | present |
| GNU gperf | 3.0.3 | `/usr/bin/gperf` (system) | present |
| bsdtar | 3.5.3 (libarchive 3.7.4) | `/usr/bin/{tar,bsdtar}` (system) | present under the name `bsdtar` |
| python3 (PATH) | 3.12.9 / 3.14.5 (varies) | pyenv shim / Homebrew | present; version-agnostic use (see §5) |
| node (emsdk-bundled) | 16.20.0 (arm64) | emsdk | runs wasm output |
| python (emsdk-bundled) | 3.9.2 (arm64) | emsdk | emcc's own interpreter |

Since these are not pinned, treat the *behaviour* the Makefile relies on — not
the exact versions — as the contract. `native-env.sh` normalises the two host
gaps that matter (GNU `make`/`sed`; see §3).

---

## 3. Prerequisite translation: container apt set → macOS

The container (`Dockerfile`) installs an apt set derived from busytex CI + the
Makefile. This path was re-derived for macOS by static analysis of the vendored
`build/upstream/busytex/Makefile` (the native + wasm targets only — not the
`example`, `download-native`, or `ubuntu-wasm` shortcut paths). "Install only
the missing pieces; verify need before installing."

| Container apt package | macOS disposition | Rationale |
| --- | --- | --- |
| `cmake` | **installed** (`brew install cmake`) | invoked (`CMAKE_native`, `emcmake cmake`); absent on macOS |
| — (GNU sed) | **installed** (`brew install gnu-sed`) | Makefile uses GNU `sed -i` in `source/texlive.patched` (critical path); BSD sed's `-i` is incompatible |
| — (GNU make) | **installed** (`brew install make`) | build driver; host ships GNU Make 3.81 (GPLv2), container runs 4.x — parity for a complex recursive Makefile |
| `build-essential` | present (Xcode CLT: clang/clang++/make) | native helper-tool compiler |
| `git` | present (Homebrew) | — |
| `perl` | present (`/usr/bin/perl`) | `install-tl` |
| `python3` | present (see §5) | Makefile helper scripts; emcc uses its own bundled python |
| `curl` | present (`/usr/bin/curl`) | source fetch (via fetch.sh) |
| `libarchive-tools` (`bsdtar`) | present (`/usr/bin/bsdtar`, macOS tar IS libarchive) | `source/texmfrepo.txt` recipe |
| `gperf` | present (`/usr/bin/gperf`, GNU 3.0.3) | fontconfig hash generation |
| `xz-utils`, `bzip2`, `file` | present (system / libarchive-backed tar) | archive handling |
| `ca-certificates` | present (system trust store) | TLS |
| `p7zip-full` | **not installed** | `7z` is never invoked in the native+wasm path (only referenced by CI's prereq list) |
| `wget` | **not installed** | only in `example`/`download-native` recipes; the from-source native build uses `curl` |
| `autoconf`,`automake`,`libtool` | **not installed** | never invoked; TeX Live ships pre-generated `configure`/`libtool` |
| `pkg-config` | **not installed** | never invoked by the Makefile |
| `icu-devtools` | **not installed** | native ICU tools are built from source; host icu tools unused |
| `strace` | **not installed** | Linux-only diagnostic; only in commented/`smoke-native` lines |

---

## 4. Set up from scratch

Prerequisite: Xcode (or the Command Line Tools) and Homebrew installed.

```sh
# 1. Fetch + hash-verify the pinned sources (shared with the container path).
#    Populates ~/.cache/wasmtex/sources. See build/sources/README.md.
build/sources/fetch.sh

# 2. Install the pinned emsdk out-of-tree, hard-checked to the pins.lock commit.
TC="${WASMTEX_TOOLCHAIN_DIR:-$HOME/.cache/wasmtex/toolchain}"
mkdir -p "$TC"
git clone https://github.com/emscripten-core/emsdk.git "$TC/emsdk" \
  && git -C "$TC/emsdk" checkout --detach d9c66fa2c2cd78daeb672967b2ef12bf18adf842 \
  && test "$(git -C "$TC/emsdk" rev-parse HEAD)" = d9c66fa2c2cd78daeb672967b2ef12bf18adf842 \
  || { echo "emsdk commit != pins.lock — aborting" >&2; false; }
"$TC/emsdk/emsdk" install  3.1.43 \
  && "$TC/emsdk/emsdk" activate 3.1.43

# 3. Install the two missing host build tools (see §3).
brew install cmake gnu-sed make

# 4. Enter the build environment (idempotent; safe under set -u / set -e).
source build/toolchain/native-env.sh
```

Reverting is `rm -rf ~/.cache/wasmtex/toolchain` plus, if desired,
`brew uninstall cmake gnu-sed make`. Nothing is written into the repo tree or
into shell startup files.

---

## 5. Notes & gaps handed to item 5N

Static analysis flagged these host/container divergences. The two that block
setup (`make`, `sed`) are handled by `native-env.sh`; the rest are recorded for
item 5N (`make artifacts` native), which resolves genuine source
incompatibilities via documented patches in `build/patches/` — never in-place
edits of `build/upstream/`.

- **`sed`** — GNU `sed -i` (Makefile lines 238, 241) is on the critical path.
  Handled: `native-env.sh` puts GNU sed on PATH as `sed`.
- **`make`** — host GNU Make 3.81 vs container 4.x. Handled: `native-env.sh`
  puts GNU Make 4.x on PATH as `make`. (No 3.82/4.x-only *syntax* is used by
  the Makefile, so this is parity insurance, not a known parse failure.)
- **`cmake` 4.x** — Homebrew ships cmake 4.4.0, which removed compatibility
  with `cmake_minimum_required(VERSION < 3.5)`. Some TL 2023 library
  `CMakeLists.txt` may declare old minimums. **Flag for 5N**: expect a possible
  cmake-4 compatibility error; resolve with `-DCMAKE_POLICY_VERSION_MINIMUM`
  or a documented patch, or by pinning an older cmake (an M3 hard-pin question).
- **`ldd`** — absent on macOS. Only used in the `smoke-native` target, prefixed
  with `-` (make ignores the error); not on the artifact path. No action.
- **`objcopy`** — `OBJCOPY_native` is defined but never invoked; the wasm path
  stubs `OBJCOPY_wasm = echo`. No binutils needed.
- **`fontconfig` on darwin** — the Makefile builds fontconfig from source with
  BSD/darwin headers; a known 5N risk area (per the M0 revised work list).
- **`python3` on PATH** — resolves to whatever is first (pyenv 3.12.9 or
  Homebrew 3.14.5); the Makefile's helper scripts are Python-3-version-agnostic
  and emcc uses the emsdk-bundled Python 3.9.2 (`EMSDK_PYTHON`), so this is
  immaterial. Not pinned (M3).

---

## 6. Smoke check

```sh
source build/toolchain/native-env.sh
emcc --version            # -> emcc ... 3.1.43 ...

cat > /tmp/hello.c <<'EOF'
#include <stdio.h>
int main(void) { printf("ok\n"); return 0; }
EOF
emcc /tmp/hello.c -o /tmp/hello.js
"$EMSDK_NODE" /tmp/hello.js   # -> ok
```

Verified on the authoring host (2026-07-22): `emcc --version` reports `3.1.43`;
the emsdk clang and node binaries are `Mach-O 64-bit executable arm64` (native,
not Rosetta); `hello.c` compiled to a valid `WebAssembly (wasm) binary module
version 0x1 (MVP)` and ran under the emsdk-bundled node 16.20.0.
