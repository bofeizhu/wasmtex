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

# Native build (5N)

The native-first pivot (DESIGN.md §9 revision) drives the same vendored busytex
`Makefile` **raw on the arm64 macOS host**, offline from the verified cache. This
section is the 5N stage log. Driver: `build/artifacts/build-native.sh`; root
`make artifacts` delegates here (container flow parked as `make artifacts-container`).

## Design decisions (recorded before first native build)

- **Work tree, out of tree.** `~/.cache/wasmtex/build/native/busytex` (override
  `WASMTEX_WORK_DIR`), a sibling of the fetch.sh source cache and the toolchain
  cache. Keeps the multi-GB TL source tree + 4.8 GB texmfrepo staging off the
  repo volume; only `dist/` (git-ignored) lands in the repo. `build/upstream/`
  stays pristine — the vendored machinery is COPIED into the work tree and
  `make` runs there (same discipline as the parked container flow).
- **Offline pre-staging** mirrors `run-in-container.sh`: each source is extracted
  from the cached tarball into `source/<id>/` with the `source/<id>.txt` sentinel
  the Makefile's `curl | tar` rule would have produced (a no-prereq sentinel that
  already exists is up-to-date, so the download recipe never fires); `texmfrepo`
  is unpacked from the frozen ISO with macOS `bsdtar -x` (reads ISO9660 directly).
- **Repro hygiene** identical to the container flow: `SOURCE_DATE_EPOCH=1781618797`
  (busytex pin commit date), `FORCE_SOURCE_DATE=1`, `TZ=UTC`, `LC_ALL=LANG=C.UTF-8`
  (native-env.sh already sets TZ/LC_ALL), `umask 022`.
- **Real parallelism.** Native arm64 GNU Make 4.4.1 — the jobserver works here
  (the `-j1` constraint was Rosetta-only). Default `-j$(sysctl -n hw.ncpu)` = 8
  via `MAKEFLAGS`, override `WASMTEX_JOBS`.
- **macOS incompatibilities → make-variable overrides (no vendored-file patches
  needed for the native pass).** Static analysis + host probes found four; each is
  a `_native`-scoped (or native-only-tool) variable, overridden on the `make`
  command line (which propagates to every recursive sub-make via MAKEOVERRIDES),
  so the wasm/basic/bundle sub-builds are untouched:
  - `NM_native=true` — the `busytexapplets` rule (Makefile:515) runs
    `$(NM_native) -D …libkpathsea.a` inside an `&&` chain; macOS `nm` (llvm-nm)
    **errors** on `-D` (`File format has no dynamic symbol table`), failing the
    recipe. `NM_native` is otherwise only diagnostic (echo BEFORENM/AFTERNM), so
    `true -D <path>` → exit 0 neutralises it with zero artifact impact.
  - `CMAKE_native=cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5` — expat 2.5.0 declares
    `cmake_minimum_required(VERSION 3.1.3)`; Homebrew cmake 4.4.0 removed
    compatibility with `< 3.5` (fatal error). The policy floor is the documented
    escape hatch (native-host.md §5 preferred remedy). expat is the ONLY CMake
    build in the tree, so this is the whole cmake-4 exposure.
  - `LDFLAGS_TEXLIVE_native=-lm -pthread` — upstream value is
    `--static -static -static-libstdc++ -static-libgcc -ldl -lm -pthread -lpthread -lc -Wl,--unresolved-symbols=ignore-all`;
    every Linux-only token breaks macOS (no static libSystem; no `-ldl`/separate
    `-lpthread`; Apple ld rejects `--unresolved-symbols`). Reduced to the portable
    core. Deliberately NO `-undefined,dynamic_lookup` here — this LDFLAGS also
    drives `configure`'s link probes, which must stay honest.
  - `OPTS_BUSYTEX_LINK_native=-lm -pthread -Wl,-undefined,dynamic_lookup` — the
    final multicall link (Makefile:374) legitimately has undefined symbols by
    design (the busytex nulling/redefine trick); `-Wl,-undefined,dynamic_lookup`
    is the Apple-ld equivalent of GNU `--unresolved-symbols=ignore-all` (probed:
    links and runs). The plain `busytex` link (unlike `busytexextra`, which we do
    NOT build) has no duplicate-definition need, so no allow-multiple-definition
    analogue is required.
  Off the artifact path, confirmed no-ops: `OBJCOPY_native` (never invoked;
  wasm stubs it to `echo`), `LDD_native` (only in `-`-prefixed `smoke-native`).

