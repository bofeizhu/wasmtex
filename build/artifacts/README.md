<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/artifacts/ — containerized `make artifacts` pipeline (PARKED for M2)

> PARKED 2026-07-22: superseded as the M0 path by the native-first pivot
> (DESIGN.md §9 revision). Do not run this expecting the current dev flow —
> M0 item 5N drives the native host build; this container flow becomes the
> canonical builder at M2 (build logistics & CI).

Original WasmTeX (MIT) glue that runs the **vendored, unmodified** busytex build
(`build/upstream/busytex/`) inside the pinned `wasmtex-toolchain` image, fully
offline, and lands the M0 faithful-baseline artifacts in `dist/` (git-ignored).

## Files

- `build.sh` — host side. Preflight-checks the pinned cache and image identity
  (`build/sources/pins.lock` `[toolchain-image] image_id`), then `docker run`s
  the container with `--network none`, `--platform linux/amd64`, the cache
  mounted read-only, the vendored machinery + these scripts read-only, `dist/`
  read-write, and a named docker volume for the build tree. The repo-root
  `make artifacts` delegates here.
- `run-in-container.sh` — container side. Sets the reproducibility environment,
  pre-stages sources from the cache into the paths the busytex Makefile's
  download rules produce (so those rules never reach the network), then runs the
  make targets in upstream `build-wasm.yml` order and assembles `dist/`.

## How offline works without touching vendored files

The busytex `Makefile` downloads its sources. We do not edit it. Instead:

1. The container has **no network** (`--network none`).
2. `run-in-container.sh` extracts each pinned source from the read-only cache
   into `source/<id>/` and writes the `source/<id>.txt` sentinel — byte-for-byte
   what the Makefile's `source/<id>.txt` rule would have produced via `curl`.
   A no-prerequisite target that already exists is up-to-date, so make skips the
   download recipe entirely. The TL 2023 texmf repo is unpacked from the frozen
   ISO with `bsdtar` (as the Makefile does), not the split-release cache URL.

No `build/patches/` entry is required: pre-staging closes every acquisition path
M0 exercises. If a future change ever needs to alter vendored machinery, it must
land as a documented patch under `build/patches/`, never an in-place edit.

## Usage

```sh
build/toolchain/build-image.sh     # once: build the pinned image
build/sources/fetch.sh             # once: fetch + verify the pinned sources
make artifacts                     # full build (hours, Rosetta-emulated)

# Single stage (resumable; stages share the work volume):
make artifacts STAGE=prep|native|basic|wasm|bundle|dist
make clean-artifacts               # remove dist/ and the work volume
```

## Output (`dist/`)

`busytex.js`, `busytex.wasm` (engine), `busytex_pipeline.js`, `busytex_worker.js`
(worker/pipeline glue), `texlive-basic.js` + `texlive-basic.data` (data bundle),
`formats/*.fmt` (pdflatex/xelatex/luahblatex format dumps), and `SHA256SUMS`.

Reproducibility (`SOURCE_DATE_EPOCH`, stable ordering) is wired here; the
byte-for-byte double-build gate lands at M2 (`build/repro-check.sh`).
