<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M3 — Build logistics & CI: build journal

Durable engineering record for the build-logistics milestone. One section per
work item, written as the work runs. Records every decision, verification,
failure → fix and standing note so a future maintainer can replay it. Feeds
`docs/LOG.md` (the terse milestone record); this is the long-form companion.

Provenance discipline (DESIGN.md §2): research here is confined to Docker Hub /
`emscripten-core/emsdk` (MIT) / Ubuntu channels. No GPL/AGPL WASM-TeX wrapper
source was opened; encounters (none this item) are noted so the audit trail
shows avoidance.

---

## Item 3 — arm64 canonical-builder container

Dated 2026-07-23. Goal: re-pin `build/toolchain/` as the canonical **arm64**
Linux builder (DESIGN.md §9 amendment), built natively on the Apple-Silicon
host (no Rosetta), with a lean prerequisite set derived from the current
`build/engines` needs; keep the amd64 image as the equivalence lane; smoke it;
pin the built image ID additively in `pins.lock`.

Host: Docker Desktop 4.82.0, engine `linux/arm64` (aarch64, native — the daemon
`Architecture: aarch64`). `uname -m` on the host = `arm64`.

### Decision 1 — arch parameterization: ONE parameterized Dockerfile

**Chosen:** a single `Dockerfile` that `FROM`s the ubuntu:22.04 **multi-arch
manifest-list (INDEX) digest**; the build's `--platform` (from `build-image.sh`,
default `linux/arm64`) selects the per-arch base. `build-image.sh <arch>` varies
only `--platform` and the tag (`wasmtex-toolchain:<arch>-dev`).

**Rejected:** a sibling `Dockerfile.arm64`. Two pinned images must coexist (arm64
canonical + amd64 equivalence lane) and they must stay **identical except for
architecture** — that is the whole premise of the three-way equivalence check.
Two files would drift (prereqs, emsdk steps, ENV); one parameterized file makes
"differs only in `--platform`" a structural guarantee, not a review burden.

**Why the INDEX digest rather than a per-arch `TARGETARCH`→platform-digest map
in the Dockerfile:** Dockerfile `FROM` cannot do nested-ARG indirection
(`${UBUNTU_DIGEST_${TARGETARCH}}`), so a per-arch-digest scheme would have to
push the arch→digest mapping into `build-image.sh` anyway. The index digest is
strictly cleaner: it is arch-agnostic and, being a content-addressed Merkle
index, **cryptographically commits to each per-arch manifest digest** — so
pinning the index + `--platform` is a *complete, reproducible* pin for both
images from one line. The per-arch platform digests are recorded in `pins.lock`
(and the Dockerfile header) for audit/cross-reference.

Bonus: removing the M0 hardcoded `FROM --platform=linux/amd64` (a deliberate
constant, needed when amd64 was mandatory) eliminates the BuildKit
`FromPlatformFlagConstDisallowed` lint the M0 image tripped.

### Decision 2 — base image: ubuntu:22.04 (not 24.04)

**Chosen:** 22.04, deliberately, for the *canonical* builder. Two reasons:

1. **Era-consistency with emsdk 3.1.43** (mid-2023). The pinned emsdk downloads
   prebuilt LLVM/clang + node built against the glibc of that era; 22.04
   (glibc 2.35) is contemporaneous, 24.04 (glibc 2.39) is not.
2. **Clean equivalence lane (decisive).** The amd64 lane is 22.04. Pinning the
   arm64 canonical to 22.04 too means the three-way hash check
   {arm64 macOS / arm64 22.04 container / amd64 22.04 container} differs in
   **architecture alone** — any divergence is cleanly attributable. 24.04 on the
   arm64 lane only would confound arch with a userland-version delta
   (glibc/gcc/autotools/sed), defeating the experiment.

Bonus: apt `cmake` on 22.04 is 3.22 (< 4), so the native-host cmake-4 policy
workaround (`-DCMAKE_POLICY_VERSION_MINIMUM=3.5`, a Homebrew-cmake-4 artifact)
is **not needed** in the container — the expat build's old
`cmake_minimum_required` is honoured as-is.

Digests (from the pinned index `sha256:0e0a0fc6…8982`, resolved with
`docker manifest inspect`):

| platform | digest |
| --- | --- |
| linux/arm64/v8 (canonical base) | `sha256:ecd3706b6b5587d1318e1777359b8563f9db6e8e5a81841f04dc3c7edbefbdc1` |
| linux/amd64 (equivalence lane) | `sha256:0d779ea9…973c8` (matches the M0 `[toolchain-image]` pin — confirms the index) |

### Decision 3 (the plan's risk) — emsdk 3.1.43 linux-arm64 prebuilt: PRESENT

The M3 plan flagged: *"emsdk linux-arm64 at 3.1.43 assumed available; if the
prebuilt is missing, the M2 rule applies — minimum exact bump, pinned
everywhere, journaled."* Investigated in three steps:

1. **Alarm.** `emscripten-releases-tags.json` at the pinned emsdk commit
   `d9c66fa2` carries `"latest-arm64-linux": "3.1.33"`, and `emsdk.py`
   (line ~3059) prints *"arm64-linux binaries are not available for all
   releases"* for any explicit version on arm64-linux. Read naively, this says
   "no arm64 build past 3.1.33" — i.e. 3.1.43 arm64 would be missing.