## Native stage log

| stage | target(s) | wall | outcome |
| --- | --- | --- | --- |
| prep | machinery copy + offline source staging + `build/versions.txt` | ~12 s | OK. ISO extraction (source/texmfrepo 4.8 G, 11524 archive pkgs, install-tl + tlpkg present) + texlive/expat/fontconfig tarballs staged offline from cache; sentinels written. macOS `bsdtar` + APFS extracted the ISO fast. No network. |
| native (attempt 1) | `make -j8 native` | ~15 min, FAILED | `texlive.configured` (TL core + helper tools) OK; `texlivedependencies`: expat OK (cmake policy override worked), zziplib OK, then **libpng FAILED** on macOS — `<fp.h>` not found. Fix below; not killed by harness, a real source incompat. |
| (interruption) | — | ~20 min gap | The driving agent's monitor-wait failed (4th such failure this project; monitors abandoned for in-turn polling thereafter): attempt 1's make had already exited with the libpng error at ~19:30 but sat unobserved until the main session resumed the agent at 19:33. No build state lost — make resumes incrementally. |
| native (attempt 2) | `make -j8 native` (resume, libpng patched) | ~2 min, FAILED | libpng OK, libpaper OK, then **zlib FAILED** — `fdopen(fd,mode) NULL` macro clobbers the system `<stdio.h>` prototype. Same `TARGET_OS_MAC` root cause. Fix below. |
| native (attempt 3) | `make -j8 native` (resume, zlib patched) | ~20 min | **OK** — full native build: all deps (incl. icu, fontconfig-on-darwin — no darwin fontconfig issue materialised), busytexapplets, and `build/native/busytex` (36.5 MB Mach-O arm64) linked. First link crashed at load (`NSFontManager` not found); fixed by linking Apple frameworks (below). After relink: `busytex {xetex,pdftex,luahbtex,bibtex8,xdvipdfmx} --version` all report TeX Live 2023. Helper tools for the wasm pass (ctangle/otangle/tangle/web2c/fixwrites/makecpool/splitup, icupkg, pkgdata, apinames) all present. |
| basic | `make build/texlive-basic.txt` | ~6 min | **OK** — install-tl (offline repo, `--custom-bin` our native busytex wrappers) built the `texlive-basic` TDS and dumped/pruned formats via the native engines on macOS with no changes. Retained (full set): `xelatex.fmt` 8.7M, `pdflatex.fmt` 6.5M, `luahblatex.fmt` 11.9M, `dvilualatex.fmt` 4.6M, `dviluatex.fmt` 1.2M, `luatex.fmt` 1.2M, `optex.fmt` 0.7M, `tex.fmt` 0.3M — sizes match the container baseline. `build/texlive-basic.tar.gz` also produced. |
| wasm | `make -j8 wasm` | ~29 min | **OK** — `build/wasm/busytex.wasm` 28.9 MB + `busytex.js` 349 KB. No source changes needed (the libpng/zlib patches are shared source; under emcc `TARGET_OS_MAC` is undefined so they are no-ops for wasm; `CMAKE_wasm` carries the same expat policy floor). Darwin-host libtool probes `-single_module`/`-force_load` (unsupported by wasm-ld) fail gracefully in configure and are never used (static-only build). Final link's undefined-symbol warnings (TECkit_*, zzip_*) are upstream-normal (`-sERROR_ON_UNDEFINED_SYMBOLS=0`, the multicall nulling). |
| bundle | `make build/wasm/texlive-basic.js` | ~1 min | **OK** — `file_packager` (system python3, no import issue) packed the `texlive-basic` TDS: `texlive-basic.data` 79.5 MB (LZ4 125 MB→79.5 MB) + `texlive-basic.js` 1.7 MB (with `ProvidesPackage` index prepended). |
| dist | `build-native.sh dist` | ~10 s | **OK** — assembled `dist/`: `busytex.{js,wasm}`, `busytex_{pipeline,worker}.js` (byte-identical to vendored MIT glue), `texlive-basic.{js,data}`, `formats/*.fmt` (all 8: xelatex, pdflatex, luahblatex, dvilualatex, dviluatex, luatex, optex, tex), `SHA256SUMS` (sorted, via macOS `shasum -a 256`). `dist/` git-ignored. Note for M2's three-way hash check: the native flow adds `CMAKE_POLICY_VERSION_MINIMUM=3.5` to `CMAKE_wasm` (cmake 4.x here vs the container's 3.x without it) — configure-behavior only, but the first suspect if expat-derived wasm objects diverge. |
| **`make artifacts` STAGE=all** | end-to-end via root Makefile | ~1 min | **OK (ALL_EXIT=0)** — full pipeline through the real entry point on the already-built tree: patches idempotently skipped, **zero recompilation** (all cached), `dist/` reassembled identically. Proves Makefile → `build-native.sh` → prep/native/basic/wasm/bundle/dist chaining. |

