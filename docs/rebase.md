<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
  Not derived from any third-party source.
-->

# The annual rebase runbook

This is the operational sequence for rebasing WasmTeX onto the next TeX Live
snapshot — the "current TeX Live" promise (DESIGN.md §1) made repeatable
(DESIGN.md §6.2). It is written for the person or agent doing **TL 2027** next,
and it is seeded by the **TL 2026 rebase (M2)** — the first execution of this
procedure. The M2 evidence is quoted inline as worked examples; the long-form
record it distills is `docs/plans/M2-journal.md`, and the terse milestone record
is `docs/LOG.md`.

**Read this first — what is and is not automated.** DESIGN §6.2 frames the rebase
as "a scripted `make rebase TL=2027`". The honest state after M2 is narrower and
you should not expect otherwise: the **judgment** phases (pin research, patch
re-test, drift diagnosis and fixes) are manual and are the bulk of the work; the
**mechanical acceptance tail** (fetch-verify, gate, suites, conformance, audit)
is aggregated behind `make rebase-check`. The conformance corpus (§8) is THE
acceptance gate. The table:

| Phase | What it is | Scripted? |
| --- | --- | --- |
| 0. Prerequisites | toolchain, cache, disk | check by hand |
| 1. Pin research | resolve + verify the snapshot; forecast drift | **judgment** (fetch-verify is scripted) |
| 2. Patch re-test | check each active patch vs new sources | **judgment** |
| 3. Build + drift | build the engines; fix the year's drift | `make artifacts` runs; **drift fixes are judgment** |
| 4. Fixture regen | re-capture golden transcripts | procedure scripted (per `GENERATOR.md`); divergences are judgment |
| 5. Conformance + gates | the acceptance gate | **`make rebase-check`** |

Provenance discipline binds every phase (DESIGN §2, constitutional): research
for pins and drift is confined to TUG / CTAN / GitHub `TeX-Live` channels and the
vendored source itself. **Never open a GPL/AGPL WASM-TeX wrapper's source.** If
one surfaces, note the encounter in the year's journal so the audit trail shows
avoidance — do not read it.

Throughout, substitute the target year for `<Y>` (M2's worked example is
`<Y> = 2026`, rebasing from `2023`; TL 2027 rebases from `2026`).

---

## Phase 0 — Prerequisites

Do these before touching pins. None are WasmTeX-specific magic; they are the
things whose absence wastes a build.

1. **Toolchain present and pinned.** The pinned emsdk + GNU userland must be set
   up per `build/toolchain/native-host.md`; `build/artifacts/build-native.sh`
   sources `build/toolchain/native-env.sh` and aborts early if emsdk is missing.
   Confirm `emcc --version` matches the `[toolchain-image]` pin in
   `build/sources/pins.lock` (M2: **3.1.43**, emsdk commit `d9c66fa2`). Whether
   this pin *changes* is a Phase 3 decision, not a Phase 0 assumption.