2. **Empirical check (decisive).** The `latest-arm64-linux` alias is only the
   conservative default emsdk substitutes for `install latest` on arm64-linux
   (`emsdk.py` line ~2023); it does **not** mean specific higher versions lack a
   build. Probed the actual GCS object for 3.1.43's release hash
   (`bf3c159888633d232c0507f4c76cc156a43c32dc`) with a 1-byte range request:

   ```
   linux/bf3c159…/wasm-binaries-arm64.tbz2  -> HTTP 206, size 242,978,805 B
   linux/bf3c159…/wasm-binaries.tbz2 (x64)  -> HTTP 206, size 338,938,722 B
   ```

   The linux-arm64 prebuilt for **3.1.43 exists** (~232 MB, real body).
3. **Build proof.** Building the image, emsdk detected `aarch64` and downloaded
   `node-v16.20.0-linux-arm64.tar.xz` (21,997,996 B) **and**
   `bf3c159…-wasm-binaries-arm64.tbz2` (242,978,805 B), then activated cleanly.
   The "not available for all releases" warning printed and was harmless.

**Outcome: the risk did NOT materialize. No version bump.** The same emsdk pin
(`3.1.43` / commit `d9c66fa2…`, emscripten-releases `bf3c159…`) holds across all
three lanes — native darwin-arm64, canonical linux-arm64, parked linux-amd64 —
differing only in platform binaries. `emsdk_release = bf3c159…` is recorded in
`[toolchain-image-arm64]` so the arm64-prebuilt provenance is explicit.

### Decision 4 — prerequisite shrink: 20 → 10 packages

Enumerated from what the config **actually invokes** (`build/engines/Makefile`
recipes + the `build/artifacts` driver), by token grep, not the M0 busytex-CI
mirror. The M0 set mirrored the upstream GH `ubuntu-22.04` runner + CI's named
extras; the trimmed engine config (no LuaTeX, no bench/ubuntu/example paths —
M2 item 3) invokes far less.

**Kept (10):**

| pkg | invoked by |
| --- | --- |
| `build-essential` | Makefile `CC/CXX/AR/LD/nm` + recursive `$(MAKE)`; native helper tools (ctangle/otangle/web2c/icupkg/pkgdata/genccode) reused by the wasm pass |
| `cmake` | expat 2.5.0 build (`CMAKE_native` / `emcmake cmake`) |
| `perl` | `install-tl` (`build/texlive-%.txt`) |
| `python3` | `REDEFINE_SYM`/`EXTERN_SYM` inline, `emcc_wrapper.py`, `file_packager.py` |
| `gperf` | fontconfig 2.13.96 sub-build (see nuance below) |
| `libarchive-tools` (bsdtar) | reads the ISO9660 image to stage texmf (driver `do_prep`; Makefile `source/texmfrepo.txt`) |
| `xz-utils` | `tar -xf *.tar.xz` of ISO archive packages + install-tl extraction |
| `curl` | Makefile `source/%.txt` download rules (offline build pre-stages, but curl is the tool those rules name) |
| `ca-certificates` | TLS for the emsdk https git-clone (image build) + curl |
| `git` | clones emsdk at image-build time |

**Dropped (10):** `p7zip-full`, `strace`, `icu-devtools`, `wget`, `bzip2`,
`pkg-config`, `file`, `autoconf`, `automake`, `libtool` — **zero** invocations
across the Makefile + drivers (token grep), consistent with the M0
`native-host.md` "not installed" column:

- `p7zip-full` / `wget` / `strace` / `icu-devtools` — CI-mirror-only or
  commented; `7z` never invoked, from-source build uses curl, `strace` only in
  a commented `install-tl` line, ICU tools built from source.
- `autoconf`/`automake`/`libtool` — TL ships pre-generated `configure` and a
  per-package generated `libtool` script (from in-tree `ltmain.sh`); the
  autotools *regen* packages are never invoked. (The 2 "libtool" grep hits are
  Makefile prose about libtool behavior, not invocations.)
- `pkg-config` — fontconfig gets expat/freetype via explicit
  `--with-expat-*` / `FREETYPE_*` flags; no `.pc` lookup on the build path.
- `bzip2` — 0 hits; the pipeline is `.tar.gz` (sources) + `.tar.xz` (ISO
  packages). (The emsdk `.tbz2` download is decompressed by emsdk's own Python
  `tarfile`/`bz2`, not the CLI.)
- `file` — all 10 grep hits are `--cache-file=` / prose, never the `file`
  command. Its only plausible caller is libtool's `deplibs_check_method`, which
  is `pass_all` (no `file`) for ELF on GNU/Linux. **Caveat for item 4:** if a
  TL library's generated libtool instead uses `file_magic` and warns/misbehaves
  at link, `file` is the first re-add suspect (journal it). Low risk.

**Nuance — `gperf` is a *transitive* keep.** It has 0 direct hits in our
Makefile, same as the drops. It stays because fontconfig 2.13.96's own
`configure` hard-requires gperf to generate `fcobjshash.h` and **aborts**
without it (the busytex CI listed it for exactly this; the native host had it
present). This is the principled line vs `file`/`libtool`: gperf's absence is a
hard configure failure; `file`'s is a soft libtool fallback.

### Build + smoke

`build/toolchain/build-image.sh arm64` (native, ~9m50s wall — dominated by the
232 MB emsdk download through the environment proxy + unpack):

- **Image ID:** `sha256:5d4af6533004f8d9c71857dfc9babb2c0757263410fad4af199543b9c49630dc`
- **Tag:** `wasmtex-toolchain:arm64-dev`

Smoke (`docker run --platform linux/arm64 … bash -l`):

