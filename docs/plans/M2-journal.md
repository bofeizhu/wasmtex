<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M2 — Rebase to TeX Live 2026: build journal

Durable engineering record for the annual-rebase archaeology. One section per
work item, written as the work runs, not after. Records every resolution,
failure -> fix, and standing decision so a future rebaser can replay it. Feeds
`docs/LOG.md` (the terse milestone record); this is the long-form companion.

Provenance discipline (DESIGN.md §2): web research for pins is confined to
TUG / CTAN / GitHub `TeX-Live` channels. No GPL/AGPL WASM-TeX wrapper project
source was opened at any point; encounters (if any) are noted so the audit
trail shows avoidance.

---

> **Item 4b retirement condition (for the next ICU rebaser).** Retire the
> genccode offset-TOC repackaging transform if a future ICU pkgdata grows a
> no-assembly offset-TOC static mode (watch `pkg_createWithoutAssemblyCode`
> in tools/pkgdata) or drops the `initAliasData` length gate
> (common/ucnv_io.cpp). Retest with the `ucnv_countAvailable()` probe:
> expect ~232, not 0. Full mechanism in the Item 4b section below.

## Item 2 — TL 2026 pin research + pins.lock update

Dated 2026-07-23. Goal: resolve the TL 2026 snapshot artifacts (texlive-source
release tag + the frozen `texlive2026-*.iso`), pin them in
`build/sources/pins.lock` with sha256 (+ ISO published-sha512 cross-check),
fetch+verify via `fetch.sh`, and sanity-probe the source tree so item 4 has a
drift forecast. The 2023 pins STAY until M2 completes (the old build must remain
reproducible until the rebase lands); a later item retires them.

### Research log (chronological)

**texlive-source tag.** The 2023 pin URL is
`archive/refs/heads/tags/texlive-2023.0.tar.gz` — a git-svn *branch* under
`refs/heads/tags/`, NOT a real `refs/tags/` tag (LOG.md M0 item 2 already flags
this as "a mutable git-svn branch ref URL"). So `git/refs/tags/…` 404s; the
correct namespace is `git/refs/heads/tags/…`. Enumerating
`git/matching-refs/heads/tags/texlive-202` gives the full landscape:

    2020.0 | 2021.1 2021.2 2021.3 | 2022.0 | 2023.0 | 2024.0 2024.1 2024.2
    2025.0 2025.1 2025.2 | 2026.0 2026.1

