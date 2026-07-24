# Engineering Log

One dated entry per work session recording what was attempted, what failed and
how it was fixed, and what was deferred. This log is kept because TeX toolchain
knowledge rots fast: the annual rebase to the next TeX Live release depends on
an honest record of why the build is shaped the way it is.

## 2026-07-24 — Fix: demo importmap drift broke the browser demo-smoke (item-8 regression)

**Done.** The M5 item-8 artifacts-build (commit 8e303c9) went red: `build` and
`conformance` PASSED, but the `demo-smoke` job hit its 20-min timeout and the run
was CANCELLED. Root cause = an item-8 regression: item 8 added the leaf module
`runtime/src/version.ts`, so the compiled `index.js` now re-exports
`from './version'` (extensionless, tsc-preserved). The demo loads the runtime as
native browser ESM via a hand-maintained `<importmap>` in `demo/index.html` that
bridges each extensionless specifier to its `.js` — but the map was NOT updated
for `version`, so the browser requested `/runtime/dist/src/version` → 404 → the
whole runtime module graph failed to evaluate → `window.__wasmtexResult` never
set → EVERY smoke test failed. Because the page-load tests only notice via a
wait-timeout, each failure burned the 2.5-min Playwright test timeout and the job
blew past 20 min (a slow CANCEL, not a clear failure).

**Fix (2 parts).** (1) Added `"/runtime/dist/src/version"` to the importmap
(reproduced the failure locally, then verified the full chromium suite + firefox/
webkit module-load all green). (2) Added a fast, no-browser **drift guard** test
(`importmap covers every runtime module`): it reads the built `runtime/dist/src/*.js`
relative imports and asserts the importmap covers each — passes in ~10 ms, and on
drift fails in ~6 ms with the exact missing specifier, converting the 20-min
silent timeout into an instant, precise error. Proven to fail-on-drift.

**Known CI-gating gap (recorded, deferred).** artifacts-build (which HOSTS the
conformance + demo-smoke gates) triggers only on `build/**` path changes — so a
change under `conformance/**`, `demo/**`, or `runtime/**` alone does NOT re-run
those integration gates. Item 8 only tripped it because it also touched `build/**`;
the journal-templates commit (conformance-only) triggered NO artifacts-build at
all. For THIS release these are validated by a manual `workflow_dispatch` of
artifacts-build on main-tip (covers item 8 + journal entries + this demo fix in
one run). Post-v1 follow-up: wire a cheap "consumer gate" that runs conformance +
demo-smoke against a downloaded/cached dist, triggered by those dirs — so they are
auto-gated without a full ~50-min container rebuild.

## 2026-07-24 — Conformance: supplied-class top-journal templates (test-only)

**Done, reviewer-approved (request-changes → 3 should-fixes + 2 nits applied →
approve).** Two new conformance entries prove WasmTeX typesets against a
caller-SUPPLIED top-journal class it does NOT bundle: `journal-ieee`
(IEEEtran.cls, IEEE) and `journal-elsevier` (elsarticle.cls, Elsevier). The
`.cls` is placed in the entry dir → the runner sweeps it into the job `files`
map (`run.mjs` reads every non-expectations file), exactly as a host would pass
its own class. Both mount `academic` via the §5.4(a) scan — IEEEtran typesets in
Times (metrics in academic) and the paper loads `cite` (also academic);
elsarticle's `\RequirePackage`s pull an academic package. IEEE's inline
`thebibliography` + `\cite` forces the §5.3 auto-rerun (phases engine,engine).
All 14 corpus entries green; license audit green (2545 shipped pkgs free).

**Scope decision (user, 2026-07-24): TEST-ONLY, do not ship.** The classes are
NOT added to any tier/bundle or the npm package — first-class journal support is
deferred to a future milestone as a SEPARATE package, never folded into
`academic` (the whole `collection-publishers` would ~4× the academic payload:
+2.2 GB / +109 k files vs a curated 5-class set's +2.2 MB — measured, both
rejected in favor of supply-at-runtime). Recorded in DESIGN §9 Post-v1.

**Provenance (DESIGN §2 clause 2 — TL upstream files under their own license,
inventoried).** IEEEtran.cls (LPPL-1.3, pkg ieeetran r59672) and elsarticle.cls
(LPPL-1.3, pkg elsarticle r77318) extracted byte-verbatim from the pinned TL2026
archive (sha256-checked vs source; no SPDX header injected — LPPL rename
sensitivity). Both inventoried in a new THIRD_PARTY_NOTICES.md "Conformance test
fixtures" section; the `paper.tex` files are ORIGINAL work (not IEEE/Elsevier
sample templates). The license-audit MIT-header + copyleft scans filter by
extension and exempt `.cls`/`.tex`, so the fixtures don't trip CI. Both `.cls`
are LPPL (not GPL/AGPL) → §2 clause 3 satisfied.

**Gotcha recorded:** IEEEtran defaults to Times, whose TFMs are academic-only,
and it pulls the font via low-level font selection (not `\usepackage`), so the
§5.4(a) scan can't see it AND the missing-TFM fatal abort did NOT trigger the
§5.4(b) missing-file retry (bundles stayed [core], fast fail). Fix: load `cite`
(academic, idiomatic for IEEE) so the scan mounts academic first, bringing Times.

## 2026-07-24 — M5 item 8: release workflow + npm↔assets version lockstep

**Done, reviewer-approved (request-changes → all fixes applied → approve).**
`.github/workflows/release.yml` (4 jobs): `build` on arm64 (pre-build
lockstep gate tag==package.json, container build in the pinned toolchain,
post-build gate manifest.version==version, pack the 3 archives, render
notes), `conformance`+`demo-smoke` on amd64 (needs:build), and `release`
(needs all three; `contents:write` scoped to THIS job only; `gh release
create --draft --verify-tag`). Triggered by an `assets-v*` tag PUSH; a
`workflow_dispatch` on any ref is always a dry-run (builds+packs+uploads a
workflow artifact, never a release).

Lockstep chain, single source of truth = `runtime/package.json` version:
`runtime/src/version.ts` (`version` + `ASSETS_VERSION = version`, a leaf
module to avoid an index↔client cycle) → drivers read package.json and pass
`--version` to gen-assets → `manifest.json.version` → `createTypesetter`
soft-verifies the fetched manifest BEFORE spawning any worker
(`AssetVersionMismatchError`, `factoryState.spawns===0` on mismatch).
Default verify is lenient on an absent manifest version (back-compat with
older asset trees); an explicit `expectAssetsVersion: '<v>'` pin is
fail-closed (absent ⇒ throw). protocol.ts gained the `license-inventory`
role (item 6 follow-through).

**Review: request-changes → fixed → approve.** Finding 1 (should-fix): a
`workflow_dispatch` pointed at a tag ref could set `is_release=true` and cut
a release — double-gated on `github.event_name == 'push'` (in the
`is_release` derivation AND the `release` job `if:`). Nit 2: `createTypesetter`
now rejects a malformed `expectAssetsVersion` (anything not a non-empty
string or `false`) with `TypesetInputError`, before the fetch. Nit 3: the
drivers (`run-in-container.sh`, `build-native.sh`) + gen-assets + pack now
reject a literal `undefined`/`null` version (those PASS the filename-safe
regex — the string `node -p .version` prints for a missing field). Nit 4:
the string-pin path is fail-closed on an absent manifest version, matching
the "guard against a wrong/corrupt manifest" contract. Tests: +6 runtime
(pinned-absent fail-closed, malformed-override rejects; 281 total) +2
build-tooling (undefined/null reject; 160 total), all green; typecheck +
lint clean. Commit triggers a container build that stamps the version and
runs the full gate set + browser matrix.

## 2026-07-24 — M5 item 7: versioned-archive packer (the §7 release archives)

**Done, reviewer-approved.** `build/release/`: an ORIGINAL zero-dep
deterministic tar+gzip core (`tar.mjs` — a hand-rolled USTAR writer +
streaming reader, chosen over shelling to host tar because bsdtar
(macOS) / GNU tar (Linux) differ in deterministic-flag spelling +
padding; streams so the 474 MB bundle never buffers whole, peak 112 MB
RSS) + `pack.mjs` (CLI + fail-closed verify-vs-manifest) + README +
`RELEASE_NOTES.template.md` + `make pack VERSION=<v>`. 32 tests
(round-trip, byte-identical double-pack, corrupt/truncated/tamper
rejection, epoch precedence, + a system-`tar` cross-check).

3 archives (VERSION=0.1.0): `wasmtex-assets-0.1.0.tar.gz` 415 MB gz (full
dist: engine + formats + core+academic + manifest/assets/licenses/
SHA256SUMS), `wasmtex-bundle-academic-0.1.0.tar.gz` 363 MB, `wasmtex-
bundle-core-0.1.0.tar.gz` 36 MB. Determinism proven (packed 3× →
byte-identical; canonical gzip header, SOURCE_DATE_EPOCH mtime). Verify
re-reads each written archive, re-hashes every entry vs manifest sha256+
bytes (both directions, gen-assets SHA256SUMS-exclusion rules), fail-
closed. USTAR validated field-by-field vs POSIX + against system tar
(byte-identical extraction). The per-bundle set is data-driven from
manifest.bundles[].files (alias-filtered) → rebase-proof.