| check | result |
| --- | --- |
| `emcc --version` (non-login, baked `EM_CONFIG`) | `emcc … 3.1.43` ✓ |
| `uname -m` | `aarch64` ✓ |
| prereqs present | gcc/g++ 11.4.0, make 4.3, binutils 2.38, cmake 3.22.1, perl 5.34.0, python3 3.10.12, gperf 3.1, bsdtar 3.6.0, xz 5.2.5, curl 7.81.0, git 2.34.1 ✓ |
| AArch64 ELF proof | `e_machine`=183 (`EM_AARCH64`) for emsdk clang, emsdk node, and gcc — native, not emulated ✓ |
| bundled node | `/opt/emsdk/node/16.20.0_64bit/bin/node`, `process.arch=arm64`, v16.20.0 ✓ |
| hello.c → wasm → node | compiled by arm64 emcc; ran `ok`; wasm magic `00 61 73 6d`, 12,172 B ✓ |

(First hello attempt failed on a shell-quoting bug in the *test harness*
heredoc, not the toolchain; re-run via a stdin script passed cleanly.)

### License audit

`build/audit/license-audit.sh` — green. The Dockerfile carries its SPDX MIT +
"original work" header (check (e) scans `Dockerfile`); build-image.sh unchanged
in provenance. Nothing GPL/AGPL introduced; no third-party source opened.

### Pins / docs touched

- `build/sources/pins.lock`: **additive** `[toolchain-image-arm64]` block (arm64
  platform digest, shared index digest, emsdk + `emsdk_release`, built image ID,
  `platform=linux/arm64`). `[toolchain-image]` kept and annotated as the parked
  amd64 equivalence lane (its `image_id` is the M0-era build — item 6 rebuilds
  it from the now-shared Dockerfile and re-pins).
- `build/toolchain/README.md`: restructured — arm64 canonical, amd64
  equivalence lane, native macOS dev-only; one-Dockerfile-two-images explained;
  lean prereq set. The `build/artifacts` container-flow scripts keep their M0
  parked banners (item 4 revives them).
- `build/toolchain/native-host.md`, `THIRD_PARTY_NOTICES.md`: pointers updated
  to name `[toolchain-image-arm64]` as the canonical lane the darwin-arm64 host
  mirrors.

### Deviations

- None from DESIGN.md. The one plan *assumption* under test (arm64 prebuilt
  availability) resolved in favour of the status quo (present), so the M2
  bump-rule contingency was not exercised.
- Scope boundary respected: the amd64 image is **not** rebuilt here (its lean
  re-pin + the equivalence hashes are item 6, preferably on a CI amd64 runner
  per the plan's `-j1`/Rosetta lesson). The `build/artifacts` container flow
  (build.sh / run-in-container.sh) is **not** revived here (item 4).

### Item 3 post-review addendum (2026-07-23)

Review fixes applied: the OCI `image.source` LABEL had the wrong org
(`wasmtex/wasmtex` — an M0-era error rebaked into the fresh image); fixing
it invalidated the layer cache, so the image was REBUILT and re-pinned in
the same commit (old `23c01f1f…`, final `5d4af653…` — the ID recorded in
pins.lock and above). The README smoke command was corrected (the printf
quoting produced invalid C — the published command is now the verified
`puts` variant, matching what actually ran); THIRD_PARTY_NOTICES' pin
table moved to the 2026 ids (stale since the M2 item-9 retirement).
Post-rebuild smoke re-verified: emcc 3.1.43, aarch64.

---

## Item 4 — Containerized build green (arm64 canonical builder)

Dated 2026-07-23. Goal (M3 plan item 4): revive the M0-parked container flow
(`build/artifacts/build.sh` + `run-in-container.sh`), re-pointed at `build/engines/`
+ the TL 2026 pins + the arm64 canonical image, and land a full `dist/` from a
fully-offline in-container build with every gate green against it. Fold in the
`--use-preload-cache` drop (the M1-journaled §5.2 deviation). This is the first
time OUR engine config (forked native-only at M2) is built in the container.

### Revival delta — the two scripts

Both scripts had their `!! PARKED (M3) — STALE PATH` banners removed and headers
rewritten for the canonical-builder role. Substantive re-pointing:

**`build.sh` (host side):**

| axis | M0-parked | revived (M3) |
| --- | --- | --- |
| config mount | `build/upstream/busytex` → `/machinery` | `build/engines` → `/engines` (+ `build/manifest` → `/manifest` for gen-assets) |
| image tag | `wasmtex-toolchain:dev` | `wasmtex-toolchain:arm64-dev` |
| `--platform` | `linux/amd64` | `linux/arm64` |
| image-id pin | `[toolchain-image]` | `[toolchain-image-arm64]` |
| required inputs | TL 2023 names | `texlive-source-2026.0.tar.gz`, `texlive2026-20260301.iso` |
| `SOURCE_DATE_EPOCH` | `1781618797` (busytex 2023 commit) | `1772323200` (TL 2026 freeze — **matches the native driver**, so artifacts are epoch-comparable) |
| jobs | `-j1` (Rosetta jobserver bug) | container `nproc` (native arm64 jobserver works; the `-j1` rule was Rosetta-only) |
| work volume | `wasmtex-m0-work` | `wasmtex-work` (+ clean-per-build policy, below) |

**`run-in-container.sh` (container side):**

- Config file set: M0's 9-file `MACHINERY_FILES` (packfs.c/.py, cosmo_getpass.h,
  ubuntu_package_preload.py, busytex_pipeline.js, busytex_worker.js) → the trimmed
  **3-file** set (`Makefile busytex.c emcc_wrapper.py`) — the M2 item-3 fork
  dropped packfs/Cosmopolitan/ubuntu-.deb/worker-glue entirely.
- Build tree root `/work/busytex` → `/work` (mirrors `build-native.sh`'s `$work`
  root layout, so the container and native trees are structurally identical).
