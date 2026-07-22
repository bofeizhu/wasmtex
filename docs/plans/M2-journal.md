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