## Native build (5N): COMPLETE

`make artifacts` produces the M0 faithful-baseline artifacts natively on arm64
macOS. `dist/` (139 MB): `busytex.wasm` (28.9 MB, valid WebAssembly MVP) +
`busytex.js` (349 KB); `busytex_pipeline.js` + `busytex_worker.js` (vendored MIT,
byte-identical); `texlive-basic.js` (1.7 MB) + `texlive-basic.data` (79.5 MB);
`formats/` = xelatex.fmt 8.7M, pdflatex.fmt 6.5M, luahblatex.fmt 11.9M (+ luatex
variants + tex.fmt); `SHA256SUMS`.

Net changes vs the parked container flow: **2 make-variable overrides became 4**
(`NM_native`, `CMAKE_native`/`CMAKE_wasm` policy floor, `LDFLAGS_TEXLIVE_native`,
`OPTS_BUSYTEX_LINK_native` incl. the 5 Apple frameworks) and **2 source patches**
(`build/patches/libpng-macos-fp-h`, `build/patches/zlib-macos-fdopen` — both the
`TARGET_OS_MAC` classic-Mac false-positive, both upstream-able, applied
idempotently to the work copy in prep; `build/upstream/` untouched). Everything
else (offline pre-staging, target order, repro hygiene) mirrors the container
flow. The container flow's predicted risks that did NOT materialise: darwin
fontconfig-from-source built cleanly; ICU built cleanly; the only cmake-4 exposure
was expat (policy floor handled it). Reproducibility double-build remains deferred
to M2 (DESIGN.md §9); this native path is development-only.

### native attempt 1 failure -> fix (libpng `<fp.h>`)

libpng 1.6.39 failed compiling every TU:

```
source/texlive/libs/libpng/libpng-src/pngpriv.h:524:16: fatal error: 'fp.h' file not found
  524 | #      include <fp.h>
make[5]: *** [Makefile:855: libpng-src/pngrio.o] Error 1
...
make: *** [Makefile:532: native] Error 2
```

