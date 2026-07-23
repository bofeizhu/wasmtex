# Third-Party Notices

This file is the generated inventory of third-party components distributed with
WasmTeX. The code authored in this repository is MIT-licensed (see `LICENSE`).
The release artifacts are an *aggregate distribution of TeX Live programs*
compiled to WebAssembly, each carried under its own free license; WasmTeX adds no
wrapper license over them. Their sources are the pinned TeX Live snapshot plus
the patches and scripts in this repository, which satisfies the
source-availability obligations of the GPL-licensed members of that aggregate
and preserves the separate-program boundary for host applications.

This inventory is populated as components are vendored. **As of the TL-2026
rebase (M2 item 3), NO third-party code is vendored verbatim into this
repository: the busytex build machinery was dissolved from its M0 staging area
into `build/engines/` as our own maintained, MIT-licensed build config, each
file carrying a derived-work or original-work provenance header (below). The
TeX Live programs and packages and the fetched build dependencies are pinned by
hash but not vendored (see `build/sources/pins.lock`); their full per-package
license enumeration is deferred to the TeX Live 2026 rebase (engines) and
tiered-bundle generation (packages), per DESIGN.md §9. The license audit
verifies the per-file provenance headers and this deferral, and is enforced in
CI by `build/audit/license-audit.sh`.**

## Upstream: busytex/busytex (MIT)

WasmTeX's build machinery derives from **busytex/busytex** — the upstream project
that established the multicall WASM TeX binary and its Emscripten build approach
(DESIGN.md §2).

- Upstream: <https://github.com/busytex/busytex>
- Pinned commit: `f2bd7b11ee1b7b093638321c1f3e5d70389d307b`
  (recorded in `build/sources/pins.lock` `[busytex]`; `fetch.sh` hard-verifies
  `git rev-parse HEAD` against it before anything is used)
- License: **MIT**. The upstream repository has **no top-level LICENSE file**;
  its README "License" section is the license statement of record:

  > MIT - applies only to the code and scripts in the repo, not to the published
  > binaries (on the releases page). The binaries include linked TexLive code, so
  > the respective TexLived/dependencies licenses apply.

  (busytex/busytex `README.md`, "License" section, at the pinned commit.)

**Build config derived from busytex (per-file derivation headers).** At M2 item
3 the M0 staging area `build/upstream/busytex/` (which had held the machinery
vendored unmodified) was dissolved into `build/engines/` as WasmTeX's own
maintained build config. The **per-file headers are now the provenance record**
(there is no `PROVENANCE.md` manifest anymore); `build/audit/license-audit.sh`
checks (a/b) enforce that every file under `build/engines/` carries a derived-
from-busytex header naming the pinned commit, or an original-work header:

- `Makefile` — derived; our engine build config (LuaTeX, bench/native-fat,
  Ubuntu-bundle, `example`, and Cosmopolitan paths dropped; the format set
  trimmed to the non-lua retained set);
- `busytex.c` — derived; the multicall dispatcher (lua applet entries dropped);
- `emcc_wrapper.py` — derived; the `CCSKIP_*_wasm` compiler-wrapper shim, body
  unmodified;
- `README.md` — original WasmTeX work describing this directory.

The upstream helpers that only served dropped paths are **no longer forked**:
`packfs.c` / `packfs.py` (the bench native-fat binary), `cosmo_getpass.h`
(Cosmopolitan-only, a no-op on our targets), and `ubuntu_package_preload.py`
(the Ubuntu `.deb` bundle path).

**Worker/pipeline glue no longer distributed.** The `busytex_pipeline.js` /
`busytex_worker.js` glue that M0 shipped in `dist/` for faithful parity was
**dropped from `dist/` at M2 item 3**: the WasmTeX runtime replaced its role at
M1 (the demo drives our typed worker, not the glue), and M2 makes the build
config ours, so `dist/` now carries only WasmTeX-authored/-consumed artifacts.
The runtime worker sources cite the glue as a behavioural reference (MIT) in
comments; the pinned upstream commit remains fetchable via
`build/sources/pins.lock` `[busytex]` for anyone auditing that lineage.

Upstream attribution is preserved here and in `LICENSE`/`NOTICE`.

