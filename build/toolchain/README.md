# build/toolchain/

This directory holds two build paths:

- **Native arm64 macOS host (active, M0 dev path)** — per the DESIGN.md §9
  revision, bootstrap development builds run raw on the maintainer's host for
  fast iteration toward the runtime MVP. See **[`native-host.md`](./native-host.md)**
  (the host contract: what is pinned, prerequisite translation, setup, smoke)
  and **[`native-env.sh`](./native-env.sh)** (`source` it to enter the build
  environment). The pinned emsdk (Emscripten `3.1.43`, emsdk commit
  `d9c66fa2…`) is the **same** value as the container below and as
  `build/sources/pins.lock` — only the platform binaries differ (darwin-arm64).
- **Pinned amd64 container (parked for M2)** — the canonical, reproducible
  builder documented in the rest of this file. It is *parked, not discarded*:
  the constitutional floor is that **only container-built, pin-verified
  artifacts are ever released** (DESIGN.md §9); the native path is
  development-only. The container becomes the canonical builder at M2 (build
  logistics & CI), where the reproducibility gate and a native-vs-container
  output-equivalence check live.

---

## The pinned build-toolchain container (parked for M2)

The pinned build-toolchain container: a bare `ubuntu:22.04` plus the exact
toolchain the busytex + TeX Live WebAssembly build needs. Everything that
affects artifacts is pinned here and mirrored into `build/sources/pins.lock`
(M0 item 2), so the build is reproducible: the same inputs produce
byte-identical artifacts.

## Contents

- `Dockerfile` — original work (MIT, this repo). Defines the image.
- `build-image.sh` — builds the image for `linux/amd64`, tags it
  `wasmtex-toolchain:dev`, and prints the built image identifier.

## What is pinned

| Pin | Value | Where |
| --- | --- | --- |
| Base image | `ubuntu:22.04`, linux/amd64 platform digest `sha256:0d779ea9…973c8` | `Dockerfile` `FROM` (via `UBUNTU_DIGEST` ARG) |
| Base image (index) | manifest-list digest `sha256:0e0a0fc6…8982` | `Dockerfile` comment, cross-reference only |
| Emscripten | `3.1.43` | `Dockerfile` `EMSCRIPTEN_VERSION` ARG |
| emsdk | commit `d9c66fa2c2cd78daeb672967b2ef12bf18adf842` (git tag `3.1.43`) | `Dockerfile` `EMSDK_COMMIT` ARG |

The pins match upstream busytex CI (`.github/workflows/build-wasm.yml`) and its
README "Building from source" list, at the pinned busytex commit
`f2bd7b11ee1b7b093638321c1f3e5d70389d307b`. The apt package set installs both
the extras that CI names explicitly (`gperf p7zip-full strace icu-devtools`,
`wget cmake git`) and the toolchain the GitHub `ubuntu-22.04` runner provides
implicitly but the busytex Makefile actually invokes (`build-essential`,
`perl`, `python3`, `libarchive-tools`/`bsdtar`, `cmake`, …). See the Dockerfile
comments for the per-group rationale.

Environment hygiene set in the image: `LANG=LC_ALL=C.UTF-8` (a fixed,
locale-package-free UTF-8 locale) and `TZ=UTC`. `SOURCE_DATE_EPOCH` is **not**
baked in — it is exported at build-invocation time so one image can stamp
artifacts deterministically for any pinned epoch.

## Build the image

```sh
build/toolchain/build-image.sh
```

Builds `wasmtex-toolchain:dev` with `--platform linux/amd64` and prints the
Image ID to record in `pins.lock`. On an Apple-Silicon (arm64) host this runs
under Rosetta emulation and is slow; that is expected (docs/plans/M0.md Risks).

## Smoke check

After building, confirm the emulated toolchain is the pinned Emscripten and is
genuinely x86_64:

```sh
docker run --rm --platform linux/amd64 wasmtex-toolchain:dev \
  bash -lc 'emcc --version && uname -m'
```

Expect the first line to report `emcc … 3.1.43` and the architecture line to
report `x86_64`. Also verify the non-login-shell path (exercises the baked
`ENV`/`PATH`, not `/etc/profile.d`):

```sh
docker run --rm --platform linux/amd64 wasmtex-toolchain:dev emcc --version
```

## Reproducibility note

Artifact reproducibility pins the **built image digest** (the Image ID that
`build-image.sh` prints, recorded in `pins.lock`), not the Dockerfile alone.
The Dockerfile is provenance for *how* the image is made; `apt-get` package
resolution is not bit-reproducible across time (mirrors move, package versions
roll), so the Dockerfile does not by itself guarantee an identical image on a
future rebuild. Likewise, `emsdk install` downloads the prebuilt 3.1.43
LLVM/clang and node binaries from `storage.googleapis.com` at image-build
time without a repo-side checksum; the built-image digest is the pin that
covers both apt and these downloads. Rebuild the image once, record its
digest, and build all artifacts inside that pinned image. If the image is
ever rebuilt, its new digest is re-pinned in `pins.lock` in the same commit
that rebuilds it.