Cause (probed, not guessed): pngpriv.h:517-518 selects the classic Mac OS
`<fp.h>` header when `TARGET_OS_MAC` is defined. On a modern macOS SDK
`TARGET_OS_MAC` is `1` on *every* Apple platform and is pulled in transitively by
system headers libpng includes before this point (verified: `#include <stdlib.h>`
alone → `TARGET_OS_MAC 1`). It is a false signal for pre-OSX Carbon, where
`<fp.h>` lived; the header does not exist on modern macOS. Upstream busytex builds
on Linux, where none of the guard macros are defined and the `#else` (`<math.h>`)
branch is taken, so the bug is invisible there. No Makefile/CFLAGS knob redirects
this (the libpng build has no per-lib CFLAGS injection point), so it is a genuine
source-level fix → **patch** (not a make-variable override).

Fix: `build/patches/libpng-macos-fp-h/` (patch + HEADER.md) removes
`|| defined(TARGET_OS_MAC)` from the guard, so Apple clang takes the `<math.h>`
branch. Applied to the staged work copy at build time by
`build-native.sh do_prep → apply_macos_patches` (idempotent: skips if the patch
already reverses cleanly; `build/upstream/` never touched). Verified: the patch
applies `-p1` cleanly to a fresh pristine extraction, and rebuilding the libpng
target alone produced `libpng.a` (304920 bytes). Upstream-able (HEADER.md).

### native attempt 2 failure -> fix (zlib `fdopen`)

```
zutil.h:147:33: note: expanded from macro 'fdopen'
  147 | #        define fdopen(fd,mode) NULL /* No fdopen() */
_stdio.h:322:7: note: to match this '('
4 warnings and 3 errors generated.  ->  make: *** [native] Error 2
```

Same `TARGET_OS_MAC` false-positive class as libpng. `libs/zlib/zlib-src/zutil.h:140`
`#if defined(MACOS) || defined(TARGET_OS_MAC)` stubs `#define fdopen(fd,mode) NULL`
(assuming pre-OSX Mac has no `fdopen`), which then mangles the system `<stdio.h>`
`fdopen` prototype the full (non-`Z_SOLO`) zlib build also pulls in.

Preemptive recon (`grep -rl TARGET_OS_MAC` over the TL tree) enumerated every
occurrence so they weren't discovered one slow build at a time: libpng (fixed),
zlib (this), freetype's *bundled* gzip zutil.h (identical block but compiled
`Z_SOLO`, which guards out the stub + stdio — **safe, no patch**), freetype
`mac-support.h` and ICU `platform.h` (both use `TARGET_OS_MAC` **correctly** for
genuine macOS support — left intact). Only standalone zlib needed the fix.

Fix: `build/patches/zlib-macos-fdopen/` removes `|| defined(TARGET_OS_MAC)` from
zutil.h:140 → Unix default (`OS_CODE 3`, `fdopen` untouched). Verified: patch
applies `-p1` to pristine; `libz.a` (104472 bytes) rebuilt. Upstream-able.

### native attempt 3 fix (XeTeX macOS font backend — link, not source)

The native link succeeded but the binary crashed at **load**:

```
dyld[]: symbol not found in flat namespace '_OBJC_CLASS_$_NSFontManager'
```

On darwin, TL's configure compiles XeTeX's native CoreText/AppKit font backend
(`xetexdir/XeTeXFontMgr_Mac.mm`) instead of the fontconfig backend used on Linux.
That object references CoreFoundation/CoreGraphics/CoreText + AppKit
`NSFontManager` (402 undefined symbols; `nm -u` + the `.deps/…XeTeXFontMgr_Mac.Po`
confirm the source). `-Wl,-undefined,dynamic_lookup` let them link, but the ObjC
class ref binds eagerly at load and dyld can't find it → the binary won't even
start. This is exactly the backend a normal MacTeX xetex uses; it just needs the
Apple frameworks linked, which busytex's Linux-oriented `OPTS_BUSYTEX_LINK`
omits.