2. **Source cache verified.** Run `build/sources/fetch.sh` — it must exit 0 with
   the previous year's pins already green. This is the baseline you add to, not
   replace (Phase 1's additive lock scheme).
3. **Disk.** The build needs the previous year's tree kept as a fallback *plus*
   the new year's staging. The new ISO alone is ~6.3 GiB, its extracted
   `texmfrepo` ~6.3 GB, and native+wasm build trees are tens of GB. M2 ran with
   **808 GiB free**; budget on that order. `df -g ~/.cache/wasmtex`.
4. **Node + Playwright.** The runtime/conformance gates need Node; the demo smoke
   needs Playwright browsers (`npm --prefix demo exec playwright install`). These
   are `make rebase-check`'s prerequisites (Phase 5).

---

## Phase 1 — Pin research (judgment)

The goal: resolve the TL `<Y>` snapshot to two verifiable artifacts — the
`texlive-source` release tag and the frozen `texlive<Y>-*.iso` — pin them
additively in `build/sources/pins.lock` with cross-checked hashes, fetch+verify
them, and produce the **drift forecast** that arms Phase 3. Keep the previous
year's build reproducible until Phase 3 cuts over.

### 1a. The tag-namespace gotcha

The `texlive-source` release tags are **git-svn branch refs under
`refs/heads/tags/`, not real `refs/tags/`**. So the intuitive
`.../git/refs/tags/texlive-<Y>.0` **404s**; the correct namespace is
`.../git/refs/heads/tags/texlive-<Y>.0`. Enumerate the landscape with
`.../git/matching-refs/heads/tags/texlive-<Y-decade>` (M2 saw
`2026.0 2026.1` alongside the prior years). The codeload URL the lock records is
the `github.com/.../archive/refs/heads/tags/texlive-<Y>.0.tar.gz` form (fetch.sh
follows the 302 to `codeload.github.com`), matching the existing block shape.

**Pin `.0`, the canonical initial annual release**, unless a specific later
correction is required. M2 resolved `texlive-2026.0` →
`f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d` (r78235, 2026-03-01) and pinned it
over `texlive-2026.1` (a later dvipdfmx psfile-quoting *runtime* fix) for
freeze-date coherence with the ISO (below). If a `.1+` fix later proves
necessary, the preferred remedy is to **carry the upstream fix as a
`build/patches/` entry, preserving the `.0` pin** (bumping the whole pin to `.1`
dissolves the `.0`/ISO freeze-date coherence). Bumping the pin is a deliberate,
journaled decision — never silent.

### 1b. Historic-vs-release-area decision tree

```
Is texlive<Y>-<date>.iso in the TUG HISTORIC mirror
    ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/<Y>/ ?
├── YES → pin THAT url + its published .sha512 checksum_url. Done. (Frozen; ideal.)
└── NO  (release year — ISO not archived to historic yet)
        → FALLBACK: pin the exact DATED iso from the CTAN release area
          .../pub/tex/systems/texlive/Images/texlive<Y>-<date>.iso
          + its published .sha512.
          AVOID the unnamed symlinks texlive.iso / texlive<Y>.iso — they ROTATE
          within the year and vanish when TL <Y+1> ships.
          RECORD the mirror-rotation exposure + the RE-PIN-BACK rule (1e below).
```

M2 hit the fallback branch: the 2026 historic tree carried only the component
`.tar.xz` set, no consolidated `.iso`, so it pinned
`texlive2026-20260301.iso` (6,784,798,720 B) from the release-area `Images/`
path.

### 1c. Checksum discipline — three-way agreement

An ISO is too big to eyeball; verification is fail-closed and triangulated,
exactly as M0/M2 did it:

1. `sha256` of the downloaded bytes;
2. `sha512` of the downloaded bytes;
3. the mirror's **published** `.sha512`.

(2) must equal (3) byte-for-byte (`CROSSCHECK=PASS`). The lock records **both**
the sha256 and sha512; `fetch.sh` then re-hashes the cached bytes against the
lock on every run (`"2 hash(es) verified"`). For the source tarball, the sha256
over the `.tar.gz` bytes is the anchor (GitHub auto-archives are not guaranteed
byte-stable — a mismatch there means "GitHub re-generated the tarball", not
corruption; see `build/sources/README.md`).

### 1d. Additive lock scheme

**Do not edit the previous year's blocks.** Leave `[texlive-source]` /
`[texlive-iso]` (and any prior `-<year>` blocks) **byte-identical** so the old
build stays bit-for-bit reproducible until Phase 3 cuts over, and **add**
`[texlive-source-<Y>]` / `[texlive-iso-<Y>]`. Block ids are free to choose:
build scripts and patch HEADERs key off the cache **filename**
(`texlive-source-<Y>.0.tar.gz`), not the block id, and `fetch.sh` only requires
id uniqueness. The superseded blocks are retired at the milestone's
ACCEPTANCE step (named owner — for M2 that is item 9), once Phases 3-5 are
green on the new pins; the retirement may also drop the `-<Y>` suffix back
to canonical ids. Do not leave the retirement ownerless (M2 nearly did).

### 1e. The re-pin-back rule (carry it forward)

If Phase 1 used the release-area fallback (1b), leave a standing reminder in the
lock comment and the year's journal: **once TL `<Y>` is archived into
`.../historic/systems/texlive/<Y>/...iso`, switch the `[texlive-iso-<Y>]` `url`
and `checksum_url` back to the historic path.** The content hashes are unchanged,
so the swap self-verifies. M2 tied this to the M3 milestone ("RE-PIN-AT-M3").
Carry an equivalent reminder each year the fallback is used.

### 1f. Drift-forecast probe — MANDATORY pre-build step

Before building anything, extract the source tarball and produce the **vendored
`libs/` version-delta table**. This is not optional colour; it is the risk map
Phase 3 reads, and it is what tells you *in advance* whether an emsdk bump is
likely. Procedure:

- Layout is `libs/<lib>/<lib>-src/` (version-less dir). Read versions from
  `libs/README` and confirm against each `libs/<lib>/version.ac`.
- Tabulate **prev → new** for every lib, and **mark the ones that link into our
  multicall** (xetex / pdftex / xdvipdfmx / bibtex8 / makeindex / kpsewhich).
- Also diff `texk/` subdirs (M2: 36 vs 35 — one added `texk/xdvipsk/`, not in our
  set; none removed) and check `version.ac` (`tex_live_version`) +
  `texk/web2c/configure.ac` (`AC_INIT([Web2C], tex_live_version(), …)` — the
  macro form that ties Web2C to the TL year).

The M2 table (TL 2023 → TL 2026; `*` = links into our multicall) — reproduce its
*shape* for `<Y>`:

| Library | 2023 | 2026 | Δ | Risk |
| --- | --- | --- | --- | --- |
| harfbuzz * | 7.0.1 | 12.3.2 | +5 MAJOR | **HIGHEST** — modern C++; primary emsdk trigger |
| icu * | 70.1 | 78.2 | +8 MAJOR | **HIGH** — C++17/20; second emsdk trigger; ICU-data-packaging class |
| zlib * | 1.2.13 | 1.3.2 | minor+ | lands on a macOS patch (re-test) |
| libpng * | 1.6.39 | 1.6.55 | +16 patch | lands on a macOS patch (re-test) |
| xpdf * | 4.04 | 4.06 | minor | low |
| freetype2 * | 2.13.0 | 2.14.1 | minor | low |
| teckit * | 2.5.11 | 2.5.13 | patch | low |
| graphite2 * | 1.3.14 | 1.3.14 | none | — |
| libpaper * | 1.1.28 | 1.1.29 | patch | low |
| pplib / zziplib | — | (unchanged) | none | — |
| lua53 | — | (left the multicall link at M2 item 3 — no longer in the linked set; compute YOUR year's set fresh, per above) | — | — |

**Headline for `<Y>`:** the two C++ heavyweights (harfbuzz, icu) drive the
emsdk-bump question; the compression libs (zlib, libpng) drive the patch
re-test. Everything our engines link that is unchanged or a trivial bump is
low-risk. Record the table in the year's journal — Phase 3 cites it.

### Phase 1 gates

`build/sources/fetch.sh` green twice (verify-all + idempotent, exit 0);
`build/audit/license-audit.sh` green (the lock is config; new blocks carry no
header requirement).

---

## Phase 2 — Patch re-test (judgment)

**Check each ACTIVE patch against the new sources FIRST — before running the
build.** A stale patch is not a silent no-op: prep's `apply_macos_patches` tries
to apply it against reorganized upstream context and **aborts the build**. So
each active `build/patches/<name>/*.patch` gets one of two outcomes, decided by
extracting the exact target file from the new source tarball and inspecting the
guard the patch touches:

- **Fixed upstream → RETIRE.** Remove the `.patch` file (so `apply_macos_patches`
  is a clean no-op) and **keep + rewrite the sibling `HEADER.md` as a dated
  RETIRED archival record**: what the defect was, why it is gone (quote the new
  upstream block as evidence), and a "do not resurrect" note. The license audit
  check (c) enforces that a retired dir keeps a `HEADER.md` recording the
  retirement and the diff-context-excerpt clause — **zero active patches is
  legitimate**.
- **Drifted but still needed → RE-DIFF.** Regenerate the patch against the new
  context, keep the `HEADER.md` current, and keep the SPDX + excerpt-clause
  reference the audit's check (c) requires.

M2 worked example: the drift forecast (1f) flagged zlib `1.2.13→1.3.2` and
libpng `1.6.39→1.6.55` landing on the two `TARGET_OS_MAC` patches. Both were
**RETIRED** — libpng 1.6.55 dropped the `<fp.h>`/`TARGET_OS_MAC` guard entirely
(now unconditional `<float.h>`/`<math.h>`), and zlib 1.3.2 collapsed its guard to
`#if defined(MACOS)` and added modern-Apple handling. `build/patches/` now holds
zero active patches and two retired `HEADER.md` records
(`build/patches/{libpng-macos-fp-h,zlib-macos-fdopen}/HEADER.md`) — read them as
the template for a retirement.

---

## Phase 3 — Build + drift (build scripted; fixes are judgment)

Run the build on the new pins and fix the year's drift as it surfaces. **Journal
every failure → fix** in a new `docs/plans/M<n>-journal.md`, written as the work
runs — the journal is as much the deliverable as the binary.

### 3a. Build-side pins to cut over (same commit, before the first stage)

- **Fresh work dir.** Bump `WASMTEX_WORK_DIR`'s default in `build-native.sh` to a
  new sibling (M2: `busytex-2026`) — and the duplicated default in the root
  `Makefile`'s `clean-artifacts` target, which must stay in sync or `make
  clean-artifacts` silently leaves the real multi-GB tree behind.
  **Additive, never wipe** — the previous
  tree's configure caches, staged source, dumped `.fmt`, and ISO `texmfrepo` must
  not contaminate the new build, and the old tree stays a fallback until
  acceptance.
- **`SOURCE_DATE_EPOCH` = the new freeze date.** Set the `build-native.sh`
  default to the TL `<Y>` freeze epoch (M2: `1772323200` = 2026-03-01, the *same*
  point as the `.0` source tag commit and the ISO date — the coherence Phase 1
  chose `.0` for). Tying the epoch to the freeze date makes each year's build
  self-descriptive; it reaches the `.fmt` formats via `FORCE_SOURCE_DATE`.
- **Cache-filename cutover.** Point `tl_src` / `iso` in `build-native.sh` at the
  new pins (`texlive-source-<Y>.0.tar.gz`, `texlive<Y>-<date>.iso`).
- **Gate banner bump (sanctioned build-side pin).** `verify-engine.mjs`
  `EXPECT_VERSION` → `TeX Live <Y>`. This is a *build gate constant, not runtime
  code* — the runtime never asserts a TL year.
- **Makefile documentary URLs.** Bump the illustrative `URL_texlive*` and
  `tags/texlive-*.0` doc-URLs in `build/engines/Makefile` (the build *rules* are
  version-agnostic; they operate on `source/texlive/` regardless of year).

### 3b. The emsdk-bump decision rule (verbatim, from M2 plan item 4)

> the emsdk-bump decision rule is: bump ONLY if the build genuinely requires it,
> to an exact pinned version, recorded in pins.lock + native-host.md + toolchain
> README in the same commit (the M3 container re-pin then inherits it).

"Genuinely requires it" means a **compiler-capability failure** under the pinned
emsdk (unknown attribute, unsupported C++ feature, libc++ gap) — *not* a
standard-selection flag you can pass yourself. M2 **KEPT 3.1.43**: emsdk 3.1.43's
clang (LLVM 17) compiled harfbuzz 12.3.2 and icu 78.2 outright; the only C++
change needed was a `-std=` flag (drift class 3c below), which is not an emsdk
capability question. Attempt the pinned emsdk **first**; document the exact error
before bumping.

### 3c. Known drift classes (with their M2 instances)

The build is incremental and staged (`make artifacts STAGE=prep|native|basic|
wasm|bundle|dist`, resumable). These are the drift classes M2 hit; expect the
same *shapes*, journal the specifics.

**(1) C++ standard defaults (native compiler lag).** Newer ICU/harfbuzz public
headers use later C++-library features; a consumer that includes them must
compile at that standard. The trap is the **native** compiler: M2's Apple clang
21 defaults to `__cplusplus = 201402L` (C++14), so XeTeX failed against ICU 78
headers (`no template named 'is_pointer_v' … 'is_same_v' … 'void_t'`) even though
the reference Linux gcc/clang and emsdk 3.1.43 default to gnu++17. **Fix (our
Makefile):** `CXXSTD = -std=gnu++17` threaded through the C++ compiles
(`CXXFLAGS_native`, `CXXFLAGS_TEXLIVE_wasm`, and the wasm engine `CXX=` lines) —
CXX side only (a C++ std on a C compile errs). Prefer `gnu++17` (the reference
platform's effective web2c standard) over strict `c++17`. Config-owned flag, not
a source defect → Makefile, no patch.

**(2) Duplicate & common symbols in the multicall link (the nm-intersection
method).** The busytex multicall links xetex+pdftex+bibtex8+xdvipdfmx+makeindex+
kpathsea into one binary; new web2c-generated globals that TeX emits into two
engines collide there (they never collide in a normal TL build where the engines
are separate executables). XeTeX is the unrenamed primary; the `*_REDEFINE` lists
(`-D<sym>=busy<prog>_<sym>`) rename the others away. Two sub-shapes, and a
critical native/wasm asymmetry:

- **Defined-symbol duplicates (nm type `T`/`D`)** fail at *both* native and wasm
  link. M2: `zisbitset`, new in TL 2026, emitted into both `pdftex0.o` and
  `xetex0.o` → added to `PDFTEX_REDEFINE`.
- **Common symbols (nm type `C`, tentative defs)**: **Apple ld64 coalesces them
  (native passes silently); wasm-ld does NOT and reports duplicates.** So a wasm
  link can fail on collisions a green native link hid. M2:
  `savearitherror oldselectorignorederr outputcanend` → added to
  `PDFTEX_REDEFINE`.

**Do not whack-a-mole.** Compute the **full collision set** once = the
intersection of the GLOBAL (uppercase nm type: `T D B C S R`) defined symbols of
the xetex core objects vs the pdftex core objects; add the intersection to
`PDFTEX_REDEFINE` in one edit. `CFLAGS_PDFTEX` feeds both the native and wasm
opts, so one list entry fixes both links. Rebuild the affected engine's objects
(`rm` its `*.o`/`*.a`) so every TU recompiles with the new `-D`. Config-owned →
Makefile, no patch.

**(3) ICU data-packaging (the item-4b class).** ICU's `pkgdata --without-assembly`
(required — wasm can't assemble arch `.s`) emits a **pointer-TOC** static archive
whose per-item length lookup is hard-coded `-1`. ICU 78's
`common/ucnv_io.cpp initAliasData()` added a **length gate**
(`dataLength <= 4 → invalidFormat`) that rejects it → `u_init` returns
`U_INVALID_FORMAT_ERROR`, `ucnv_countAvailable() = 0`, the alias table never
loads, and wasm XeTeX dies at `XeTeXFontMgr_FC.cpp` "internal error; cannot read
font names" (exit 3). (Native XeTeX dodges it — CoreText font manager, no
`ucnv_open`.) **Fix (our Makefile):** `genccode` (no `-a`) the complete
intermediate `icudt<N>l.dat` — which already carries a proper **offset-TOC** —
into one portable C byte-array object that *replaces* `libicudata.a`, for native
and wasm alike (entry point derived from the `.dat` basename, no version literal;
deterministic, so M3's double-build gate is unaffected). A `.DELETE_ON_ERROR:`
guards against an interrupted repackage leaving the pointer-TOC archive for the
next incremental make to silently accept.

> **Item-4b retirement condition (watch for this and delete the transform):**
> retire the genccode offset-TOC repackaging if a future ICU `pkgdata` grows a
> no-assembly offset-TOC static mode (watch `pkg_createWithoutAssemblyCode` in
> `tools/pkgdata`) **or** drops the `initAliasData` length gate
> (`common/ucnv_io.cpp`). Retest with the fast native probe: link a tiny harness
> against the built `libicuuc.a` + `libicudata.a` and call
> `ucnv_countAvailable()` — expect **~232, not 0**. This iterates in *seconds*
> against native ICU with no wasm rebuild; only the final artifact needs the wasm
> ICU rebuilt. Full mechanism in the M2-journal Item 4b section.

### 3d. Run + acceptance

`make artifacts` (or stage by stage). Acceptance for this phase: **dist/
assembles and the execution gate is green** asserting the `TeX Live <Y>` banner
(`env` imports well under the 150 ceiling — M2: 53; the hollow-archive defect was
363). The `basic` stage's format prune must leave exactly the retained set
(`xetex/xelatex.fmt`, `pdftex/pdflatex.fmt`) and remove the whole
`luahbtex/ luatex/ tex/` dirs (lua-free since M2; the prune, not the profile, is
load-bearing because `collection-basic` still declares `depend luahbtex`).

---

## Phase 4 — Fixture regeneration (procedure scripted; divergences are judgment)

Re-capture the 21 golden fixtures (12 diagnostics + 9 sequencing) from the new
`dist/` per the two procedures in
`runtime/test/fixtures/{diagnostics,sequencing}/GENERATOR.md` (each now carries an
exact "Source documents" section + a "TL 2026 rebase deltas" note — keep both
current for `<Y>`). Drive the real `EmscriptenEngineHost` through
`createWorkerCore` against `dist/` from a **throwaway** generator (not committed —
journal discipline), overwrite the fixtures in place, and read `git diff` against
the committed prior-year versions as the oracle.

**The version-agnostic scorecard.** The parser and machine detectors anchor on
version-stable substrings (`Undefined control sequence.`, `! Emergency stop.`,
`Reference/Citation \`…' … undefined on input line N`, `Rerun to get
cross-references right`, the `Package/Class … Warning:` + folded `(name)`
continuation, bibtex8/makeindex exit codes) and paren-stack semantics — **not** on
banners. The target outcome is that `diagnostics.test.ts` + `sequencing.test.ts`
pass with **ZERO test-file changes**. M2 hit exactly that (78/78, and the three
bibtex8 fixtures were byte-identical across TL years).

**Churn (expected) vs finding (journal it).**

- *Expected cosmetic churn* — regenerate and move on: engine banners
  (`0.999995→0.999998`, `TeX Live 2023→2026`), `LaTeX2e`/`L3`/document-class
  dates, `makeindex 2.17→2.18`, `.xdv`/`.pdf` render byte counts.
- *Benign structural churn* — verify it touches no anchor, then note it: M2's
  kernel stopped auto-loading `ts1cmr.fd`, so a balanced `(…)` vanished from 14
  fixtures; because it was never on the parser's paren stack at a diagnostic,
  attribution and line numbers were unaffected. Recorded in both `GENERATOR.md`.
- *A real finding* — **a detector or parser assertion that actually breaks**.
  That is a substantive discovery about the new engine's output, not a fixture to
  paper over: journal it, and fix the parser/detector deliberately (a runtime-code
  change with its own tests), not by loosening the fixture. M2 produced **zero**
  such findings.

Also update the TL-year references in the two `GENERATOR.md` headers and the two
test files' provenance comments/labels (comments/labels only — no assertion
changes if the scorecard held).

