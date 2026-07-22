# Third-Party Notices

This file is the generated inventory of third-party components distributed with
MoTeX. The code authored in this repository is MIT-licensed (see `LICENSE`).
The release artifacts are an *aggregate distribution of TeX Live programs*
compiled to WebAssembly, each carried under its own free license; MoTeX adds no
wrapper license over them. Their sources are the pinned TeX Live snapshot plus
the patches and scripts in this repository, which satisfies the
source-availability obligations of the GPL-licensed members of that aggregate
and preserves the separate-program boundary for host applications.

This inventory is populated as components are vendored. **As of 2026-07-22,
nothing has been vendored;** the sections below are the skeleton to be filled in
during M0/M1.

## Upstream: busytex/busytex (MIT)

Status: to be vendored at M0 — nothing vendored yet. Upstream attribution will
be preserved here and in `LICENSE` once the build machinery is vendored.

## TeX Live programs, macro and font packages

Status: to be inventoried from the pinned TeX Live snapshot at M0/M1 — nothing
vendored yet. Expected license families include the Knuth license, LPPL, GPL
(some engines and tools), and OFL (fonts).

## Build dependencies

Status: to be pinned in `build/sources/pins.lock` at M0 — nothing pinned yet.
Covers the engine build toolchain and TeX Live's normal dependencies
(harfbuzz, icu, freetype, zlib, …).