Fix (make-variable override, not a patch): append
`-framework CoreFoundation -framework CoreGraphics -framework CoreText -framework Foundation -framework AppKit`
to `OPTS_BUSYTEX_LINK_native`. Relinked (`rm build/native/busytex{,.o}` →
`make build/native/busytex`); the binary now loads and all engines report their
versions. The native busytex is a build-host-only tool (helper tools + install-tl
format dumping); the shipped **wasm** engine uses its own fontconfig backend
(emcc never compiles the Mac backend), so the font backend divergence does not
reach the artifact. `.fmt` dumps are font-backend-independent. Benign link
warnings only (duplicate-library de-dup; `__common` alignment reduced 0x8000→0x4000).

## 6N demo notes

Item 6N (`demo/` + Playwright hello-world PDF proof) is the first time the
item-5N **wasm** is actually *executed*. It documents the vendored-glue contract
that M1's own runtime replaces, and — critically — it caught a latent 5N build
defect that `WebAssembly.validate` + size checks could not.

### Glue API contract (drives `dist/busytex_worker.js`; needed by M1)

The demo drives the vendored worker/pipeline glue via its own `postMessage`
protocol (learned from the vendored source + upstream busytex's MIT
`example/example.html`; no GPL/AGPL wrapper opened). Two message shapes:

- **init** — `{ busytex_js, busytex_wasm, preload_data_packages_js,
  data_packages_js, texmf_local }`. The worker branches on
  `busytex_wasm && busytex_js && preload_data_packages_js` being truthy and
  constructs `BusytexPipeline`. Replies: `{ print }` log lines (many), then
  `{ initialized: appletVersions }` once ready. `preload` omitted ⇒ `undefined`
  ⇒ `preload !== false` ⇒ preloads. `verbose`/`driver` are *not* read at init.
- **compile** — `{ files:[{path,contents}], main_tex_path, bibtex, verbose,
  driver, data_packages_js }`. Reply: `{ pdf: Uint8Array|null, log: string,
  exit_code: number, logs: [...] }`. `bibtex:false` (no `\bibliography`) selects
  the 2-step `xetex → xdvipdfmx` sequence; `data_packages_js:null` = auto-resolve.
  Exceptions arrive as `{ exception: string }`.

**Asset-path contract (M1 must honour):** the worker resolves `busytex_js`
(via `importScripts`), `busytex_wasm` (via `fetch`+`compileStreaming`), and each
data-package `.js` — *and its `.data` sibling* — **relative to the worker's own
URL**, not the page. The emscripten data-package loader falls back to
`REMOTE_PACKAGE_BASE='texlive-basic.data'` (busytex.js/texlive-basic.js line
~398) unless `Module.locateFile` is set, which it isn't. We serve the **repo
root** on one origin and pass **absolute `/dist/...`** paths, so `/dist/…js`,
`/dist/busytex.wasm`, `/dist/texlive-basic.data` all resolve regardless of where
the page lives. `busytex.wasm` **requires `Content-Type: application/wasm`**
(compileStreaming) — `demo/serve.mjs`'s MIME map is load-bearing. Classic worker
(`importScripts`), no SharedArrayBuffer / COOP-COEP (matches DESIGN §10).

**Init quirk (bites M1):** when preloading, the ctor's init path runs
`report_applet_versions` — it invokes **every applet with `--version`**
(pipeline.js:442-445). `compile()` then does `await this.Module`, so **any init
failure surfaces as an "Exception during compilation"**, masking its true origin.
The upstream source even flags it (`// TODO: exception here not caught?`).

### Artifact defect found by 6N — item-5N wasm is functionally hollow (DEFERRED to 5N; RESOLVED — see "5N reopened" below)

The hello-world compile **aborts**, not in TeX but in the pipeline's init-time
`xdvipdfmx --version` probe: `RuntimeError: Aborted(-1)` at
`_png_get_header_ver` (busytex.js:8642), an emscripten *missing-function stub*
(`err('missing function: png_get_header_ver'); abort(-1)`).

Root cause (confirmed against `dist/busytex.wasm` + the 5N work tree):