---

## Phase 5 — Conformance + gates (the acceptance gate)

**The conformance corpus is THE acceptance gate for a rebase (DESIGN §6.2 + §8).**
The four M2 seeds (`conformance/corpus/{hello-xetex,hello-pdftex,bib-cite,
idx-makeindex}`) drive the PUBLIC `createTypesetter` over the real wasm and
assert the §8 contract: exit code, PDF page count, extracted text snippets (with
negative controls), and exact diagnostics shape.

Run the mechanical acceptance tail — one command:

```
make rebase-check
```

It is a fail-fast, ordered aggregator of the six gates (it does **not** build —
run `make artifacts` first; see the manual-step note below). Inputs → artifact
→ suites order,
so a regression fails as early as possible:

| # | Gate | Command it runs | Expected (M2 green set) |
| --- | --- | --- | --- |
| 1 | fetch verify | `build/sources/fetch.sh` | all blocks OK, exit 0 |
| 2 | execution gate | `node build/artifacts/verify-engine.mjs dist` | banner `TeX Live <Y>`; ~53 env imports |
| 3 | license audit | `build/audit/license-audit.sh` | all checks passed |
| 4 | runtime suite | `npm --prefix runtime run typecheck && npm --prefix runtime test` | typecheck clean; **186/186** |
| 5 | conformance | `npm --prefix conformance run conformance` | **4/4** seeds |
| 6 | demo smoke | `npm --prefix demo test` | **4/4** (Playwright) |

