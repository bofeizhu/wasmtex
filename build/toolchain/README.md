# build/toolchain/

This directory holds the WasmTeX build toolchain. There are three lanes; only
the container lanes ever produce released artifacts.

- **Canonical builder — pinned arm64 Linux container (active, M3).** A
  digest-pinned `ubuntu:22.04` (arm64) plus the exact toolchain the
  WasmTeX (busytex-derived) + TeX Live 2026 WebAssembly build needs, built
  **natively on the Apple-Silicon host — no Rosetta**. Per the 2026-07-22
  DESIGN.md §9 amendment this is the canonical, reproducible builder; the
  constitutional floor is that **only container-built, pin-verified artifacts
  are ever released** (DESIGN.md §9). Defined by [`Dockerfile`](./Dockerfile),
  built by [`build-image.sh`](./build-image.sh). Everything that affects
  artifacts is pinned here and mirrored into
  [`build/sources/pins.lock`](../sources/pins.lock)
  `[toolchain-image-arm64]`.
- **Equivalence lane — pinned amd64 Linux container (parked for M3 item 6).**
  The same userland, one architecture over. Built from the **same
  parameterized `Dockerfile`** with `--platform linux/amd64` (under emulation
  on an arm64 host — prefer a CI amd64 runner). Its only role is the M3
  three-way artifact-hash equivalence check; it survives only if it earns its
  keep. Pinned in `pins.lock` `[toolchain-image]` (the M0-era image_id, kept as
  the historical record until item 6 rebuilds it).
- **Native arm64 macOS host (development only).** Raw host builds for fast
  iteration, no container. See [`native-host.md`](./native-host.md) and
  [`native-env.sh`](./native-env.sh). The pinned emsdk (Emscripten `3.1.43`,
  emsdk commit `d9c66fa2…`) is the **same** value as the containers and as
  `pins.lock` — only the platform binaries differ (darwin-arm64 there,
  linux-arm64 / linux-amd64 in the containers).

The full item-3 record (arch-parameterization decision, base-image decision,
the emsdk arm64-prebuilt verification, the prerequisite shrink) is in
[`docs/plans/M3-journal.md`](../../docs/plans/M3-journal.md).

> The **container build flow** scripts that run the engine build *inside* this
> image (`build/artifacts/build.sh`, `run-in-container.sh`) are still PARKED
> with their M0 stale-path banners; M3 item 4 revives and re-points them at
> `build/engines/` + the arm64 image. Until then use the native flow,
> `build/artifacts/build-native.sh`.

---

## One Dockerfile, two pinned images

The base is pinned by the **multi-arch manifest-list (INDEX) digest**, which is
arch-agnostic and cryptographically commits to each per-arch manifest. The
Dockerfile `FROM`s that index; the build's `--platform` (supplied by
`build-image.sh`, default `linux/arm64`) selects which per-arch base is pulled.
The canonical image and the equivalence-lane image therefore differ **only in
`--platform`** — precisely the invariant the equivalence check needs. (A sibling
`Dockerfile.arm64` was rejected: two near-identical files would drift.) This
supersedes the M0 amd64-only design, which hardcoded `FROM
--platform=linux/amd64` and tripped BuildKit's `FromPlatformFlagConstDisallowed`
lint; that constant is gone.

**Why `ubuntu:22.04` (not 24.04):** (1) era-consistency with the pinned emsdk
`3.1.43` prebuilt binaries (mid-2023); (2) the equivalence lane compares arm64
vs amd64 on the *same* 22.04 userland, so any artifact-hash divergence is
attributable to **architecture alone**, not a userland-version confound. As a
bonus, apt `cmake` on 22.04 is 3.22 (< 4), so the native-host cmake-4
policy-floor workaround is not needed here.

## Contents

