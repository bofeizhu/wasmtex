<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/upstream/ — M0-only vendoring staging area

This directory holds upstream build machinery **vendored faithfully at a pinned
commit**, staged for the M0 "faithful baseline" milestone (DESIGN.md §9). It is
temporary scaffolding, recorded as an explicit extension to the DESIGN.md §4
repository layout (that section carries the one-line note; CLAUDE.md forbids
silent layout deviations).

## Contract

- **Faithful and unmodified.** Everything under `busytex/` is copied byte-for-
  byte from busytex/busytex at the pinned commit
  `f2bd7b11ee1b7b093638321c1f3e5d70389d307b` (see `build/sources/pins.lock`
  `[busytex]`). The only change to each file is a prepended provenance header;
  the file body is identical to upstream. Every vendored file carries such a
  header, and `busytex/PROVENANCE.md` is the per-file manifest (origin path,
  upstream sha256, vendored sha256, modified flag).
- **No local modifications here.** Do not patch, refactor, or "fix" vendored
  files in this directory. Any local change to upstream build machinery is
  introduced and justified at **M0 item 4** as a documented patch (the patch
  lives in `build/patches/` per DESIGN.md §4/§6.2, with a header explaining
  what and why); this staging area stays a clean mirror of the pin so the
  diff between "upstream as pinned" and "what we build" is always legible.
- **License.** The vendored files are MIT (busytex); `THIRD_PARTY_NOTICES.md`
  carries the upstream license statement and the inventory. Files authored by
  WasmTeX in this tree (`README.md`, `busytex/PROVENANCE.md`) are MIT under this
  repository's own `LICENSE`.

## Lifecycle

`build/upstream/` exists **only during M0**. At the **TeX Live 2026 rebase**
(DESIGN.md §9) the vendored machinery is dissolved into its permanent homes under the DESIGN.md §4
layout — `build/engines/` (per-program builds and the combined multicall link),
`build/formats/`, `build/bundles/`, and `build/patches/` — at which point this
staging directory is removed. Nothing outside M0 should depend on paths under
`build/upstream/`.

## What is (and isn't) here

Only the build machinery M0 needs: the `Makefile`, the repo-local source and
helper files it references, and the worker/pipeline JS glue the demo page loads,
plus the upstream `README.md` as documentation of origin. Upstream texmf trees,
prebuilt artifacts, example documents, CI workflow definitions, and alternate
build paths (biber, cosmopolitan, benchmarks) are **not** vendored. See
`busytex/PROVENANCE.md` for the exact file list and the exclusion rationale.