> **The reproducibility gate is a SEPARATE step, not part of `rebase-check`.**
> DESIGN §6.1's build-twice check (`make repro-check`, `build/repro-check.sh`)
> runs two full clean container builds (~hours) and is deliberately kept out of
> `rebase-check`'s fast, fail-fast tail. Run it as its own step of the rebase (it
> verifies the *canonical builder* is still deterministic on the new pins) and as
> its own CI job — never fold it into the acceptance aggregator above.

The M2 corpus run for reference (fresh typesetter per entry, public API over real
wasm):

```
ok   hello-pdftex    pdftex  1 page   1 pass    engine
ok   hello-xetex     xetex   1 page   1 pass    engine>xdvipdfmx
ok   bib-cite        pdftex  1 page   3 passes  engine>bibtex8>engine>engine
ok   idx-makeindex   xetex   2 pages  3 passes  engine>makeindex>engine>engine>xdvipdfmx
```

Note the two honest shapes the seeds pin, so a `<Y>` divergence is legible: (a)
`bib-cite` carries **4 warnings** (pass-1 "Citation … undefined" + the
rerun/label pair) that the multi-pass log legitimately retains — an empty
diagnostics list there would be the surprise; (b) `idx-makeindex`'s third pass is
a genuine `.aux`-change convergence pass (index grew the doc to 2 pages), the
§5.3 rerun-until-quiescent contract, not a makeindex quirk.

