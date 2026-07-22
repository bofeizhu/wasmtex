<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M0 item 4 — `make artifacts` build journal

One line per stage: target, wall time, outcome, and every failure -> fix with
the exact error snippet. Feeds `docs/LOG.md` and the annual-rebase archaeology.
Written as the build runs, not after.

## Design decisions (recorded before first build)

- **Offline strategy.** The upstream busytex `Makefile` (vendored, pristine at
  `build/upstream/busytex/`) downloads its sources via `curl`/`bsdtar`
  (`URL_texlive`, `URL_expat`, `URL_fontconfig`, and the TL 2023 ISO). We do
  **not** edit the vendored files. Instead the container runs with
  `--network none` and `build/artifacts/run-in-container.sh` pre-stages each
  source from the read-only cache into the exact path the Makefile's download
  rule produces — `source/<id>/` plus the `source/<id>.txt` sentinel — using the
  same extraction commands (`tar -xzf … --strip-components=1`; `bsdtar -x` for
  the ISO). A `.txt` sentinel with no prerequisites that already exists is
  up-to-date to make, so the `curl`/`bsdtar` recipes never fire. Any missed
  pre-stage fails loud (no network). **No patch files were needed** — pre-staging
  alone closes every acquisition path M0 uses; `build/patches/` stays empty.
- **Build tree location.** The vendored machinery is copied into a docker
  **named volume** (`wasmtex-m0-work`, VM-native ext4 — fast under Rosetta);
  `build/upstream/` stays pristine. Only `dist/` crosses the host bind mount.
- **Target order** mirrors upstream `.github/workflows/build-wasm.yml`, with the
  native pass built **from source** (`make native`, per `build-native.yml`)
  instead of the `download-native` prebuilt-binary shortcut (build/sources/
  README.md rationale). Order: prep -> native -> basic -> wasm -> bundle -> dist.
- **Reproducibility hooks.** `SOURCE_DATE_EPOCH=1781618797` (the busytex pin
  commit `f2bd7b11` date, 2026-06-16 16:06:37 +0200 == 1781618797; chosen as the
  single most build-defining pin). `FORCE_SOURCE_DATE=1` so the TeX engines
  stamp `.fmt` dumps with it. `TZ=UTC`, `umask 022`.
  `LC_ALL=C.UTF-8` — a deliberate micro-deviation from a literal `LC_ALL=C`:
  it is the locale the pinned image and upstream's CI runner already use, is
  equally deterministic, and avoids UTF-8 mishandling by `install-tl`/`find`
  over texmf trees. Item 5's double-build diff is the real determinism gate.
- **Parallelism.** `-j4` (container has 8 cores but 7.7 GiB RAM; heavy C++
  compiles — icu, luatex — under Rosetta risk OOM at `-j8`). Upstream uses
  `-j2`; the phony targets sequence their sub-makes on separate recipe lines,
  so `-j` only parallelizes within each leaf autotools make (repro-safe: archive
  members come from lexical globs; the bundle is packed over a fixed tree).

## Preflight (verified before building)

- Cache complete: ISO 4.77 GiB + texlive-source/expat/fontconfig tarballs, all
  at pinned paths. Image `wasmtex-toolchain:dev` == pinned
  `sha256:1b37eac1bc6f…b436dce6`. Container: emcc 3.1.43, bsdtar/perl/python3/
  gperf present, 8 cores, 7.7 GiB RAM. Docker VM disk 319 GiB free.
- ISO root (bsdtar) carries `install-tl`, `archive/*.tar.xz`
  (incl. `texlive-scripts.r66584`, `latexconfig.r53525`, `tex-ini-files.*`),
  `tlpkg/` — exactly what the `build/texlive-basic.txt` install-tl step reads.

## Stage log

