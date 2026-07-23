<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/artifacts/ — the `make artifacts` pipelines

Two drivers for OUR maintained engine build config (`build/engines/`, MIT,
forked from busytex at M2 item 3). Both build the SAME artifacts with the SAME
stage sequence, offline pre-staging and execution gate; they differ only in
*where* they run.

- **`build.sh` + `run-in-container.sh` — the CANONICAL builder** (`make
  artifacts-container`, M3 item 4). Runs inside the pinned **arm64** toolchain
  image (`build/sources/pins.lock [toolchain-image-arm64]`), fully offline.
  Per DESIGN.md §9 this is the only path whose output is ever released.
- **`build-native.sh` — the development flow** (`make artifacts`). Runs raw on
  the arm64 macOS host with a pinned emsdk; fast iteration, never a release
  source. Its macOS-specific make overrides (Apple frameworks, cmake-4 policy
  floor, LDFLAGS trim, URL-blank offline enforcement) are exactly what the
  container flow does NOT need — the container's Linux GNU userland uses the
  Makefile's defaults, and `--network none` is its offline enforcement.
- **`verify-engine.mjs`** — the shared execution gate both drivers run at the
  end of `dist`: it drives the built engine under node and fails the build on a
  structurally-valid-but-hollow wasm (env-import sanity + a real
  `xetex --version` that must print the TeX Live 2026 banner).

## The container flow

- `build.sh` — host side. Preflights the pinned cache and image identity
  (`[toolchain-image-arm64] image_id`), then `docker run`s the container with
  `--platform linux/arm64`, `--network none`, the cache mounted read-only,
  `build/engines/` + `build/manifest/` + these scripts read-only, `dist/`
  read-write, and a named docker volume for the build tree. The repo-root
  `make artifacts-container` delegates here.
- `run-in-container.sh` — container side. Sets the reproducibility environment,
  pre-stages sources from the cache into the paths the Makefile's download rules
  produce (so those rules never reach the network), runs
  `prep → native → basic → wasm → bundle → dist`, and assembles `dist/`
  (+ `SHA256SUMS`, `assets.json`, execution gate).

### Work-tree policy (reproducibility)

The build tree lives on a **named docker volume** (`wasmtex-work`), not a host
bind mount: it stays on the VM-native filesystem, so the multi-GB TL source
tree + ~6.5 GB texmfrepo ISO staging + build objects are not dragged through the
slow macOS virtiofs mount. Only the small `dist/` output crosses a bind mount.

A full build (`STAGE=all`) or its first phase (`STAGE=prep`) **wipes and
recreates the volume**, so every build starts from a pristine tree — the
build-twice reproducibility gate (M3 item 5) and the equivalence check (item 6)
must not be contaminated by incremental state. A single-stage resume
(`STAGE=native|basic|wasm|bundle|dist`) reuses the in-progress volume.

## How offline works

Our `build/engines/Makefile` downloads its sources by default. We do not let it:

1. The container has **no network** (`--network none`) — the hard enforcement.
2. `run-in-container.sh` extracts each pinned source from the read-only cache
   into `source/<id>/` and writes the `source/<id>.txt` sentinel — byte-for-byte
   what the Makefile's `source/<id>.txt` rule would have produced via `curl`. A
   no-prerequisite target that already exists is up-to-date, so make skips the
   download recipe entirely. The TL texmf repo is unpacked from the frozen ISO
   with `bsdtar` (as the Makefile does), not the split-release cache URL.

The build **config** (`build/engines/`) is ours and edited directly; changes to
third-party **TeX Live source** land as documented patches under
`build/patches/` (each with a HEADER.md), never in-place edits. Those patches
are macOS-scoped (and currently retired), so the container applies none.

## Usage

```sh
build/toolchain/build-image.sh arm64   # once: build the pinned canonical image
build/sources/fetch.sh                 # once: fetch + verify the pinned sources
make artifacts-container               # full build inside the container (hours)

# Single stage (resumable within one build; STAGE=prep/all starts clean):
make artifacts-container STAGE=prep|native|basic|wasm|bundle|dist
make clean-artifacts                   # remove dist/ and the work volume
```

## Output (`dist/`)

`busytex.js`, `busytex.wasm` (engine); the **tier data bundles**
`core.{js,data}` + `academic.{js,data}` (M4 item 3 — disjoint per-tier bundles,
split from one combined install by the tlpdb tier map, both mounting at
`/texlive`); `texlive-basic.{js,data}` (a back-compat **byte alias of `core`**,
kept one release for the demo + published 0.0.1 consumers, dropped at M5);
`formats/*.fmt` (the `xelatex` + `pdflatex` format dumps — the non-lua retained
set, carried in `core`); `assets.json` (data-driven inventory — its structural
`bundle-js`/`bundle-data` roles classify every tier for free); and `SHA256SUMS`.

Reproducibility (`SOURCE_DATE_EPOCH`, stable ordering) is wired here; the
byte-for-byte double-build gate is M3 item 5 (`build/repro-check.sh`), and the
three-way arm64/amd64 equivalence check is item 6.