- `Dockerfile` — original work (MIT, this repo). Defines the image for both
  arches (arch selected by the build's `--platform`).
- `build-image.sh` — builds the image for the requested arch (default `arm64`),
  tags it `wasmtex-toolchain:<arch>-dev`, and prints the built Image ID.
- `native-host.md` / `native-env.sh` — the development-only native macOS lane.

## What is pinned

| Pin | Value | Where |
| --- | --- | --- |
| Base index (shared) | `ubuntu:22.04` manifest-list `sha256:0e0a0fc6…8982` | `Dockerfile` `FROM` (via `UBUNTU_INDEX_DIGEST`) |
| Base arm64 platform | index → arm64/v8 `sha256:ecd3706b…bdc1` | `pins.lock` `[toolchain-image-arm64]` |
| Base amd64 platform | index → amd64 `sha256:0d779ea9…973c8` | `pins.lock` `[toolchain-image]` |
| Emscripten | `3.1.43` | `Dockerfile` `EMSCRIPTEN_VERSION` ARG |
| emsdk | commit `d9c66fa2c2cd78daeb672967b2ef12bf18adf842` (tag `3.1.43`) | `Dockerfile` `EMSDK_COMMIT` ARG |
| emsdk arm64 prebuilt | release `bf3c159…`, `wasm-binaries-arm64.tbz2` (242,978,805 B) — **confirmed present** | `pins.lock` `emsdk_release`; journal item 3 |
| Built Image ID (arm64) | `sha256:23c01f1f…dce421…8f27` (the repro anchor) | `pins.lock` `[toolchain-image-arm64]` `image_id` |

## Prerequisites (the lean set)

The apt set is enumerated from what **our build config actually invokes**
(`build/engines/Makefile` + the `build/artifacts` driver), not the M0
busytex-CI mirror. It halves from 20 packages to **10**:

`build-essential`, `ca-certificates`, `cmake`, `curl`, `git`, `gperf`,
`libarchive-tools` (bsdtar), `perl`, `python3`, `xz-utils`.

Per-tool justification and the full drop list (`p7zip-full`, `strace`,
`icu-devtools`, `wget`, `bzip2`, `file`, `pkg-config`, `autoconf`, `automake`,
`libtool` — none invoked on the native+wasm path) are in the Dockerfile comment
and `docs/plans/M3-journal.md` item 3.

`SOURCE_DATE_EPOCH` is **not** baked in — it is exported at build-invocation
time so one image can stamp artifacts deterministically for any pinned epoch.
Environment hygiene set in the image: `LANG=LC_ALL=C.UTF-8`, `TZ=UTC`.

## Build the image

```sh
build/toolchain/build-image.sh            # arm64 canonical (native); tags :arm64-dev
build/toolchain/build-image.sh amd64      # equivalence lane; tags :amd64-dev (emulated on arm64)
```

Prints the Image ID to record in `pins.lock`. The arm64 build is native on an
Apple-Silicon host; the amd64 build runs under emulation there (slow — prefer a
CI amd64 runner, per the M3 plan).

## Smoke check

Confirm the toolchain is the pinned Emscripten and genuinely aarch64, then
compile+run a hello-world to wasm under the bundled node:

```sh
# baked ENV path (non-login): emcc resolves via EM_CONFIG
docker run --rm --platform linux/arm64 wasmtex-toolchain:arm64-dev emcc --version

# login shell (node on PATH) + full check
docker run --rm --platform linux/arm64 wasmtex-toolchain:arm64-dev bash -lc '
  emcc --version | head -1        # -> emcc ... 3.1.43
  uname -m                        # -> aarch64
  printf "#include <stdio.h>\nint main(void){puts(\"ok\");return 0;}\n" > /tmp/h.c
  emcc /tmp/h.c -o /tmp/h.js && node /tmp/h.js   # -> ok
'
```

Verified on the authoring host (2026-07-23): `emcc … 3.1.43`; `uname -m` =
`aarch64`; the emsdk clang/node ELF `e_machine` = 183 (`EM_AARCH64`, i.e. native
not emulated); `node` reports `process.arch = arm64`; `hello.c` compiled to a
valid wasm module (magic `00 61 73 6d`) and ran. Full transcript in the journal.

## Reproducibility note

Artifact reproducibility pins the **built image ID** (what `build-image.sh`
prints, recorded in `pins.lock`), not the Dockerfile alone. The Dockerfile is
provenance for *how* the image is made; `apt-get` resolution is not
bit-reproducible across time (mirrors move, versions roll), and `emsdk install`
downloads the prebuilt 3.1.43 LLVM/clang + node from `storage.googleapis.com`
without a repo-side checksum. The built-image ID covers both. Rebuild the image
once, record its ID, and build all artifacts inside that pinned image; if the
image is ever rebuilt, its new ID is re-pinned in `pins.lock` in the same commit
that rebuilds it.