- `do_dist` **rewritten to match `build-native.sh` `do_dist` byte-for-byte**: it no
  longer copies the vendored `busytex_pipeline.js`/`busytex_worker.js` into `dist/`
  (dropped from the shipped set at M2 item 3), and it now runs the two steps the
  M0 container side predated — `gen-assets.mjs` (the `assets.json` inventory) and
  the **execution gate** (`verify-engine.mjs`). Checksums use Linux `sha256sum`,
  whose `<hash>␠␠<path>` output is byte-identical to the native driver's
  `shasum -a 256`, so `SHA256SUMS` is directly comparable across the two builds.
- `do_prep` applies **no** source patches (`build/patches/*/*.patch`) — see the
  delta note below.

### Work-tree decision — named volume, clean per build

**Chosen:** a **named docker volume** (`wasmtex-work`), **wiped and recreated on
`STAGE=all`/`STAGE=prep`** (a single-stage resume reuses it).

**Why a volume, not a bind mount:** the build tree is the multi-GB TL source tree
+ ~6.5 GB texmfrepo ISO staging + all build objects. A macOS host bind mount drags
every one of those bytes through the slow virtiofs/gRPC-FUSE layer; a named volume
lives on the VM-native ext4 and is fast (prep — including the 6.5 GB ISO `bsdtar`
— completed in ~29 s on a fresh volume). Only the small `dist/` output crosses a
bind mount. This is the same rationale M0 used.

**Why clean-per-build (the new part):** M3 item 5 (build-twice reproducibility)
and item 6 (three-way equivalence) require that each build start from a **pristine
tree** — incremental configure caches, dumped `.fmt`, or leftover objects would
confound a byte-for-byte diff. So a full build wipes the volume first. This
deliberately diverges from the native driver, which is *incremental/resumable*
(it keeps `busytex-2026/` across runs) — a development-speed choice that the
canonical/repro builder must not inherit. Single-stage resumes still reuse the
volume so a crashed multi-hour build can be babysat stage-by-stage against its
partial tree.

### Native-vs-container override delta (enumerated)

`build-native.sh` injects a `macos_overrides` array on every `make`; the container
driver injects **none** of it, because the image is a Linux GNU userland, not
macOS. Each override is native-scoped and its *absence* is correct in-container:

| native override | why native needs it | container: |
| --- | --- | --- |
| `CMAKE_native` / `CMAKE_wasm` `+= -DCMAKE_POLICY_VERSION_MINIMUM=3.5` | Homebrew cmake 4.x dropped the pre-3.5 policy expat 2.5.0 declares | apt cmake is **3.22** (< 4) → old `cmake_minimum_required` honoured as-is. Omit. |
| `LDFLAGS_TEXLIVE_native = -lm -pthread` | trims the Linux static/`-ldl`/`--unresolved-symbols` flags Apple ld rejects | the Makefile **default** (full Linux LDFLAGS) is exactly right. Omit → default applies. |
| `OPTS_BUSYTEX_LINK_native = … -framework CoreFoundation … AppKit` | XeTeX's macOS CoreText/AppKit font backend needs Apple frameworks | XeTeX on Linux uses the fontconfig/freetype backend, links no frameworks. Omit → Makefile default (Linux `-ldl -lm -pthread …`) applies. |
| `URL_texlive` / `URL_expat` / `URL_fontconfig` / `URL_texlive_full_iso_cache` = (blank) | no network namespace on the host → a missed pre-stage must fail *closed* rather than curl an unpinned source | `--network none` is the hard enforcement; the URLs stay documentary. Omit. |

Not a delta (host-agnostic, already folded into `build/engines/Makefile`):
`OPTS_LIBS_wasm = AR=$(AR_wasm)` (emar for wasm archives) — fixes the hollow-wasm
defect on a BSD-ar host; a harmless no-op under GNU ar (format-agnostic).

**Source patches:** `build/patches/` holds two entries (`zlib-macos-fdopen`,
`libpng-macos-fp-h`), both **RETIRED** at M2 item 4 (header-only, the `.patch`
diffs removed) and both macOS-scoped anyway (a `TARGET_OS_MAC` false-positive that
never fires on Linux). So `build-native.sh`'s `apply_macos_patches` is *already* a
no-op today, and the container omitting patch application is exactly equivalent.

### Dropping `--use-preload-cache` (M3 plan fold-in; §5.2 restored)