| stage | target(s) | wall | outcome |
| --- | --- | --- | --- |
| prep | machinery copy + offline source staging + `build/versions.txt` | ~19 s | OK. Sentinels + trees staged: source/texlive 427M (configure OK), expat (CMake), fontconfig (configure OK), source/texmfrepo 4.8G from ISO (install-tl + tlpkg + 11524 archive pkgs; texlive-scripts/latexconfig/tex-ini-files present). No network hit. |
| native (attempt 1) | `make -j4 native` | ~15 min, FAILED | Jobserver breakage in the expat CMake sub-build — see below. `build/native/texlive.configured` (autotools) completed first, so reruns resume at the deps step. |
| native (attempt 2) | serial expat pre-build + `MAKEFLAGS=-j2 make native` | ~1 min, FAILED | Got past expat; then `zziplib`'s `cd ../zlib && make rebuild` hit the SAME jobserver error at -j2. Jobserver is broadly unreliable here, not expat-specific — see below. |
| native (attempt 3) | `MAKEFLAGS=-j1 make native` | ~33 min | OK. `build/native/busytex` = 43.5 MB static x86_64 ELF. Smoke: `busytex {xetex,pdftex,luahbtex,bibtex8} --version` all report TeX Live 2023 (XeTeX 0.999995, pdfTeX 1.40.25, LuaHBTeX 1.16.0, BibTeX8 0.99d). Two `Error 1 (ignored)` lines = the Makefile's `-cp *.c` self-copy for native libxetex/libpdftex (`-`-prefixed, benign). No jobserver errors at -j1. |
| basic | `make build/texlive-basic.txt` | ~2 min | OK. install-tl (offline repo) built the texlive-basic TDS + dumped formats via the native engines: `luahblatex.fmt` 11.9 MB, `pdflatex.fmt` 6.5 MB, `xelatex.fmt` 8.7 MB (retained set after upstream's prune). Building these formats requires the full latex macro tree, so the TDS is functional. `build/texlive-basic.tar.gz` also produced. |
| wasm | `make wasm` | abandoned | Stage was in flight when the native-first pivot landed (2026-07-22): the driver agent died in a session restart and the `wasmtex-m0-build` container was stopped and removed; partial results discarded (work volume `wasmtex-m0-work` retained). Container flow parked for M2. |

### native attempt 1 failure -> fix

Failed in `build/native/texlivedependencies` at the very first dependency,
`build/native/expat/libexpat.a` (a CMake build), with GNU Make's pipe jobserver
going bad inside the nested CMake makefiles:

```
[ 75%] Building C object CMakeFiles/expat.dir/lib/xmltok.c.o
make[5]: *** write jobserver: Bad file descriptor.  Stop.
make[4]: *** [CMakeFiles/Makefile2:83: CMakeFiles/expat.dir/all] Error 2
make[2]: *** [Makefile:301: build/native/expat/libexpat.a] Error 2
make[1]: *** [Makefile:497: build/native/texlivedependencies] Error 2
make:    *** [Makefile:532: native] Error 2
```

Cause (isolated by probe, not guessed): the failing step is the **CMake**-built
expat, and CMake's nested makefiles break GNU Make 4.3's anonymous-pipe
jobserver in this Docker-Desktop/Rosetta environment under **any** `-jN>1` —
NOT a cmdline-vs-env or N=2-vs-N=4 thing. Probes on the expat leaf target:

| invocation | result |
| --- | --- |
| `MAKEFLAGS=-j2 make …/expat/libexpat.a` (env, upstream-style) | FAIL — same `write jobserver: Bad file descriptor` |
| `make -j1 …/expat/libexpat.a` | OK — `libexpat.a` built |
| `MAKEFLAGS=-j2 make …/expat/libexpat.a` when already built | OK — "up to date" no-op, no CMake re-entry |

Crucially, attempt 1 got **through** `texlive.configured`, which itself runs a
big autotools `$(MAKE_native) -C build/native/texlive` at `-j4` — so autotools
recursive makes parallelize fine here; only CMake breaks. And expat is the
**only** CMake build in the whole busytex tree (`$(CMAKE_$*)` appears once, in
the `build/%/expat/libexpat.a` rule). (Upstream CI's identical `-j2` build
presumably degrades gracefully to `-j1` for expat on the GH runner rather than
erroring; the hard error here is environment-specific.)

First fix attempt — pre-build expat at `-j1`, then `MAKEFLAGS=-j2 make native` —
got PAST expat but failed at the next dependency, `zziplib`:

```
cd ./../../libs/zlib && make  rebuild
make[5]: *** write jobserver: Bad file descriptor.  Stop.
make[2]: *** [Makefile:288: build/native/texlive/libs/zziplib/libzzip.a] Error 2
make[1]: *** [Makefile:498: build/native/texlivedependencies] Error 2
```

So the jobserver breakage is NOT CMake-specific: zziplib is autotools, and its
`cd ../zlib && make rebuild` (a literal `make`, not `$(MAKE)`) also aborts. The
breakage is sub-make-dependent and would be whack-a-mole to chase leaf by leaf.

Final fix (no Makefile edit): **default `JOBS=1`** on this host. At `-j1` GNU
Make creates no jobserver at all, so no sub-make can hit the bad-fd error —
guaranteed safe, fully deterministic, and no more surprises mid-build. Removed
the now-insufficient `prebuild_expat_serial`. Cost is wall time (x86_64-emulated
`-j1` is slow — the M0.md "arm64 host" risk, resolved by a documented
host-specific parallelism decision rather than fighting the emulated jobserver).
`WASMTEX_JOBS` still overrides for a real x86_64 builder (CI), where upstream's
`-j2` is known good — the artifacts are host-arch-independent wasm, so CI
parallelism does not change outputs. Also `build.sh` now names the container and
drops `--rm` so a failed stage leaves logs for post-mortem, and
`docker wait <name>` gives a clean blocking completion signal for babysitting.
