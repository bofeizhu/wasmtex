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