- `WebAssembly.Module.imports(busytex.wasm)` = **363 unresolved `env` imports**:
  harfbuzz ×147, libpng ×38, graphite2 ×22, zziplib ×13, zlib
  (deflate/inflate/gz/crc32/adler32), TECkit ×3, poppler C++ (`_ZN…`) ×27,
  libpaper — i.e. **every third-party C/C++ dependency library**.
- In the 5N work tree (`~/.cache/wasmtex/build/native/busytex/build/wasm/`), the
  per-library **objects compiled fine** (zlib 15 `.o`, libpng 15, harfbuzz 58,
  graphite2 29, zziplib 9, teckit 4, libpaper 2) but the **archives are empty
  96-byte BSD `ar` files** (`__.SYMDEF SORTED`, zero members):
  `libharfbuzz.a`, `libgraphite2.a`, `libTECkit.a`, `libpng.a`, `libz.a`,
  `libzzip.a`, `libpaper.a`. freetype (4 MB), pplib (254 KB), icu (2.5 MB) built
  real — those go through a different (working) archive path.
- The archive step is `Makefile:287-288` (`$(MAKE_$*) -C <libdir>`, delegating to
  each library's TeX-Live-generated Makefile). On macOS the objects were *not*
  archived into the `.a`. The final multicall link (`Makefile:371-374`) carries
  `-Wl,--unresolved-symbols=ignore-all -sERROR_ON_UNDEFINED_SYMBOLS=0`, so the
  empty archives passed **silently** and emscripten stubbed all 363 symbols to
  `abort(-1)`. `WebAssembly.validate` is true for such a binary, and 5N never
  ran an engine — so the defect slipped 5N's acceptance and surfaced only here.

**Impact:** the current `dist/` wasm cannot compile anything (XeTeX needs
harfbuzz; xdvipdfmx needs libpng/zlib/poppler; even `--version` touches libpng).
No demo-side workaround exists (the abort is inside the vendored glue's
unconditional init probe, and a real xdvipdfmx run needs zlib anyway).

**Ownership:** this is an **item-5N build defect**, out of 6N scope (6N must not
modify `dist/` or vendored files). The `.o` files already exist, so the fix is
likely a targeted archive-rule correction + relink rather than a full rebuild —
but it belongs to the build milestone, and 5N/M2 must add an **execution** check
(engine actually emits a PDF) so a hollow-but-valid binary can never pass again.

**6N deliverables stand:** `demo/` (page + `serve.mjs`), the Playwright smoke,
and the guarded CI job are complete and correct. The smoke is deliberately kept
**strict** (asserts a real `%PDF-…%%EOF` > 1 KB) and therefore RED against the
hollow artifact — it did its job as the M0 compile-to-PDF gate. It goes green
unchanged once 5N produces a correctly-linked wasm. Everything up to the engine
abort is proven working: page load, classic worker, `application/wasm` streaming
instantiation, 79 MB `.data` fetch, package resolution, and the compile
invocation (screenshot in the 6N run shows the full log through `Running…`).

## Native build (5N) REOPENED (2026-07-22): empty wasm archives → fixed + execution gate

6N's first-ever *execution* of `dist/busytex.wasm` exposed the hollow-archive
defect (diagnosed in "6N demo notes" above). This section is the fix: the exact
mechanism (reproduced on real objects), the one-variable remedy, the new
execution gate, and the green rebuild.

### Root-cause mechanism (reproduced, not guessed)

The wasm archive rule (vendored Makefile:287-288) delegates to each library's
configure-generated Makefile: `$(MAKE_$*) -C $(dir $@) … $(OPTS_LIBS_$*)`.
Upstream defines **`OPTS_LIBS_native = AR=$(AR_native)`** (Makefile:206) with the
comment *"Some of the libraries in libs/ don't use `libtool`, which leads to `AR`
being hardcoded to `ar`. … Force everyone to respect proper `AR`."* — but there
is **no `OPTS_LIBS_wasm`**. So the wasm archive sub-make passes nothing to
override the library Makefile's hardcoded `AR = ar` (e.g. libpng Makefile:118),
and `emmake`'s exported `AR=emar` (environment) loses to that Makefile assignment.

- On **Linux** (upstream's host) `ar` = GNU ar, format-agnostic — it archives the
  emscripten wasm/LLVM objects fine, so the missing `OPTS_LIBS_wasm` is invisible
  upstream.
- On **macOS** `/usr/bin/ar` is BSD ar (cctools). Reproduced verbatim on libpng's
  actual staged wasm objects (`build/wasm/texlive/libs/libpng/libpng-src/*.o`,
  which `file(1)` reports as `WebAssembly (wasm) binary module`):
  ```
  $ /usr/bin/ar cru host.a *.o
  ranlib: warning: archive member 'png.o' not a mach-o file      # …×15, exit 0
  $ ls -l host.a  → 96 bytes ;  ar t host.a → __.SYMDEF SORTED   (zero members)
  ```
  BSD `ar` auto-ranlibs and **silently drops every non-Mach-O member** (a mere
  warning, **exit 0**), leaving a 96-byte archive of just the symbol table. The
  final link's `-Wl,--unresolved-symbols=ignore-all -sERROR_ON_UNDEFINED_SYMBOLS=0`
  then stubbed all now-missing dependency symbols to `abort(-1)` → 363 unresolved
  `env` imports → the runtime abort at `_png_get_header_ver`.

Contrast, same objects with the correct archiver: `emar cru emar.a *.o` → 210476
bytes, 15 members, `png_get_header_ver` present (`T`, in the armap). The fix was
proven at the unit before any build change.

**Why only 8 of the libs went hollow** (evidence: `grep '^AR = ' <lib>/Makefile`):

| through Makefile:287-288 | archiver | libtool? | result |
| --- | --- | --- | --- |
| libpng, zlib, harfbuzz, graphite2, teckit, xpdf, libpaper, zziplib | `AR = ar` (host BSD) | no | **96-byte empty** |
| pplib | `AR = …/emscripten/emar` | yes | real (254 KB) |

Exactly upstream's stated split: the non-libtool libs hardcode `ar`; the libtool
libs (pplib via libtool; kpathsea/lua53 via the `.libs/` rule; freetype via its
configure-honored AR; icu via its own build) had
`emar` detected by configure and were already sound. (The "6N notes" listed xpdf
as building real; re-measurement shows xpdf too was 96-byte empty — it is a
non-libtool `AR = ar` lib. It contributed the 27 poppler `_ZN…` stubs.)

### The fix — make-variable override (not a patch)

Added **`OPTS_LIBS_wasm=AR=emar`** to `build-native.sh`'s `macos_overrides` (the
wasm twin of upstream's `OPTS_LIBS_native`). Passed on the top `make` command line
it propagates to Makefile:288's `$(OPTS_LIBS_wasm)`, placing `AR=emar` on each
library sub-make's *command line* — which beats the Makefile's `AR = ar`. Chosen
as an **override, not a `build/patches/` entry**, because (a) it is build
orchestration, not a source incompatibility in a vendored file (unlike the
libpng/zlib `TARGET_OS_MAC` patches); (b) it exactly mirrors an existing upstream
variable; and (c) it keeps `build/upstream/` pristine — the task's preferred
mechanism. Upstream-able as a one-line `OPTS_LIBS_wasm = AR=$(AR_wasm)` in the
Makefile. Native/basic/bundle stages are untouched (they reference
`$(OPTS_LIBS_native)`; `OPTS_LIBS_wasm` is inert there). Overrides: **4 → 5**.

### NEW execution gate (required by the reopened item)

`build/artifacts/verify-engine.mjs` (original node harness) + `do_verify()` in
build-native.sh, run at the end of the `dist` stage (and standalone as a new
`verify` stage). Two assertions, each fails the build loud (non-zero exit →
`set -e` aborts):
1. **env-import sanity** — `WebAssembly.Module.imports` `env` count ≤ 150 (a
   constant). Cheap, and catches this exact class directly (hollow = 363; sound =
   76). Prints the live count every run.
2. **real execution** — loads the `-sMODULARIZE=1 -sEXPORT_NAME=busytex
   -sINVOKE_RUN=0` engine under node and `callMain(['xetex','--version'])`,
   asserting exit 0 and a `TeX Live 2023` banner. `WebAssembly.validate` + a size
   check were both true for the hollow artifact — only *running* it tells sound
   from hollow.
De-risked before the long build: run against the OLD dist it correctly FAILED at
check 1 (363 > 150, with a harfbuzz/zlib import sample); against the rebuilt dist
it PASSED both.

### Rebuild (incremental) + results

Removed the 9 stale empty archives (teckit ships 2: `libTECkit.a` +
`libTECkit_Compiler.a`) and `build/wasm/busytex.{js,wasm,o,tar}` to force the redo
(the `.a` targets are timestamp-gated and the `busytex.js` rule has no prereqs);
the compiled `.o` were left untouched. `make artifacts STAGE=wasm` = **36.8 s**
(re-archives the 8 libs via `emar cru … && emranlib`, relinks); `make artifacts
STAGE=dist` re-assembled `dist/` and the gate PASSED.

- **env imports: 363 → 76**, all legitimate emscripten helpers (`__syscall_*`,
  `invoke_*`, `emscripten_*`, `_*_js`, luasocket net shims) — **zero**
  library-symbol stubs (no `hb_*`/`png_*`/`gz*`/`TECkit_*`/`zzip_*`/`_ZN`).
- Archives now real: harfbuzz 3.57 MB/58 members, libxpdf 1.64 MB/56, libpng
  210 KB/15, zlib 82 KB/15, graphite2 192 KB/29, TECkit 195 KB/1, zziplib 21 KB/9,
  libpaper 8 KB/2.
- Engine: `busytex.wasm` = 30,366,631 B (larger than the hollow build, which
  omitted the dependency code); `busytex.js` = 295,606 B.
- `dist/` delta: **only** `busytex.wasm` (`b919244c…` → `cf0298e1…`) and
  `busytex.js` (`fbd87dff…` → `f381d9ba…`) changed; the data bundle, all 8 `.fmt`,
  and the vendored `busytex_{pipeline,worker}.js` are byte-identical.
- Gate proof — `xetex --version` self-reports *Compiled with zlib 1.2.13 /
  Graphite2 1.3.14 / HarfBuzz 7.0.1 / libpng 1.6.39 / ICU 72.1 / FreeType 2.13.0 /
  fontconfig 2.13.96* (the very libraries that had linked empty), exit 0.

### 6N smoke — GREEN

`cd demo && npm test` → **1 passed (3.4 s)**; compile 2385 ms,
`exitCode=0 ok=true size=12487B`. All gating assertions pass: no uncaught page
errors, no console errors, `ok === true`, `exitCode === 0`, PDF bytes present,
**> 1 KB**, `%PDF-` header, `%%EOF` trailer. Captured PDF ≈ 12.49 KB (`file`:
*PDF document, version 1.5 (zip deflate encoded)*, 18 objects; sha256
`57f9d1c13d1ffb3413b614589112951875354f8679144cbc16b44f2255e98bfb` for that
instance — exact bytes vary run-to-run because xdvipdfmx stamps a runtime
`/CreationDate`+`/ID`, `SOURCE_DATE_EPOCH` not being present in the browser ENV;
byte-determinism is the M2 double-build gate). The informational text/provenance
probes are `false` as expected (content streams are deflate-compressed). The
`_png_get_header_ver` abort is gone.

**Deferred / not touched:** byte-level PDF determinism (M2). `docs/LOG.md`,
`README.md`, `DESIGN.md`, `NOTICE` left strictly alone (uncommitted user edits).
No commit — the orchestrating session reviews and commits.