If a gate fails, the failing tool's own output is the diagnosis; fix and re-run
`make rebase-check`. Green across all six = the rebase is accepted for the seed
corpus. (An independent re-run by a second agent is the M2 item-9 discipline.)

---

## What is scripted vs a judgment call (no overclaiming)

DESIGN §6.2 aspires to "a scripted `make rebase TL=<Y>`". Read this honestly
before you rely on it:

**Scripted / mechanical:**
- Fetch + hash-verify of pinned inputs (`build/sources/fetch.sh`), fail-closed.
- The staged build itself (`make artifacts`) — *once the pins and any drift fixes
  are in place*.
- The whole acceptance tail behind **`make rebase-check`** (Phase 5): fetch-verify
  → gate → audit → runtime suite → conformance → demo smoke, ordered and
  fail-fast, with a printed phase checklist. It doubles as the executable form of
  the acceptance list, kept honest because it runs.

**Judgment calls (the bulk of the work — no script decides these):**
- **Pin research (Phase 1)** — the tag namespace, `.0`-vs-`.1`, historic-vs-
  release-area, the re-pin-back reminder, and reading the drift-forecast table.
- **Patch re-test (Phase 2)** — retire-vs-re-diff is a source inspection per
  patch.
- **Drift diagnosis and fixes (Phase 3)** — the emsdk-bump call, the C++-standard
  flag, the nm-intersection redefine set, the ICU data-packaging transform. Each
  is a root-cause investigation landing in *our* Makefile.