## TeX Live programs, macro and font packages

Status: to be inventoried when the engines build against the pinned TeX Live
snapshot at the TeX Live 2026 rebase and the tiered bundles are generated
(DESIGN.md §5.4, §7, §9) — no TeX Live program or package source is *vendored
into this repository*, so nothing in this section falls under the M0 item-7
audit's vendored-coverage requirement. The engine sources (`texlive-source`,
tag `texlive-2026.0`, since the M2 rebase) and the texmf tree (the frozen
`texlive2026-20260301.iso`) are fetched into an out-of-tree cache by
`build/sources/fetch.sh` and consumed by the build; they are pinned by hash in
`build/sources/pins.lock` (the TL 2023 pins remain recorded there until
retired). One narrow exception: the retired patch records under
`build/patches/*/HEADER.md` quote small excerpts of the patched third-party
sources (libpng and zlib, both permissively licensed — the defects were fixed
upstream in TL 2026 and the patches retired) under those sources' own
licenses. Expected license
families include the Knuth license, LPPL, GPL (some engines and tools), and OFL
(fonts); each is enumerated per package when the tiered bundles are generated
(DESIGN.md §5.4, §7).

## Build dependencies

Build dependencies are **pinned by hash in `build/sources/pins.lock`**, which is
the authoritative inventory of every external input the reproducible build
fetches. These sources are downloaded into an out-of-tree cache and compiled by
the build; they are **not vendored into this repository**. Their license
identifiers are recorded in the table below and pinned in
`build/sources/pins.lock`; the full per-package license text carried alongside
the release artifacts is assembled at the release-engineering license audit
(DESIGN.md §7, §9).

| Source (`pins.lock` id) | Pin | License (confirmed against `pins.lock` at the item-7 audit) |
| --- | --- | --- |
| `texlive-source` | `texlive-2023.0` tarball | TeX Live source tree — mixed (Knuth / LPPL / GPL / …) |
| `expat` | `expat-2.5.0.tar.gz` | MIT |
| `fontconfig` | `fontconfig-2.13.96.tar.gz` | MIT-style (fontconfig) |
| `texlive-iso` | `texlive2023-20230313.iso` | TeX Live aggregate (per-package) |

`expat` and `fontconfig` are the only libraries the busytex Makefile fetches
outside the TeX Live source tree; TeX Live vendors its other normal dependencies
(among others: harfbuzz, icu, freetype, zlib, graphite2, teckit, pplib, zziplib,
libpaper, lua53, xpdf), which are therefore covered by the `texlive-source` pin. The
toolchain container (`ubuntu:22.04`, emsdk/Emscripten 3.1.43) is recorded in
`pins.lock` `[toolchain-image]` and `build/toolchain/`; the same pinned emsdk
is consumed by both the parked container and the native host path
(`build/toolchain/native-host.md`), with darwin-arm64 platform binaries on
the latter. GNU tools installed via Homebrew for the native path are host
prerequisites only and never enter the artifact provenance chain.

## Development and test tooling (not distributed)

The `demo/` package is an M0 CI smoke vehicle — not the runtime npm package and
not part of any release artifact. Its sole dependency, the dev-only
`@playwright/test` (Apache-2.0, `demo/package.json` `devDependencies`), drives
the headless-browser hello-world PDF smoke; it is not vendored, is absent from
`runtime/`, and ships in nothing WasmTeX distributes, so it carries no
third-party-notice obligation. It is recorded here only so its omission from the
inventory above is a stated posture rather than a gap.

The `runtime/` package's own `devDependencies` — `typescript` and `vitest`
(both MIT/Apache-family dev tooling) and, from M1 item 5, **`esbuild`**
(MIT, `runtime/package.json` `devDependencies`, pinned exact) — are build/test
tools, not distributed. `esbuild` bundles `runtime/worker/entry.ts` into the
single self-contained classic-worker script `runtime/dist/worker.js`
(`npm run build:worker`); it injects no runtime of its own, so that output is
100% WasmTeX-authored MIT code and the tool itself ships in nothing WasmTeX
distributes. Like the engine build toolchain, these carry no third-party-notice
obligation and are recorded here only as a stated posture.
