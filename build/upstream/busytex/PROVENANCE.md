<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE). This file is
  the provenance manifest for the vendored busytex build machinery; it is not
  derived from any third-party source.
-->

# Provenance manifest — vendored busytex build machinery

This directory (`build/upstream/busytex/`) is a faithful, unmodified vendoring
of selected build machinery from **busytex/busytex** at the pinned commit. It is
an **M0-only staging area** — see `build/upstream/README.md` for the staging
contract and `DESIGN.md` §4 for the layout note.

- Upstream: <https://github.com/busytex/busytex>
- Pinned commit: `f2bd7b11ee1b7b093638321c1f3e5d70389d307b`
  (2026-06-16 HEAD of `main`; recorded in `build/sources/pins.lock` `[busytex]`,
  where `fetch.sh` hard-verifies `git rev-parse HEAD` against it)
- License: **MIT**, per the upstream README "License" section. The upstream
  repository has **no top-level LICENSE file**; the README is the license
  statement of record (quoted in `THIRD_PARTY_NOTICES.md`).
- Vendored: **2026-07-22** (M0 item 3), from the commit-verified cache clone at
  `~/.cache/wasmtex/sources/git/busytex`.

## Header convention (why "Modified: no" despite a header)

Every vendored file below carries a **prepended provenance header** in its
native comment syntax (`#`, `//`, `/* */`, or `<!-- -->`). That header is the
only text added; the upstream file **body** — everything after the header — is
byte-for-byte identical to the pinned commit. The **Modified** column therefore
records whether the upstream *content* was patched (it was not: all `no`), not
whether a header was added (it always is). Local patches, if any are ever
needed, are introduced and justified at M0 item 4, never here.

To verify a file's body is unmodified without counting header lines:

```sh
SRC=~/.cache/wasmtex/sources/git/busytex        # commit-verified clone
f=Makefile
tail -c "$(wc -c < "$SRC/$f")" build/upstream/busytex/"$f" | shasum -a 256
#   -> equals the "Upstream sha256" column below (the pristine upstream file)
shasum -a 256 build/upstream/busytex/"$f"
#   -> equals the "Vendored sha256" column below (header + pristine body)
```

## Manifest

`Origin` is the path within busytex/busytex at the pinned commit; each file is
vendored to the same basename in this directory. `Upstream sha256` is the
sha256 of the pristine upstream file; `Vendored sha256` is the sha256 of the
vendored copy on disk (provenance header + unmodified body).

| Origin | Upstream sha256 | Vendored sha256 | Modified |
| --- | --- | --- | --- |
| `Makefile` | `b234d8e35586d22a545ccca9c67219bd258f63d959c2f0648ee26aa6d1d1050a` | `824858b191be0bfa0a4234bfef59698218d3faa83c96050229d28fb5a005af20` | no |
| `busytex.c` | `d02ba41ede8298561de953ef435e97d3aca3068243aec3c1e7d388310da639a1` | `03ef164d6a72214395dad85239849008677fd9350bfcaec8f43744bea6ec987b` | no |
| `packfs.c` | `2a7145fb4bc6e2594d415b8ed1bd7d7a06d3f6303a0f4d0417717732bd59e6e1` | `67296a452295c56518487f64391cb21a7bce3f07fb1b7008e548cf026e69fe8a` | no |
| `packfs.py` | `d091699a4f0bd0f4df16b6d03be2f409b062946a2cc049716ff136c6fa61c7e0` | `3f87956a225d7ae8258435c9e992c5e601609e844a29aab418db3f27f15447f5` | no |
| `emcc_wrapper.py` | `65f8ca523810b6968b428897a779f57527703523fb15c09afc35037d77ea4487` | `412c667ea7e6f4f0199d6845ad8448b8376e9520863cda6ed30d841d11693fca` | no |
| `cosmo_getpass.h` | `6d67316a6eb60bb97cf7607dd3d24a4717488e038de83722f90df075d25837d4` | `b548eec91cfd9d40a993bff6f8656bee642f854b02b88398ce2ee0b8b29d0e58` | no |
| `ubuntu_package_preload.py` | `d3700c8a853862e14638b22910be5311f509bd03983d671b9c6f744cc05b6cc5` | `c35cc7535f86ef3b6863980cd7f984892da5b56490f383429300ab5146ca5823` | no |
| `busytex_pipeline.js` | `af8c48a287f7c34cc2a91b52bce9d46cc7ac44cc159d9cf71b6944a97f093bea` | `3677f3c5f3dbd2882034cceae7dd39df9bf5780f9a9654880f08970410a2e984` | no |
| `busytex_worker.js` | `623136034d61d52be43df97bbe320612f0cca139b955431fb168c529531d21c4` | `b557fd0df1e097db5798224be65df53ea75e0deaebbaf598579ec45fe35c65d2` | no |
| `README.md` | `cd419c22c6e34fffb09c2a750063ff7edf0e0bb57369da8e5a072f1a8bb04329` | `65b8937dbc458f5f6067478b812c200294d9bffd33a69b25b7253c30d5aae8a4` | no |