- **Fixture divergences (Phase 4)** — cosmetic churn vs a real parser/detector
  finding.

**Why `make rebase-check` is a `-check`, not `make rebase`.** It deliberately does
**not** perform the rebase: it does not research pins, apply or re-diff patches
(there are zero active patches to apply after M2), run the multi-hour staged
build, or regenerate fixtures. Those are Phases 1–4 — driven by hand because they
are judgment (1, 2, 3-fixes, 4-divergences) or a babysat, resumable, hours-long
operation (the build). Folding the build into a one-shot check would fight the
staged/resume model and misrepresent an automated pipeline that does not exist.
`rebase-check` earns its place as the *acceptance aggregator* — a single, ordered,
fail-fast entry point across five directories and six tools for an operation run
once a year — but it is scoped to verification, and the name says so.

If a future year makes more of this genuinely mechanical (e.g. an actual
patch-apply step once patches return, or a pin-resolver that survives the
namespace gotcha), grow the tooling and update this runbook and DESIGN §6.2
together — in an explicit commit, per the CLAUDE.md convention.

---

## References

- **DESIGN.md §6.2** — the annual-rebase contract (the conformance corpus is the
  acceptance gate); §1 (the "current TeX Live" promise); §8 (verification).
- **`docs/plans/M2-journal.md`** — the long-form record this runbook distills
  (Item 2 pins, Item 3 fork, Item 4/4b build + ICU, Items 5–7 verification).
- **`docs/LOG.md`** — the terse dated milestone record.
- **`docs/plans/M2.md`** — the M2 work list and acceptance criteria.
- **`build/sources/README.md`** — the `pins.lock` format and verification-failure
  semantics.
- **`build/patches/*/HEADER.md`** — retired-patch archival records (the Phase 2
  retirement template).