Removed ` --use-preload-cache` from the `build/wasm/texlive-%.js` file_packager
recipe in `build/engines/Makefile`, and added a header mod-list bullet. Upstream
busytex built the bundle with that flag, so the generated `texlive-basic.js`
**unconditionally** cached the ~50 MB `.data` into an `EM_PRELOAD_CACHE` IndexedDB
store on every browser/worker load — the M1-journaled always-on-persistence
deviation from DESIGN §5.2 ("the library never *requires* IndexedDB … persistence
is an optional adapter"). This restores the strict posture.

**De-risked empirically before the build** (A/B of `file_packager.py` in the
pinned image, minimal preload bundle with vs without the flag):

- **without** the flag: **zero** `EM_PRELOAD_CACHE`/`openDatabase`/`preloadFallback`/
  `indexedDB` markers, **no** `throw 'using IndexedDB…'`, and `runWithFS` calls
  `fetchRemotePackage` directly. `.js` 6074 B vs 13530 B with the flag.
- Both loaders stay correct: the browser worker (`createWorkerModuleLoader`) only
  ever had the IDB store/read *added on top* of a fetch it already did → removing it
  is pure §5.2 posture, correctness unchanged. The node test/conformance loader
  (`runtime/node/node-engine-loader.ts`) injects `require`/`process` (drives the
  node `fs` read regardless) and `location`/`self` (now harmless no-ops — no IDB
  probe left to steer); `window` stays uninjected so the `typeof window` deref is
  never reached.

**Bundle delta (native regen under the new Makefile, before the container build):**
`texlive-basic.js` 1,459,979 → **1,452,511 B** (−7,468 B, the removed IDB machinery),
new sha256 `9c3daf2b…` (was `1a8f4089…`); `texlive-basic.data` **byte-identical**
(52,775,230 B, sha256 `5ead5862…` — the `.data` content is independent of the
loader flag). The native execution gate passed on the regenerated bundle (XeTeX,
`TeX Live 2026`, exit 0), confirming the change is sound before committing to the
multi-hour container build. This regenerated native `dist/` is the clean item-5
baseline (both sides now post-flag-drop, so the container-vs-native diff isolates
*platform*, not this config change).

### Docs / Makefile touched

- Root `Makefile`: `artifacts-container` target + header comment flipped from
  "PARKED for M3" to the canonical builder; `clean-artifacts` volume default
  `wasmtex-m0-work` → `wasmtex-work`.
- `build/artifacts/README.md`: PARKED/STALE banners removed; documents the two
  drivers, the work-tree policy, and the offline mechanism.

### Build run + timings

Full `make artifacts-container` (STAGE=all) on the 8-vCPU native arm64 host,
`--network none`, fresh `wasmtex-work` volume. Exit 0; container `wasmtex-build`
exited 0. Per-stage wall (from the log's UTC banners):

| stage | wall | note |
| --- | --- | --- |
| prep | ~29 s | config sync + 3 tarballs + 6.5 GB ISO `bsdtar`, fresh volume |
| native | ~10 m 08 s | native multicall busytex (gcc arm64, `-j8`) |
| basic | ~36 s | install-tl texlive-basic + `.fmt` dump |
| wasm | ~22 m 33 s | wasm multicall (emsdk clang, `-j8`) — the long pole |
| bundle | ~1 s | file_packager (no `--use-preload-cache`) |
| dist+verify | ~2 s | assemble + `assets.json` + execution gate |
| **total** | **~33 m 49 s** | well under the 60–90 m estimate (8-core, native, no Rosetta) |

Benign non-fatal log noise (all shared with the native build, none aborting):
freetype's `cp: cannot stat '…/docs/markdown'` (a refdoc dir absent from the
tarball), the `-cp …/*.c` glob (leading `-` → make ignores), and the ICU-rule
comment text ("cannot read font names") echoed by make. No `make *** Error`.

### Gate outcomes (all against the container-built `dist/`)

| gate | result |
| --- | --- |
| execution gate (in-container, `verify-engine.mjs`) | **PASS** — xetex `TeX Live 2026`, exit 0; env-imports 53 (ceiling 150); `assets.json` 7 entries |
| execution gate (host rerun vs landed `dist/`) | **PASS** — dist/ landed intact across the bind mount |
| `gen-assets` (assets.json inventory) | **green** — 7 entries, hashes cross-checked in-build |
| runtime suite (`typecheck` + `vitest`) | **PASS** — typecheck clean; **186/186** (10 files), incl. **8 real-wasm** integration tests (xetex→xdvipdfmx, crossref reruns, bibtex8 e2e, public API, cancel+reinit, broken-doc diagnostics) |
| conformance corpus | **4/4** — bib-cite (pdftex+bibtex8), hello-pdftex, hello-xetex (+xdvipdfmx), idx-makeindex (+makeindex); content-verified with negative controls |
| demo smoke (Playwright / Chromium) | **4/4** — hello XeTeX, pdfTeX+neg-control, broken-doc diagnostics, cancel()+reinit (§5.2) — the **browser-worker** path, where the cache drop matters most |
| license / provenance audit | **PASS** — all checks (engines headers, patches, copyleft tripwire, SPDX) |

The runtime + demo greens are also the item-2 acceptance: the
no-`--use-preload-cache` bundle loads and compiles under **both** the node loader
(runtime real-wasm) and the browser worker (demo), storage-less — §5.2 restored.

### Item 5 preview — container (arm64 Linux) vs native (arm64 macOS) hashes

Both builds are post-item-2 (identical Makefile), same arch, differing only in
**userland/toolchain platform**. Per-file (native → container):

| file | native B | container B | Δ | sha256 |
| --- | --- | --- | --- | --- |
| `busytex.js` (glue) | 273,991 | 273,991 | 0 | **IDENTICAL** (`81aa161c…`) |
| `busytex.wasm` | 27,508,145 | 27,501,925 | −6,220 | differ |
| `formats/pdflatex.fmt` | 2,286,489 | 2,286,258 | −231 | differ |
| `formats/xelatex.fmt` | 4,472,954 | 4,472,381 | −573 | differ |
| `texlive-basic.data` | 52,775,230 | 52,660,712 | −114,518 | differ |
| `texlive-basic.js` | 1,452,511 | 1,450,840 | −1,671 | differ |
| `SHA256SUMS` / `assets.json` | — | — | — | differ (derived reflections of the above; the generator logic + `generated` field are identical) |

**Findings (mechanisms, cheaply established — these are item-6 inputs, not
failures; the plan already sanctions native-vs-container host-layer differences,
with the container pair as the canonical comparison):**

1. **Glue JS is bit-identical** — emscripten's MODULARIZE loader codegen is
   platform-independent.
2. **`busytex.wasm` is ~95% build-path leakage, not codegen.** Both wasm carry
   **116** `__FILE__` strings (graphite2 `Segment.cpp`/`Pass.cpp`/… and xetexdir
   `hz.cpp`/`XeTeXOTMath.cpp`) with an **identical source-relative file set** —
   only the absolute prefix differs (`/Users/bofeizhu/.cache/wasmtex/build/native/busytex-2026`
   = 56 ch vs `/work` = 5 ch, Δ51 B each → 116×51 = **5,916 B of the 6,220 B
   delta**). Residual ~304 B. So the emsdk-clang wasm codegen is **effectively
   userland-independent** (validating DESIGN §9's "wasm is host-arch-independent
   by construction"). **Item-6 action:** normalise the build path
   (`-ffile-prefix-map`/`-fmacro-prefix-map`, or build every lane at the same
   canonical path) and re-diff — the wasm should collapse to near/bit-identical.
3. **`.fmt` formats differ with ZERO path leakage** → the *native* engine
   (host-compiled: Apple clang arm64 vs GNU gcc arm64) dumps host-compiler-
   dependent formats. Diverge from char 10, cascading (~99.5% of bytes). This is
   the "`.fmt` native-dump suspicion" the M3 plan flagged for item 6 — confirmed
   real and **independent of paths**. It does not affect releases: shipped `.fmt`
   come from the **container** engine (releases are container-only, DESIGN §9).
4. **`texlive-basic.data` (−114,518 B)** embeds the differing `.fmt` (~800 B)
   plus ~113 KB of further divergence — other host-dependent generated TDS
   content and/or LZ4 ripple over the changed `.fmt`; `texlive-basic.js` tracks
   `.data` (file_packager metadata). Full decomposition is item-6 depth.

The canonical repro gates remain the **container pair**: item 5 (container
build-twice, byte-identical) and item 6 (arm64 vs amd64 container). This
native-vs-container preview says: expect the wasm to equalise under path
normalisation; expect the native-dumped `.fmt`/bundle to carry a host-compiler
signature that the container lane eliminates by construction.

### Deviations

None from DESIGN.md. The `--use-preload-cache` drop *removes* a deviation
(restores §5.2's optional-adapter posture). The container flow's clean-per-build
volume policy intentionally diverges from the native driver's incremental/
resumable tree — required by the item-5/6 reproducibility contract, not a DESIGN
change.

---

## Item 5 — Reproducibility double-build gate

Dated 2026-07-23. Goal (M3 plan item 5, DESIGN.md §6.1): `build/repro-check.sh` —
the build-twice gate. Run N clean container builds; their `dist/` (SHA256SUMS +
assets.json + every payload byte) must be byte-identical; any divergence is a
nondeterminism bug hunted to its source and fixed in the Makefile/driver, never
smoothed over. `SOURCE_DATE_EPOCH` is already pinned; the plan's suspects were
archive ordering, gzip mtimes in `.fmt`, install-tl-embedded dates, locale sort,
and file_packager input ordering. Wire `make repro-check`. Journal.

### The gate — `build/repro-check.sh`

Original work (SPDX MIT), style-matched to the sibling drivers. Two modes:

- **full (default, canonical)** — run N (≥2) fresh clean-volume container builds
  and diff pairwise. This is the mode CI and the annual-rebase acceptance use, so
  the verdict rests on **nothing that predates the check**.
- **`--reuse-current` (pragmatic)** — treat the `dist/` already on disk as build
  #1 (snapshotting it *first*, before anything overwrites it) and run exactly ONE
  more clean build as #2. Halves wall-time (one ~34 min build, not two) at the
  cost of trusting the on-disk `dist/` was itself a pin-verified container build.
  `make repro-check` defaults to full; `REPRO_ARGS=--reuse-current` selects this.

Each build delegates to `build/artifacts/build.sh` (STAGE=all), which enforces
the pinned-image identity check and **wipes its docker work volume first** — so
each build starts pristine and re-running the gate is safe (resumable-safe: no
build inherits another's incremental state; the item-4 clean-volume policy is
load-bearing here).

**Why snapshot the whole `dist/`, not just SHA256SUMS.** SHA256SUMS byte-identity
is the authoritative GREEN verdict — it hashes every payload file — so the diff
*decision* needs only SHA256SUMS + assets.json. But the RED **report** wants the
actual diverging bytes (sizes, first-divergence offset, a hex+ASCII context
window), and the next build overwrites `dist/`. So each build's `dist/` is
snapshotted eagerly into `build/out/repro-check/build-NN/` (git-ignored), and the
report is generated from the snapshots after all builds finish. The report leads
with the SHA256SUMS + assets.json oracle callout, then a full per-file byte diff:
for each differing file, its size in each build (+Δ), the `cmp` line, and a
`hexdump -C` window on **both** sides around the first divergence — the ASCII
gutter is what makes an embedded date/path/mtime legible at a glance.

### Portability hardening (host = macOS dev **and** Linux CI)

The gate's *comparison and report run on the host* (macOS for a `--reuse-current`
dev run; Linux in CI), so the report primitives must be BSD/GNU-portable. A
pre-run test of the exact `cmp`/offset/hexdump pipeline against real `dist/` bytes
plus a fabricated perturbed copy — **before** spending 34 minutes — caught two
BSD-vs-GNU bugs that would otherwise have produced a garbled report on the very
run they were meant to diagnose:

1. **`od -t x1z` is not portable.** BSD `od` (macOS) rejects the `z` ASCII-gutter
   format char (`od: z: unrecognised format character`). Switched the context
   window to `hexdump -C -s <skip> -n <len>` — supported by both BSD and
   util-linux (CI), ASCII gutter intact.
2. **`cmp` offset wording differs.** GNU prints `differ: byte N`; BSD (macOS)
   prints `differ: char N`. The sed extractor matched only `byte`, so on the
   macOS host it silently fell back to offset 0/1. Fixed to match either word
   (`differ: [a-z]* N`).

(A third issue the test surfaced was in the *test harness itself* — a missing
`mkdir` — not the gate; the gate's `[ -f ]` guards handle a genuinely
one-sided file via its "ONLY in build N" branch.)

### Nondeterminism suspects — pre-analysis

Checked the plan's headline suspects against the pinned image and the on-disk
artifacts *before* building; the two classic ones are already neutralized by
construction, which is why container-vs-container had a real chance of being
clean on the first try:

- **file_packager input ordering — NOT a suspect.** emsdk 3.1.43's
  `tools/file_packager.py` sorts `data_files` by `dstpath` (its own comment:
  *"sorted … to make the order of files reproducible across file systems /
  operating systems (os.walk does not …)"*). So the `.data` packing order is
  filesystem-order-independent — a fresh ext4 volume's htree readdir order cannot
  perturb it.
- **gzip mtime in `.fmt` — already zeroed.** The shipped `.fmt` are gzip streams
  (`1f 8b 08 00`) whose 4-byte mtime field is `00 00 00 00`. The classic
  gzip-timestamp nondeterminism is pre-neutralized (web2c's dump path zeroes it).
- **locale sort** — `LC_ALL=C.UTF-8` in the container, `LC_ALL=C sort` in
  `do_dist`'s SHA256SUMS, and gen-assets' C-locale path sort all agree.
- **install-tl / TeX dates** — `SOURCE_DATE_EPOCH=1772323200` + `FORCE_SOURCE_DATE=1`
  + `TZ=UTC` are exported by `run-in-container.sh`; assets.json's `generated`
  field is derived from the epoch (deterministic), and the `.fmt` dump date rides
  `FORCE_SOURCE_DATE`.

So the residual risk was whatever these do *not* cover — an install-tl log or a
generated TDS file embedding a wall-clock date that lands in the packed
`build/texlive-basic/` tree, or a genuinely order-sensitive step upstream of the
file_packager sort.

### Run 1 + verdict — DIVERGED, root-caused to `ls-R`

Executed `build/repro-check.sh --reuse-current` (build #1 = item-4's on-disk
`dist/`; build #2 = one fresh clean-volume container build, ~32 min, exit 0),
babysat in-turn. **VERDICT: DIVERGED.** Exactly four files differed, and all four
trace to a SINGLE source (`build/out/repro-check/report.txt`):

| file | build1 | build2 | Δ | why |
| --- | --- | --- | --- | --- |
| `texlive-basic.data` | 52,660,712 | 52,660,788 | +76 | **root cause** (below) |
| `texlive-basic.js` | 1,450,840 | 1,450,843 | +3 | file_packager metadata tracking `.data` |
| `SHA256SUMS` | 509 | 509 | 0 | the `texlive-basic.data` hash line |
| `assets.json` | 1,341 | 1,341 | 0 | embeds those hashes |

**Byte-IDENTICAL across the two builds — the key negative result:** `busytex.wasm`,
`busytex.js`, `formats/pdflatex.fmt`, `formats/xelatex.fmt`. So the emsdk-clang
wasm codegen, the MODULARIZE glue, AND the `.fmt` format dumps are already
reproducible container-to-container (the `FORCE_SOURCE_DATE` epoch + the
gzip-mtime-zeroing hold; the native-vs-container `.fmt`/wasm deltas the item-4
preview saw were host-compiler/build-path artifacts that vanish within the
container lane). `ls-R` is the SOLE root cause; the other three files are derived
reflections of it.

**Localizing the `.data` divergence.** First differing byte at offset 32,113,164,
whose `hexdump` context (the gate's own report) reads
`… % ls-R -- filename database for kpathsea; …`. In `texlive-basic.js` the only
independent change is `compressedData.cachedOffset` 52656616 → 52656692 (Δ **76**,
matching the `.data` growth) plus the LZ4 `offsets` block-boundary array shifting
after that block — i.e. one packed file's LZ4-compressed representation grew 76
bytes while the file list's uncompressed offsets were unaffected: a **constant
size, changed content** signature.

**Root cause — `ls-R` readdir order.** install-tl runs `mktexlsr`, which writes
each texmf tree's `ls-R` kpathsea database by walking the tree in **filesystem
readdir order** and does NOT sort. `build/artifacts/build.sh` gives every build a
**freshly created docker volume** (the item-4 clean-volume repro policy), and a
fresh ext4 filesystem carries a **randomized htree hash seed** (mkfs picks it), so
the readdir order of any directory differs from one build's volume to the next.
Two otherwise-identical builds therefore emit `ls-R` with the same entries in a
different byte order → different `texlive-basic.data` (the reorder compresses
~76 B worse under LZ4) → different `.js`/SHA256SUMS/assets.json. Confirmed against
build #2's actual tree: every `ls-R` directory block was in scrambled
(non-C-sorted) readdir order (e.g. `./tex/latex/base:` → `doc-2016-02-15.sty,
slides.def, omscmr.fd, cp437de.def, …`). `SOURCE_DATE_EPOCH` cannot touch this —
it is ORDERING, not a timestamp.

A **second, subtler** facet: install-tl's `updmap` writes the font-map dirs
incrementally, so `mktexlsr` lists a single directory such as
`./texmf-var/fonts/map/dvips/updmap:` under MULTIPLE duplicate headers (7×, one
map file each), and the split across those duplicates is itself readdir/timing
dependent.

### The fix — `build/engines/normalize-lsr.py`

New original helper (SPDX MIT). After install-tl, the `build/texlive-%.txt` recipe
runs it over every generated `ls-R`
(`find … -name ls-R -exec $(PYTHON) $(abspath normalize-lsr.py) {} +`). It rewrites
each `ls-R` into a canonical byte-order that is a pure function of the file SET,
not of readdir order: parse into (dir-header → entries) records exactly as
kpathsea's own reader does (a line ending in `:` is a header, others are entries,
blanks separate), then emit blocks in sorted-header order, entries within each
block sorted, and — critically — MERGE all occurrences of a duplicate header into
one block with the deduplicated UNION of their entries (absorbing the updmap
split, occurrence count, and intra-block order all at once). All sorting is by raw
bytes = `LC_ALL=C`, host/locale-independent. kpathsea folds `ls-R` into a
directory→files hash and is order-independent, so this is strictly
behavior-preserving — it removes only the nondeterminism. Wired into BOTH drivers'
`machinery_files` (`Makefile busytex.c emcc_wrapper.py normalize-lsr.py`) so it
syncs into the work tree like `emcc_wrapper.py`; a Makefile-header mod-list bullet
records it. `.gitignore` gained `__pycache__/`/`*.pyc` (running the helper compiles
bytecode into `build/engines/`, which the license audit's build/engines scan would
otherwise flag).

### Verification — analysis-only (standing no-local-build directive)

A standing directive landed mid-finalization: **no further container builds on
this machine**; the hunt is analysis-only from the existing artifacts/snapshots,
and any rebuild-based re-verification is CI work. The fix was verified WITHOUT a
rebuild, which is sound because the fix's core property is checkable directly:

- **Order-independence (the property that fixes the bug).** A throwaway harness
  imported the real `canonicalize()` and ran it over build #2's three actual
  `ls-R` files AND over 5 independent random re-shufflings of each (each shuffle
  permutes block order + within-block entry order — exactly what a different
  volume's readdir order would produce). All shuffles normalized to the
  BYTE-IDENTICAL canonical form. So a build on any htree seed yields the same
  `ls-R` bytes.
- **Idempotence** (`canonicalize(canonicalize(x)) == canonicalize(x)`) and
  **content preservation** (the dir→{files} set is unchanged — nothing added or
  lost, verified as a set-equality that accounts for the duplicate-header merge)
  held on all three files.
- **Recipe form validated in the pinned image**: the exact
  `find … -exec python3 normalize-lsr.py {} +` invocation ran inside
  `wasmtex-toolchain:arm64-dev` (python3 3.10.12) against a writable copy of the
  `ls-R` files — canonicalized correctly, exit 0, idempotent on re-run.

Because (a) `ls-R` was the SOLE divergence in the two completed builds (wasm/glue/
formats were byte-identical) and (b) the normalizer makes `ls-R` provably
readdir-order-independent, two post-fix builds are expected byte-identical. The
**empirical build-twice green is deferred to CI** (M3 item 7 wires `make
repro-check` as its own job) per the directive — the local two-build run started
for this purpose was aborted at build #1's prep stage and MUST NOT be re-run
locally.

### Status / deferred

- **Landed:** the gate (`build/repro-check.sh`), `make repro-check`, the
  `docs/rebase.md` Phase-5 note, the `ls-R` root-cause fix (`normalize-lsr.py` +
  recipe + both drivers), audit green, execution gate green on the on-disk
  `dist/`.
- **On-disk `dist/` is the PRE-fix build #2** (readdir-order `ls-R`); it still
  passes the execution gate. The fix is in the build CONFIG and takes effect on
  the next build (CI). No local rebuild was performed to refresh it (directive).
- **Deferred to CI (M3 item 7):** the empirical two-clean-build `make repro-check`
  green — the byte-identical `SHA256SUMS` proof that closes item 5's acceptance.
  This journal + the analytical verification are the evidence that the fix is
  correct; CI provides the final empirical confirmation.

### Deviations

None from DESIGN.md. `normalize-lsr.py` canonicalizes an install-tl output for
reproducibility (DESIGN.md §6.1); it is behavior-preserving for kpathsea and
touches no engine/source code. The empirical build-twice demonstration is deferred
to CI by an operational directive (no local builds), not a DESIGN change; §6.1's
contract is unchanged and now has both a runnable gate and a root-cause fix.

### Review outcome (code-reviewer, 2026-07-23)

**Request-changes → all applied.** The reviewer verified the normalizer with 19
synthetic-fixture tests, traced the recipe (install-tl at the only ls-R writer;
normalize runs after it and the prune, before packing), confirmed machinery
sync, and matched the journal against the on-disk evidence byte-for-byte. Two
should-fixes landed:

1. **`--keep-going` false GREEN** (the gate's one real flaw): a failed build
   left the previous dist/ on disk, was snapshotted anyway, and diffed clean.
   Now: failed builds are recorded and NOT snapshotted, pairs missing a
   snapshot are skipped in the diff, and any failure forces verdict
   `INCOMPLETE` + exit 1 before the green path is even considered.
2. **Local-run doc contradiction**: root Makefile + script header recommended
   local runs the standing directive prohibits; both now cross-reference the
   M3 standing decision (container builds on CI runners only).

Nits also applied: robust awk `--help` extractor (sed range had drifted),
`LC_ALL=C cmp` (gettext-localized message broke the offset extractor under
non-English locales), header rule tightened to kpathsea's real one (ends `:`
AND starts `./`/`/` — a colon-suffixed filename can no longer hijack a block),
format citation moved from `db.c` to the kpathsea manual. Post-fix: 8/8
property tests green (idempotence, 50-shuffle order-independence, dup-header
merge, content preservation, raw-byte sort, magic header, edge cases).