**Review: approve, 3 should-fixes folded.** (1) `readTarGzEntries` used
`src.pipe(gunzip)` which doesn't forward a SOURCE error → an ENOENT/read
error crashed the process instead of rejecting; added `src.on('error')`
→ now rejects (verified). (2) The writer+reader share assumptions, so a
symmetric bug would pass every self-round-trip test — added a system-tar
interop test (skips where no tar). (3) The release-notes template's
`../THIRD_PARTY_NOTICES.md`/`../docs/embedding.md` links resolved wrong
(and don't work in a GitHub Release body) → `{{REPO_URL}}/{{TAG}}`
placeholders. Nits noted-not-fixed: interior-zero-block tolerance,
stale-archive verify message, fail() in exported helpers. build/release
is NOT a build input → this commit is fast-CI only (the archives ship
from the container build via item 8's release workflow, DESIGN §9 floor).

## 2026-07-24 — M5 item 6: soak + browser matrix + demo migration + alias drop

**Done, reviewer-approved.** The hardening finale, 5 parts:
- **Soak** (`runtime/test/soak.test.ts`): 50 seeded-deterministic sequential
  jobs, 37 completed / 13 cancelled → **12 REAL worker terminate+respawns**
  (fixed a first cut where sync-cancels were queued-drops by draining the
  pump so the job is ACTIVE when cancelled). ZERO cross-job contamination
  (each job's unique marker present + all 49 others absent, in transcript
  AND recovered PDF). `dispose()` → `live===0`, terminated===spawned.
- **Memory finding — CONFIRMED-BENIGN (no dispose leak).** rss/external
  don't return to baseline in the Node in-process harness, BUT arrayBuffers
  PLATEAU at ~243 MB (≈≤2 live engines, not 12×~150 MB) — dropped engines'
  linear memory + MEMFS ARE collected. The residue is V8/OS page retention,
  not a reference leak (client dispose nulls the worker; adapter terminate
  nulls the core→module→wasm graph). The §10 browser target uses
  Worker.terminate() which reclaims the whole isolate regardless.
- **Browser matrix**: firefox+webkit added → 15/15 (5 tests × 3), no skips,
  incl. a REAL in-browser on-demand academic mount on all three (the M4
  deferral closed; Firefox ~14 s for the 496 MB mount vs ~5 s elsewhere).
- **Demo migrated** to preload:[core]/onDemand:[academic] with a live
  on-demand siunitx example; default doc stays core-only (tripwire intact).
- **texlive-basic alias DROPPED** from both drivers; regenerated dist ships
  only core+academic (manifest/assets/SHA256SUMS carry no alias); the
  runtime `aliasOf` mechanism is retained for a consumer supplying a custom
  inventory. Surfaced + fixed: the `license-inventory` role (M5 item 2)
  wasn't in the runtime's KNOWN_ROLES → added to protocol.ts AssetRole +
  the test's closed gate (still rejects unknown roles).

**BREAKING (0.1.0 release notes):** `texlive-basic` is removed — any 0.0.1
consumer that named it must switch to `core` (+ `academic` on demand).
Acceptable pre-1.0.

**Review: request-changes → both fixed.** (1) The soak's `workerSpawns > 1`
would have passed the very queued-drop bug it guards (that bug produced 3);
tightened to `> cancelled.length/2`. (2) The embedding guide (a LIVE
consumer doc) still documented the texlive-basic alias + showed it in the
example manifest — an embedder following it would hit an init failure;
purged to past-tense. Count-comment nits (six→seven roles, Makefile).
268 runtime / 12 conformance / 15 browser / 54 build-tooling green.

## 2026-07-24 — M5 item 5: size budgets (preload-path tripwire)

**Done, self-reviewed.** `build/budgets.json` (checked-in, human-
editable, prose in `_`-keys) sets per-asset byte ceilings: the PRELOAD
path strict (busytex.wasm ≤30 MB, core.js ≤2 MB, core.data ≤60 MB — the
cold-start cost every embed pays), the ON-DEMAND academic tier loose
(academic.js ≤12 MB, academic.data ≤550 MB — a drift tripwire, not a
tight ceiling). `build/audit/check-sizes.mjs` reads the manifest `bytes`
and FAILS (naming asset + actual vs budget) on any over-budget asset;
warns on a NEW unbudgeted-large artifact (>5 MB) — but sha256-dedups so
the byte-identical texlive-basic aliases of core.* don't false-warn.
Wired fail-closed into the dist stage of both drivers after gen-assets
(build.sh mounts build/audit + budgets.json), so the container build
enforces it with no workflow edit — mirroring the item-2 license audit
placement (a manifest is required, so it runs post-build, not in stock-
checkout fast CI; 24 unit tests in build.yml cover the logic).

Current headroom (used%): busytex.wasm 27.5 MB / 92%, core.js 1.47 MB /
73%, core.data 53.9 MB / 90%, academic.js 9.3 MB / 78%, academic.data
496 MB / 90%. Verified: real dist PASS; forced breach (core.data → 40 MB
budget) FAILS naming core.data; determinism (--json byte-identical);
24/24 tests. This commit touches the build drivers → triggers a
container build that runs the check in the real dist stage.

## 2026-07-24 — M5 item 4: fuller conformance corpus + a stub CJK font fixture

**Done, reviewer-approved.** 5 new corpus entries (12/12 corpus green,
267 runtime, no regression): `unicode-math` (XeTeX, §5.4 scan→academic,
math ∫∞∑√ recovered, LatinModernMath embedded), `multi-include` (pdfTeX,
core-only, 4 pages, `\include`+TOC+`\ref` 2-pass rerun, phases=[engine,
engine] as the rerun lock), `known-bad` (deliberate missing package →
ok:false, exit 1, noPdf, exact diagnostic {File not found, main.tex:3};
mounts academic exactly ONCE then fails — the correct bounded §5.4(b)
behavior, not spurious), `tikz-standalone` (scan→academic pgfplots
figure), `cjk-hostfont` (CJK via a HOST-supplied font in the `files` map,
fandol ABSENT — the §6.3 bring-your-own-font contract; the host font
round-trips because its plain Unicode cmap gives xdvipdfmx a ToUnicode
CMap). 2 new runner assertions: `noPdf` (assert no PDF), `absentFonts`
(negative font control). Assertions proven to discriminate (injected-
failure).

**Font fixture provenance (§2 constitutional):** `WasmTeXStubCJK-Regular
.ttf` (~1.6 KB) is ORIGINAL work — `conformance/fixtures/build-stub-cjk.py`
hand-authors 9 rectangular Han glyphs via fontTools, opening/subsetting NO
existing font. Reviewer regenerated + TTX-diffed against the checked-in
binary: identical but for build timestamps → CONFIRMED original, MIT, no
THIRD_PARTY_NOTICES entry (that file inventories third-party material
only). Fix folded: `SOURCE_DATE_EPOCH=0` pins the generator so the rebuild
is BIT-IDENTICAL (`cmp`-verifiable, not a TTX diff) — regenerated. Nit
folded: a README note that `absentFonts` must pair with a positive check
(else vacuous on a missing PDF). Nits skipped: pinning tikz's incidental
pgfplots diagnostic (rebase-fragile, no coverage gain); the §6.3 "font in
fixtures/" wording (the .ttf lives in the corpus entry dir = the actual
`files`-map host-font contract; documented in fixtures/README).

## 2026-07-24 — M5 item 3: release docs (README + embedding guide)

**Done.** Root README.md rewritten — the stale "pre-code bootstrap, no
engine yet" status replaced with the truth (M0–M4 Done, M5 in progress,
first release 0.1.0 imminent not published, a "what works today"
section). New `docs/embedding.md` (~525 lines): the DESIGN §10 embedding
profile end to end — the JS-package/hosted-assets split, install, the
asset archive tree, `application/wasm` MIME, same-origin boot, the real
createTypesetter option table, the `preload:['core']/onDemand:['academic']`
model + both §5.4 paths ("on-demand = local bundle mount, no compile-time
network"), the job API (typeset/onLog/diagnostics/cancel/dispose,
stats.bundlesLoaded) + a copy-pasteable example, cold start with zero
storage, HOST-side manifest integrity verification, the custom-scheme
path (locateAsset + workerUrl, Electron protocol.handle), the error
taxonomy. runtime/README flipped ("assets ship as versioned GitHub
Release archives assets-v<v>") + the quickstart bundles texlive-basic →
core/academic.

**Accuracy** (every API grep-verified vs client.ts/index.ts/protocol.ts):
corrected first-draft errors — fontspec is in academic not core (a plain
XeTeX doc is core-only; explicit font selection pulls academic); `tikz`
isn't a provides key (ships via pgf → resolves by the retry, not the
scan); locateAsset does NOT relocate the worker (workerUrl/workerFactory
required under a custom scheme). **Node floor corrected to 18** (the
README's "Requires Node 24" was an overclaim — vitest/esbuild floor is
18, source is ES2022; Node 24 is the single TESTED major in CI, not the
minimum; consuming wasmtex needs no Node — it's browser-targeted).
Integrity is documented as a HOST-side step (the runtime validates the
manifest shape + loads by role but does NOT re-hash — matches §10 "an
integrity manifest the host CAN verify").

**Item-8 spec surfaced:** manifest.json needs a lockstep package
`version` field (0.1.0) for the documented `ASSETS_VERSION` soft-verify
to check against — it carries schemaVersion + texliveSnapshot but no
package-lockstep version. Recorded in M5.md item 8. Docs-only; no code.

## 2026-07-24 — M5 item 2: shipped-aggregate license enumeration + fail-closed audit

**Done, reviewer-approved.** The released bundles now have a machine-
readable license inventory + an audit that fails closed. `build/bundles/
licenses.mjs` walks each tier's package set (via resolveTiers), reads
each `catalogue-license`, and FAILS if any SHIPPED package (core or
academic) has a missing/`noinfo`/`nonfree`/unknown-to-allowlist license,
NAMING it. The allowlist is the TeX Catalogue free-token set (46 tokens
in this tlpdb vetted; nonfree/NC/ND absent); `collection` is treated as
present-but-unspecified (needs a cited exception, not silently free).

**Result: all 2545 shipped packages are FREE** (151 core + 2394
academic; 36 distinct tokens — LPPL ~2020, GPL-family ~250 incl. 16
agpl3, MIT ~110, PD ~72, CC-BY/BY-SA ~42, BSD ~25, OFL/GUST/Knuth ~24,
Apache ~12). The AGPL/GPL packages are aggregate-distribution TL PROGRAMS
the engine invokes — NOT source our code derives from (§2 governs our
code; §1/§7 the aggregate). Raw (`--no-exceptions`) the audit flags 22
(17 TL-infra with no metadata: glyphlist/hyphen-base/texlive.infra/
tlshell/…; 5 CTAN grab-bags with a `collection` token: ltxmisc [core],
frankenstein/preprint/was/fragments [academic]) — all TL-proper, so
`license-exceptions.mjs` resolves each as `other-free` citing LICENSE.TL
(FSF + DFSG blanket statement, quote verified verbatim). **Kept all 22**
(sound; several grab-bags carry journal packages — authblk via preprint,
gensymb/upgreek via was); dropping the 5 from academic is a one-line
tiers.mjs option if max caution is preferred (flagged to user).

**Wiring:** `dist/licenses.json` emitted before SHA256SUMS in the dist
stage of both drivers (hashed + manifest-listed, new `license-inventory`
role in gen-assets), so a failing audit aborts the build before
SHA256SUMS. `build/audit/license-audit.sh` check (f) runs it when a
tlpdb is present (green-defer otherwise); `licenses.test.mjs` (23) wired
into build.yml. THIRD_PARTY_NOTICES.md's stale "to be inventoried"
deferral replaced with the real grouped enumeration + the §7 aggregate
statement. Review: approve, 2 cosmetic nits folded (gen-assets "seven
rules", allowlist legal-basis comment). Deterministic (sorted, no
wall-clock); 30/30 tests.

## 2026-07-24 — M4 COMPLETE (Bundles + manifests): independently accepted

**Milestone accepted** (item 9). The tester independently verified all 7
acceptance criteria firsthand against the CI-built tiered artifact
(acceptance run 30055643973, commit 53f6f87, all jobs green): disjoint
core+academic tiers (157 / 2414 pkgs, tlpdb rev 78233); schemaVersion-2
manifest integrity (verify-manifest 30 checks, SHA256SUMS 10/10,
snapshot {2026, rev 78233, freeze 2026-03-01}); runtime on-demand mount
(267/267 runtime tests); §5.4 BOTH paths + citation + core-only-no-
download (7/7 corpus run firsthand against the CI bytes — sci-paper scan,
cjk-ctex retry, pkg-core-only none); in-container CI gates against the
tiered artifact; provenance/license clean. No blockers.

**What M4 delivered:** the single 53 MB texlive-basic bundle became a
tlpdb-driven two-tier system — `core` (53.9 MB, always preloaded) +
`academic` (473.6 MiB, on-demand: the scientific-journal + CJK working
set with bundled fandol) — with a top-level schemaVersion-2 integrity
`manifest.json` (per-file sha256/bytes + per-bundle provided-package
index + TL snapshot), real on-demand mounting (JS-heap, survives the
between-jobs memory reset, no re-snapshot), and the §5.4 automatic
resolution: an up-front `\usepackage` scan (unknown names do nothing) +
a missing-file retry that mounts `academic` and re-runs once. A journal
author's document — scientific math/figures/citations, or Chinese via
ctex/fandol — pulls academic automatically and only when needed.
texlive-basic kept as a byte-identical core alias (dropped at M5).

**Deferred to M5 (documented, not M4 defects):** real-browser on-demand
Playwright smoke; CJK Unicode-extraction (needs a ToUnicode CMap path);
the per-PR cross-run integration coverage; dropping the texlive-basic
alias; the item-5/6/7 hardening nits (in-flight loadBundle idempotency
edge, multi-level alias, pass-2 retry test). M5 = release engineering
(versioned archives, the first real assets-vX.Y.Z release, npm publish,
browser matrix, size budgets, soak) — **user-gated** (release/publish are
user-only actions).

## 2026-07-24 — Fix: conformance pdf-probe drops a page-tree object stream (CI red)

**Red CI fixed** (item-8 build run 30050548281: `conformance` failed,
`idx-makeindex` probed 0 pages on a VALID 2-page PDF; build + demo-smoke
green). NOT a product regression — a test-oracle bug. `idx-makeindex`'s
page tree lives entirely inside one FlateDecode object stream (`/ObjStm`)
that embeds the build timestamp, so its compressed bytes re-roll every
run (the CI PDF was 7648 B vs 7656 B locally). `conformance/pdf-probe.mjs`
`inflateStreams` bounded each stream by an `endstream` TEXT SEARCH then
stripped a trailing EOL — and when the stream's last COMPRESSED byte was
`0x0d` it over-stripped one byte, truncating the deflate stream →
`inflateSync` throws → the page ObjStm silently dropped → 0 pages.
Empirically 56/4000 timestamp variants failed, ALL with last-byte
`0x0d` (perfect correlation); the `endstream`-in-binary sibling was 0/4000
(far rarer). Intermittent, environment-correlated — exactly why it hid
until now.

**Fix:** `inflateStreams` is now `/Length`-authoritative — slice exactly
`/Length N` bytes (no EOL trim, no `endstream` search) when N is a direct
integer; fall back to a retry-successive-`endstream` search only for an
indirect `/Length N M R`. A valid flate stream is never silently dropped.
`{count,viaPagesCount,leafPageObjects}` shape unchanged; §8 oracle NOT
weakened (a broken/truncated/wrong PDF still reads wrong — verified
adversarially: fail-safe undercount, never a false green).

**Review: request-changes → fixed.** The new indirect-`/Length` fallback,
on exhausting all candidates, returned `next: buf.length` — aborting the
WHOLE scan and dropping every later stream (a latent recurrence of the
same 0-pages class). Fixed to resume past the first `endstream`; added a
case-D regression test (non-flate indirect-`/Length` stream before the
page stream). `conformance/pdf-probe.test.mjs` (NEW, 10 tests, wired into
build.yml CI): reproduces the exact drop against the verbatim pre-fix
logic. Validated: 6000-variant sweep 0 drops; conformance green ×5 vs the
CI artifact (idx-makeindex = 2 pages every time); runtime 267/267.

**Observation (descoped):** the PDF's embedded timestamp is nondeter-
ministic run-to-run (repro is descoped — §6.1 amendment); the fix targets
the PROBE, not the PDF.

## 2026-07-24 — M4 item 8: beyond-basic corpus + integration (target-driven)

**Done, reviewer-approved (no blockers).** The conformance corpus now
exercises the tiers + both §5.4 paths against the real target. Runner
(`conformance/run.mjs`) configures `preload:[core]` + `onDemand:[academic]`,
reads `manifest.json` (the provides index the scan needs), keeps the
whole-run green-skip, adds per-entry skip when a tier's files are absent,
and preflights `verify-manifest.mjs` (recompute sha256/bytes per shipped
file + provides present/disjoint/alias — catches a corrupt/truncated
download loud). Three new entries + `bundlesLoaded:[core]` on the 4 basic
ones. 7/7 corpus + 267 runtime green; deterministic.

- **`sci-paper`** — siunitx/mathtools/pgfplots + natbib/plainnat/bibtex8.
  §5.4(a) SCAN (no "not found" in the live log) + the full journal
  pipeline + the M4 CITATION acceptance (\citet/\citep surnames
  Zhang/Rossi/Nakamura/Okonkwo recovered from the PDF). Discovery:
  natbib/plainnat are in CORE, so citation resolves from preload;
  academic is driven by siunitx/mathtools/pgfplots.
- **`cjk-ctex`** — \documentclass{ctexart} + bundled fandol, no host
  font. §5.4(b) RETRY proven INDEPENDENTLY (the scan reads \usepackage
  not \documentclass → ctexart.cls is a miss → academic mounts → retry;
  live log has "not found", result.log spliced clean). CJK verified
  STRUCTURALLY via a new `fontProbe` (FandolSong + FontFile embedded +
  a 54-glyph CID run, floor 30) — honest: xdvipdfmx CID subsets carry
  no ToUnicode CMap, so the Chinese isn't text-extractable.
- **`pkg-core-only`** — \usepackage{longtable} → bundlesLoaded=[core],
  no academic download (corpus-level lock of the unknown-name policy).

Assertions proven to discriminate (injected wrong expectations → FAIL),
per the §8 never-weaken bar. **Review fix folded:** the CI conformance
presence-assert (artifacts-build.yml) named texlive-basic/assets.json but
NOT core.{js,data}/academic.{js,data} — a partial dist could pass it then
silently green-skip the whole/academic corpus; realigned to the tiered
set. Nits deferred: verify-manifest alias `files` check + multi-level
alias; the `/not found/i` live-log breadth (safe fail-direction).

**Note:** item 8 (conformance/) does NOT trigger artifacts-build.yml, so
the new corpus runs in CI only on a build-input change / dispatch —
folded into item 9's acceptance CI run (a full tiered build + all gates).

## 2026-07-24 — M4 items 6+7: §5.4 automatic bundle resolution

**Done, reviewer-approved (after 2 should-fixes).** Both halves of §5.4,
on item 5's `loadBundle` seam, replacing the eager-at-init stand-in with
lazy triggering. **Item 6 (static scan):** `worker/bundle-resolution.ts`
scans the project's `\usepackage`/`\RequirePackage` (comma-lists,
optional-arg + comment aware incl. `\%`), resolves each via the manifest
`provides` (`bundleProvidingPackage`), and preselects a matching on-demand
tier before pass 1. **Item 7 (missing-file retry):** `extractMissingFiles`
(diagnostics) + on a pass failing with kpathsea "not found", mount the
un-handled tier and re-run the step ONCE, bounded by a `handledBundles`
set. **loadBundle hardened** (item-5 nits): in-flight promise memoization,
alias canonicalization, dedupe.

**Both policies proven on real data:** (1) the unknown-name policy is
structural — `bundleProvidingPackage`→undefined→skip, so `\usepackage{
longtable}` (core, not a provided-package name) compiles in ~2.3 s with
`bundlesLoaded=['core']`, academic NEVER downloaded; (2) both §5.4 paths
work INDEPENDENTLY — siunitx via the scan (first try), and (scan blind to
`\documentclass{ctexart}`) a CJK doc via the retry (probe fails
"ctexart.cls not found" → academic mounts → retry compiles). A genuinely-
missing package → one bounded mount → clean failure, no loop.

**Log honesty (the load-bearing subtlety, verified):** the failed probe
pass streams LIVE via onLog, then is index-spliced out of `result.log`
(only that step's probe lines; document content that repeats the text
can't mis-splice); `stats.passes`/diagnostics reflect the authoritative
retry; a failed retry keeps its real error. 266 runtime tests.

**Review: request-changes → both fixed.** (1) **ReDoS** — the scan regex
`\s*(?:[…])?\s*` backtracks quadratically on a `\usepackage`+long-
whitespace hostile file (host-supplied, reaches the scan before pass 1);
measured 41 s at 160 KB. Fixed to the linear `(?:[…]\s*)?` form (grammar-
identical; ~ms at 1 MB) + a ReDoS regression test. (2) **Serialization**
— `onCompile` is now async (awaits the mount), so an out-of-contract
same-realm sender could interleave a 2nd compile mid-job and run job A's
retry against job B's re-staged files — wrong output under A's jobId.
Fixed: `worker/entry.ts` chains handler calls into a FIFO queue (cancel is
a client-side worker.terminate(), unaffected); stale "serial by
construction" comment corrected. Nits deferred: alias double-count in core
bookkeeping (pathological config), a pass-2-retry test, multi-level alias
chains.

## 2026-07-24 — M4 item 5: on-demand bundle mount (the crux capability)

**Done, reviewer-approved. The M4 technical unknown resolved positively.**
`bundles.onDemand` is now real: a tier's file_packager `.data` mounts into
the RUNNING engine after init (was inert). SPIKE first (the plan's
mandate): the generated loader already handles post-init —
`if (Module.calledRun) runWithFS()` — so NO WORKERFS/re-init fallback was
needed.

**The load-bearing subtlety — snapshot/restore orthogonality (verified by
review against the real Emscripten glue).** The worker snapshots ONLY
linear memory (heap.slice(0, 64 MiB) header) and zeroes-past-header on
reset between jobs. The on-demand mount is JS-HEAP-only (Emscripten FS
nodes + the LZ4 `.data` as a JS ArrayBuffer, decompressing into per-
callMain scratch the reset zeroes), so it is ORTHOGONAL to the snapshot —
no re-snapshot needed. Proven: a mid-session mount (snapshot predates the
tier) compiles siunitx + a CJK doc across 3 subsequent resets, all green.

**Mechanism:** `mountViaRunDependencies` (hooks monitorRunDependencies,
resolves on return-to-0 = files FS-visible; verified no race, no spurious
main re-run since dependenciesFulfilled is null post-init);
`EngineHost.loadBundle(name)` is the reusable seam items 6–7 call;
`EngineModuleLoader.mountDataPackage` for the worker (importScripts) +
node loaders. Eager-at-init trigger is the item-5 stand-in (§5.4 lazy
triggering is 6–7). No wire-protocol change; storage-less/cold-start,
cancellation, jobId correlation intact. 213 runtime tests (+18); worker
IIFE clean (no node: leakage); manifest-driven (not hardcoded).
On-demand academic mount ≈3.6–8.6 s (496 MB async read + LZ4).

**Review: approve.** Fix folded: `loadedBundles.clear()` at the top of
`load()` — a re-init on the same host (after a mid-mount init failure)
against a fresh engine would otherwise keep a stale set, making eager
loadBundle no-op and bundlesLoaded lie. Nits deferred to items 6–7 (which
drive the seam): in-flight loadBundle idempotency (concurrent same-name
double-mount), alias-tier canonicalization (don't mount texlive-basic as
a 3rd tier), preload/onDemand duplicate-name dedupe. Items 8–9 must run
the on-demand survival tests against the container-built tiered artifact
(they're runIf-gated on the 496 MB tier being present).

## 2026-07-24 — M4 item 4: manifest.json (schemaVersion 2)

**Done, reviewer-approved (no blockers).** `build/manifest/gen-assets.mjs`
now emits `dist/manifest.json` (the DESIGN §7 name) as a schemaVersion-2
SUPERSET: the per-file inventory + `texliveSnapshot` ({release 2026,
tlpdbRevision 78233, sourceDateEpoch, freeze 2026-03-01}, from the real
tlpdb `00texlive.config` + SOURCE_DATE_EPOCH), a static `engines` list
(the multicall applet set), and a per-bundle `bundles` index with
`provides` (package names) — core 157, academic 2414, `texlive-basic`
honestly marked `aliasOf: core` (detected by equal .data sha256).
`assets.json` stays schemaVersion 1 (byte-shape identical to 0.0.1) so
old consumers are unaffected. The resolver data reaches gen-assets via a
`build/stage/tiers.json` side-channel that stage-tiers emits during
staging (gen-assets never re-parses the tlpdb); wired into the Makefile +
both drivers; manifest.json excluded from SHA256SUMS (can't hash itself).

**Runtime:** `parseAssetsInventory` (the trust boundary — the manifest is
fetched from the host-controlled asset URL) validates + carries the new
fields, rebuilding them into fresh literals (no `__proto__`/extra-key
leakage; malformed entries dropped). New exported `bundleProvidingPackage`
(case-insensitive, alias-skipping) is the §5.4 accessor items 6–7 will
use. `client.ts` prefers manifest.json, falls back to assets.json (cold-
start / storage-less contract unchanged). 57 build-side + 195 runtime
tests green, typecheck clean, manifest byte-identical on rerun.

**Review fixes folded:** (1) manifest.json added to the gate REQUIRED
lists (conformance/run.mjs + artifacts-build.yml assert) — it's now the
runtime's PREFERRED artifact, so a regression dropping it must fail the
gate. (2) A sidecar `schemaVersion` guard in gen-assets. (3) **Item-6
policy pinned** (load-bearing, in M4.md): `provides` is a package-NAME
index, so item 6's `\usepackage` scan must treat an UNMATCHED name as
"unknown → do nothing" and let item 7's missing-file retry handle it —
NOT "not-in-core ⇒ load academic" (that would download the 496 MB tier
for core-served docs like longtable/graphicx, whose .sty names aren't
provided-package names). A filename→bundle index is only needed once a
2nd on-demand tier (`full`) exists. Deferred-trivial: stale "assets.json"
doc/error strings; a couple more malformed-field test pins.

## 2026-07-24 — M4 item 3: multi-bundle build (core + academic)

**Done, natively validated.** One combined install → two DISJOINT
tlpdb-driven bundles: `build/bundles/gen-profile.mjs` (install profile =
union of all tiers), `build/bundles/stage-tiers.mjs` (hardlink the pruned
install into per-tier trees via item-2's fileToTier; academic-owned →
academic, everything else → core), per-tier file_packager
(`build/wasm/data/%.js`). Both drivers (native + container) build both
tiers; `build.sh` mounts `build/bundles` ro; offline (--network none)
and the ISO-staged install unchanged.

**Real sizes** (native): **core.data 53.9 MB** (+1.2 MB vs old basic —
fuller xelatex.fmt all-language hyphenation + full-tree ls-R), **academic
.data 473.6 MiB** (on-demand tier; 681 MB tree → LZ4). Disjoint (0
overlap). dist now ~621 MB. `texlive-basic.{js,data}` kept as a
BYTE-IDENTICAL alias of core (zero consumer changes; drop at M5; caveat:
don't preload both core and texlive-basic in one session).

**Validation** (native, real runtime, both tiers preloaded): siunitx+
mathtools → PDF; ctexart[fontset=fandol] Chinese → PDF; both exit 0,
`bundlesLoaded=[core,academic]`, 0 diagnostics. Execution gate green.
Coder judgment call (approved): an additive *.fmt sweep drops 8 JP pTeX
formats + amstex (~14 MB) academic's collection-langcjk made fmtutil
dump — unrunnable on our xetex+pdftex multicall — keeping core at 53.9
(not 68) MB. DESIGN §6.3 note recorded (academic rename + fandol).

**Review: approve, container build safe to trigger.** Container/native
parity verified line-for-line; disjointness a proven function; fmt sweep
scoped + safe. Fixes folded: `build/bundles/**` added to
artifacts-build.yml's path filter (tier scripts determine artifact
bytes); the engines Makefile derived-work header updated for the M4
change.

**Deferred (recorded, not M4-item-3 blockers):**
- **Native-resume stale-tree hazard** (should-fix 3): `build/texlive-%`
  install doesn't `rm -rf` the tree first, so a native rebuild after a
  `tiers.mjs` edit can leave orphaned files that stage-tiers' catch-all
  folds into core (silent bloat). **CI is unaffected (fresh volume).**
  Fix before the next native rebuild that changes tiers.
- **Item-2 carry-forwards** (should-fix 4): the real-tlpdb core-
  containment test is now functionally covered (the conformance gate
  runs the corpus against core via the byte-alias), formally re-deferred;
  the `resolve.mjs` hardcoded `busytex-2026` default path (pins-derived)
  stays deferred (env-overridable, annual-rebase-drift class).
- Nits: parallel-make passwd/empty micro-race (same bytes), fmt-sweep
  .log/empty-dir debris (KBs), a user-facing alias caveat doc.

## 2026-07-24 — M4 item 2: tlpdb parser + tier map (build/bundles/)

**Done.** The bundle-tiering foundation: `build/bundles/tlpdb.mjs` (a
zero-dep parser of TeX Live's `texlive.tlpdb`), `tiers.mjs` (the
committed core/academic tier definition as editable data — N-tier
general), `resolve.mjs` (first-tier-wins DISJOINT `file → tier`
resolution + per-tier `provides` index + CLI), and 32 `node:test` tests.
No build/container change — pure local tooling.

**Verified against ground truth** (pinned TL2026 tlpdb, rev 78233, 8422
packages): all 10 plan collection names + `fandol` exist verbatim — the
tier definitions were accurate. Real per-tier numbers: **core 157 pkgs /
6106 files / ~100.8 MiB** (est), **academic 2414 pkgs / 31363 files /
~745 MiB** (est). The est is size-blocks×4096, a conservative UPPER
bound (per-file ceil-rounded); today's core-equivalent `texlive-basic`
packs ~2:1 (100 MiB est → 52.7 MB real), so **academic likely ~300–400
MB packed** — large but on-demand-only. `collection-latexextra` (1652
deps) + `collection-langchinese` dominate academic. Disjointness proven
two independent ways (0 cross-tier file collisions).

**Review (approve + fixes folded).** The tests weren't run by any CI —
wired `node --test build/bundles/*.test.mjs` into build.yml's build job
(was a bare placeholder; the synthetic half is CI-runnable, the
real-tlpdb groups skip green without the ISO). Comment nits fixed
(`node --test build/bundles/` errors on Node 24 → name files
explicitly; a stale test pointer). Deferred to item 3: a full
core-containment test (the invariant was PROVEN in review by diffing
resolved core against `dist/texlive-basic.js`'s file_packager metadata —
0 unexplained content files, the 49 extras are install-generated); and
the `resolve.mjs` hardcoded `busytex-2026` default path (same
annual-rebase-drift class as the old clean-artifacts bug — env-
overridable, derive from pins.lock later).

**Next (item 3) needs a user call first:** materializing `academic`
(~300–400 MB) is the first CI-container-rebuild cost — surfaced to the
user before triggering.

## 2026-07-23 — M3 COMPLETE (Build logistics & CI): loop STOP-target reached

**Milestone accepted.** The tester independently verified the revised
(post-descope) acceptance list and every criterion PASSED; confirmed on
the current HEAD by CI run 30016715455 (commit d21160f) — artifacts-
build + conformance + demo-smoke all `success`, 0 Node-20 deprecation
warnings. M3 is the autonomous loop's explicit STOP target, so the loop
ENDS here.

**What M3 delivered (arc):** a pinned **arm64** Linux toolchain container
(digest-pinned userland + emsdk 3.1.43), deployed to GHCR and pulled
by-digest in CI with an identity gate; the canonical containerized build
running the full offline wasm path in CI (`artifacts-build.yml`), landing
dist/ with the in-container execution gate green; the §8 functional gates
(conformance corpus + Playwright demo→PDF smoke) wired to run against the
CI-built artifact on an amd64 runner — which also settles host-arch
independence functionally (arm64-built wasm runs on amd64 in CI and on
macOS arm64 firsthand). Selective ISO staging demoted after measuring
109 GB runner disk (the "14 GB wall" was a macOS-runner figure).

**What M3 dropped (user decisions, recorded as DESIGN deviations):**
byte-for-byte reproducibility (§6.1) and the three-way hash-equivalence
check (§9) — the release bar is now functional correctness from the
pinned container on pin-verified inputs, not bit-identical output. The
repro gate + ls-R normalizer stay in-tree as off-path tooling. No local
container builds (all container work is CI-only). amd64 lane not needed.

**Carry-forwards (not M3 blockers):** the known install-tl wall-clock-
timestamp nondeterminism (only relevant if byte-repro is revived); the
accepted per-PR cross-run integration-coverage follow-up; the historic
ISO re-pin when TUG archives TL 2026. Next milestone is M4 (bundles +
manifests) — but the loop does NOT auto-continue past M3 per the
push-through directive; M4 begins on the user's next go.

## 2026-07-23 — M3 item 7 COMPLETE: gates green in CI; node24 action bump

**Gates verified green.** Run 30012659864 (the slice-B2 push) ran the
full path end-to-end: `artifacts-build` built dist/ in the pinned
container, then `conformance` and `demo-smoke` downloaded that artifact
and BOTH succeeded — the first real functional-gate execution in CI.
Item 7 done. This is the M3 functional acceptance bar (post byte-repro
descope) demonstrated live.

**Node 20 deprecation cleared.** The run surfaced GitHub's Node-20
deprecation warning for `actions/cache/restore@v4` and
`actions/upload-artifact@v5`. Root cause + trap: for the artifact/cache
actions, `v5` is NOT the node24 major (unlike checkout/setup-node where
it is) — verified against each action.yml `runs.using`: cache node24 is
**v5**, upload-artifact node24 is **v6**, and download-artifact node24
is **v7** (its v6 is still node20 — the versions are offset between
upload and download). Bumped all three in artifacts-build.yml (the only
workflow using them). Pure runtime bump, no API change; the triggered
rebuild reconfirms cache restore/save + artifact round-trip on node24.

## 2026-07-23 — M3 item 7b2: functional gates run against the CI artifact

**Done.** The two functional gates — the §8 conformance corpus and the
Playwright demo→PDF smoke — now run against the CI-built artifact, which
is the release bar after the byte-repro descope. Both moved out of
build.yml (where they green-skipped on an absent local dist/) into
artifacts-build.yml as `needs: artifacts-build` jobs that download the
same-run `wasmtex-dist-<pins_short>` artifact and run on `ubuntu-latest`
(amd64) — so they also functionally prove the arm64-built wasm executes
on amd64, complementing the macOS-arm64 run (the item-6 cross-platform
question, now settled on two foreign platforms). build.yml keeps only
its placeholder `build` job; no gate logic is duplicated. artifacts-
build.yml's checkout/upload/download/setup-node bumped v4→v5 (clears the
Node 20 warnings, the deferred bump). The now-descoped repro-mode docs
were reframed (optional tooling, not a v1 §6.1 gate).

**Review (approve + should-fix folded).** The anti-green-skip assert
checked only busytex.wasm, but run.mjs green-skips if ANY of five
required files is absent — a partial dist could have passed silently.
Fixed: the assert now checks all five. Nits folded: Node-version comment
corrected (`engines` is >=18, not a 24 pin); two stale repro comments
softened.

**Artifact round-trip (load-bearing).** `upload-artifact path: dist/`
roots files at the artifact root; `download-artifact path: dist`
restores them to repo-root dist/ — exactly where run.mjs (`DIST=join(
REPO,'dist')`) and demo/serve.mjs (`/dist/`) read. Same-run download
needs no `actions: read` (uses ACTIONS_RUNTIME_TOKEN). Verified by
review against the consumer code.

**Deferred (accepted):** per-PR cross-run integration coverage —
build.yml gates that download the LATEST artifact so runtime/demo/
conformance PRs not touching build inputs still get an integration run
(needs `actions: read`). runtime-tests.yml unit tests cover them now.

## 2026-07-23 — Scope: byte-for-byte reproducibility DROPPED from v1

**User decision.** Byte-identical builds are no longer a v1 requirement.
The one CI repro run (30003309704) had proven the artifacts are *nearly*
reproducible — `busytex.wasm`/`.js` and both `.fmt` formats byte-identical
across two clean builds — with a single remaining divergence: install-tl/
updmap bake wall-clock timestamps into a few generated font-map files, not
covered by `SOURCE_DATE_EPOCH`. Closing that needs per-file timestamp
normalizers; the user judged the effort + font-corruption risk not worth it
for an MVP ("as long as it works we are fine"). Context that supports the
call: **upstream busytex has no reproducibility gate either** — byte-repro
was a WasmTeX-original bar (§6.1), stricter than what we derive from.

**Recorded as a DESIGN deviation** (constitutional; CLAUDE.md requires it):
DESIGN.md §6.1 + the principles list + §9 M3 amended. The release guarantee
becomes "built in the pinned container from pin-verified inputs, passing the
functional gates (execution gate + §8 conformance corpus)" — not bit-
identical output. UNCHANGED: inputs stay pinned + hash-verified (provenance
intact), releases come only from the pinned container, `SOURCE_DATE_EPOCH` +
stable ordering stay set.

**Actions.** Stopped the in-flight timestamp-fix coder (nothing written —
tree was clean). Cancelled the planned parallel-repro-matrix redesign
(committed a2d3707 hours earlier — now superseded). `normalize-lsr.py` and
`repro-check.sh` STAY (behavior-preserving, zero-cost, off the release
path). M3 resequenced: item 5 closed as descoped; item 6 replaced by the
functional cross-platform check (already green on macOS arm64); item 7
remainder is wiring the guarded gate jobs to the CI-built artifact; item 8
acceptance drops the repro + equivalence verdicts.

## 2026-07-23 — M3 item 7a: toolchain deployed to GHCR; CI smoke green

**User-directed unit** ("deploy the container to GitHub and see if it's
working") folded into item 7 as slice A, after the same user directive
banned further local container builds (loop prompt + plan updated;
milestone tail resequenced 5→7→6→8). The EXISTING pinned image was
pushed — not rebuilt in CI, which would re-resolve apt and drift the
userland items 4/5 validated. Push used the user's own `gh`/docker
login (classifier correctly blocked token piping by the agent);
`docker logout ghcr.io` immediately after; registry_ref +
registry_digest pinned additively in [toolchain-image-arm64].

**First run: GREEN in 26 s** (self-fired — the workflow's path filter
includes pins.lock, which the landing commit touches). Answers:
(1) the Actions GITHUB_TOKEN pulls the PRIVATE OCI-label-linked
package with zero settings changes; (2) identity gate passed — the
GHCR digest resolves to the exact pinned image_id on the runner;
(3) emcc 3.1.43 / aarch64 sanity green in-container; (4) **109 GB
free disk — the "14 GB wall" was the macOS runner spec, and it is
RETIRED** (M3-notes correction): selective ISO staging demoted from
load-bearing to optional. Slice B now: containerized build job (full
ISO staging fine), ISO acquisition strategy, repro-check two-build
mode in CI (item 5's empirical green), artifact caching, flipping the
guarded gates.

**Review (approve, no blockers → fixes folded).** Default run shell
lacks pipefail → a df failure would have silently zeroed the
load-bearing disk telemetry (job-level `defaults.run.shell: bash`);
`timeout-minutes: 30` added. Reviewer verified the awk pin-parse
against the live lock, token-into-env (never run-body interpolation),
and trigger self-fire semantics by execution.

## 2026-07-23 — M3 item 5: repro gate built; DIVERGED → ls-R root cause → fixed

**Verdict.** The build-twice gate (`build/repro-check.sh`, `make
repro-check`) compared item 4's build with a fresh clean container
build: **DIVERGED in exactly 4 files** — texlive-basic.data (+76 B,
root), texlive-basic.js (+3 B offset metadata), SHA256SUMS/assets.json
(hash reflections). busytex.wasm, busytex.js and BOTH .fmt dumps were
byte-identical: wasm codegen and format dumping are already
reproducible container-to-container.

**Root cause.** install-tl's mktexlsr writes each texmf tree's `ls-R`
kpathsea database in *readdir order*; every clean build gets a fresh
docker volume = fresh ext4 with a randomized htree hash seed, so the
byte order differs per build (SOURCE_DATE_EPOCH can't help — ordering,
not timestamps). Second facet: updmap's incremental map writes split
one dir across duplicate ls-R headers, readdir/timing-dependently.

**Fix at the source.** `build/engines/normalize-lsr.py` canonicalizes
every ls-R after install-tl: blocks sorted by header, entries sorted
raw-byte (LC_ALL=C equivalent), duplicate headers merged to one
deduped union block — a pure function of the file *set*. kpathsea
reads ls-R order-independently, so behavior-preserving. Proven
analytically (no local rebuild, per the standing directive below):
order-independence over real build-#2 ls-R files + random shuffles,
idempotence, content-preservation (the dir→files map IS kpathsea's
in-memory database), plus 8 synthetic-fixture property tests.

**Standing directive (user, 2026-07-23).** No container builds on this
machine anymore — arm64 or amd64, any mode. Codified in the loop
prompt + M3 plan; the empirical two-build GREEN moves to CI (item 7
becomes item 6's prerequisite; expected order 5→7→6→8). A second
full-mode gate run was killed at prep the moment the directive landed.

**Review (request-changes → fixed).** `--keep-going` could report a
false GREEN: a failed build #2 left dist/ holding build #1's bytes,
the snapshot duplicated it, diff empty → REPRODUCIBLE for a build that
never ran. Fixed: failed builds are recorded + unsnapshotted, pairs
with missing snapshots are skipped, and ANY failure forces verdict
INCOMPLETE, exit 1. Also fixed: local-run wording in Makefile/script
contradicted the directive (now cross-referenced); --help sed range
overran (robust awk extractor); LC_ALL=C on cmp (gettext localization
would break the offset extractor); normalizer header rule tightened to
kpathsea's (ends ':' AND starts './'/'/'); format citation swapped
from db.c to the kpathsea manual. BSD/GNU portability bugs (od -t x1z,
cmp "char"-vs-"byte") were caught pre-run by validating BOTH gate
paths against real bytes before spending build time.

**Deferred.** Item 5's checkbox stays open pending the CI empirical
two-build green (closes with item 7/8). dist/ on disk remains the
valid pre-fix build #2. `build/texlive-basic.txt` + the tar member
order stay nondeterministic — neither ships in dist/, noted only.

## 2026-07-23 — M3 item 4: the canonical container build is green

**Done.** `coder` agent revived the parked container flow onto
build/engines + the 2026 pins + the arm64 image: same stage sequence,
offline pre-staging, and verify gate as the native driver — but
--network none is the hard offline enforcement, none of the macOS
overrides apply (enumerated delta journaled), and the work tree is a
named volume WIPED per full build (repro discipline the dev flow
deliberately doesn't have). First full in-container build: **~34 min**
(native 10m, wasm 22.5m), execution gate green, and ALL gates green
against the container-built dist/ — independently re-run (gate,
186/186, conformance 4/4, smoke 4/4, audit). `--use-preload-cache`
dropped from the bundle step: the M1-journaled IndexedDB deviation is
REMOVED (§5.2 optional-adapter posture restored; texlive-basic.js
−7.5 KB; A/B de-risked before the build).

**The comparison preview (item 5/6 map).** Container vs native (same
arch, different userland): glue JS BIT-IDENTICAL; busytex.wasm differs
by 6,220 B of which ~95% is __FILE__ build-path leakage (116 strings ×
51-char prefix delta — item 6 action: -ffile-prefix-map, then
re-diff); the .fmt dumps differ with ZERO path leakage — the
host-compiler signature of the native engine's format dumps, the
plan's original suspicion confirmed (irrelevant to releases: shipped
formats are container-dumped). Canonical comparisons remain the
container pair.

**Review (approve + fixes).** clean-artifacts pointed at the retired
2023 work tree (fixed here, not chipped); empty pinned_id would have
silently accepted any image on the canonical builder (fail-loud guard
added); STAGE=verify needed no work volume (arm added, exercised
live); set -e now covers the container script's preamble; a stale
docker-wait comment corrected.

## 2026-07-23 — M3 items 2+3: ISO re-check; arm64 canonical container

**Item 2.** historic/2026/ still has no consolidated ISO (404);
re-check dated in the lock, reminder stands.

**Item 3.** `coder` agent delivered the arm64 canonical builder:
ONE parameterized Dockerfile pinning the ubuntu:22.04 multi-arch
INDEX digest — the canonical (arm64) and equivalence-lane (amd64)
images differ ONLY in --platform, the structural invariant item 6's
three-way check needs. 22.04 kept deliberately (era-consistency with
emsdk 3.1.43; same userland across lanes so divergence = arch alone;
apt cmake 3.22 sidesteps the cmake-4 policy floor). The plan's
emsdk-arm64 risk did NOT materialize (3.1.43's linux-arm64 prebuilt
proven present by a range probe; same pin across all three lanes).
Prerequisites halved 20→10 by enumerating what OUR config invokes
(gperf kept as fontconfig's hard transitive requirement). Smoked:
emcc 3.1.43, aarch64, native ELF (no emulation), hello wasm runs.
pins.lock gains [toolchain-image-arm64] additively; the amd64 block
annotated as the parked equivalence lane.

**Review (request-changes → fixed).** (1) The OCI source LABEL had
the wrong org (an M0-era error rebaked into the fresh image) — fixed,
image REBUILT and re-pinned in the same commit (final image_id
5d4af653…). (2) The README's smoke command produced invalid C via
printf quoting — replaced with the verified variant; journal notes
the correction. (3) THIRD_PARTY_NOTICES' dependency table still
cited the RETIRED 2023 pins — moved to the 2026 ids. All gates
re-run green post-rebuild (smoke, fetch.sh, audit).

## 2026-07-22 — Bootstrap

**Attempted / done.** Repo initialized on `main`. Claude Code levels
configured (session: Fable 5 at xhigh — ultracode per session; `coder` and
`tester` agents: Opus 4.8 max; `code-reviewer`: Fable 5 high). All
PROMPT.md Bootstrap files authored via an orchestrated workflow (2 scouts,
4 author agents, 1 reviewer): LICENSE, THIRD_PARTY_NOTICES.md skeleton,
.editorconfig, .gitignore, README, this log, the DESIGN.md §4 scaffold
(placeholder READMEs), and three green-by-construction CI skeletons
(build, runtime-tests, license-audit).

**Name check (Bootstrap step 2).** npm `motex` is TAKEN (v0.0.0
placeholder by "catise", published 2026-02-06); a `motex` GitHub org also
exists. Renamed the project to **wasmtex** (verified free on npm and
GitHub). Alternatives considered: livetex, wotex, motexjs (npm-free; the
first two collide with existing GitHub users). Local directory is still
named `motex`; renaming it is optional and deferred.

**Failed → fixed.** (1) Workflow subagents referencing the new
`.claude/agents` types failed — the agent registry loads at session start;
fixed by resuming with explicit model/effort overrides at the same levels.
(2) On workflow resume, `args` arrived undereferenced, leaving literal
"undefined" in LICENSE and THIRD_PARTY_NOTICES.md; caught by the author
agent and the review pass, fixed by hand. Lesson: workflow scripts should
parse `args` defensively (`typeof args === 'string' ? JSON.parse(args) :
args`). (3) Code review (request-changes) also caught
`.claude/scheduled_tasks.lock` missing from .gitignore; fixed.

**M0 pin research (for the upcoming plan).** Upstream busytex/busytex
HEAD: `f2bd7b11ee1b7b093638321c1f3e5d70389d307b` (2026-06-16, branch
`main`, MIT per README — note: upstream has no top-level LICENSE file).
Its build pins TeX Live 2023 (texlive-source tag `texlive-2023.0` +
`texlive2023-20230313.iso`), Emscripten 3.1.43 via emsdk on ubuntu-22.04
CI, single top-level Makefile, no Docker. The CTAN URL for yearly ISOs
rotates — M0 must mirror the split-ISO cache.

**Deferred.** GitHub remote + first push (user's call); local directory
rename; npm-name squat dispute for `motex` (moot after rename).

## 2026-07-22 — M0 plan (autonomous loop, iteration 1)

**Attempted / done.** Added `.claude/commands/work.md` (the `/loop /work`
iteration prompt driving autonomous sessions). Environment check: Docker
29.6.1 running (engine platform linux/arm64 — Apple Silicon), 844 GiB
free.
Authored `docs/plans/M0.md`: pins table (busytex `f2bd7b1`, TL 2023 via
historic mirror, emsdk 3.1.43, amd64 base image by digest), the four
PROMPT.md acceptance checks, an 8-item commit-sized work list, and
standing decisions — notably pinning `--platform linux/amd64` under
Rosetta so local artifacts stay comparable with x86_64 CI.

**Deferred.** Whether emulated amd64 build time is tolerable is unproven;
revisit at work item 4 if needed (documented deviation path in the plan).
CI execution of the M0 acceptance checks deferred to M4 per DESIGN.md §9
(explicit deviation from PROMPT.md rule 3, recorded in the plan).

**Review.** `code-reviewer` pass on this diff: request-changes (record the
`build/upstream/` layout extension in DESIGN.md at creation time; label
the CI-deferral deviation; three nits). All applied before commit.

## 2026-07-22 — M0 item 1: toolchain container (loop, iterations 2–3)

**Attempted / done.** `coder` agent built `build/toolchain/`: Dockerfile
(ubuntu:22.04 @ amd64 digest `0d779ea9…`, forced `--platform
linux/amd64`; emsdk at commit `d9c66fa2` = tag 3.1.43; apt set = upstream
busytex CI prerequisites ∪ what its Makefile invokes that a bare
ubuntu:22.04 lacks, incl. `libarchive-tools` for the split-ISO bsdtar),
`build-image.sh`, real README contract. Built image ID
`sha256:1b37eac1…b436dce6` — the container pin for pins.lock (item 2).
Smoke check passed and was re-verified from the main session: emcc 3.1.43,
`uname -m` = x86_64. Provenance: only busytex (MIT) at the pinned commit
was consulted; no GPL/AGPL source opened.

**Failed → fixed.** (1) False alarm: main session declared the image build
"died" because `docker images` showed nothing and no build process was
found — in fact BuildKit tags the image only at the export stage, and the
first probe raced the ~5.5 min Rosetta build (apt layer alone 253 s).
Lesson: verify container builds via the build's exit code or log, never a
point-in-time `docker images`. (2) Review (request-changes) caught the
README attributing non-reproducibility to apt alone while `emsdk install`
also fetches un-checksummed binaries from storage.googleapis.com at
image-build time; fixed — the built-image digest is the pin covering
both. Also fixed: misleading ARG comment; smoke check now also exercises
the non-login-shell `ENV` path.

**Timing.** Cold amd64-under-Rosetta image build ≈ 5.5 min (apt 254 s,
emsdk 71 s). Warm rebuild fully cache-hit with identical image ID.

**Deferred.** emsdk layer keeps its git history + download cache
(hundreds of MB of image bloat); slimming it would change the image ID
already produced, so deliberately left for a future re-pin commit.
Item 1's "record build args in pins.lock" lands with item 2, which must
carry `UBUNTU_DIGEST`, `EMSCRIPTEN_VERSION`, `EMSDK_COMMIT`, and the
image ID above.

## 2026-07-22 — M0 item 2: pins.lock + fetch.sh (loop, iterations 4–6)

**Attempted / done.** `coder` agent authored `build/sources/pins.lock`
(INI-style blocks, awk-parsed — macOS ships bash 3.2, no associative
arrays), `fetch.sh` (atomic tmp-then-rename downloads, per-pin sha256
and/or sha512, refuses unpinned or non-hex hashes, idempotent), and the
real sources README. All six pins recorded: busytex `f2bd7b1` (git,
commit-verified + archive hash), texlive-source 2023.0, expat 2.5.0 and
fontconfig 2.13.96 (the only libs upstream fetches outside the TL tree),
the 4.77 GiB TL 2023 ISO, and the item-1 container pins. Full fetch ran:
~10 min cold (ISO at ~9 MB/s), 9 s idempotent re-verify of 4.90 GiB.
ISO checksum three-way agreement: downloaded bytes == mirror's published
.sha512 == lock. Review (request-changes): duplicate-block-id guard
added (dup ids silently resolved to the first block — reproducibility
hazard), remediation hints on mismatch paths, README notes upstream's
unpinned example-asset wgets. Re-verified green after fixes.

**Failed → fixed.** (1) The agent initially wrote a real-looking
*invented* sha256 as the ISO placeholder; caught before landing —
replaced with a non-hex `PENDING-FIRST-FETCH` sentinel that fetch.sh
treats as unset. Lesson: never write hash-shaped placeholders. (2)
`ftp.math.utah.edu` (the mirror M0.md suggested) fails TLS through this
environment's proxy; switched to `ftp.tu-chemnitz.de/pub/tug/historic/`
(range-capable, publishes .sha512). (3) Agent's completion-waiter
failed to wake it after the ISO download; nudged from the main session.

**Deferred.** `texlive-source` is pinned via a mutable git-svn branch
ref URL (byte-matches upstream's own `URL_texlive`; sha256 fails
closed) — switching to the underlying commit's codeload URL would drop
the mutable-ref dependency; revisit at item 3/4. GitHub on-the-fly
archives are not guaranteed byte-stable; a future hash mismatch means
"GitHub regenerated the tarball" (loud fail is the intended signal).
Upstream's `download-native` release binaries and rolling-`.deb` bundle
path deliberately not pinned (documented in the README); busytex
THIRD_PARTY_NOTICES entry lands with item 3 when code is vendored.

## 2026-07-22 — M0 item 3: vendor busytex machinery (loop, iteration 7)

**Attempted / done.** `coder` agent vendored 10 upstream files into
`build/upstream/busytex/` from the commit-verified cache clone
(`rev-parse` == `f2bd7b1`): Makefile, busytex.c, packfs.c/.py,
emcc_wrapper.py, cosmo_getpass.h, ubuntu_package_preload.py,
busytex_pipeline.js, busytex_worker.js, upstream README. Selection rule:
Makefile + every repo-local path it references + the two JS glue files
the demo loads. Each file: pristine body + provenance header;
PROVENANCE.md manifest records upstream and vendored sha256 per file.
Excluded: CI workflows, example/ tree, busytexmk.py, arXiv/cosmo
helpers (enumerated with reasons in the agent report / PROVENANCE.md).
THIRD_PARTY_NOTICES.md rewritten with the real busytex entry (verbatim
README license quote; upstream has no LICENSE file) and a
fetched-not-vendored table mirroring pins.lock. DESIGN.md §4 gained the
staging-area note (recorded deviation, per plan). Review: APPROVE —
reviewer independently re-verified all 10 body hashes, the license
quote, and the container git-archive check.

**Verified.** `git archive` framing for the busytex pin is identical
under host git 2.48.1 and the container's git 2.34.1 (both produce the
pinned `archive_sha256` `f670beff…`); recorded as a pins.lock comment,
no re-pin needed. Vendored Makefile parses under the container's GNU
Make 4.3 (`make -n` on two targets).

**Deferred.** `ubuntu_package_preload.py` is unused by M0's build path
(only the `build/wasm/ubuntu/%.js` recipe uses it) but vendored to keep
the Makefile's path references closed; drop at M1 if still unused.

## 2026-07-22 — M0 item 4 (container attempt) + native-first pivot

**Attempted.** `coder` agent wired the containerized `make artifacts`:
root Makefile, `build/artifacts/build.sh` (preflight pins check,
`--network none`, ro cache mount), `run-in-container.sh` (repro env,
offline pre-staging into the exact `source/<id>` paths the upstream
Makefile's download recipes produce — zero vendored-file edits, no
patches needed), journal at docs/plans/M0-item4-journal.md. Prep stage
verified offline (4.8G texmf repo staged from the ISO, 11524 packages).

**Failed → diagnosed.** `make -j4 native` died repeatedly with
`write jobserver: Bad file descriptor` — GNU Make's jobserver pipe fds
do not survive process spawning under Rosetta emulation; hits both
autotools and CMake sub-makes (first at zziplib's literal
`cd ../zlib && make rebuild`). Not fixable per-leaf without whack-a-mole
patching. Fix chosen: `-j1` on this host (no jobserver exists at -j1),
`WASMTEX_JOBS` override for real x86_64 builders. Operational fixes:
named container (`wasmtex-m0-build`), dropped `--rm` (keep logs for
post-mortem), `docker wait` for blocking supervision — the third
yield-and-wait agent failure this project (items 1 and 2 each needed a
manual nudge after their waiters never fired) made in-session
babysitting the standing rule.

**Pivot (user direction).** Serial emulated builds are prohibitively
slow for bootstrap. User directive: arm64 macOS is first-class now —
build raw on the host (no container), prove the toolchain, and drive
fast toward the wrapper-layer MVP (the project core); container/amd64/
CI/reproducibility logistics return after the MVP round. Recorded as an
explicit DESIGN.md §9 revision (milestones reordered: M0 native
baseline → M1 runtime MVP → M2 build logistics & CI → M3 TL 2026 →
M4 bundles → M5 release+hardening) + §6.1 bootstrap note. M0 plan
gained a revised work list (4N–8N); items 1–3 stand; the amd64
container wiring is committed as parked-for-M2, per-file provenance
headers intact. The orphaned serial build container was stopped and
removed (its driver agent died in a session restart). Constitutional
floor preserved: only container-built, pin-verified artifacts are ever
released; native host builds are dev-only.

## 2026-07-22 — M0 item 4N: native host toolchain (loop, post-pivot)

**Attempted / done.** `coder` agent set up the native arm64 toolchain:
emsdk cloned out-of-tree (`~/.cache/wasmtex/toolchain/emsdk`),
hard-detached and rev-parse-verified at the same pinned commit as the
container (`d9c66fa2`, tag 3.1.43); `install`+`activate` pulled the
darwin-arm64 binaries of the same emscripten-releases build
(`bf3c1598…`) the container resolves. Homebrew footprint kept minimal
by static analysis of the vendored Makefile: installed only cmake 4.4.0,
gnu-sed 4.10 (GNU `sed -i` is on the critical texlive.patched path),
GNU make 4.4.1 (host ships 3.81); verified-unneeded: p7zip, wget,
autotools, pkg-config (never invoked on the native+wasm path);
`/usr/bin/tar` already is bsdtar. New `build/toolchain/native-env.sh`
(sourceable, idempotent, bash+zsh, nounset-safe) and `native-host.md`
(host contract: hard pins vs documented-not-pinned, apt→macOS
translation table, setup, smoke). Smoke passed end-to-end: emcc 3.1.43
native arm64, hello.c → wasm → runs under emsdk node; independently
re-verified from the main session.

**Failed → fixed.** Review (request-changes): (1) emsdk_env.sh failure
was swallowed — a cloned-but-never-activated emsdk yielded rc=0 with no
emcc; added a post-activation guard (emcc present + version pinned to
3.1.43, loud return 1). (2) native-host.md's setup snippet claimed
"aborts otherwise" but ran sequentially; now `&&`-chained with a loud
abort. Nit: THIRD_PARTY_NOTICES emsdk clause extended to cover the
native path; GPL brew tools noted as host-only, outside the artifact
provenance chain.

**Deferred.** cmake 4.4.0 removed compat with `cmake_minimum_required
< 3.5` — TL 2023 CMakeLists may trip it; remedies documented in
native-host.md §5, handed to 5N. fontconfig-on-darwin build risk → 5N.
Hard host pinning → M2. `_wt_rc` leaks into the sourcing shell
(namespaced, harmless; noted by review, accepted).

## 2026-07-22 — Roadmap amendments: drop amd64 requirement; drop LuaTeX from v1

**Context.** User questions during the 5N build surfaced two scope cuts;
both adopted by user direction and recorded as dated DESIGN.md
amendments (§3 note, §5.1 enum, §9 addendum).

**(1) amd64 requirement dropped.** wasm artifacts are wasm32 —
host-arch-independent by construction; GitHub now provides free arm64
Linux (2025-08 GA) and arm64 macOS standard runners for public repos,
voiding the "CI = amd64 Linux" premise behind the original pin. M2's
canonical builder becomes a pinned **arm64** Linux container; the
three-way hash-equivalence check {arm64 macOS, arm64 Linux container,
amd64 Linux container} is the validation gate; amd64 survives at most
as a free CI verification lane. Analysis + runner-landscape findings in
docs/plans/M2-notes.md (14 GB runner SSD is the binding CI constraint,
not CPU). The parked amd64 container and its jobserver findings remain
valid fallbacks.

**(2) LuaTeX dropped from v1.** M1 wrapper is XeTeX-first ('pdftex' if
near-free; 'luatex' enum reserved, unimplemented); `luahbtex` exits the
multicall link and formats at the M3 rebase — removing the largest
engine from wasm size, the annual-rebase surface, and the one
arch-suspect artifact (luahblatex.fmt, possible wordsize-sensitive Lua
state). M0's in-flight faithful baseline still builds the full upstream
engine set unchanged, deliberately, as the toolchain control
experiment.

**Consistency sweep.** README milestone table, build/toolchain/README
parked-container bullet, M0 plan risk bullet, and M2-notes updated in
the same commit (lesson from the pivot review: the front-door docs
drift first).

## 2026-07-22 — M0 item 5N: native `make artifacts` COMPLETE (loop)

**Done.** `coder` agent drove the full vendored busytex build raw on
arm64 macOS, offline from the verified cache: **~70 min wall end to
end** (prep 12 s; native ~37 min across three attempts; basic 6 min;
wasm 29 min; bundle 1 min) vs. never finishing under Rosetta. `dist/`
(139 MB, git-ignored): busytex.wasm 28.9 MB (`WebAssembly.validate` =
true; hashes recorded in SHA256SUMS + the journal), busytex.js, the two
byte-identical MIT glue files, 8 `.fmt` formats, texlive-basic bundle
pair. `make artifacts` re-runs as an 11 s no-op. Vendored tree pristine
throughout; macOS fixes = four make-variable overrides + two
upstream-able patches in build/patches/ (libpng `<fp.h>` and zlib
`fdopen` — both the same `TARGET_OS_MAC` false-positive root cause,
each with HEADER.md).

**Failed → fixed.** (1) libpng/zlib classic-Mac guards (patches above).
(2) Native busytex dyld-crashed on load: darwin TL compiles XeTeX's
CoreText/AppKit font backend; ObjC class refs bind eagerly despite
`-undefined,dynamic_lookup` — fixed by linking the five Apple
frameworks MacTeX's xetex links (build-host tool only; the wasm engine
uses fontconfig, so this cannot reach artifact bytes). (3) The agent's
monitor-wait failed a 4th time (attempt-1's make exited unobserved for
~20 min); monitors are now abandoned project-wide for in-turn polling —
recorded in the journal's stage log too. (4) Review (request-changes):
offline claim was unenforced on the host (no `--network none` here) —
added URL-blanking overrides so a missed pre-stage fails closed instead
of fetching unpinned bytes; patch HEADER.md/notices wording made
precise about diff context lines quoting permissively-licensed sources;
journal gaps filled (interruption row, full 8-format inventory,
CMAKE_wasm policy-floor note flagged for M2's hash check).

**Predicted risks that did not bite.** darwin fontconfig and ICU built
clean; expat was the only cmake-4 exposure; `-single_module` libtool
probe failures harmless (static-only).

**Deferred.** Reproducibility double-build → M2. Compile-to-PDF proof →
6N (demo + Playwright), next.

## 2026-07-22 — M0 item 6N infrastructure: demo + Playwright; 5N REOPENED

**Done.** `coder` agent built the 6N smoke vehicle: `demo/index.html`
(minimal, no-DOCTYPE fixed in review, drives the vendored worker glue
per its real message contract), `serve.mjs` (localhost static server;
`application/wasm` MIME is load-bearing for `compileStreaming`;
traversal-safe, verified by review probes), Chromium-only Playwright
smoke (strict: ok flag, `%PDF-` header, `%%EOF` trailer, >1 KB, zero
console/page errors; text probe non-gating due to xdvipdfmx stream
compression), guarded `demo-smoke` CI job (skips cleanly without
dist/ — review hardened the guard to all six artifacts and switched CI
to `npm ci`). The glue's init/compile postMessage contract — including
worker-relative asset resolution and the misleading
init-failure-as-compile-error quirk — is documented in the journal's 6N
notes as the reference for what M1's runtime replaces.

**The catch: 5N reopened.** First-ever execution of `dist/busytex.wasm`
aborted at `_png_get_header_ver`: the binary has 363 unresolved `env`
imports stubbed to `abort(-1)` (harfbuzz 147, libpng 38, graphite2 22,
zlib, TECkit, …). Root cause: on macOS the per-library objects compiled
but the archive step produced **empty 96-byte `ar` files**, and the
final link's `--unresolved-symbols=ignore-all` +
`ERROR_ON_UNDEFINED_SYMBOLS=0` swallowed the emptiness silently.
`WebAssembly.validate` is true for such a binary — 5N's acceptance was
structurally satisfiable by a hollow artifact, which is exactly the gap
6N exists to close. 5N is reopened with an added **execution gate**
(engine `--version` under node) so this class of defect can never pass
again. Review independently reproduced the import counts and approved
the RED smoke as correct gate behavior.

**Deferred.** The wasm archive/link fix is the reopened 5N unit, next
iteration. 6N acceptance flips green unchanged once a sound wasm lands.

## 2026-07-22 — 5N fixed (hollow wasm) + 6N GREEN: hello-world PDF in Chromium

**Root cause (evidence-backed, review re-reproduced it).** Upstream's
Makefile defines `OPTS_LIBS_native = AR=$(AR_native)` ("force everyone
to respect proper AR") but never an `OPTS_LIBS_wasm` twin. Non-libtool
libs (harfbuzz, libpng, zlib, graphite2, teckit, xpdf, libpaper,
zziplib) hardcode `AR = ar` in configure-generated Makefiles, beating
emmake's environment `AR=emar`. On Linux GNU ar archives wasm objects
fine (bug invisible upstream); on macOS BSD ar auto-ranlibs and
silently DROPS every non-Mach-O member with exit 0 — eight 96-byte
archives, 363 symbols stubbed to abort by the link's ignore-all flags.
Also corrected: the earlier 6N note misreported xpdf as building real;
re-measurement showed it hollow too (it supplied the poppler stubs).

**Fix.** One make-variable override, `OPTS_LIBS_wasm=AR=emar` (mirrors
upstream's native guard; upstream-able as `OPTS_LIBS_wasm =
AR=$(AR_wasm)`). No patch, vendored tree pristine. Incremental rebuild:
re-archive 8 libs + relink in 37 s. `busytex.wasm` 28.9→30.4 MB (now
actually carries the dependency code); env imports 363→76, all
legitimate emscripten helpers. Data bundle and all formats
byte-identical.

**Execution gate (new, per the reopened item).** `verify-engine.mjs` +
a `verify` stage ending every dist assembly (timeout-guarded): asserts
env-import count ≤150 and runs `xetex --version` under node expecting
exit 0 + a TeX Live 2023 banner. De-risked: it FAILS against the old
hollow dist, PASSES against the fixed one. Hollow-but-valid can never
ship silently again.

**6N GREEN.** Demo smoke passes end-to-end in ~3 s: hello-world →
XeTeX → xdvipdfmx → valid PDF (12,490 B, `%PDF-`…`%%EOF`, 18 objects),
zero console/page errors. Engine self-reports zlib 1.2.13 / HarfBuzz
7.0.1 / libpng 1.6.39 / Graphite2 1.3.14 / ICU 72.1 / FreeType 2.13.0.
Independently re-run from the main session before commit. M0
acceptance (a) and (c) are now both demonstrably satisfied.

**Deferred.** PDF byte-determinism (xdvipdfmx stamps runtime
/CreationDate + /ID in-browser) → M2 double-build gate. Remaining M0:
7N notices audit, 8N acceptance run.
*(Numbering note: "M2" here meant build logistics & CI as numbered at
the time of writing; the same-day M2 ↔ M3 swap below renumbered it M3.)*

## 2026-07-22 — Roadmap amendment: rebase and logistics swapped (M2 ↔ M3)

**Decision (user-directed, third §9 amendment today).** New order:
M0 → M1 Runtime v1 → **M2 Rebase to TL 2026** → **M3 Build logistics &
CI** → M4 → M5. Rationale: (1) a rebase may bump emsdk, which would
invalidate logistics-era container pins and repro baselines — building
logistics once, against TL 2026, avoids paying the three-build
equivalence check twice; (2) logistics/CI needs the GitHub remote,
which still does not exist (user's call, parked since bootstrap) — the
rebase needs nothing external; (3) established this session that the
rebase barely touches M1 (runtime is TL-agnostic if asset lists stay
data-driven, the diagnostics parser is fixture-tested, and no version
banners are asserted in runtime code — rules to be baked into the M1
plan). Trade-off recorded: the first fully CI-gated annual rebase
becomes TL 2027; M2's acceptance rests on corpus seeds + execution
gate + demo smoke, with M3's gates re-validating immediately after.

**Mechanics.** Global renumber across live docs (logistics M2→M3,
rebase M3→M2): DESIGN.md (§3/§4/§6.1 notes, §9 third amendment +
swapped bullets), README table, Makefile/build-native.sh comments,
build/artifacts + build/toolchain + build/engines docs,
.github/workflows/build.yml, docs/plans/M0.md; docs/plans/M2-notes.md
renamed **M3-notes.md**. LOG/journal history left append-only per the
established rule, with one disclosed exception: a numbering note
appended to the prior entry's Deferred line (its "M2" reference was
written hours before the swap).
THIRD_PARTY_NOTICES.md, NOTICE, and license-audit.yml deliberately
untouched — the 7N audit agent owns them in flight; its output will be
reconciled to the new numbering at 7N close-out.

## 2026-07-22 — M0 item 7N: notices audit + real license-audit CI (loop)

**Done.** `coder` agent delivered `build/audit/license-audit.sh`
(original, portable BSD/GNU, one command, fail-closed) with five
checks: (a) every vendored busytex file carries a header naming the
pinned commit AND the disk set is bijective with PROVENANCE.md; (b)
manifest vendored-sha256s match disk (tamper check); (c) every patch
has a HEADER.md sibling and the context-excerpt licensing clause; (d)
no GPL/AGPL SPDX identifier in runtime/ or demo/ sources; (e) all
original build//demo/ sources carry SPDX MIT headers (exemptions
enumerated inline). license-audit.yml is now a thin wrapper calling
the script. Each check was de-risked by inducing its failure mode
(tamper, unmanifested file, stripped clause, planted GPL SPDX,
headerless script) — every one FAILs non-zero, restores to green.

**Audit sweep findings.** Vendored tree pristine and hash-clean;
NOTICE/THIRD_PARTY_NOTICES/README acknowledgments mutually consistent.
Fixed: stale milestone numbers in the notices (rewritten to stable
event names — the rebase number churned M1→M3→M2 in one day, so
numbers don't belong in notices); item-7 over-claims (it verifies the
vendored inventory + deferral, not a full TL enumeration); Playwright
dev-tooling posture now stated explicitly. Real violation found: the
two .patch files carried no licensing clause — fixed with a 7-line
comment each; `patch --forward` and `--reverse --dry-run` empirically
re-verified, and the 11 s no-op `make artifacts` re-run from the main
session confirms idempotent apply/skip intact. Left deliberately: the
vendored upstream README's frozen header says "at M1" — editing it
would break pristine vendoring + the manifest hash; lesson recorded
(never embed volatile milestone numbers in frozen vendoring headers).

**Process note.** Committed on direct user instruction with
main-session verification (audit run green + no-op build) in lieu of
the usual code-reviewer pass; the script's documented negative-test
de-risking substitutes for the adversarial half of that review.

**Remaining M0.** 8N acceptance run only.

## 2026-07-22 — M0 COMPLETE: acceptance verified independently (8N)

**Verdict.** `tester` agent re-executed every check against HEAD
`219f775`, clean tree: (a) `make artifacts STAGE=all` exit 0 (11 s
incremental no-op, 0 recompiles), execution gate PASSED (76 env
imports vs 150 ceiling; `xetex --version` → "TeX Live 2023", exit 0),
`shasum -c SHA256SUMS` all 14 OK; (b) reproducibility double-build
confirmed *not claimed* — recorded M3 deferral in plan + DESIGN
§6.1/§9; (c) demo smoke: 1 passed, hello-world → valid 12,488 B PDF in
headless Chromium, 2396 ms compile, zero console/page errors; (d)
license audit: all five checks pass. CI: runtime-tests, build,
license-audit all green on HEAD. **M0 acceptance SATISFIED.**

**Artifact inventory of record (dist/, 139 MB, git-ignored).**
busytex.js f381d9ba… (295,606 B); busytex.wasm cf0298e1… (30,366,631
B); busytex_pipeline.js 3677f3c5… (31,204 B); busytex_worker.js
b557fd0d… (2,052 B); formats/: dvilualatex 801a2f97… (4,558,611),
dviluatex f1753efb… (1,194,589), luahblatex ecc8f976… (11,880,048),
luatex 45446b99… (1,194,521), optex ad9c808b… (698,555), pdflatex
92d56285… (6,477,728), tex d10a56cb… (303,574), xelatex a18f97b4…
(8,714,792); texlive-basic.data 2d7a6d6f… (79,503,467);
texlive-basic.js bf7f44b3… (1,703,852). Full 64-char hashes:
dist/SHA256SUMS (regenerate via `make artifacts STAGE=dist`).

**Coverage gaps carried forward (tester's notes, none blocking).**
(1) PDF validity is proven structurally, not by content — text-snippet
+ page-count assertions land with the M5 conformance corpus; consider
a content probe in M1's runtime tests. (2) The execution gate proves
boot, not typesetting — the compile path is covered only by the demo
smoke; M1's unit tests should add a typeset-path check. (3)
Chromium-only per §8 (FF/WebKit advisory at M5). (4) Determinism
asserted, not demonstrated, until M3's double-build.

## 2026-07-22 — M1 item 2: runtime package scaffold (loop)

**Done.** `coder` agent scaffolded `runtime/`: package `wasmtex`
(private until M5, ESM, exports map matching real tsc output, node
>=24), strict tsconfig pair, vitest, tiny-but-real first surface
(`version` + `EngineName` union with 'luatex' reserved) with a
drift-guard test; runtime-tests CI workflow replaced with a real
npm ci → typecheck → test run (lockfile carries linux binaries;
cache-dependency-path correct for the subdir package).

**Finding worth keeping.** vitest's typecheck mode does NOT fail on
ordinary type errors in test bodies (assertion feature only —
empirically proven with a planted error); test/ is therefore
typechecked by real tsc via tsconfig.test.json. False-green averted.

**Review (approve + fixes applied).** (1) Build tsconfig had
`types:["node"]` — would let Buffer/process leak into browser/worker
code unseen; now `types:[]` for src//worker/, node types only in the
test config. (2) license-audit check (e) was blind to runtime/ .ts
files — gate extended (now 16 sources). Nits: @types/node exact-pinned;
vitest.config.ts brought under typecheck. All re-verified green
(typecheck, 2/2 tests, audit).

## 2026-07-23 — npm 0.0.1 name-reservation release prepared (user-directed)

**Decision.** Publish the runtime library to npm as 0.0.1 BEFORE M3 —
a deliberate name-reservation release (the bootstrap lost `motex` to a
squatter; `wasmtex` verified still free). Constitutional floor
untouched: the tarball ships ONLY the MIT library (no engine
artifacts); the §4 lockstep rule binds from the first real
assets-vX.Y.Z release, recorded as a dated DESIGN note. The USER runs
`npm publish` (user-only action); this session only prepared it.

**Prepared.** package.json: 0.0.1, private removed, publishConfig/
repository/keywords; version const synced (drift-guard test);
runtime/LICENSE (MIT copy); npm-facing README (assets-not-released
stated up front; accurate §5.1 quickstart). Review caught three
pre-publish improvements to the immutable artifact: the internal
node-harness excluded from the tarball (193→117 KB — it was
unreachable via the exports map anyway), engines relaxed >=24→>=18
(24 is the dev requirement, not the consumption floor), and a stale
"diagnostics empty in M1" doc comment that would have shipped in
every consumer's editor hover corrected. Tarball verified: 37 files,
LICENSE/README/dist, no engine bytes. 186/186, audit green.

**Published.** User ran `npm publish`; registry confirmed:
`wasmtex@0.0.1`, unpacked 418,085 B. The name is secured.

## 2026-07-24 — M2 COMPLETE: TL 2026 rebase acceptance verified (item 9)

**Named-owner step first.** TL 2023 pins retired from pins.lock (the
runbook 1d step; values in git history; cached 2023 files deletable);
fetch.sh now verifies exactly six blocks, all green.

**Verdict.** `tester` agent ran `make rebase-check` — its FIRST full
end-to-end execution — at HEAD 26ffc8b, clean tree: **6/6 gates in
54.8 s.** Fetch verify (incl. the 6.78 GB ISO, 2 hashes); execution
gate (53 env imports, "TeX Live 2026_busytexwasm"); license audit
(40 sources, all-retired patches enforced); runtime 186/186 incl.
real-wasm luatex rejection; conformance 4/4 (bib-cite 3 passes via
bibtex8; idx-makeindex 2 pages via the full makeindex sequence);
demo smoke 4/4. LuaTeX absent at every layer (applet listing probed
empirically; formats exactly {xelatex,pdflatex}.fmt; no lua build
targets — the packed texmf still carries lua-named LaTeX *package*
sources per collection-basic, correctly noted as not an engine).
Engine banners confirm the forecast column: ICU 78.2, HarfBuzz
12.3.2, zlib 1.3.2, libpng 1.6.55, FreeType 2.14.1. Runbook matches
reality command-for-command; DESIGN §6.2 pointer additive. Artifact
inventory of record (88,776,788 B total): busytex.wasm 1c9b96dc…
(27,508,145), busytex.js 81aa161c… (273,991), pdflatex.fmt 4c757811…
(2,286,489), xelatex.fmt 551fe496… (4,472,954), texlive-basic.data
5ead5862… (52,775,230), texlive-basic.js 1a8f4089… (1,459,979);
assets.json generated 2026-03-01T00:00:00Z. **M2 acceptance
SATISFIED.**

**Milestone summary.** The first annual rebase is done and
institutionalized: TL 2023→2026 in seven working items — pins with
three-way checksums, the build config forked to ours (LuaTeX exited:
wasm −13%, bundle −25% before the 2026 sizes), only three drift fixes
(no emsdk bump; both macOS patches retired as fixed-upstream), one
real regression (ICU 78 alias-table packaging) root-caused and fixed
portably, fixtures regenerated with the version-agnostic claim fully
validated, a four-seed conformance corpus driving the public runtime,
and docs/rebase.md + make rebase-check so TL 2027 starts from an
operation, not archaeology. Carried forward: CI runs the wasm path
only after M3 wires artifacts in; the ISO re-pins to historic/ at M3.
Next per §9: **M3 — Build logistics & CI** (plan next iteration).

## 2026-07-24 — M2 item 8: the rebase runbook (loop)

**Done.** `coder` agent distilled the ~1300-line M2 journal into
docs/rebase.md (496 lines): five phases with the M2 evidence inline —
pin research (tag-namespace gotcha, historic-vs-release decision tree,
MANDATORY drift-forecast probe), patch re-tests (retire-vs-re-diff),
build (emsdk rule verbatim; the three drift classes with their real
instances incl. the ICU item-4b retirement condition), fixture
regeneration (the scorecard + churn-vs-finding taxonomy), and
conformance as THE §6.2 acceptance gate. `make rebase-check`
implemented as the acceptance aggregator only (six gates, fail-fast,
dist-guarded) — deliberately NOT named `make rebase`, because a
patch-applying automation does not exist and post-retirement has
nothing to apply; that §6.2 wording tension is surfaced honestly in
the runbook and routed through a future joint DESIGN+runbook commit.
DESIGN §6.2 pointer is dated and additive; README links the runbook.

**Review (approve + fixes).** Reviewer verified the runbook against
the journal claim-by-claim and ran gates 1-3 live. Fixed: the
drift-table still starred lua53 as a linked lib (false since item 3)
and omitted libpaper; the 2023-pin retirement was ownerless — now
explicitly owned by item 9 (and the runbook warns against ownerless
retirements). Gaps the distillation surfaced: §6.2 tension, scattered
prerequisites (now Phase 0), the year-agnostic abstraction itself.

## 2026-07-24 — M2 item 7: conformance seed corpus (loop)

**Done.** `coder` agent delivered conformance/: four committed corpus
projects (hello-xetex, hello-pdftex, bib-cite, idx-makeindex) with
machine-readable expectations (exit/ok, minPages, text snippets with
negative controls, exact diagnostics, executed-phase sequences), a
runner driving the PUBLIC createTypesetter over real wasm, and a
shared pdf-probe (the demo smoke now imports the same single
implementation). The in-process node harness was promoted from test
support to runtime/node/ with an esbuild node-harness bundle — one
definition, two consumers. Guarded CI job added; runner green-skips
without dist/.

**Milestone-grade evidence.** The makeindex path ran on real wasm for
the FIRST time: engine → makeindex (3 entries) → incorporate pass →
converge pass → xdvipdfmx, 2 pages, index terms rendering only via
\printindex (body-absence proven). bibtex8 seed pins the honest
multi-pass diagnostics shape (pass-1 citation warnings — a deliberate
rebase tripwire, documented). Runner discrimination proven (wrong
snippet → exit 1). Review: approve; fixes applied — audit checks
(d)/(e) now cover conformance/ (new top-level source tree), CI guards
gained assets.json, page-probe cross-check now ASSERTS agreement
instead of printing it, integrator caught a duplicate-compilerOptions
JSON bug that had silently dropped noEmit. All gates green: 186/186,
conformance 4/4, smoke 4/4, audit (38+ sources).

## 2026-07-24 — M2 items 5+6: formats verified; fixtures regenerated

**Item 5.** Deliberate re-checks closed: dist/formats exactly
{xelatex,pdflatex}.fmt lua-free; assets.json 7 assets/6 roles all
verified; a node MEMFS probe LISTED the mounted TL 2026 TDS and
confirmed the FORMAT_* constants byte-for-byte (no lua dirs) — the M1
acceptance carry-forward is formally closed. The ~4.2 MB fmt shrink
root-caused honestly: not compression (both years gzip'd, W2TX
identical) — the decompressed dumps themselves shrank ~9-10 MB each;
benign.

**Item 6 — the version-agnostic scorecard.** All 21 fixtures
re-captured from the TL 2026 engines per GENERATOR.md. The claim
HELD completely: 78/78 parser+detector tests with ZERO assertion
changes; every anchored substring and exit code survived; the 3
bibtex8 fixtures came back BYTE-IDENTICAL across TeX Live years.
Churn was purely cosmetic (banners, LaTeX2e/L3/class dates,
makeindex 2.17→2.18). One benign structural delta (TL 2026 no longer
auto-loads ts1cmr.fd — balanced parens, never on the attribution
stack). Regeneration friction became a fix: both GENERATOR.md files
gained exact source-document sections (they had under-specified the
bodies). Gates: 186/186, smoke 4/4, execution gate + audit green —
independently re-run. Review: approve, one journal count fix.

## 2026-07-24 — M2 item 4b: ICU 78 alias blocker FIXED; XeTeX restored

**Root cause (precise).** ICU 78's `initAliasData` gained a length
gate (`dataLength <= 4 → invalidFormat`); the busytex-era
`pkgdata --without-assembly` static packaging emits a POINTER-TOC
archive whose lookup hard-codes `*pLength = -1` — so the alias table
that loaded fine under ICU 70 now fails `U_INVALID_FORMAT_ERROR`,
`ucnv_countAvailable()=0`, and XeTeX's fontconfig manager dies at
"cannot read font names". A genuine ICU 70→78 runtime change; the
data itself was present and valid all along.

**Fix (our Makefile, no source patches).** pkgdata's intermediate
`icudt*l.dat` — which carries a proper OFFSET-TOC — is genccode'd
into one portable C byte-array object that replaces the pointer-TOC
archive, for native and wasm alike (no assembly, entry point derived
from the .dat basename, no version literals; deterministic output —
M3's double-build gate unaffected). Native probe: countAvailable
0→232, `macintosh` opens (byte-identical to the TL 2023 baseline).
All 10 blocked tests flipped: runtime 186/186, demo smoke 4/4,
execution gate green, audit green — independently re-run. wasm
shrank 16 KB.

**Review.** Approve after one should-fix: `.DELETE_ON_ERROR:` added —
an interrupted repackage would otherwise leave the regenerated
pointer-TOC archive for the next incremental make to silently accept,
resurrecting the exact defect past the execution gate. Retirement
condition for the transform recorded at the journal top (watch
pkgdata for a no-assembly offset-TOC mode; retest via
countAvailable). The item-6 fixture-churn bucket is EMPTY — the ICU
fix restored XeTeX without perturbing any golden assertion.

## 2026-07-24 — M2 item 4: TL 2026 build lands; ICU 78 blocker isolated

**Done.** `coder` agent cut the build over to the TL 2026 pins: full
prep→native→basic→wasm→bundle→dist green, execution gate passing with
the "TeX Live 2026_busytexwasm" banner. The drift forecast resolved
far better than feared: **emsdk stays at 3.1.43** (it compiled
harfbuzz 12.3.2 and icu 78.2 outright — no capability gap); **both
macOS patches retired** (upstream fixed the TARGET_OS_MAC defects in
libpng 1.6.55 and zlib 1.3.2; HEADER.md files rewritten as dated
retirement records, audit check (c) extended: all-retired allowed,
archival records + excerpt clauses enforced, zero-records fails).
Only three drift fixes, all in our Makefile with the mod-list updated:
CXXSTD=gnu++17 (Apple clang defaults to C++14; ICU 78 needs 17),
zisbitset native duplicate → REDEFINE, and three new TL 2026 common
symbols (wasm-ld doesn't coalesce commons; complete collision set
computed, not whack-a-moled). SOURCE_DATE_EPOCH → the TL 2026 freeze
date (1772323200); fresh work tree; 2023 build preserved as fallback.

**Numbers.** Formats collapsed impressively (pdflatex.fmt −64.7%,
xelatex.fmt −48.7%); bundle −10.9%; wasm +4.4% (newer libs). Review
should-fixes applied: notices updated to the 2026 pins + retired-patch
excerpt wording; the orphaned texmfrepo make rule now fails loud
instead of silently succeeding on empty stdin; sources README gained
the active-pins banner.

**The blocker (isolated, not fixed — next unit).** wasm XeTeX aborts
at font-manager init: ICU 78's converter-alias table does not load
(`ucnv_countAvailable()=0`; canonical names open, aliases fail) —
a 70→78 data-build/load regression, root-caused with differential
probes (native ICU 78 shows it too; TL 2023 ICU 70 is fine). pdfTeX
is fully functional; runtime 179/186 and smoke 1/4 are ALL
XeTeX-only failures. Fix direction journaled (ICU data
packaging/TOC; iterable against native ICU without wasm rebuilds).

## 2026-07-23 — M2 item 3: build/upstream dissolved into build/engines (loop)

**Done.** `coder` agent forked the build config into our own tree:
build/engines/{Makefile,busytex.c,emcc_wrapper.py} with DERIVED WORK
headers naming f2bd7b1 (mods listed per file; reviewer verified them
against the actual diffs), README original. LuaTeX excised end to end
— targets, lua53 dep, dispatch table, flags — plus bench/ubuntu/
cosmo/example paths (Makefile 618→560 lines; the rebase surface
shrank measurably). Un-forked: packfs.*, cosmo_getpass.h,
ubuntu_package_preload.py (served only dropped paths). The M0 hollow-
archive fix folded into the Makefile proper (OPTS_LIBS_wasm=AR=emar —
fixes every host now the config is ours). Vendored glue dropped from
dist/ (roles 8→6, propagated through protocol/generator/tests/CI
guard). build/upstream/ deleted; DESIGN §4 staging note removed —
the dissolution it promised is complete. Audit retargeted: per-file
provenance headers ARE the record now (frozen-hash tamper check
retired with rationale; baseline anchor stays in pins.lock [busytex]);
fail-closed proven by induced failures.

**Key finding (journaled).** Dropping collection-luatex does NOT stop
lua-format dumping: scheme-basic→collection-basic force-installs lua
fmtutil entries, built by the HOST TeX (non-hermetic). The whole-dir
prune is the load-bearing excision — now stated at both Makefile
sites (review's should-fix; a rebaser would have deleted the prune as
dead code). Review also hardened the audit's marker precedence
(derived-wins) and corrected a journal metric.

**Numbers (verified against TL 2023).** busytex.wasm 30.37→26.37 MB
(−13.2%); busytex.js −7.3%; native −17.1%; texlive-basic.data
79.5→59.2 MB (−25.5%). Gates: execution gate green (53 env imports),
runtime 186/186, demo smoke 4/4, audit green — all re-run from the
main session.

## 2026-07-23 — M2 item 2: TL 2026 pinned (loop)

**Done.** `coder` agent pinned the rebase snapshot: texlive-source
`texlive-2026.0` (git-svn branch ref, commit f26cc5ed recorded;
`.1` deliberately skipped — freeze-date coherence with the ISO, its
dvipdfmx fix available as a patch candidate) and
`texlive2026-20260301.iso` (6.32 GiB, three-way sha512 agreement).
Historic/2026 carries only component tarballs, no consolidated ISO
yet — the plan's sanctioned release-area exception taken, dated
filename only, rotation exposure + RE-PIN-AT-M3 documented in the
lock block itself (and now the README, per review). 2023 + 2026 pins
coexist, both verify, cache 4.9→11.4 GiB. expat/fontconfig kept (no
speculative bumps).

**Drift forecast (item 4's map).** harfbuzz 7.0.1→12.3.2 and icu
70.1→78.2 are the emsdk-bump risks; zlib 1.2.13→1.3.2 and libpng
1.6.39→1.6.55 land on our two TARGET_OS_MAC patches; texk/ reorg
minimal (one new dir). ISO top-level shape identical to 2023 —
prep stage needs only the filename swap.

**Process note.** The agent's completion-waiter failed again after
the ISO download (recurrence; nudged to finalize in-turn). Review:
approve — reviewer independently re-fetched the published checksum,
re-resolved both git refs, and confirmed historic/'s ISO absence;
should-fix applied (README's absolute historic-only rule gained the
sanctioned release-year exception + table rows).

## 2026-07-23 — M1 COMPLETE: Runtime v1 acceptance verified (item 10)

**Verdict.** `tester` agent independently executed every acceptance
check at HEAD e5b535f, clean tree: PASS on all seven. 186/186 runtime
tests (typecheck + build + suite), the four named §8 cases read and
confirmed to assert their claims (stale-result-cannot-resolve-newer-
job; cancel terminates + fresh-worker reinit, proven over real wasm;
broken-doc structured diagnostics with subfile attribution; 12-fixture
exact-array parser corpus); demo smoke 4/4 with the network-level
no-glue assertion and both content proofs + negative controls; 8
real-wasm integration tests in ~23 s; CI green on HEAD with
runtime-tests genuinely running ci/typecheck/build/test; XeTeX-first
honored (luatex rejected at three layers, pdftex proven end-to-end);
rebase-proofing rules audited (asset knowledge role-driven; fixtures
regeneratable; no TL version strings in runtime code); license audit
green. **M1 acceptance SATISFIED — the MVP core exists.**

**Carry-forwards (tester's notes).** (1) CI proves the pure modules
only until M3 wires artifacts in — wasm-path evidence is local (the
documented deferral). (2) M4 acceptance should include manifest
sha256-vs-bytes verification (assets.test.ts checks shape, not
integrity). (3) The two FORMAT_* in-MEMFS TDS path constants in
core.ts are the one code-constant format knowledge (no inventory field
can express intra-bundle paths); judged acceptable, conformance corpus
catches a TDS-layout change at rebase.

**Milestone summary.** M1 delivered the §5 API in full: correlated
protocol (hostile-input-hardened at both boundaries), worker with the
snapshot/restore execution model, §5.3 sequencing machine
(fixture-grounded), client with real cancellation, diagnostics parser,
demo migrated off the vendored glue (proven at network level), 186
node tests + 4 browser tests, everything reviewed with three
blockers/five-catches-per-round caught and fixed along the way. Next
per the roadmap: **M2 — Rebase to TL 2026** (plan next iteration;
LuaTeX exits the build there).

## 2026-07-23 — M1 item 9: demo migrated to the runtime (loop)

**Done.** `coder` agent rewrote demo/index.html to drive the §5
runtime as native ESM (createTypesetter; import map bridges tsc's
extensionless internal specifiers — documented as a deliberate
canary), rendering PDF/log/diagnostics/stats. The vendored glue is no
longer loaded by the page — proven at the NETWORK level by the smoke
(all requests recorded; glue absent; our worker present). CI
demo-smoke builds the runtime when the dist guard passes; still skips
green without artifacts.

**Acceptance wins.** (1) Content-level PDF proof, twice over: XeTeX
text reconstructed via the embedded ToUnicode CMap (ligature-safe) and
pdfTeX via content-stream literals — both with COMMITTED negative
controls (wrong sentence asserted absent; demonstrated red when
pointed at the wrong string). Closes M0 gap #1. (2) First REAL
Worker.terminate() cancellation in Chromium: cancel → CancelledError →
fresh-worker recompile succeeds. (3) Broken-doc diagnostics visible in
a real browser: {error, 'Undefined control sequence.',
chapters/broken.tex, 4}. Smoke 4/4 (~7 s); runtime 186/186; audit
green. Review: APPROVE, nits only (clear-triage assertion applied;
CMap collision with math fonts documented — demo doc kept single-font
with a warning comment).

## 2026-07-23 — M1 item 8: diagnostics parser (loop)

**Done.** `coder` agent delivered `runtime/src/diagnostics.ts` — pure,
zero-dep, client-side only (worker bundle byte-identical): TeX `!`
errors with `l.N` lines, LaTeX/Package/Class warnings with
continuation folding, kpathsea not-found kept verbatim for M4, file
attribution via a paren-stack with null placeholders for prose parens
(prose can't poison attribution — reviewer probed it), Overfull boxes
excluded, global dedup + caps. 12 fixtures captured verbatim from the
pinned engines (both engine variants where they differ). The
subfile-attribution case — error inside an \input'd chapter — proven
end-to-end through the public API over real wasm:
{severity:'error', file:'chapters/broken.tex', line:4}. That closes
§8 acceptance case (iii).

**Review: request-changes, the catch mattered.** A document missing
\end{document} — a highly likely LLM-authored error (§10) — produces
`! Emergency stop.` as the transcript's ONLY error line; the
terminator filter dropped it → failed compile, EMPTY diagnostics,
breaking §5.2's promise. Fixed by promoting standalone terminators to
errors (consequence-terminators still filtered), with a real captured
no-end-document fixture and a public-API assertion. Nits: warning
continuations can no longer swallow stack-close lines; dedup key now
collision-proof (which surfaced and removed 3 stray NUL bytes); docs
aligned. 186/186 tests, audit green.

## 2026-07-23 — M1 item 7: client API (loop)

**Done.** `coder` agent delivered `runtime/src/client.ts` — the §5.1
public surface, verbatim (options/job/result shapes reviewer-checked
against the DESIGN code block): createTypesetter, job objects
(done/onLog with late-subscriber replay/cancel), serialized jobs,
cancel = terminate + transparent reinit, dispose, error taxonomy
(Cancelled/WorkerCrashed/Fatal/TypesetInput). All four §8 acceptance
cases proven with evidence (stale-A-result injected during B → dropped
+ B unaffected; workerSpawns===2 on cancel; queue serialization;
dispose rejections) plus full-stack public-API tests over real wasm.
locateAsset lands end-to-end (per-entry url override, validated at
both boundaries); onAssetProgress is honestly coarse (real totals, no
fabricated byte counts — importScripts exposes none). Also fixed a
pre-existing gap the agent flagged: `npm run build` failed under the
hardened ES2022-only lib (TextDecoder) — minimal ambient declaration
added and CI now runs the build step so packability is gated.

**Review: BLOCKER caught, fixed, and proven.** The dispatch pump's
settled-head path used shift() while #cancelJob had already spliced
the cancelled handle — cancelling a queued job during reinit silently
dropped the NEXT job, whose done promise hung forever (reviewer
reproduced the hang live). Fixed with identity-based removal + a
regression test verified to FAIL on the unfixed code. Nits: integration
test title now states the cancel lands pre-delivery in-process;
workerUrl doc notes locateAsset does not cover the worker script.
Gates: 148/148, build green, 28.6 KB bundle with zero client symbols,
audit green.

## 2026-07-23 — M1 item 6: §5.3 sequencing state machine (loop)

**Done.** `coder` agent delivered `sequencing.ts` — a pure reducer
encoding §5.3 exactly: bib gate (\citation AND \bibdata in the root
aux), makeindex gate (non-empty .idx), rerun on transcript markers OR
aux/toc change, tools force one incorporate pass, hard cap 5, explicit
N exact (tools still gate; degenerate passes:1+bib documented).
Rerun markers captured as fixtures from the REAL pinned engines (9
transcripts + GENERATOR.md — no folklore strings). bibtex8 semantics
evidence-grounded: exit ≤1 continue (warnings write usable .bbl),
≥2 abort → ok:false with the tool's transcript; stricter and simpler
than upstream's stdout-string sniffing. texlive-basic turned out to
carry plain.bst, so the bibtex8 path is proven END-TO-END on real
wasm: xelatex→bibtex8→xelatex→xelatex→xdvipdfmx, 3 passes; crossref
converges in 2; hello in 1. 116 tests total (41 pure machine).

**Review (request-changes → fixed).** (1) pdfTeX collects a PDF every
pass, so an abort after a good pass 1 attached a STALE pass-1 PDF
(citations as [?]) to ok:false — now bytes ship only on full success,
with a pdftex-variant regression test. (2) Root-aux-only bib detection
misses \include projects (\citation lands in chapter .aux) — accepted
as documented v1 limitation at the detection site + journal; real fix
needs dynamic collect, deferred. (3) Defense-in-depth step bound on
the driver loop (invariant regression → loud fatal, not a spinning
worker). Gates: typecheck clean, 116/116, 27 KB bundle self-contained,
audit green.

## 2026-07-23 — M1 item 5: worker entry (loop)

**Done.** `coder` agent built the worker: `core.ts` (orchestration over
an injected EngineHost; every outbound message via protocol
constructors, jobId-correlated; luatex → unsupported-engine; item-6
seam marked at planCompile), `engine-host.ts` (real emscripten host),
`entry.ts` (thin classic-worker binding), `parseClientMessage` +
outbound constructors added to the protocol at the item-3 trust bar,
esbuild (exact-pinned devDep) bundling a 21 KB self-contained IIFE
classic worker (zero imports/node builtins — grep-gated).

**Execution model (empirical, journaled in M1-item5-journal.md).** One
persistent MODULARIZE instance + 64 MiB linear-memory snapshot/restore
after every callMain — REQUIRED (without reset the second run OOMs;
with it reruns are byte-identical); MEMFS lives in the JS heap so the
79 MB bundle and intermediates survive resets. Snapshot trick credited
to upstream busytex_pipeline.js as behavioral reference (MIT).

**Review: request-changes, five real catches, all fixed + tested.**
(1) Failing xetex compiles had NO error text in result.log
(batchmode) — switched to nonstopmode; integration test now asserts
"Undefined control sequence" surfaces. (2) _flush_streams never
called — TTY half-lines survived the memory reset and would surface
under the NEXT job's id (§5.2 content violation); now flushed per run,
3-job isolation test proves no bleed. (3) `..` path traversal escaped
the job dir and persisted across jobs — rejected at the trust boundary
with hostile tests. (4) Upstream's zero-past-header load assertion was
dropped — restored (112 ms once/session); a rebase outgrowing the
64 MiB header now fails loud. (5) Inherited always-on IndexedDB bundle
cache (upstream --use-preload-cache) deviates from §5.2's
optional-adapter stance — journaled; drop planned at the M2 bundle
rebuild. 66/66 tests; hello-world through real wasm under node in
2.7 s; multi-job isolation ~4 s.

## 2026-07-23 — M1 item 4: assets.json generator (loop)

**Done.** `coder` agent delivered `build/manifest/gen-assets.mjs`
(original, zero-dep): deterministic dist inventory — sorted paths,
SOURCE_DATE_EPOCH-only timestamp, 8 structural roles (first-match-wins;
sibling-pairing rules so a rebase's renamed bundles classify with no
code change), UNKNOWN file → hard exit 1, SHA256SUMS cross-check both
directions, symlinks rejected. Wired into the dist stage before the
verify gate. Trust chain: assets.json carries the sha256 of SHA256SUMS
which covers everything else — the single unanchored root, exactly the
seat M4's integrity manifest takes over (schemaVersion bump).
Idempotency proven across three runs incl. one from the main session
(identical bytes, 2f917af1…). Protocol asset types tightened
(strictly type-level — reviewer verified the item-3 guards untouched);
schema↔type compatibility pinned by compile-time witnesses + a
real-file runtime test that skips cleanly in CI. 31/31 tests, audit
green (20 sources). Review: approve; nits folded (SHA256SUMS find now
excludes assets.json against a future incremental dist; test comment
credits the precision pins, not excess-property checking). Deferred to
item 5: verify-engine gaining an assets.json existence/parse check.

## 2026-07-23 — M1 item 3: correlated protocol module (loop)

**Done.** `coder` agent delivered `runtime/src/protocol.ts` — the §5.2
constitutional core, original design (envelopes `{type, v, jobId}`,
discriminated unions both directions, recognizably divergent from the
journaled upstream glue contract): branded JobId (counter+random, no
Date.now), `isForJob` as the single correlation gate, total
never-throwing `parseWorkerMessage` that rebuilds accepted messages as
fresh literals, `transferablesOf` with dedup + SAB exclusion. No
cancel message by design (cancel = worker termination, §5.2).
Diagnostics deliberately off the wire (client-side parser, item 8 —
rebase-proofing rule 2). 29 protocol tests incl. the concrete
stale-result-vs-newer-job scenario and prototype-pollution suites.

**Review: BLOCKER caught and fixed.** The parser-table lookup walked
the prototype chain — `type:"constructor"` resolved to Object's
constructor and `Object(data, jobId)` returned the HOSTILE OBJECT BY
REFERENCE (reviewer proved it empirically), falsifying the module's
fresh-literal invariant at the exact trust boundary it defends. Fixed
with an `Object.hasOwn` own-key guard + a rejection test suite over
inherited-member type values (constructor/toString/__proto__/…).
Ride-alongs: transferablesOf now documents the subarray
whole-buffer-detach hazard; fresh-literal claim scoped precisely
(byte payloads referenced by design); SAB-exclusion branch now tested.
Re-verified: typecheck clean, 29/29, audit green.

## 2026-07-22 — M1 opened: Runtime v1 plan

**Done.** docs/plans/M1.md authored and committed: §5 API over a
correlated worker protocol, XeTeX-first scope (pdftex only if
near-free; luatex reserved), 10 commit-sized items (scaffold →
protocol → data-driven assets.json → worker → §5.3 sequencing state
machine → client API → diagnostics parser w/ real-transcript fixtures
→ demo migration → tester-verified acceptance). The three
rebase-proofing rules are binding plan text; M0's carry-forward gaps
(content-level PDF assertion, typeset-path integration test) are in
the acceptance list. Loop continues without stopping per the
2026-07-22 push-through directive.

**Milestone summary (M0).** M0 proved the toolchain end to end on the
native-first path: pinned sources (5, hash-verified incl. the 4.77 GiB
ISO), pinned emsdk 3.1.43 (container + darwin-arm64), vendored busytex
machinery byte-verified at f2bd7b1, full TL 2023 build native on arm64
in ~70 min, wasm multicall engine that boots and typesets in Chromium,
a demo + Playwright gate, a real license audit, and three green CI
workflows on a now-public repo. Deviations all recorded: native-first
pivot, amd64 requirement dropped, LuaTeX dropped from v1, M2↔M3 swap,
repro/CI deferrals. Next per the revised §9: **M1 Runtime v1** — plan
written next iteration (loop continues per the 2026-07-22 push-through
directive).