`PROVENANCE.md` (this file) and `../README.md` are original WasmTeX work
(MIT, this repo), not vendored; each carries its own SPDX header.

## Why these files, and what was deliberately excluded

**Selection rule.** Vendor the `Makefile`, every repo-local file the `Makefile`
references by path, the two worker/pipeline JS glue files the demo page needs,
and the upstream `README.md` (as documentation of origin). Nothing generated,
no texmf trees, no example documents.

The six `Makefile`-referenced helpers and where they are used at the pinned
commit:

- `busytex.c` — the multicall dispatcher compiled by the native/wasm engine
  build (`Makefile` `build/%/busytex*` rules).
- `packfs.c`, `packfs.py` — pack-filesystem embedding for the native
  `busytexextra` binary (`Makefile` `build/native/busytexextra` rule).
- `emcc_wrapper.py` — wraps native TeX/ICU/FreeType helper tools during the
  wasm build (`Makefile` `CCSKIP_*_wasm` variables).
- `cosmo_getpass.h` — copied into `texk/dvipdfm-x/` and `#include`-injected
  during the standard `source/texlive.patched` step (a prerequisite of every
  build target), not a cosmopolitan-only concern despite its name.
- `ubuntu_package_preload.py` — used only by the `build/wasm/ubuntu/%.js` rule,
  the rolling-Ubuntu-`.deb` bundle path that M0 does **not** build (out of
  scope per `build/sources/README.md` "Deliberately not pinned: ubuntu/*
  bundles"). Vendored regardless so the vendored `Makefile`'s own file-level
  references stay satisfiable and the machinery is internally consistent.

**Excluded (present at the pinned commit, not vendored):**

- `.github/workflows/*.yml` — GitHub Actions orchestration, not consumed by
  `make`. `build-wasm.yml` and `build-native.yml` are the enumeration source
  and the canonical make-target sequence M0 item 4 reproduces (in our own
  pinned container, not on GitHub Actions); they remain available in the
  commit-verified cache clone. `build-biber.yml` (biber is a v1 non-goal,
  DESIGN.md §3), `build-cosmo.yml` (cosmopolitan target, not the wasm/native
  artifact path) and `bench-native.yml` (benchmark harness) are alternate
  paths outside M0.
- `example/` (entire tree: `README.md`, `assets/*`, `*.sh`, `*.py`, `*.bat`,
  `*.bib`, `*.tex`, `example.html`, `fonts.conf`) — upstream example documents,
  example-runner/dist scripts, and the upstream demo page. WasmTeX's own demo
  is original work landing at M0 item 6; the runtime `fonts.conf` is generated
  by the `Makefile` at install time (`echo … > fonts.conf`), not read from
  `example/`.
- `busytexmk.py` — a latexmk-style driver referenced only by `bench-native.yml`;
  a runtime helper, not artifact build machinery.
- `log_file_access_dynamic.c` — a file-access tracing shim, referenced by no
  Makefile, script, or workflow at this commit.
- `build_arxiv.sh`, `build_arxiv.ps1`, `build_arxiv_strace.sh` — arXiv
  benchmarking helpers (bench path).
- `build_cosmo.sh` — cosmopolitan build driver (not the wasm/native path;
  unreferenced by the Makefile).
- `.gitignore` — upstream repo hygiene, not build machinery.