`.0` is the canonical initial annual release (matches our 2023.0 pin and the
task's expected `texlive-2026.0`). Resolved:

- `texlive-2026.0` -> commit `f26cc5ed05a1f784d1e694fe5b9cfc3ce992c03d`
  ("texlive-2026.0 tag based on r78235", committed 2026-03-01).
- `texlive-2026.1` -> commit `6a300188053b8f2ded89dbd52293732a706b9c0e`
  ("based on r78399, with dvipdfmx psfile quoting fix", 2026-03-17).

**Decision: pin `.0`, not `.1`.** Three reasons. (1) `.0` is the canonical
initial release, consistent with our 2023.0 pin and the yearly pattern. (2) The
frozen ISO is dated `20260301` (see below) — the SAME freeze date as the `.0`
source tag; `.1` (20260317) is a later source-only correction that no re-pressed
2026 ISO reflects. Pinning `.0` keeps the engine source tree and the texmf ISO
coherent at one freeze point. (3) `.1`'s only delta is a dvipdfmx psfile-quoting
runtime fix (not a build fix), so `.0` builds cleanly and the fix is
non-essential for the corpus. `.1` is recorded here as a known later correction;
bumping to it would be a deliberate future decision (e.g. if a conformance doc
needs the fix), never silent.

Codeload: `github.com/…/archive/refs/heads/tags/texlive-2026.0.tar.gz`
302-redirects to
`codeload.github.com/TeX-Live/texlive-source/tar.gz/refs/heads/tags/texlive-2026.0`.
The lock records the `github.com/archive/…` form (fetch.sh follows redirects),
matching the existing `[texlive-source]` block shape exactly.

**ISO — historic vs release-area decision.** The proven historic mirror
`ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2026/` EXISTS but as of
2026-07-23 carries only the release-year component tree — `install-tl-unx.tar.gz`,
`install-tl.zip`, and `texlive-20260301-{source,texmf,bin,extra,devsource}.tar.xz`
(each + `.sha512` + `.asc`). There is NO consolidated `.iso` there yet (HEAD of
`texlive2026-20260301.iso` and `texlive2026.iso` both 404). This is exactly the
M2 "ISO availability" risk (release year -> ISO not archived into historic yet).

Fallback per the plan: the exact dated ISO from the release area with its
published checksum. Located on the SAME Chemnitz host (TLS works here; utah
fails) under the CTAN mirror tree `/pub/tex/systems/texlive/Images/`:

- `texlive2026-20260301.iso` (dated filename — stable within the release year)
- `texlive2026-20260301.iso.sha512` -> published
  `4a9071bb567c3bdd6443378dedc8e485aea4a2f1203ec8ed7c17f6787093b9c37636a037032c0be63352e3d0bf98cf5616dab19fdcd7cb83f766b3e085b620ff`
- `texlive2026-20260301.iso.md5` -> `f5872cb2dec838670f91ed5c62493553`
- (also `texlive.iso` / `texlive2026.iso` unnamed symlinks — AVOIDED; they
  rotate within the year. The dated filename is the pin target.)
- Size 6784798720 bytes (6.32 GiB), Last-Modified 2026-03-01 17:36 GMT,
  `Accept-Ranges: bytes` (fetch.sh resume works).

MIRROR-ROTATION EXPOSURE (standing note): `/pub/tex/systems/texlive/Images/` is
a CTAN "current" release area — it is overwritten when TL 2027 ships, at which
point `texlive2026-20260301.iso` disappears from this path. Our content hashes
(sha256 + sha512) still fail-closed, but the URL will 404 after rotation.
**RE-PIN-AT-M3 REMINDER:** once TL 2026 lands in
`…/historic/systems/texlive/2026/…iso`, switch the `[texlive-iso-2026]` `url`
and `checksum_url` back to the historic path (content hashes stay identical, so
the swap self-verifies — same discipline as the 2023 block). This deviation from
the README "historic archives only" rule is sanctioned by the M2 ISO-availability
risk for the release year only.

**Lock scheme decision.** Build scripts (`run-in-container.sh`, `build.sh`,
`build-native.sh`) and the patch HEADERs key off the cache FILENAME
(`texlive-source-2023.0.tar.gz`), never the pins.lock block id; fetch.sh iterates
ids generically and only requires uniqueness. So the block id is free to choose.
Cleanest, lowest-risk scheme: leave `[texlive-source]` / `[texlive-iso]` (2023)
BYTE-IDENTICAL (old build stays bit-for-bit reproducible until the rebase lands)
and ADD `[texlive-source-2026]` / `[texlive-iso-2026]`. A later M2 item retires
the 2023 blocks once item 4's build cuts over. Documented in the lock comments.

### Source-tree sanity probe (item 4 drift forecast)

Source tarball top-level (prefix `texlive-source-tags-texlive-2026.0/`):
`Build/ texk/ libs/ utils/ am/ auxdir/ build-aux/ m4/ doc/ configure(.ac)
version.ac Makefile.am/.in README.*`. Same shape as 2023.

- **TL source version** (`version.ac`): `tex_live_version = 2026` (was 2023).
- **web2c version** (`texk/web2c/configure.ac`): `AC_INIT([Web2C],
  tex_live_version(), …)` — identical macro form both years, so Web2C tracks
  the TL year (2026). No AC_INIT reorg.
- **texk/ structural drift**: 36 subdirs (2026) vs 35 (2023). Exactly ONE added
  — `texk/xdvipsk/` (a dvips variant, NOT in our program set) — and NONE
  removed. So the feared "texk/ build-system reorg 2023->2026" is minimal at the
  directory level; internal configure/Makefile churn inside existing dirs is
  still possible and is item 4's job to surface.

**Vendored `libs/` version delta (TL 2023 -> TL 2026).** Layout is
`libs/<lib>/<lib>-src/` (version-less src dir); versions read from
`libs/README` and confirmed against each `libs/<lib>/version.ac`. Libraries
that LINK into our multicall (xetex/pdftex/xdvipdfmx/bibtex8/makeindex/kpsewhich)
are marked *. This is the drift forecast for item 4's build + the emsdk-bump
decision:

| Library | TL 2023 | TL 2026 | Δ | Item-4 risk |
| --- | --- | --- | --- | --- |
| harfbuzz * | 7.0.1 | 12.3.2 | +5 MAJOR | **HIGHEST** — modern C++; primary emsdk/clang/libc++ bump trigger |
| icu * | 70.1 | 78.2 | +8 MAJOR | **HIGH** — C++17/20; second bump trigger |
| zlib * | 1.2.13 | 1.3.2 | minor+ | gzlib.c reorg — re-test `zlib-macos-fdopen` patch (likely drifted/upstreamed) |
| libpng * | 1.6.39 | 1.6.55 | +16 patch | re-test `libpng-macos-fp-h` patch |
| xpdf * | 4.04 | 4.06 | minor | pdftex; low |
| freetype2 * | 2.13.0 | 2.14.1 | minor | low |
| teckit * | 2.5.11 | 2.5.13 | patch | low |
| libpaper * | 1.1.28 | 1.1.29 | patch | low |
| graphite2 * | 1.3.14 | 1.3.14 | none | — |
| pplib * | 2.05.0 | 2.05.0 | none | — |
| zziplib * | 0.13.72 | 0.13.72 | none | — |
| lua (lua53) * | 5.3.6 | 5.3.6 | none | lua53 may leave the link once luahbtex is dropped (§9 amendment) |
| mpfr | 4.2.0 | 4.2.2 | patch | MetaPost-side; not linked |
| mpfi | (absent) | 1.5.4 | NEW | MetaPost interval arith; not linked |
| cairo | 1.16.0 | 1.16.0 | none | MetaPost png; "no longer checked" upstream |
| pixman | 0.42.2 | 0.42.2 | none | with cairo |
| gd | 2.3.3 | 2.3.3 | none | — |
| gmp | 6.2.1 | 6.2.1 | none | — |
| potrace | 1.16 | 1.16 | none | — |
| luajit | 2.1.0-beta3 | 2.1.0-beta3 | none | luajittex dropped anyway |

Note: 2023's `libs/README` also listed a stale `lua 5.2.4`; 2026 dropped it,
keeping only 5.3.6. Headline: **harfbuzz (7->12) and icu (70->78) are the two
big C++ drifts** and the exact reason the M2 emsdk-bump decision rule exists;
**zlib and libpng bumps land directly on the two TARGET_OS_MAC patches** item 4
re-tests. Everything else our engines link is unchanged or a trivial bump.

### Fetch + verify (three-way agreement) + ISO probe

**ISO download.** 6784798720 bytes in 651 s (~10.9 min, ~9.9 MB/s) from the
Chemnitz Images/ release area. `Accept-Ranges: bytes` -> fetch.sh resume works.
(Aside: the in-turn completion waiter did not wake the agent — same failure mode
as M0 item 2's ISO download; the main session nudged it. The download + hashes
had completed correctly and atomically; only the wake-up missed.)

**Three-way agreement (ISO), same discipline as M0 item 2:**

1. sha256 of the downloaded bytes:
   `a143d17759f08344b916ae38829b71e1ea5a2f7029e87798242a588c918469d2`
2. sha512 of the downloaded bytes:
   `4a9071bb…620ff`
3. mirror's PUBLISHED `.sha512`: `4a9071bb…620ff` — **identical to (2)**.
4. lock records both; `fetch.sh` re-hashes the cached bytes and checks them
   against the lock ("2 hash(es) verified" for `[texlive-iso-2026]`).

So: downloaded bytes == mirror published .sha512 == lock == re-verified cache.
`CROSSCHECK=PASS`.

**fetch.sh green twice.**
- Run 1 (verify-all): all 8 blocks OK; `[texlive-source-2026]` 1 hash
  (149438403 B), `[texlive-iso-2026]` 2 hashes (6784798720 B); ~22 s (re-hashing
  both ISOs). exit 0.
- Run 2 (idempotent): every entry `skip`, no re-download, ~21 s. exit 0.
- Cache total 4.90 GiB -> **11.36 GiB** (+6.46 GiB = ISO 6.32 GiB + source
  142.5 MiB). Both 2023 and 2026 pins coexist and verify.

**ISO shape probe** (`bsdtar -tf`, exactly how the prep stage reads the ISO9660
root via `bsdtar -x -C source/texmfrepo -f "$ISO"`). TL2026 ISO top-level is the
SAME SET as the 2023 ISO (diff empty). Carries what prep stages:

- `install-tl` (installer script) ✓
- `archive/` — 14932 `*.tar.xz` packages (install-tl's package repo) ✓
- `tlpkg/texlive.tlpdb` (package DB) + `tlpkg/TeXLive/TLConfig.pm` +
  `tlpkg/installer/` ✓
- plus `source/ texlive-doc/ LICENSE.TL LICENSE.CTAN release-texlive.txt`.
- `release-texlive.txt` banner: "TeX Live (https://tug.org/texlive) version
  2026" — definitive TL2026 confirmation.

Prep-stage compatibility: no shape change from 2023, so item 4's ISO staging
needs only the filename swap (`texlive2023-…iso` -> `texlive2026-20260301.iso`).

### Gates

- `build/sources/fetch.sh` — green twice (verify-all + idempotent), exit 0.
- `build/audit/license-audit.sh` — green (lock is config; the `[busytex]` commit
  still parses; new blocks carry no header requirement).

### Deferrals / reminders (carried to later items)

- **RE-PIN-AT-M3**: move `[texlive-iso-2026]` url + checksum_url from the CTAN
  release-area Images/ path back to `…/historic/systems/texlive/2026/…iso` once
  the frozen ISO is archived there (content hashes unchanged -> self-verifying).
- **Retire 2023 blocks**: `[texlive-source]` / `[texlive-iso]` stay until item 4
  cuts the build over; a later M2 item deletes them (and may drop the `-2026`
  suffix to canonical ids then).
- **emsdk-bump watch (item 4)**: harfbuzz 7->12 and icu 70->78 are the triggers.
- **Patch re-test (item 4)**: `zlib-macos-fdopen` (zlib 1.2.13->1.3.2) and
  `libpng-macos-fp-h` (libpng 1.6.39->1.6.55) target versions both moved.
- **`texlive-2026.1`** available if a conformance doc later needs the dvipdfmx
  psfile-quoting fix (deliberate future decision, not silent) — preferred
  remedy if it bites at item 4: carry the upstream dvipdfmx fix as a
  `build/patches/` entry, PRESERVING the `.0` pin (the .0/ISO freeze-date
  coherence is the reason the .0 was chosen; bumping the whole pin to `.1`
  would dissolve it).

---

## Item 3 — Dissolve `build/upstream/` into our own build config

Dated 2026-07-23. Goal: fork the vendored busytex Makefile (+ the helpers it
needs) into `build/engines/` as OUR maintained, MIT build config with per-file
derived-work headers; drop LuaTeX / bench / Ubuntu-bundle / Cosmopolitan /
example paths; retarget the driver and the license audit; retire
`build/upstream/`; drop the worker/pipeline glue from `dist/`. **Sequencing: this
item stays on the TL 2023 pins** — item 4 does the 2026 cutover. The deliverable
is a coherent, working OURS config **verified against the known-good TL 2023
cache**. No commit here (the orchestrating session commits).

### Forked files (build/engines/) + modification summaries

Copied byte-for-byte from the pinned commit, then adapted; each carries a
`DERIVED WORK (DESIGN.md §2.1)` header naming commit `f2bd7b11…` and listing its
mods (the header IS the provenance record — no `PROVENANCE.md` manifest):

- **`Makefile`** — our engine build config. Mods: LuaTeX removed end to end;
  `OPTS_LIBS_wasm = AR=$(AR_wasm)` folded in; bench/Ubuntu/example/Cosmopolitan
  paths dropped; format dump/prune trimmed to the non-lua retained set. (See the
  dropped-target inventory below.)
- **`busytex.c`** — multicall dispatcher. Mods: dropped the `#ifdef
  BUSYTEX_LUATEX` extern (`busymain_luahbtex`), the `luatex`/`luahbtex` applet-
  listing lines, and the `luahbtex`/`luahblatex` argv[1] dispatch. Verified: the
  relinked native binary's applet listing is `pdftex xetex xdvipdfmx bibtex8
  makeindex kpse{which,stat,access,readlink}` and `busytex luahbtex` exits 1.
- **`emcc_wrapper.py`** — the `CCSKIP_*_wasm` compiler-wrapper shim, body
  UNMODIFIED (no substantive change needed; xetex/pdftex + ICU/freetype wasm
  builds still reuse the native helper tools through it).

**Helpers evaluated and NOT forked** (only served dropped paths):
`packfs.c` / `packfs.py` (only the `busytexextra` native-fat/bench binary used
them), `cosmo_getpass.h` (Cosmopolitan-only — `#ifdef __COSMOPOLITAN__`, a no-op
on native/wasm; its inject into `dvipdfm-x/dvipdfmx.c` is dropped), and
`ubuntu_package_preload.py` (Ubuntu `.deb` bundle path). `README.md` (original
WasmTeX) describes the directory. The upstream README and the two glue JS files
are not carried forward (glue decision below).

### Dropped-target inventory (rebase-surface metric)

The Makefile shrank **618 → 560 lines**. Dropped blocks (each shrinks the annual
rebase surface):
- LuaTeX: `OBJ_LUAHBTEX`/`OBJ_LUATEX`; `lua53` from `OBJ_DEPS`;
  `LUATEX_REDEFINE` (the ~1-line mega symbol list); `LUATEX_SOCKET_DEFINES`;
  `CFLAGS_LUAHBTEX`/`CFLAGS_LUATEX`; `OPTS_LUAHBTEX_*`/`OPTS_LUATEX_*`;
  `-DBUSYTEX_LUATEX`; the `busytex_libluahbtex.a` target; the `lua53`
  library target (kpathsea half kept); `busytex_libluahbtex.a` from
  `busytexapplets`; `lua53` from `texlivedependencies`; `OBJ_LUAHBTEX` from the
  multicall link.
- bench / native-fat: the `busytexextra` target (+ `packfs`), `dist-native-full`,
  `download-native`, `BUSYTEX_BIN`.
- Ubuntu bundle: `URL_ubuntu_*`, `build/wasm/ubuntu/%.js`, `ubuntu-wasm`,
  `TEXMFFULL`, the `versions.txt` ubuntu line.
- Cosmopolitan: the `cosmo_getpass.h` copy+inject in `source/texlive.patched`
  (kept the ICU `common/Makefile.in` quoted-space normalization — re-annotated;
  it is a source-tree normalization, cheap, and was in the known-good build).
  Also re-annotated (kept as a proven no-op) the XeTeX `-Dprivileged=privileged`
  self-define.
- example / tiers: the `example` asset-download target, the `texlive-extra` and
  `texlive-full` install profiles, `dist-wasm`, `clean-example`.
- biber: **already absent** from the busytex Makefile (it lived in a separate
  `build-biber.yml`), so nothing to drop here — noted for completeness.

### Format-set decision (+ a real finding)

Retained set = **`{ xetex/xelatex.fmt, pdftex/pdflatex.fmt }`** — exactly what
the runtime `FORMAT_*` constants (`runtime/worker/core.ts`: `FORMAT_XELATEX`,
`FORMAT_PDFLATEX`) and the conformance corpus (hello-xetex, hello-pdftex,
bibtex8, makeindex — all LaTeX) use. Plain `tex/tex.fmt` is used by neither, so
it is pruned too. The `FORMAT_*` MEMFS constants are therefore unaffected (they
never referenced a lua format).

**Finding — the profile drop is NOT the mechanism; the PRUNE is.** I dropped
`collection-luatex 1` from `texlive-basic.profile` AND the `luahbtex`/`luahblatex`
install wrappers, AND the lua `lualatex.fmt->luahblatex.fmt` rename. But the
redump STILL produced lua formats. Cause (confirmed against the staged tlpdb):
`scheme-basic` pulls `collection-basic`, which has `depend luahbtex` +
`depend luatex` (→ 10 `execute AddFormat engine=lua*` lines). So the lua
fmtutil.cnf entries install regardless of `collection-luatex`. fmtutil then built
those lua `.fmt` using the **host** `luahbtex`/`luatex` (`/Library/TeX/texbin/…`
is on PATH — our multicall has no lua applet) — a non-hermetic leak, but the
outputs are **pruned** and never shipped. The shipped `xelatex.fmt`/`pdflatex.fmt`
ARE ours (built via the custom-bin wrappers; engine banner
`TeX Live 2023_busytexwasm`). Decision: keep the profile drop (correct intent)
but make the prune load-bearing by removing the whole `luahbtex/ luatex/ tex/`
dirs (rebase-robust: catches any lua format that leaks in via a dependency). The
old M0/M1 build hit the same host-engine path — it just had its own luahbtex, so
the leak was invisible; documenting it here for the annual rebaser.

### Glue-drop decision + fallout

**Decision: DROP `busytex_pipeline.js` / `busytex_worker.js` from `dist/`** (the
task's RECOMMENDED option). Rationale: the runtime replaced their role at M1
(the demo drives our typed worker, not the glue; the smoke already asserts they
are NOT loaded), and M2 makes the config ours — so `dist/` should carry only
WasmTeX-authored/-consumed artifacts. Verified nothing asserts their PRESENCE:
`demo/test/smoke.spec.mjs` asserts the glue is NOT loaded (still true); the
`assets.test.ts` runtime block only asserts every role is IN `KNOWN_ROLES`
(never that glue exists); `verify-engine.mjs` never references glue.

Fallout handled (all green after):
- `build-native.sh` do_dist: dropped the two glue `cp`s; `machinery_files`
  trimmed to `Makefile busytex.c emcc_wrapper.py`.
- `gen-assets.mjs`: retired the `glue-pipeline`/`glue-worker` ROLE_RULES + header
  table (8→6 roles). A retired rule can't fire on an absent file, so no
  unclassified-artifact error.
- `build/manifest/README.md`, `runtime/src/protocol.ts` (`AssetRole` 8→6 arms),
  `runtime/test/assets.test.ts` (`KNOWN_ROLES` 8→6): retired glue for
  consistency; typecheck + vitest green.
- `.github/workflows/build.yml`: removed the `-f dist/busytex_worker.js` /
  `-f dist/busytex_pipeline.js` presence checks from the demo-smoke guard (they
  would have wrongly skipped the smoke once glue is gone).
- Docs: `demo/index.html`, `demo/README.md`, `demo/serve.mjs` (stale
  "busytex_pipeline.js is the engine" comment fixed → `busytex.wasm`).

### Override fold-ins (driver → Makefile)

- **`OPTS_LIBS_wasm=AR=emar`** — FOLDED into the Makefile as
  `OPTS_LIBS_wasm = AR=$(AR_wasm)`. Upstream never defined it (a latent bug: the
  wasm archive rule passed an undefined var, so non-libtool libs' hardcoded
  `AR = ar` won — the hollow-wasm-archive defect on BSD-ar hosts). It fixes the
  bug for every host, not just this macOS driver, so it belongs in the config now
  that the config is ours. Removed the driver override.
- **`NM_native=true`** — REMOVED. It only existed to no-op the `nm -D`
  diagnostic in `busytexapplets` (macOS `nm` has no `-D`). Folded away by
  deleting that debug-only `echo BEFORENM && nm -D … && echo AFTERNM` tail.
- **KEPT as driver overrides** (genuinely host-specific, not config): the macOS
  frameworks link (`OPTS_BUSYTEX_LINK_native`), `LDFLAGS_TEXLIVE_native`, the
  cmake-4 policy floor (`CMAKE_native`/`CMAKE_wasm`), and the offline URL blanks.
  Also improved do_prep to SYNC changed config files (cmp-based) rather than
  copy-once, so a fork/rebase re-syncs into the work tree.

### Audit retarget + induced-failure proof

Checks (a)/(b) no longer enforce the `build/upstream` PROVENANCE.md manifest +
vendored-sha256 (both retired with the staging tree). They now require every file
under `build/engines/` to carry an SPDX MIT header AND one provenance marker:
original WasmTeX work, or a `DERIVED WORK` header naming the pinned `[busytex]`
commit. Check (e)'s `build/upstream/busytex/` exemption removed; roots now cover
`build/engines/` (`emcc_wrapper.py` is double-covered, intended). Dead
`sha256_of`/`tmpd` scaffolding removed.

Fail-closed proof (induced, then restored): (1) a headerless
`build/engines/_induced_headerless.sh` → `FAIL … lacks an SPDX-License-Identifier`
+ exit 1; (2) a `DERIVED WORK` header omitting the commit → `FAIL … does not name
the pinned [busytex] commit f2bd7b11…` + exit 1; after removing both, audit exits
0 (`all checks passed`).

### Verification against TL 2023 (in-turn, staged)

Clean-ish rebuild of what changed, on the existing (known-good) work tree:
- **native relink (no lua):** forced by removing the link outputs. `busytex.c`
  compiled without `-DBUSYTEX_LUATEX`; link has xetex+pdftex+bibtex8+xdvipdfmx+
  makeindex+kpathsea + deps, no `libtexlua53`/luahbtex. Binary
  `36,553,752 → 30,294,664 B`.
- **basic redump (adjusted set):** `install-tl` reran; the prune left exactly
  `pdflatex.fmt` + `xelatex.fmt` (see the finding above).
- **wasm relink (no lua):** `busytex.wasm 30,366,631 → 26,369,418 B`
  (`busytex.js 295,606 → 273,991`). One expected warning: `undefined symbol:
  getpass` — pre-existing on wasm (emscripten has no getpass; the cosmo stub only
  fired for `__COSMOPOLITAN__`, so it was always undefined and stubbed by
  `--unresolved-symbols=ignore-all`). This confirms the cosmo_getpass drop is a
  true wasm no-op. getpass is only reached for encrypted-PDF prompts.
- **bundle + dist + execution gate:** `texlive-basic.data 79,503,467 →
  59,247,516 B`. Gate green: 53 env imports (sound; the hollow defect was 363),
  `xetex --version` exit 0, banner `TeX Live 2023_busytexwasm`. `assets.json`:
  7 entries, roles `{checksums, engine-js, engine-wasm, format×2, bundle-data,
  bundle-js}` — no glue role; no unclassified artifact.
- **runtime suite:** `npm run typecheck` clean; `vitest` **186/186** across 10
  files — incl. `assets.test.ts` (real 6-role `dist/assets.json`), the real-wasm
  integration tests (hello-world, crossref rerun, bibtex8 e2e, public API,
  cancel+reinit, broken-doc diagnostics — all compile with the new lua-free
  engine), and "rejects luatex with a fatal". Fixtures unchanged (still TL 2023).
- **demo smoke: 4/4** (XeTeX text-bearing PDF + clean diagnostics; pdfTeX text;
  broken-doc file+line diagnostics; cancel()+fresh-worker follow-up).
- **license audit:** green.

### wasm size delta (budget note)

Dropping LuaTeX (luahbtex objects + lua53) from the multicall link:
`busytex.wasm 30,366,631 → 26,369,418 B` = **−3,997,213 B (−13.2%)**; loader
`busytex.js −21,615 B (−7.3%)`. Native binary `−6,259,088 B (−17.1%)`. Bundle
`texlive-basic.data 79,503,467 → 59,247,516 B` = **−20,255,951 B (−25.5%)** (lua
formats + the luatex/luahbtex packages pruned from the TDS the packer embeds).
No explicit budget file exists yet (DESIGN §8's is a later deliverable); recorded
here so the drop is not silently absorbed.

### Parked container flow

`build.sh` + `run-in-container.sh` still mount the retired `build/upstream/
busytex` as `/machinery`; per the plan they are NOT rewritten now. Each got a
prominent `!! PARKED (M3) — STALE PATH` banner explaining the mount is retired and
that they are re-pinned + re-pointed at `build/engines/` on arm64 at M3.

### Deviations / notes

- **ICU `common/Makefile.in` sed kept** (originally a Cosmopolitan args-with-
  spaces fix) as a source normalization, and the XeTeX `-Dprivileged=privileged`
  self-define kept as a proven no-op — both re-annotated. Conservative: they were
  in the known-good build and removing them buys nothing but build risk. Not a
  DESIGN deviation.
- **Host-engine leak into the (pruned) lua format build** — documented above; the
  shipped formats are ours, so no artifact-integrity impact. A fully hermetic
  format dump is an M3 (container, no host TeX) property.
- The wasm/native verification is a **relink** reusing M0/M1 dependency archives
  (harfbuzz/icu/… built once); the folded `OPTS_LIBS_wasm` only matters when
  those archives are rebuilt, which item 4's from-scratch TL-2026 build does. The
  relink + green execution gate proves the link graph and the config are coherent
  on TL 2023.


---

## Item 4 — Build against TL 2026

Dated 2026-07-23. Goal: `make artifacts` (prep -> native -> basic -> wasm ->
bundle -> dist) against the TL 2026 pins, execution gate green with a **TeX Live
2026** banner. This is the first from-scratch build on the new pins; the journal
is as much the deliverable as the binary. Written as the work runs.

Provenance: no GPL/AGPL WASM-TeX wrapper source was opened. Drift research is
confined to the vendored TL 2026 sources themselves (extracted from the pinned
`texlive-source-2026.0.tar.gz`) and upstream release notes on TUG/GitHub
`TeX-Live` channels where consulted.

### Pre-build decisions (before the first stage ran)

**Pin cutover (build-native.sh).** Cached-input filenames switched to the 2026
pins: `texlive-source-2026.0.tar.gz` + `texlive2026-20260301.iso` (pins.lock
[texlive-source-2026] / [texlive-iso-2026], already fetched+verified at item 2).
expat/fontconfig unchanged (item 2 decision — not re-pinned for 2026).

**SOURCE_DATE_EPOCH: switched to the TL 2026 freeze date, `1772323200`
(2026-03-01T00:00:00Z)** — was `1781618797` (the busytex pin commit date) for the
TL 2023 build. Justification: (1) the build machinery is OURS now (forked at item
3), so the busytex commit is a frozen fork-point reference, not a property of the
artifacts. (2) 2026-03-01 is the coherent epoch for a TL-2026 build — the SAME
freeze point as BOTH the source tag (texlive-2026.0 @ r78235, committed
2026-03-01) and the ISO (texlive2026-20260301.iso); item 2 chose the `.0` tag
precisely for that freeze-date coherence, and the epoch now rides it. (3)
Annual-rebase semantics: tying the epoch to the TL freeze date makes each year's
build self-descriptive (the stamp tracks the sources, not the fork point);
keeping the busytex commit epoch would stamp every future annual build with the
same fork-point date. The .fmt formats embed this via FORCE_SOURCE_DATE, so it
reaches the artifacts. Recorded in the build-native.sh comment.

**Work dir: fresh `~/.cache/wasmtex/build/native/busytex-2026`** (WASMTEX_WORK_DIR
default bumped from `busytex`). Reason: the 2023 tree's configure caches
(native/wasm-texlive.cache), staged 2023 source/, dumped .fmt formats and the ISO
texmfrepo staging must not contaminate the 2026 build. Chose a fresh sibling dir
over wiping so the known-good TL 2023 tree stays intact as a fallback until the
rebase is accepted — same additive discipline as the pins.lock 2023/2026
coexistence. Disk: 808 GiB free; the 2026 texmfrepo ISO staging (~from a 6.32 GiB
ISO) + source tree + native/wasm builds fit comfortably alongside the 2023 tree.

**Execution-gate banner (sanctioned build-side pin).** `verify-engine.mjs`
`EXPECT_VERSION` cut over `TeX Live 2023` -> `TeX Live 2026`. This is a build gate
constant, not runtime code (the runtime never asserts a TL year).

**Makefile (ours) URL/reference cutover.** Documentary `URL_texlive` /
`URL_texlive_full_iso` and the illustrative `tags/texlive-*.0` doc-URLs bumped
2023.0 -> 2026.0; `URL_texlive_full_iso_cache` retired empty (busytex's split-ISO
GitHub release existed only for 2023 — the frozen 2026 ISO is pinned + pre-staged
offline by the driver, bypassing the curl rule). The build RULES are
version-agnostic (they operate on `source/texlive/` regardless of TL year). Header
mod-list updated (item-4 cutover bullet).

### Patch re-test outcomes (both RETIRED)

The drift forecast (item 2) flagged zlib 1.2.13->1.3.2 and libpng 1.6.39->1.6.55
landing on the two `TARGET_OS_MAC` patches. Re-tested by extracting the exact
target files from the pinned `texlive-source-2026.0.tar.gz` and inspecting the
guards **before** running prep:

- **`libpng-macos-fp-h` -> RETIRED.** In libpng 1.6.55 the classic-Mac `<fp.h>`
  guard `(... || defined(TARGET_OS_MAC))` is gone entirely; `pngpriv.h` now
  unconditionally `#include <float.h>` then `#include <math.h>` (no
  `TARGET_OS_MAC`, no `<fp.h>` anywhere in the file). Upstream fixed exactly what
  the patch narrowed. Defect cannot occur -> patch removed.
- **`zlib-macos-fdopen` -> RETIRED.** In zlib 1.3.2 the guard collapsed from
  `#if defined(MACOS) || defined(TARGET_OS_MAC)` + the `#ifndef Z_SOLO ... fdopen
  NULL` machinery to just `#if defined(MACOS)`; upstream additionally ADDED
  correct modern-Apple handling (`#ifdef __APPLE__ -> OS_CODE 19`) and a
  `#ifndef OS_CODE -> OS_CODE 3 /* Unix */` fallback. No `TARGET_OS_MAC`, no
  `fdopen` in the 2026 file. Defect cannot occur -> patch removed.

Retirement mechanics: each `.patch` file removed (otherwise prep's
`apply_macos_patches` would fail to apply the stale context against the reorganized
2026 source, aborting the build); each `HEADER.md` kept and rewritten as a RETIRED
archival record (what/why + the TL 2026 upstream-fix evidence + date), so a future
rebaser knows the patch existed and why it is gone. `build/patches/` now has ZERO
active patches -> `apply_macos_patches` is a clean no-op for the 2026 build.

License-audit check (c) previously FAILED closed on zero patches ("expected libpng
+ zlib"). Relaxed (audit is ours): zero active patches is legitimate when every
patch was retired upstream; the check now also enumerates retired dirs and
enforces each keeps a HEADER.md that records the retirement. `license-audit.sh`
green after the change (a/b 4 engine files, c "no active patches — all 2 retired",
d/e green).

### emsdk posture

Per the item-4 decision rule: attempt the build with the pinned emsdk **3.1.43
FIRST** (verified on-host: emsdk at pinned commit d9c66fa2, `emcc --version` ==
3.1.43). Bump ONLY if the newer vendored C++ (harfbuzz 12.3.2, icu 78.2) genuinely
cannot compile — documented errors first, then the minimum exact version, pinned
everywhere in the same breath. Starting the build now with 3.1.43.

### Stage: prep — GREEN (~15 s wall)

Launched 00:14:17Z. Staged into the fresh `busytex-2026` work tree:
- `source/texlive` — TL 2026 engine source tree from `texlive-source-2026.0.tar.gz`
  (strip-components=1). `version.ac`: `tex_live_version = 2026`. texlive.txt
  sentinel 1,409,421 lines.
- `source/expat`, `source/fontconfig` — unchanged pins (expat 2.5.0, fontconfig
  2.13.96).
- `source/texmfrepo` — 6.3 GB from `texlive2026-20260301.iso` via `bsdtar -x`
  (fast on NVMe). `install-tl` + `tlpkg/texlive.tlpdb` present; `archive/` carries
  **14932** `*.tar.xz` packages (incl. the three the Makefile tar-extracts:
  texlive-scripts.r78213, latexconfig.r68923, tex-ini-files.r73863);
  `release-texlive.txt` banner "TeX Live ... version 2026".
- `apply_macos_patches` a clean **no-op** (zero active patches — both retired). No
  "applying patch" / "already applied" lines in the log, confirming the stale
  patch removal was correct (had the .patch files remained, prep would have
  aborted trying to apply their reorganized context).
- build config (Makefile/busytex.c/emcc_wrapper.py) synced into the work tree.
- `SOURCE_DATE_EPOCH=1772323200` confirmed in the stage banner.

Polling mechanism note (for the checkpoint contract): stages run via
`run_in_background` writing a `<stage>.rc` exit-code sentinel + `<stage>.log`;
in-turn polling is a bounded `timeout N bash -c 'until [ -f rc ]; do sleep K;
done'` condition-wait (NOT a bare foreground sleep, NOT a Monitor). Confirmed
working on prep.

### Stage: native — DRIFT #1 (ICU 78 / C++17), FIXED in the Makefile

First native attempt (launched 00:22Z) FAILED at rc=2 after ~9 min, in the XeTeX
static lib (`build/native/texlive/texk/web2c/busytex_libxetex.a`, Makefile:419),
compiling `xetexdir/XeTeXLayoutInterface.cpp`. 20 errors, all from ICU 78 public
headers included by XeTeX:

    icu/include/unicode/char16ptr.h:429: error: no template named 'is_pointer_v'
      in namespace 'std'; did you mean 'is_pointer'?
    icu/include/unicode/stringpiece.h:135: error: no template named 'is_same_v' ...
    icu/include/unicode/bytestream.h:272: error: no template named 'void_t' ...

**Root cause.** `std::is_pointer_v` / `is_same_v` / `void_t` are C++17 library
features. ICU 78.2 (TL 2026, up from ICU 70.1 at TL 2023 — item-2 drift table)
uses them in its PUBLIC headers, so any consumer that includes them must compile
as C++17. TL's build force-adds `-std=c++17` only inside the ICU subdir (visible
in the log: "configure: Adding CXXFLAGS option -std=c++17") and otherwise relies
on the compiler DEFAULTING to >=C++17 — which Linux gcc 11+/clang 16+ do (gnu++17).
The XeTeX compile command carried NO `-std=` at all, so it used the host default.
Verified on-host: **Apple clang 21.0.0 defaults to `__cplusplus = 201402L` (C++14)**
— so `is_pointer_v` is not exposed and XeTeX fails against ICU 78 headers. This is
exactly the "expected C++ drift" the item-2 table flagged for icu 70->78, but it
bit at the NATIVE compiler (Apple clang), not emsdk — the native host compiler is
older-in-effective-default than the reference Linux toolchain, independent of the
emsdk question.

**Fix (layer: our Makefile).** Introduced `CXXSTD = -std=gnu++17` and threaded it
through the C++ compiles: `CXXFLAGS_native` (flows to the native configure and the
native xetex/pdftex/xdvipdfmx CXX), `CXXFLAGS_TEXLIVE_wasm` (wasm configure), and
the wasm engine `CXX=` lines (XeTeX/pdfTeX/xdvipdfmx). Chose **gnu++17** over strict
c++17: it is the reference Linux platform's effective web2c standard (gcc defaults
to gnu++, not strict c++), a minimal bump from the gnu++14 host default, and keeps
the GNU extensions the tree's already-compiled C++ files used — lowest risk of a
strict-mode regression in a sibling file. Applied to the CXX side only (a C++ std
on a C compile warns/errs). This is a config-owned compiler-flag fix, not a source
defect, so the Makefile (ours) is the correct layer — no patch. Header mod-list
updated.

Verification before the long rebuild: re-ran the exact failing compile with
`-std=c++17` added -> exit 0, clean object (21904 B). Then cleaned the XeTeX C++
layout objects (`xetexdir/*.o` + `libxetex.a` + `busytex_libxetex.a`) so they
rebuild uniformly at gnu++17 (the pre-error objects had compiled at gnu++14; the
big generated web2c C objects and xetexdir/image/*.o are unaffected — they are C
or non-ICU C++). Note for M3: the container from-scratch build compiles the whole
tree uniformly at gnu++17; this dev-native resume is functionally equivalent
(gnu++14/gnu++17 objects are ABI-compatible under one libc++). Re-synced the
Makefile into the work tree (via prep) and relaunched native at 00:31Z.

### Stage: native — DRIFT #2 (zisbitset duplicate symbol), FIXED in the Makefile

Second native attempt got PAST XeTeX (C++17 fix confirmed: zero is_pointer_v/
is_same_v/void_t errors this run) and past pdfTeX compilation, then FAILED at the
FINAL multicall link (`build/native/busytex`, Makefile:420) with:

    ld: warning: ignoring duplicate libraries: ...libkpathsea.a, lib.a, libmd5.a
    duplicate symbol '_zisbitset' in:
        .../build/native/texlive/texk/web2c/pdftex-pdftex0.o
        .../build/native/texlive/texk/web2c/xetex-xetex0.o
    ld: 1 duplicate symbols

**Root cause.** `zisbitset` is a NEW TL 2026 web2c-generated global function (a "z"
wrapper, `T _zisbitset` — verified via nm) emitted into BOTH pdftex0.c and
xetex0.c by TL 2026's tangle/web2c. It did not exist at TL 2023. The busytex
multicall links xetex+pdftex+bibtex8+xdvipdfmx+makeindex+kpathsea into one binary
and prevents cross-engine global collisions with the `*_REDEFINE` lists
(`-D<sym>=busy<prog>_<sym>`, "needed until wasm-ld supports --localize-hidden").
XeTeX is the unrenamed primary; pdfTeX/bibtex8/xdvipdfmx rename away from it. Since
`zisbitset` is new, it was in no list, so pdfTeX's copy kept the bare name and
collided with XeTeX's. (Only 1 duplicate in the whole link; not present in
bibtex8/xdvipdfmx objects — verified via nm, so PDFTEX_REDEFINE alone suffices.)

**Fix (layer: our Makefile).** Added `zisbitset` to `PDFTEX_REDEFINE` -> pdfTeX's
copy becomes `busypdftex_zisbitset`, XeTeX keeps `zisbitset`, collision gone. This
is the standard busytex collision mechanism; `CFLAGS_PDFTEX` feeds BOTH
`OPTS_PDFTEX_native` and `OPTS_PDFTEX_wasm`, so the single list entry fixes the
native AND the (upcoming) wasm link. A `-D` macro renames the symbol consistently
across every pdfTeX TU (definition + all references), so the engine stays
internally consistent. Config-owned, no source defect -> Makefile, not a patch.
Comment added above the redefine block. Forced a clean pdfTeX object rebuild (rm
the 25 pdftex-*.o / pdftexdir/*.o / libpdftex.a / busytex_libpdftex.a) so every
pdfTeX TU recompiles with the new `-Dzisbitset=busypdftex_zisbitset`; re-synced the
Makefile and relaunched native.

### Stage: native — GREEN (after drifts #1 + #2)

Third native attempt: rc=0. Binary `build/native/busytex` = **31,639,288 B**, Mach-O
64-bit arm64 (TL 2023 lua-free native was 30,294,664 B -> +1,344,624 B / +4.4%,
expected from the newer/larger harfbuzz 12 + icu 78). Benign link warnings only:
"ignoring duplicate libraries" (Apple ld dedups the .a listed twice), "reducing
alignment of section __DATA,__common" (alignment note), and "pattern recipe did
not update peer target build/native/busytex.js" (the `busytex`/`busytex.js` rule
has two targets; native builds only the former).

Native multicall smoke (validates the fixes end to end):
- `xetex --version`   -> `XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026_busytexnative)`
- `pdftex --version`  -> `pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026_busytexnative)`
  (confirms the zisbitset rename is transparent — pdfTeX runs)
- `bibtex8 --version` -> `8-bit Big BibTeX version 0.99d-x4.03 (TeX Live 2026)`
- `xdvipdfmx --version` -> `xdvipdfmx Version 20260113 ...`
- `kpsewhich` dispatch -> `kpathsea version 6.4.2`
All engines dispatch; banner is **TeX Live 2026**. Engine version bumps vs 2023:
XeTeX 0.999996 -> 0.999998, kpathsea -> 6.4.2. Proceeding to basic.

### Stage: basic — GREEN

rc=0 (install-tl off the local texmfrepo + format dump, ~fast). fmtutil dumped the
full scheme-basic format set (incl. lua* formats built by HOST TeX — the documented
item-3 non-hermetic leak; those outputs are pruned, never shipped). The load-bearing
prune left exactly the RETAINED set:
- `xetex/xelatex.fmt`  = 4,472,954 B
- `pdftex/pdflatex.fmt` = 2,286,489 B
and removed all other pdftex/xetex/lua/dev/plain formats + `luahbtex/ luatex/ tex/`
whole dirs + `bin/ tlpkg/ doc/ scripts/ source/ install-tl*`. Format paths
(`pdftex/pdflatex.fmt`, `xetex/xelatex.fmt`) match the runtime FORMAT_* constants —
item 5 re-verifies the MEMFS layout deliberately; here they land where expected.
Proceeding to wasm.

### Stage: wasm — DRIFT #3 (3 common-symbol duplicates, wasm-ld only), FIXED

First wasm attempt: the C++ dependency tree built cleanly under emsdk 3.1.43's
clang (libharfbuzz/libicuuc/libicudata/libfreetype/libgraphite2/libTECkit/
libpplib/libxpdf/libpng/libz all produced — the CXXSTD=gnu++17 fix carried to
wasm, and NO other emsdk-clang compile failure), the ICU locale data packaged,
and all engines compiled. It then FAILED at the final wasm link (Makefile:428):

    wasm-ld: error: duplicate symbol: savearitherror
    wasm-ld: error: duplicate symbol: oldselectorignorederr
    wasm-ld: error: duplicate symbol: outputcanend
      >>> defined in .../xetexdir/xetex-xetexextra.o
      >>> defined in .../pdftexdir/pdftex-pdftexextra.o

Note `zisbitset` is ABSENT from this list — the drift-#2 redefine fixed it for the
wasm link too (confirming CFLAGS_PDFTEX covers both toolchains).

**Root cause (why native passed but wasm failed).** All three are **COMMON symbols**
(tentative definitions, nm type 'C' — verified) newly emitted by TL 2026 into both
pdftexextra.o and xetexextra.o. Apple ld64 COALESCES common symbols (merges same-name
tentative defs), so the native multicall link merged them silently and passed;
**wasm-ld does not coalesce commons and reports them as duplicates.** In a normal TL
build xetex and pdftex are SEPARATE executables, so these never collide there — the
collision is specific to busytex's multicall link, which is what the `*_REDEFINE`
lists exist to resolve.

**Completeness (no whack-a-mole).** Rather than iterate, computed the full collision
set = the intersection of the GLOBAL (uppercase-nm-type: T/D/B/C/S/R) defined symbols
of the xetex core objects vs the pdftex core objects. Result: **exactly these three**
(all 'C'); `zisbitset` no longer intersects (renamed); none in bibtex8/xdvipdfmx.

**Fix (layer: our Makefile).** Added `savearitherror oldselectorignorederr
outputcanend` to `PDFTEX_REDEFINE` (alongside zisbitset) -> pdfTeX gets its own
storage (busypdftex_*), more correct for a multicall than native's silent common
merge, and wasm-ld is satisfied. Rebuilt native pdfTeX too (not strictly needed — the
native binary isn't shipped and already served basic + wasm-tool-seeding — but it
keeps the on-disk binary coherent with the config and validated the renames cheaply):
native rc=0, binary 31,639,496 B (+208 B), `pdftex/xetex --version` both run, banner
TeX Live 2026. Relaunched wasm (resume: pdfTeX recompile + relink; deps/libxetex/icu
data all preserved).

### Stage: wasm — GREEN (after drift #3)

rc=0. Outputs:
- `busytex.wasm` = **27,524,414 B** (TL 2023 lua-free: 26,369,418 B -> +1,154,996 B
  / +4.4%, from harfbuzz 7->12 + icu 70->78 + freetype/xpdf bumps).
- `busytex.js` = **273,991 B** (byte-identical to the TL 2023 loader — the emscripten
  JS glue is templated off the export list, not the wasm content).

### emsdk decision: KEPT at 3.1.43 (NO bump)

Per the item-4 decision rule (bump ONLY if the build genuinely requires it): the
pinned **emsdk 3.1.43** compiled ALL of TL 2026's newer vendored C++ — harfbuzz
12.3.2, icu 78.2, freetype 2.14.1, teckit, graphite2, pplib, xpdf 4.06 — and linked
the wasm multicall, with the ONLY code change being the CXXSTD=-std=gnu++17 flag
(which is a C++-standard-selection issue, NOT an emsdk-capability issue: emsdk
3.1.43's clang (LLVM 17) already DEFAULTS to gnu++17, so the flag was strictly
needed for the NATIVE Apple-clang path and is belt-and-suspenders on wasm). No
compiler-capability failure (no "unknown attribute", no unsupported C++ feature, no
libc++ gap) surfaced under 3.1.43. Therefore the emsdk pin is UNCHANGED; pins.lock
[toolchain-image], native-host.md, native-env.sh, the toolchain README and the
Dockerfile all stay as-is. The two drift fixes were both TeX-Live-source drifts
(ICU's C++17 header requirement; new multicall-colliding globals), resolved in our
Makefile — not toolchain problems. The M0-era container image claims are therefore
NOT invalidated by an emsdk change (there is none); M3's container re-pin inherits
3.1.43 unchanged.

### Stage: bundle — GREEN

rc=0. `texlive-basic.data` = 52,775,230 B; `texlive-basic.js` = 1,459,979 B.

### Stage: dist — GREEN, EXECUTION GATE PASSED (TeX Live 2026 banner)

rc=0. dist/ assembled: busytex.js/.wasm, texlive-basic.js/.data, formats/{pdflatex,
xelatex}.fmt, SHA256SUMS, assets.json. gen-assets classified **7 assets** into the
same 6 roles as TL 2023 (bundle-data, bundle-js, checksums, engine-js, engine-wasm,
format x2) — no glue role, no unclassified artifact (roles unchanged, as designed).
`assets.json generated=2026-03-01T00:00:00.000Z` confirms SOURCE_DATE_EPOCH=1772323200.

Execution gate (verify-engine.mjs):
- assets.json parses (7 entries).
- wasm imports: **60 total, 53 from "env"** (ceiling 150) — SOUND (identical to the
  TL 2023 53; not the hollow-archive 363).
- `xetex --version` exit 0, banner **"XeTeX 3.141592653-2.6-0.999998 (TeX Live
  2026_busytexwasm)"** -> gate assertion "reports TeX Live 2026" PASSED.
- The engine's own version dump confirms EVERY item-2 drift-table library linked at
  the forecast version: **ICU 78.2, zlib 1.3.2, FreeType2 2.14.1, Graphite2 1.3.14,
  HarfBuzz 12.3.2, libpng 1.6.55**, pplib v2.2, fontconfig 2.13.96 (the un-repinned
  pin — decision holds). zlib 1.3.2 + libpng 1.6.55 are the two retired-patch targets,
  confirmed linked and working.

### dist inventory + size deltas vs TL 2023 (lua-free, M2 item 3 baseline)

| Artifact | TL 2023 | TL 2026 | Delta |
| --- | --- | --- | --- |
| busytex.wasm | 26,369,418 | 27,524,414 | +1,154,996 (+4.4%) |
| busytex.js | 273,991 | 273,991 | 0 (templated loader) |
| texlive-basic.data | 59,247,516 | 52,775,230 | -6,472,286 (-10.9%) |
| texlive-basic.js | 1,433,972 | 1,459,979 | +26,007 (+1.8%) |
| formats/pdflatex.fmt | 6,477,728 | 2,286,489 | -4,191,239 (-64.7%) |
| formats/xelatex.fmt | 8,714,792 | 4,472,954 | -4,241,838 (-48.7%) |
| (native busytex) | 30,294,664 | 31,639,496 | +1,344,832 (+4.4%) |

- wasm/native +4.4%: harfbuzz 7->12 + icu 70->78 + freetype/xpdf bumps (bigger code).
- bundle data -10.9%: TL 2026 scheme-basic TDS is smaller than 2023's.
- **.fmt formats -~4.2 MB EACH (near-constant absolute drop, not proportional)**:
  both pdflatex.fmt and xelatex.fmt shed ~4.2 MB, pointing at a SHARED preloaded
  block present in 2023 but not 2026 (most likely hyphenation-pattern preloading,
  which LaTeX/TL changed in recent years to preload fewer patterns). The formats
  DUMPED successfully; whether they LOAD+typeset is validated by the runtime suite
  below (a format-load failure there would be a real defect; a byte/text-shape
  difference is expected fixture churn for item 6). FLAGGED for item 5 (formats +
  dist pruning re-verifies the FORMAT_* MEMFS constants against the TL 2026 TDS).

### Verification: runtime suite (typecheck + vitest) — 179/186, 7 XeTeX failures

`npm run typecheck` (runtime/): CLEAN. `npm test` (vitest run): **179 passed, 7 failed**
(9 of 10 test files fully green; all 7 failures in `typeset-integration.test.ts`, the
real-wasm tests). The 7 failures are ALL XeTeX/xelatex; every pdfTeX and unit test
passes. This is NOT fixture churn — it is a CONFIRMED functional regression (below).

#### CRITICAL FINDING — ICU 78 converter-alias-table not loaded -> XeTeX broken on wasm

**Symptom.** Every wasm XeTeX/xelatex compile aborts at font-manager init:
`internal error; cannot read font names` (exit 3). Source:
`xetexdir/XeTeXFontMgr_FC.cpp:326` in `XeTeXFontMgr_FC::initialize()`, which does
`ucnv_open("macintosh"/"UTF16BE"/"UTF8", &err)` then `if (err != 0) exit(3)`.

**Root cause (confirmed, version-attributed).** Direct probes of the BUILT ICU
(tiny harness linking libicuuc + libicudata, run against each build):
- TL 2026 ICU **78.2**: `ucnv_countAvailable() = 0`; `ucnv_open` by CANONICAL name
  works (`macos-0_2-10.2`, `ISO-8859-1`, `US-ASCII`, algorithmic UTF-8/16BE) but by
  ALIAS FAILS with `U_FILE_ACCESS_ERROR` (`macintosh`, `ibm-942`, `Shift_JIS`,
  `windows-1252`).
- TL 2023 ICU **70.1** (same busytex build config, unchanged): `countAvailable = 232`;
  `ucnv_open("macintosh") = U_ZERO_ERROR` (ok).
So ICU 78's runtime is NOT loading the converter **alias table** (`cnvalias.icu`),
even though `cnvalias.icu` IS present in the built data package (verified: it is in
`.../data/out/build/icudt78l/cnvalias.icu` and the `icudt78l.dat` TOC — 1 hit, same
as 2023's icudt72l.dat). XeTeX asks for the ALIAS "macintosh"; with no alias table
ICU can't resolve it -> `U_FILE_ACCESS_ERROR` -> "cannot read font names" -> exit 3.

**Scope / attribution.** NATIVE ICU 78 has the SAME `countAvailable = 0` (native
XeTeX dodges it — it uses the CoreText font manager `XeTeXFontMgr_Mac`, not `_FC`, so
`ucnv_open` is never called; that is why native `xetex --version`, the execution gate,
and all pdfTeX paths pass). This is therefore a genuine **ICU 70->78 data-build /
data-load regression** in the busytex-style custom ICU packaging, NOT caused by any
item-4 edit (CXXSTD / redefines don't touch ICU data) and NOT a test-harness artifact.
pdfTeX is fully functional end to end (uses TFM fonts, no ICU converters).

**Why this is journaled, not fixed here (scope + discipline).** Item-4 acceptance
("dist/ assembles, gate green") is MET; the task scopes runtime-suite breakage to
items 5/6 and says report+journal, don't fix, in item 4. This is beyond fixture
regen — it is a real build defect — but the fix is a deep ICU-78 data-packaging
investigation (the alias table is packaged yet not loaded at runtime; likely an ICU
78 data-TOC / packaging-mode change vs ICU 70), with multi-cycle ICU+wasm rebuilds
(~30-40 min each). Rabbit-holing it here risks the thrash the checkpoint rule warns
against. **Flagged as the #1 blocker for M2 to actually ship XeTeX.**

**Fix direction for the next agent (head start):**
- The defect is in the ICU **data build** (native AND wasm share it), reproducible in
  seconds with a libicuuc+libicudata probe of `ucnv_countAvailable()` (expect 0 now,
  must be > 0). Fast iterate against NATIVE ICU — no wasm rebuild needed to test the
  data fix; only the final artifact needs the wasm ICU rebuilt.
- `cnvalias.icu` is generated (gencnval) and IS in the package, so it is a LOAD/TOC
  issue, not an exclusion. Investigate ICU 78's data packaging vs the busytex config:
  the `--without-assembly -O icupkg.inc` pkgdata path, the data TOC/package name, and
  any ICU 78 change to how `cnvalias` is registered/looked up. Compare the icudt78l
  vs icudt72l `.dat` TOC layout. Consider whether ICU 78 needs a data-packaging-mode
  or gencnval flag the version-agnostic busytex Makefile does not supply.
- Layer: most likely our Makefile's ICU build rule (build/engines/Makefile
  `build/%/texlive/libs/icu/...` + `OPTS_ICU_*`), possibly a small ICU source/config
  patch (build/patches/) if ICU 78 needs one.

#### Breakage inventory for item 6 (the 7 failing integration tests)
All in runtime/test/typeset-integration.test.ts; all XeTeX, all the SAME ICU root
cause above (result.ok=false / missing 'Undefined control sequence' because XeTeX
exits 3 before parsing):
1. "compiles hello-world through xetex -> xdvipdfmx to a valid PDF"
2. "multiple jobs on one host: a failing compile surfaces the TeX error"
3. "reruns a \label/\ref document ... until cross-references resolve" (xelatex)
4. "compiles a bibtex8 document end to end (xelatex -> bibtex8 -> reruns -> xdvipdfmx)"
5. "compiles hello-world through the PUBLIC createTypesetter API to a valid PDF"
6. "cancelling a just-dispatched compile ... next job compiles on a fresh instance"
7. "a deliberately broken document yields structured diagnostics" (xetex exits 3)
NOTE: these are NOT fixture-text mismatches — they are ALL blocked by the ICU defect.
Once ICU converter aliases load, re-run; any REMAINING diffs (banner/log cosmetics,
PDF bytes) are then the genuine item-6 fixture-regen work. pdfTeX-only tests already
pass, so the harness + runtime are sound.

### Verification: demo smoke (Playwright) — 1/4 (was 4/4 on TL 2023)

`npm test` (demo/): **1 passed, 3 failed**. Same ICU root cause — the 3 failures are
all XeTeX; the 1 pass is pdfTeX. Consistent with the runtime suite.
- PASS: pdfTeX text-bearing PDF.
- FAIL: "hello-world (XeTeX) compiles to a valid, text-bearing PDF" — `internal error;
  cannot read font names` (exit 3).
- FAIL: "a deliberately broken document surfaces structured diagnostics (§8)" — XeTeX
  exits 3 before the intended `\undefined` error is reached.
- FAIL: "cancel() ... next compile succeeds on a fresh worker (§5.2)" — the post-cancel
  follow-up is a XeTeX compile -> font error. (The cancel/lifecycle mechanics are fine;
  it fails only because its follow-up job is XeTeX.)
Once the ICU alias fix lands, all three should recover (modulo genuine item-6 fixture
cosmetics). No demo/runtime CODE change is warranted — the failures are 100% the engine
ICU defect, not the runtime, worker, or harness.

### Item 4 — outcome summary

`make artifacts` COMPLETES against the TL 2026 pins: prep -> native -> basic -> wasm ->
bundle -> dist, execution gate GREEN asserting the **TeX Live 2026** banner. Stage
results: prep GREEN; native GREEN (after drift #1 ICU-C++17 + drift #2 zisbitset);
basic GREEN; wasm GREEN (after drift #3 three common-symbol renames); bundle GREEN;
dist GREEN + gate PASSED. gen-assets: 7 assets / same 6 roles (unchanged). License
audit GREEN (patch HEADERs retired + check (c) relaxed). emsdk KEPT at 3.1.43 (no
bump). Both TL 2023 macOS patches RETIRED (defects fixed upstream in libpng 1.6.55 /
zlib 1.3.2). SOURCE_DATE_EPOCH cut to the TL 2026 freeze (1772323200). Fresh
`busytex-2026` work tree; TL 2023 tree preserved as fallback.

**Acceptance for item 4 (dist/ assembles, gate green): MET.**

**Known blocker carried forward (NOT an item-4 acceptance item):** wasm XeTeX cannot
typeset — ICU 78 converter-alias-table load regression (root cause fully characterized
above). pdfTeX is fully functional. This must be fixed before M2's corpus/acceptance
(items 5-9) can pass for XeTeX. Flagged as the #1 follow-up.
**[RESOLVED in item 4b below — pointer-TOC vs offset-TOC data packaging; ucnv
countAvailable 0 -> 232, runtime 179/186 -> 186/186, demo 1/4 -> 4/4.]**

Deviations from DESIGN.md: none (native-first dev build per §9; only container-built
artifacts release; the banner + epoch are sanctioned build-side pins). No DESIGN.md
edits needed.

---

## Item 4b — Fix the ICU 78 converter-alias blocker (pre-item-5 unit)

Dated 2026-07-23. Goal: fix the #1 blocker item 4 characterized — wasm XeTeX aborts
at `XeTeXFontMgr_FC.cpp:326` "internal error; cannot read font names" because ICU 78's
`ucnv_open("macintosh")` returns `U_FILE_ACCESS_ERROR` and `ucnv_countAvailable()=0`.
Provenance: only ICU 78.2 sources (the pinned TL 2026 vendored ICU) and ICU's own
tools were read; no GPL/AGPL WASM-TeX wrapper source was opened. Written as the work
ran. Per the fix-direction head start (item 4), iterated on NATIVE ICU first (seconds,
no wasm rebuild) and confirmed the mechanism before touching wasm.

### Root cause (exact mechanism — pinned to two ICU source lines)

Built a native probe (`ucnv_countAvailable`, `ucnv_open` by alias vs canonical, plus
a direct `udata_openChoice(NULL,"icu","cnvalias",...)` and a UDataInfo header dump)
linking the built `libicuuc.a` + `libicudata.a`. It reproduced the item-4 symptom
exactly AND localized it:

- `u_init()` returns **`U_INVALID_FORMAT_ERROR`**; `ucnv_countAvailable()=0`; every
  alias (`macintosh`, `ibm-942`, `Shift_JIS`, `windows-1252`) fails
  `U_FILE_ACCESS_ERROR`; every canonical converter (`macos-0_2-10.2`, `ISO-8859-1`,
  `US-ASCII`, `UTF-8/16BE`, `ibm-943_P15A-2003`) opens fine.
- A DIRECT `udata_openChoice(NULL,"icu","cnvalias", accept_all, ...)` **succeeds**
  (data present + loadable), and the runtime cnvalias `UDataInfo` passes EVERY field of
  the strict `ucnv_io.cpp:isAcceptable` (size=20, LE, ASCII family, `dataFormat=CvAl`,
  `formatVersion[0]=3`). So the data is NOT missing and NOT format-rejected — the item-4
  "alias table not loaded" framing is correct but the reason is one layer deeper.

The defect is in `common/ucnv_io.cpp initAliasData()` (ICU 78), lines 250-255:

    int32_t dataLength = udata_getLength(data); // length minus the UDataInfo size
    if (dataLength <= int32_t(sizeof(sectionSizes[0]))) {   // <= 4
        goto invalidFormat;                                 // "We don't even have a TOC!"
    }

`udata_getLength()` returns **-1** for our data, so `-1 <= 4` -> `goto invalidFormat`
-> `U_INVALID_FORMAT_ERROR` -> `gAliasData` stays null -> countAvailable 0 -> aliases
unresolvable -> XeTeX exit 3. WHY -1: our ICU data is packaged as a **pointer-TOC**
(`common/ucmndata.cpp pointerTOCLookupFn`, line 298 hard-codes `*pLength=-1` for every
item — pointer-TOC items are separately-linked symbols, so item lengths are not
derivable), whereas an **offset-TOC** (`offsetTOCLookupFn`, line 251) computes a real
`*pLength = entry[1].dataOffset - entry->dataOffset`. Canonical `.cnv` converters don't
consult the length (they parse their own headers), so ONLY the alias-table load — the
one code path that length-validates its TOC — breaks. **This length gate is new since
ICU 70** (TL 2023): ICU 70's `initAliasData` did not reject pointer-TOC data on length,
so the identical busytex packaging gave `countAvailable=232` there. Not an item-4 edit
(CXXSTD/redefines don't touch ICU data); a genuine ICU 70->78 behavior change meeting
busytex's long-standing pointer-TOC packaging.

WHY we ship a pointer-TOC: the busytex ICU build passes `pkgdata --without-assembly`
(the Makefile's `PKGDATAFLAGS_ICU_*` — wasm/Cosmopolitan can't assemble arch `.s`),
and `PKGDATA_MODE` defaults to `static`. pkgdata's no-assembly static path
(`pkgdata.cpp pkg_createWithoutAssemblyCode`) hard-calls `createCommonDataFile(...,
sourceTOC=true, ...)` (pkgdata.cpp:1626) which makes `gencmn` emit a `{name, &symbol}`
**pointer-TOC** source plus one `genccode` object per data item (verified: our
`libicudata.a` = `icudt78l_dat.o` TOC + 4089 individual `*_res/_cnv/_brk/_dict.o`,
TOC entry `{ "icudt78l/cnvalias.icu", icudt78l_cnvalias_icu }`). pkgdata has no flag to
emit an offset-TOC without assembly — the assembly path (`pkg_createWithAssemblyCode`,
`genccode -a`) is the only in-tree offset-TOC producer, and assembly is exactly what
wasm can't use.

### Fix (layer: our Makefile) — repackage libicudata.a as a single-blob offset-TOC

pkgdata still builds the complete `icudt78l.dat` (21.9 MB, internal offset-TOC) as its
intermediate. The fix regenerates `libicudata.a` from THAT: `genccode` (no `-a`) turns
the whole `.dat` into ONE `const uint8_t icudt78_dat[]` C blob; compiling + archiving it
yields a single-object `libicudata.a` whose runtime TOC is an **offset-TOC**, so
`udata_getLength()` returns real lengths and the alias load passes. `genccode` output is
portable C (a byte array + the `icudt78_dat` entry point), so the SAME transform serves
native (cc) and wasm (emcc) — no assembly, satisfying the original `--without-assembly`
constraint. This lands in OUR Makefile (build/engines/, the ICU build rule), not a
patch: it is a packaging/linker-layer choice, and the ICU sources are untouched.

Minimality/robustness: XeTeX's `_FC` font manager needs the converter alias table to
resolve TrueType `name`-table encodings — `macintosh` (Mac Roman), plus `UTF16BE`/`UTF8`
(algorithmic, already fine). The single-blob offset-TOC restores the FULL alias table
(`countAvailable` 0 -> 232, matching ICU 70), so it is not a narrow per-converter hack;
it fixes the packaging so ICU's own data loads as ICU expects. The `.dat` is unchanged
data — only its container object changes (pointer-TOC split -> single offset-TOC blob).

### Native proof (before any wasm rebuild)

Reused the built `icudt78l.dat`: `genccode -e icudt78 icudt78l.dat` ->
`icudt78l_dat.c` (66 MB, symbol `icudt78_dat`) -> `cc -O2 -std=c11 -fno-common -c` ->
one 21.9 MB object -> `ar -crs libicudata_single.a`. Relinked the probe against
`libicuuc.a` + this single-object archive:

    BEFORE (pointer-TOC):  u_init=U_INVALID_FORMAT_ERROR  countAvailable=0
                           ucnv_open("macintosh")=U_FILE_ACCESS_ERROR
    AFTER  (offset-TOC):   u_init=U_ZERO_ERROR            countAvailable=232
                           ucnv_open("macintosh")=U_ZERO_ERROR  (converter opens)

`countAvailable=232` is byte-for-byte the TL 2023 ICU 70 value from item 4's differential
probe — the alias table is now fully live. (`Shift_JIS`/`windows-1252` report
`U_AMBIGUOUS_ALIAS_WARNING`, ICU's normal "this alias maps to >1 converter" signal, not
an error; the converter still opens.) Mechanism confirmed; proceeding to the Makefile
integration + wasm rebuild.

### Makefile integration (build/engines/Makefile — the ICU build rule)

Added to the `build/%/.../libicuuc.a .../libicudata.a` rule, after the ICU make: a
target-agnostic repackaging that globs pkgdata's `icudt*l.dat`, `genccode -e <ep>`s it
to a single-blob C, compiles with `$(CC_$*)` (`cc`/`emcc`), and `rm`+`$(AR_$*) -crs`
replaces `libicudata.a` with that one object. Derives all names from the `.dat`
basename (`datbase=icudt78l`, `ep=icudt78` via `basename l.dat`) so no ICU major
version is hard-coded (annual-rebase-robust). New var `GENCCODE_native` points at the
native genccode (a native tool emitting portable C — the same binary serves both
targets, exactly like the CCSKIP native icupkg/pkgdata reuse). Applied to native AND
wasm to keep the two ICU builds coherent (and for M3's uniform container build). The
Makefile DERIVED-WORK header mod-list gained an item-4b bullet.

Make-expansion validated by `make -B -n` on both targets: the wasm branch expands to
`<native genccode> -e "$ep" ... && emcc -Oz -I.../build/wasm/.../icu/include -c
...${datbase}_dat.c -o ...${datbase}_dat.o && emar -crs build/wasm/.../libicudata.a
...` — correct toolchain substitution (`emcc`/`emar`/`-Oz`/wasm include). One forcing
subtlety learned: removing only `libicudata.a` in an INCREMENTAL tree makes the ICU
subtree's `icubuild` step fail at its own `test -r libicudata.a` (the data build is
timestamp-satisfied and won't regenerate it); removing the `data/packagedata` timestamp
too lets pkgdata rebuild its pointer-TOC first, after which our step overwrites it. In a
CLEAN build (M3 container) the data step always produces the `.a` first, so the recipe
is a clean no-forcing pass. The wasm ICU rule also needs the emsdk on PATH (`emconfigure`
lives in `$(EMROOT)`) — run via the driver, which sources `build/toolchain/native-env.sh`.

### Build (real make recipe, not the hand-run) + timings

- **native ICU rebuild** via make (full rule: reconfigure + incremental ICU make +
  pkgdata pointer-TOC regen + our genccode/cc/ar repackaging): **107.9 s**. Result:
  `libicudata.a` = ONE object `icudt78l_dat.o`, 21,953,944 B (was 23,365,784 B
  pointer-TOC, 4090 objects). Probe against the make-produced archive: `u_init`
  U_ZERO_ERROR, `countAvailable=232`, `macintosh` opens. (This is the real Makefile
  path — the earlier native proof was the identical commands by hand.)
- **wasm ICU rebuild** via make (same rule, `$*`=wasm; the emcc 66 MB single-blob
  compile is the long pole): **341.3 s** (~5.7 min). Result: `libicudata.a` = ONE
  object `icudt78l_dat.o`, 21,953,726 B (was 22,988,052 B pointer-TOC, 2047 objects).
- **wasm relink** (`busytex.js`/`.wasm`, forced by removing the outputs): **4.7 s**.
  `busytex.wasm` 27,524,414 -> **27,508,145 B** (-16,269 B — the single offset-TOC blob
  is marginally smaller than the pointer-TOC's 2044-entry TOC + per-object overhead).
  The link resolved `icudt78_dat` with no undefined-symbol error (only the pre-existing
  benign `getpass` warning), confirming the entry point is correct on wasm. `busytex.js`
  byte-identical (273,991 — templated loader, unaffected).
- **native relink** (coherence; native XeTeX uses CoreText `_Mac`, not `_FC`, so it
  never hit the bug — relinked so the on-disk binary matches the config): **3.7 s**.
  `busytex` 31,639,496 -> 31,484,952 B. Confirms the incremental design: with a fresh
  `libicudata.a` present, `make native` SKIPPED the ICU rule (no genccode re-run) and
  only relinked — so a from-source M3 build and this dev resume converge.
- **dist reassembly + execution gate**: 1.1 s. Only `busytex.wasm` changed; the bundle
  (`texlive-basic.data/.js`) and the `.fmt` formats are untouched by the ICU data fix.

### Acceptance (the real gates)

- **Execution gate** (`verify-engine.mjs`): **PASSED**. `assets.json` 7 entries; wasm
  imports 60 total / 53 from `env` (sound, not the hollow 363); `xetex --version` exit 0,
  banner **"TeX Live 2026_busytexwasm"**.
- **Runtime suite** (`runtime/`): `typecheck` clean; `vitest` **186/186** (10/10 files),
  up from item 4's **179/186**. All 7 previously-failing `typeset-integration.test.ts`
  XeTeX tests flipped GREEN (hello-world xetex->xdvipdfmx PDF; failing-compile TeX error;
  \label/\ref rerun; bibtex8 end-to-end; public-API PDF; cancel+fresh-instance; broken-doc
  diagnostics). **Zero remaining failures**, so NO item-6 fixture churn surfaced in the
  runtime suite — the ICU fix restored XeTeX without perturbing the golden fixtures (the
  suite matches the TL 2023 baseline count).
- **Demo smoke** (Playwright, `demo/`): **4/4**, up from item 4's **1/4**. All three
  XeTeX-path failures recovered (XeTeX text-bearing PDF + clean diagnostics; broken-doc
  file+line diagnostics; cancel()+fresh-worker XeTeX follow-up); the pdfTeX test still
  passes. No demo/runtime CODE change was needed — the failures were 100% the engine ICU
  defect, as item 4 predicted.
- **License audit**: green (a/b 4 build/engines files all SPDX MIT incl. the edited
  Makefile; c/d/e unchanged).

### Failure classification (per the acceptance ask)

Every failure item 4 attributed to the ICU blocker (7 runtime + 3 demo) is now GREEN.
Nothing remains in the "ICU-caused" bucket. The item-6 fixture-churn bucket is EMPTY for
these suites: had the ICU fix altered PDF bytes/log cosmetics, the golden-fixture asserts
would still diff — they do not. (Item 6's fixture-regen scope stands on its own for any
NON-ICU TL-2026 drift the corpus surfaces later; this unit introduced none.)

### Reproducibility / provenance notes

- The transform is deterministic: same `.dat` -> same `genccode` C -> same object, under
  the pinned `SOURCE_DATE_EPOCH`; no new inputs, so the M3 bit-for-bit gate is unaffected.
  Only the CONTAINER of ICU's data changes (pointer-TOC split -> one offset-TOC blob); the
  `.dat` bytes are identical.
- Provenance: only ICU 78.2 sources (pinned TL 2026 vendored ICU) and ICU's own tools
  (genccode/pkgdata) were read to characterize + fix this. No GPL/AGPL WASM-TeX wrapper
  source was opened. The fix is original work in OUR Makefile; ICU sources are untouched
  (no `build/patches/` entry).

### Deviations from DESIGN.md

None. Native-first dev build per §9; only container-built artifacts release; the fix is a
build-config (Makefile) change in the sanctioned layer. No DESIGN.md edit needed. dist/ is
git-ignored (dev artifact); nothing hand-built is committed.

### Status

**ICU 78 converter-alias blocker: RESOLVED.** wasm XeTeX typesets end to end (gate +
186/186 runtime + 4/4 demo). M2 items 5-9 (formats/dist re-verify, fixture regen, corpus,
CJK, wrap-up) are unblocked for XeTeX. The M2 item-4 "outcome summary" blocker note (the
preceding section) is superseded by this one.

---

## Item 5 — Formats + dist verification

Dated 2026-07-23. Three deliberate re-checks of what items 3/4 produced (formats pruned
to xelatex+pdflatex; assets reclassified for free; the FORMAT_* MEMFS constants), closing
the M1 acceptance carry-forward. No artifacts rebuilt — dist/ is item 4b's output; this
item confirms it against the runtime contract. Provenance: only the TL 2026 vendored
sources + the built dist/ were inspected; no GPL/AGPL WASM-TeX wrapper source opened.

### 5.1 — dist/ format + asset inventory (7 assets / 6 roles, lua-free)

`dist/formats/` is EXACTLY `{pdflatex.fmt, xelatex.fmt}` — lua-free: `find dist -iname
'*lua*' -o -iname '*.fmt'` returns only those two (no `lualatex.fmt`/`luahblatex.fmt`
anywhere). `assets.json` (generated `2026-03-01T00:00:00.000Z` — SOURCE_DATE_EPOCH)
classifies 7 assets into 6 roles; every artifact matched a `gen-assets` ROLE_RULE (no
unclassified artifact), and `shasum -a 256 -c SHA256SUMS` verified all six hashed files:

| path | bytes | role |
| --- | --- | --- |
| SHA256SUMS | 509 | checksums |
| busytex.js | 273,991 | engine-js |
| busytex.wasm | 27,508,145 | engine-wasm |
| formats/pdflatex.fmt | 2,286,489 | format |
| formats/xelatex.fmt | 4,472,954 | format |
| texlive-basic.data | 52,775,230 | bundle-data |
| texlive-basic.js | 1,459,979 | bundle-js |

Roles: `{checksums, engine-js, engine-wasm, format×2, bundle-data, bundle-js}` — the same
6 as TL 2023, no glue role (dropped item 3), matching `protocol.ts AssetRole` and the
`assets.test.ts KNOWN_ROLES`. The rebase reclassified structurally (by extension/sibling),
exactly the rebase-proofing payoff the plan predicted.

### 5.2 — MEMFS TDS probe: FORMAT_* constants vs the real TL 2026 TDS (carry-forward CLOSED)

THE deliberate check the M1 acceptance carried forward. Rather than infer the layout from
the tests passing, a node probe loaded the real `EmscriptenEngineHost` against dist/ and
LISTED the mounted MEMFS (the bundle's TDS, mounted at `/texlive` by the file_packager):

- `FS.analyzePath('/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt').exists = true`
  → matches `core.ts` `FORMAT_XELATEX` byte-for-byte.
- `FS.analyzePath('/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt').exists = true`
  → matches `FORMAT_PDFLATEX`.
- `readdir('/texlive/texmf-dist/texmf-var/web2c')` = `[metafont, pdftex, xetex]` (+ an
  `updmap.log`) — NO `luatex`/`luahbtex` engine dirs, so lua-free is confirmed at the TDS
  level, not just in dist/formats/.
- `readdir(.../web2c/xetex)` = `[xelatex.fmt, + fmtutil .log files]`;
  `readdir(.../web2c/pdftex)` = `[pdflatex.fmt, + .log files]` — the `.fmt` files sit at
  exactly the constant paths; the extra `.log` files are harmless fmtutil residue.

The FORMAT_* MEMFS constants are CONFIRMED against the actual TL 2026 TDS layout: the
rebase did NOT move the format paths (the TDS convention `texmf-var/web2c/<engine>/<fmt>`
is rebase-stable, as the M1 constant comment claimed). **The M1 carry-forward — "conformance
catches a layout change" — is formally CLOSED: the deliberate probe shows no change, and had
one occurred the FORMAT_* `--fmt` argv would have failed the real-wasm suite.**

### 5.3 — Why the .fmt files each shed ~4.2 MB (one honest paragraph)

Item 4 flagged a near-constant ~4.2 MB *compressed* drop (xelatex 8.71→4.47 MB, pdflatex
6.48→2.29 MB) and guessed hyphenation preloading. Investigated to the point of a definitive
answer without chasing deeper: **it is NOT fmt compression.** Both TL 2023 AND TL 2026 `.fmt`
are gzip-compressed (magic `1f 8b 08 00` in both years — verified against the TL 2023 tree
preserved in `~/.cache/wasmtex/build/native/busytex/`), so gzip'd fmts predate TL 2023 and
the "zlib'd fmts landed in TL ~2024" hypothesis is rejected. It is also NOT a fmt-dump-format
change: the `W2TX` format identifier + `pdftex` engine tag are byte-identical across years.
The DECOMPRESSED content itself shrank a near-constant ~9-10 MB per format (xelatex
31.45→22.27 MB, −9.18; pdflatex 18.01→7.81 MB, −10.19); the ~4.2 MB compressed drop is just
the gzip shadow of that (the engines' differing compression ratios are why the compressed
drops don't track the uncompressed ones proportionally). A shared block that shrank ~equally
in both LaTeX formats points at reduced preloaded pattern/kernel data between the 2022-11 and
2025-11 LaTeX2e releases (the fixtures' banner moved `LaTeX2e <2022-11-01> patch level 1` →
`<2025-11-01>`); the exact array is not chased further per scope. BENIGN either way: the
smaller formats dump, load (banner `preloaded format=…/xelatex.fmt`), and typeset correctly —
186/186 runtime incl. real xelatex+pdflatex, execution gate green, demo smoke 4/4.

### Item 5 — outcome

All three verifications PASS: dist inventory is the pruned lua-free 7-asset/6-role set with
integrity verified; the FORMAT_* MEMFS constants are confirmed against the mounted TL 2026
TDS (M1 carry-forward closed); the .fmt shrink is a benign content reduction, not a
compression or format change. No deviations. No artifacts touched.

---

## Item 6 — Fixture regeneration (rebase-proofing rule 2)

Dated 2026-07-23. The first real exercise of the regeneration discipline: re-capture all 21
fixtures (12 diagnostics + 9 sequencing) from the TL 2026 dist per the two `GENERATOR.md`
procedures, then read the divergences as the version-agnostic scorecard. Provenance: fixtures
are transcripts of OUR pinned engine; no third-party source consulted.

### Method + the one real friction (a GENERATOR.md finding)

Drove the real `EmscriptenEngineHost` through `createWorkerCore` against dist/ from a
throwaway vitest spec (NOT committed — journal discipline), capturing the `ResultMessage.log`
for diagnostics (the full multi-pass `result.log`) and per-`host.run()` sliced transcripts +
exit codes for sequencing (a thin recording decorator around the host). Overwrote the fixtures
in place and used `git diff` against the committed TL 2023 versions as the oracle. All 18
compiles ran green (structures: crossref `engine→engine→xdvipdfmx`; bibtex `engine→bibtex8→
engine→engine→xdvipdfmx`; makeindex `engine→makeindex→engine→engine→xdvipdfmx`), so no doc
needed reshaping.

**FRICTION → FINDING.** Both `GENERATOR.md` files claimed "the documents … fully specify the
regeneration", but they did NOT: the exact document BODIES were unspecified — the blank-line
fillers that position an error on `l.4`, the `.sty`/`.cls` layout that puts `\PackageWarning`
on line 3 / `\ClassWarning` on line 4, and the 48-`a` overfull box. I reverse-engineered them
from the `l.N` / `on input line N` the old transcripts pin, then FIXED both `GENERATOR.md`:
added a "Source documents (exact)" section giving every fixture's verbatim body + engine +
options + (sequencing) which pass it slices, so the next annual rebase is deterministic. Also
learned + documented the write formula: the engine stream ends each run `…shutdown)\n\n` and
the original generator appended one more newline (fixtures end `…\n\n\n`).

### The version-agnostic scorecard — what HELD

The whole point of rule 2. The parser + detector tests pass with **ZERO test-file changes** —
every expected `Diagnostic[]` and every detector boolean unchanged (`diagnostics.test.ts`
37/37, `sequencing.test.ts` 41/41 against the regenerated fixtures). Every detector-anchored
substring survived the rebase verbatim: `Undefined control sequence.`, `! Emergency stop.`,
`LaTeX Error: File \`…' not found.`, `Reference/Citation \`…' … undefined on input line N`,
`There were undefined references`, `Label(s) may have changed. Rerun to get cross-references
right`, the `Package/Class … Warning:` + folded `(name)` continuation, and the bibtex8 /
makeindex exit codes (0/1/2 and 0). **The three bibtex8 fixtures (`bibtex8-{clean,
warning-undefined-entry,error-missing-bst}`) are BYTE-IDENTICAL to TL 2023** — BibTeX emits
no version banner in these transcripts, the cleanest possible demonstration of the claim.

### The version-agnostic scorecard — what CHURNED (all cosmetic, expected)

- XeTeX banner `0.999995` → `0.999998`; `TeX Live 2023` → `2026`.
- `LaTeX2e <2022-11-01> patch level 1` → `LaTeX2e <2025-11-01>` (the ` patch level 1` suffix
  is gone in the newer base release — a token DROP, still not a detector anchor).
- `L3 programming layer <2023-02-22>` → `<2026-01-19>`.
- `Document Class: article 2022/07/02 v1.4n` → `2025/01/22 v1.4n` (date only; `v1.4n` same).
- `makeindex, version 2.17 [TeX Live 2023]` → `2.18 [TeX Live 2026]`.
- `.xdv`/`.pdf` render byte counts (e.g. clean `752`→`516` xdv, `4059`→`3050` pdf) — font/PDF
  generation differences.

### The ONE structural change (benign — NOT a detector finding)

TL 2026's kernel no longer auto-loads `(…/base/ts1cmr.fd)` at `\begin{document}`, so that
line vanishes from EVERY doc that reaches the body (14 of the 21 fixtures (12 of the 18 compiles)). It matters for
NOTHING the parser reads: in every case it was a *balanced* `(…)` that opened AND closed
before the diagnostic, so it was never on the parser's parenthesis stack at an error/warning —
attribution (`file`) and `line` are unaffected. In `no-end-document` the TL 2023 `(ts1cmr.fd))`
double-close becomes a single `)`, but the stack is empty at `! Emergency stop.` either way →
still promoted to `{severity:'error', message:'Emergency stop.'}` with no file/line. Its
disappearance also un-wraps a col-79 line break in `quiescent-crossref-pass2` (cosmetic). This
is EXACTLY the property rebase-proofing rule 2 predicts: the parser anchors on the `! ` /
`Warning:` markers + paren-stack semantics, not on incidental font-descriptor loads. Recorded
in both `GENERATOR.md` under "TL 2026 rebase deltas" so the next rebaser expects it.

**Net: the "divergences are findings" clause produced ZERO detector/parser findings.** The
only real finding was the `GENERATOR.md` under-specification (fixed in the docs, not the code).

### Provenance updates (item 6.4)

TL 2023 → TL 2026 references updated: both `GENERATOR.md` (header build-year + the sequencing
"verified marker strings" heading), and the two test files' provenance comments/labels
(`diagnostics.test.ts` fixture-corpus comment "pinned TL2023 engine" → TL2026;
`sequencing.test.ts` corpus comment + the `describe('… over real TL2026 fixtures')` label).
No assertion changed — comments/labels only. The fixture `# generator:` / `# exit=` headers
carry no TL-year reference, so none needed touching.

### Gates (item 6.3) — all green

- runtime `npm run typecheck`: clean.
- runtime `npm test` (vitest): **186/186** (10/10 files) on the regenerated fixtures — incl.
  the real-wasm integration suite (xelatex→xdvipdfmx PDF, crossref rerun 2 passes, bibtex8
  e2e 3 passes, public-API PDF, cancel+reinit, subfile diagnostics).
- demo `npm test` (Playwright/chromium): **4/4** (XeTeX text-bearing PDF + clean diagnostics;
  pdfTeX text; broken-doc file+line diagnostics; cancel()+fresh-worker).
- execution gate (`verify-engine.mjs`): PASSED (banner `TeX Live 2026`; 53 env imports).
- license audit: all checks passed.

### Deviations from DESIGN.md

None. Fixtures are test inputs regenerated from the pinned engine (rebase-proofing rule 2);
no runtime, parser, or detector logic changed (the version-agnostic claim held, so none was
warranted). The throwaway generator is not committed. dist/ untouched (item 4b's output).

### Item 6 — outcome

**Item 6 COMPLETE.** 21 fixtures regenerated against TL 2026; version-agnostic claim VALIDATED
(zero detector/parser changes; one benign `ts1cmr.fd` structural delta that touches no anchor);
GENERATOR under-specification fixed; all five gates green.
