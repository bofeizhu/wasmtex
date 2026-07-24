<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M5 — Release engineering + hardening: build journal

Durable engineering record for the release milestone. One section per work item,
written as the work runs — every decision, verification, failure → fix and
standing note so a future maintainer can replay it. Feeds `docs/LOG.md` (the
terse milestone record); this is the long-form companion. Item 1 (the plan) is
`docs/plans/M5.md`; this journal opens at item 2.

Provenance discipline (DESIGN.md §2): the license allowlist, the audit model, and
the enumeration are original work; the only inputs read are our own dist
inventory, TeX Live's own `texlive.tlpdb` (`catalogue-license` metadata, not
third-party code), and TeX Live's own `LICENSE.TL`. No GPL/AGPL source and no
other WASM-TeX wrapper was opened; encounters (none this item) are noted so the
audit trail shows avoidance.

---

## Item 2 — bundle license enumeration + fail-closed §7 audit

Dated 2026-07-24. Goal: enumerate the license of every TeX Live package the
shipped bundles (`core` + `academic`) actually carry, from the pinned tlpdb's
`catalogue-license`, and add a FAIL-CLOSED audit that fails the build on any
shipped package with a missing / non-free / unknown license. Retire the stale
"to be inventoried" deferral in `THIRD_PARTY_NOTICES.md`. Legally load-bearing —
it is the evidence behind DESIGN §1/§7's "aggregate of free TeX Live programs"
statement — so it FAILS on anything unresolvable and never guesses. Local work,
no container build.

### What was built

- **`build/bundles/licenses.mjs`** — zero-dep Node ESM library + CLI. Reuses
  `resolveTiers` (the resolver already owns the tlpdb→tier truth) and reads each
  shipped package's `catalogue.license`. Produces the machine-readable inventory
  (per-tier `package → {license, source}`, aggregate `byLicense` + `byToken`) and
  runs the audit. CLI: `--tlpdb`, `--json OUT`, `--no-exceptions`, `--quiet`;
  exits non-zero on audit failure.
- **`build/bundles/license-exceptions.mjs`** — the cited, committed resolution
  table for shipped packages the TeX Catalogue does not usefully license.
- **`build/bundles/licenses.test.mjs`** — 23 tests (allowlist logic, the three
  resolution cases, shipped-vs-not, exception precedence, inventory determinism,
  and the real-tlpdb acceptance + baselines).
- **`dist/licenses.json`** — the generated inventory the release archive carries
  (role `license-inventory` in `manifest.json`), emitted in the container/native
  dist stage before `SHA256SUMS` so it is hashed + cross-checked like any payload.

### Key design decisions

1. **"Shipped" = owns ≥ 1 runfile in its tier.** The audit judges exactly the
   packages whose files a user receives. This cleanly excludes Collections/Schemes
   (no runfiles — already dropped by the resolver) AND doc-/binary-only packages
   (docfiles/binfiles dropped by the WASM build → 0 runfiles): `luahbtex`, `tex`,
   the `*-zh-cn` manuals, etc. Without this refinement, ~6 core + ~20 academic
   zero-file packages (several license-less) would spuriously fail. Proven
   equivalent to `runfiles.length > 0` under the resolver's disjointness guarantee,
   but computed directly (owned-count) so it never relies on that proof.

2. **Explicit free ALLOWLIST (a Set, not globs).** The TeX Catalogue's free
   license vocabulary, researched against THIS pinned tlpdb (36 tokens actually
   present) plus forward-looking siblings. Fail-closed by construction: a token a
   future pin introduces that we have not vetted is "unknown" → FAILS. Non-free
   markers (`nonfree`/`nosource`/CC-NC/CC-ND) and the `collection`/`noinfo`
   placeholders are deliberately absent.

3. **Space-separated values are aggregates, not choices.** `catalogue-license`
   often lists several licenses (`ofl lppl`, `lppl1.3c agpl3`, `gpl3+ fdl`) — a
   package whose parts carry different licenses. We split on whitespace and require
   EVERY token to be free (one non-free token = a non-free file shipped). This is
   the correct fail-closed reading.

4. **Three resolution cases (the placeholder distinction).** (A) catalogue value
   all-free → PASS. (B) UNRESOLVED — absent/empty, or a placeholder that asserts no
   license (`collection` = "bundle of parts", `noinfo` = "none found") → a *cited*
   exception resolves it; without one it FAILS. (C) a real non-free/unknown token →
   FAILS and is NOT exception-overridable (a human must drop it). This surfaced
   mid-implementation: 5 shipped packages carry `catalogue-license collection` on
   real Package stanzas (not the Collection-stanza meta-value I first assumed) —
   `ltxmisc`, `frankenstein`, `preprint`, `was`, `fragments`. `collection` means
   *unspecified*, not *non-free*, so it belongs in case B, not the nonfree bucket.

5. **`agpl3` is allowlisted (free).** 16 academic packages carry `lppl1.3c agpl3`
   (LPPL macros + AGPL code). DESIGN §2's no-copyleft rule governs OUR runtime
   code; the bundled TeX Live programs are separate programs in the aggregate under
   their own free licenses (§1/§7), and AGPL-3.0 is a free license — so it passes.
   Recorded explicitly because a naive `gpl*` glob would have missed it.

### Never-guess: how the 22 catalogue gaps were resolved

The audit, run raw (`--no-exceptions`), FAILS naming **22** shipped packages: 17
with no `catalogue-license` (TeX Live infrastructure, CJK/Thai encodings + two
Thai fonts, hyphenation data) and the 5 `collection`-token bundles above. Every
one is TeX-Live-*proper* (installed from `texlive.tlpdb`, not the separable CTAN
snapshot). TeX Live's own **`LICENSE.TL`** is the authoritative, maintainer-vetted
guarantee that all such software is *"freely redistributable … within the FSF's
definition and the DFSG"*, and is explicit that only the CTAN snapshot (which
`install-tl` does not put in `texmf-dist`, and we do not ship) contains non-free
files. So freeness is *established*, not assumed. Each gap is recorded in
`license-exceptions.mjs` as `other-free` (the honest floor — "free per LICENSE.TL,
specific license per the package's own files") with a per-package factual reason
and the LICENSE.TL citation. Choosing `other-free` over inventing a specific SPDX
id we had not read is the point: the pruned build tree drops the doc-tree license
files, so a tighter classification would need the unpruned CTAN container — a later
optional human tightening, noted in the table. This is NOT silent passing: all 22
are reported, cited, committed, and reviewable, and the audit stays fail-closed for
any NEW gap.

### Validation (against the pinned TL 2026 tlpdb, revision 78233)

- `--no-exceptions` → **FAIL**, exactly the 22 gap packages named (17 `missing`,
  5 `unspecified`). Default (with the cited exceptions) → **PASS**: 2 545 shipped
  packages (151 `core`, 2 394 `academic`), every one free; no redundant/ignored/
  unused exception.
- `node --test build/bundles/licenses.test.mjs` → 23/23 pass (real-tlpdb group
  runs locally; skips green without the ISO). `gen-assets.test.mjs` 7/7 with the
  new `license-inventory` role fixture. Full `build/audit/license-audit.sh` green
  incl. new check (f).
- Distinct free licenses: 36 tokens / 82 raw values. Dominant families: LPPL
  (~2 020 pkg-mentions), GNU GPL/LGPL/AGPL/FDL (~250, incl. `agpl3`×16), MIT/X11
  (~110), `other-free` (85 = 63 catalogue + 22 gap resolutions), public domain
  (~72), Creative Commons BY/BY-SA (~42), OFL/GUST/Knuth (~24), BSD (~25).

### CI wiring (decision)

Three-fold, chosen so the fail-closed gate runs wherever the tlpdb exists without
blocking fast per-PR CI (which has no ISO):

1. **Container/native dist stage** (`build/artifacts/build-native.sh` +
   `run-in-container.sh`): `licenses.mjs --json dist/licenses.json` runs BEFORE
   `SHA256SUMS` — the audit is a fail-closed build gate AND emits the shipped
   inventory as a hashed, manifest-listed release artifact. `gen-assets.mjs` got a
   `license-inventory` role rule so `licenses.json` classifies cleanly.
2. **`build/audit/license-audit.sh` check (f)**: runs the aggregate audit when a
   tlpdb is present (`$WASMTEX_TLPDB` or the maintainer's native cache); notes it
   deferred to the dist stage when absent. Complements the existing
   source-provenance checks (a–e), does not replace them.
3. **Fast CI `build.yml`**: `licenses.test.mjs` added to the `node --test` line —
   the synthetic + exceptions-table tests (allowlist logic, the 22-entry baseline)
   run per-PR; the real-tlpdb group skips green.

### Reported for human attention

The 22 gap packages are the key output the user should be aware of — all resolved
`other-free` via LICENSE.TL, all reported. The 5 `collection`-token bundles
(`ltxmisc`, `frankenstein`, `preprint`, `was`, `fragments`) are the most worth a
second look (old CTAN grab-bags); dropping any from `academic` is a valid
alternative resolution (edit `tiers.mjs`). No shipped package is non-free.

---

## Item 4 — the fuller conformance corpus

Dated 2026-07-24. Goal: complete the §8 corpus beyond the M4 tier-exercising seeds
(`sci-paper`/`cjk-ctex`/`pkg-core-only`) with the remaining DESIGN §8 doc types —
`unicode-math` (XeTeX), a multi-chapter `\include` project, a known-bad document
(diagnostics, not a PDF), a standalone TikZ figure, and a host-supplied-font CJK
variant (§6.3, font via `files`, not the bundled fandol). Validated against the
on-disk native `dist/` (core + academic + manifest); no container build. Tester
work; the orchestrating session reviews + commits.

### What was added

Five corpus entries (each `conformance/corpus/<name>/` with original `.tex` +
`expectations.json`), all green against `dist/`:

| entry | engine | pages | passes | bundlesLoaded | resolution | pdf | key proof |
|---|---|---|---|---|---|---|---|
| `unicode-math` | xetex | 1 | 1 | core+academic | scan | 11 KB | real math ROUND-TRIPS (∫ ∞ ∑ √ recovered); LatinModernMath embedded |
| `multi-include` | pdftex | 4 | 2 | core | none | 78 KB | `\include` + TOC + forward-`\ref` rerun (`phases=[engine,engine]`); pinned pass-1 diags |
| `known-bad` | pdftex | — | 1 | core+academic | (n/a) | none | `ok:false`, exit 1, `noPdf`, error-diagnostic shape; bounded 1-mount retry |
| `tikz-standalone` | pdftex | 1 | 1 | core+academic | scan | 36 KB | cropped `standalone` figure; pgfplots scan; labels recover |
| `cjk-hostfont` | xetex | 1 | 1 | core+academic | scan | 6 KB | host font embedded, **fandol absent**; CJK round-trips |

Plus: `conformance/fixtures/` (the CJK stub-font generator + provenance README);
two new runner assertions in `run.mjs` (`noPdf`, `absentFonts`); and `README.md`
updated (entry descriptions + schema keys + `fixtures/` layout).

### Key design decisions

1. **`provides`-name lookup forces the scan drivers.** The §5.4(a) scan resolves
   `\usepackage` NAMES against the manifest `provides` index; `tikz` is NOT a
   provides name (it ships from the `pgf` package), so a bare `\usepackage{tikz}`
   would fall to the RETRY path. To keep the two figure/math entries on the SCAN
   path (as §8/the task specify), they load provides-name packages: `unicode-math`
   and `pgfplots` (both academic provides). `tikz-standalone` uses
   `\documentclass{standalone}` (academic, invisible to the scan) but `pgfplots`
   preselects academic before pass 1, so standalone.cls is present when pass 1 runs.

2. **`multi-include` stays core + pins the rerun.** `report.cls` + `\tableofcontents`
   + `\include` + `\label/\ref` are all base LaTeX (core), so `bundlesLoaded=['core']`,
   `resolution=none`. A forward `\ref` (chap1 → chap2) is undefined on pass 1 →
   "Rerun to get cross-references right" → the §5.3 auto-rerun runs pass 2.
   `phases=['engine','engine']` is the rerun-loop LOCK (the runner has no direct
   passes assertion; two engine banners = two passes). The 3 pinned diagnostics are
   the pass-1 undefined-`\ref` warnings the multi-pass transcript retains — a
   parser exercise distinct from `bib-cite` (cross-reference, not citation; file/line
   attributed across the `\include`d `chap1.tex:5`).

3. **`known-bad` = missing package, and the retry is BOUNDED, not spurious.**
   `\usepackage{nosuchpackagexyz}` is in no tier. Observed: pass 1 fails "File
   `nosuchpackagexyz.sty' not found"; the §5.4(b) retry — the sound
   over-approximation with a single on-demand tier (`selectBundlesForMissingFiles`)
   — mounts academic ONCE; the re-run still can't find it; clean fail. So
   `bundlesLoaded=['core','academic']` (one attempt, no loop), `ok:false`,
   `exitCode:1`, NO PDF ("Fatal error occurred, no output PDF file produced!").
   This is the CORRECT non-spurious behavior the task asked to confirm (the corpus
   counterpart to the integration test "a genuinely-missing package retries once
   then fails cleanly"). The error diagnostic shape (the deliverable):
   `{severity:"error", message:"LaTeX Error: File \`nosuchpackagexyz.sty' not
   found.", file:"main.tex", line:3}` — line 3 is `\begin{document}`, the
   emergency-stop point (the parser takes the first `l.<n>` after the error). No
   `resolution` is pinned: the retry mounted but did not resolve, which fits none of
   scan/retry/none cleanly (final log retains "not found").

4. **Host-CJK fixture is ORIGINAL work, not a vendored font.** Rather than vendor a
   real open CJK face (5–20 MB even subset, third-party-licensed), the fixture
   `WasmTeXStubCJK-Regular.ttf` (~1.6 KB) is hand-authored via fontTools
   (`conformance/fixtures/build-stub-cjk.py`): plain rectangular glyphs for the nine
   Han codepoints the doc uses. It exercises the ENTIRE §6.3 host-font path
   (project-file font resolved by `\setCJKmainfont[Path=./]`, used for the CJK range,
   embedded, demonstrably not fandol) while the assertion is STRUCTURAL (fontProbe;
   no pixel comparison, §8). `\usepackage{xeCJK}` (not `ctex`) drives the scan and
   loads no default font, so fandol never enters. Bonus: the stub carries a plain
   Unicode cmap, so xdvipdfmx writes a ToUnicode CMap and the Chinese round-trips —
   `你好世界` etc. are asserted as `textSnippets` too (contrast `cjk-ctex`, whose
   fandol CID subset has no ToUnicode → structural-only).

5. **Two runner assertions added (strengthening, never weakening).** The error path
   and the negative font control needed harness support the M4 runner lacked:
   - `noPdf: true` → asserts `!(result.pdf instanceof Uint8Array)` (the `known-bad`
     "NOT a PDF" contract; counterpart to `minPages`).
   - `absentFonts: [...]` → each name must NOT substring any `/BaseFont` (the
     `cjk-hostfont` "NOT fandol" control; counterpart to `embeddedFonts`).

### Validation (native `dist/`, manifest preflight OK: 30 checks, 11 files)

- `node conformance/run.mjs` → **all 12 run corpus entries passed** (7 prior + 5
  new), exit 0. Per-entry figures in the table above (verbatim from the runner
  summary). The `known-bad` entry's `ok:false`/no-PDF is a PASS of its test.
- **Assertions discriminate** (injected wrong expectations → the runner FAILs,
  verbatim; then reverted):
  - `known-bad` diag message mutated to `WRONGNAME.sty` → `FAIL: diagnostics — got
    [{… nosuchpackagexyz.sty …}]`.
  - `cjk-hostfont` `embeddedFonts:["FandolSong"]` → `FAIL: font:FandolSong — embedded
    /BaseFont names: [… WasmTeXStubCJK-Regular]`; `absentFonts:["WasmTeXStubCJK"]` →
    `FAIL: absentFont:WasmTeXStubCJK — /BaseFont unexpectedly matches "WasmTeXStubCJK"`.
    Both directions of the host-font-not-fandol control proven.
  - `noPdf:true` injected on `multi-include` (which DOES emit a PDF) → `FAIL: noPdf —
    unexpected PDF produced (77938B)`.
- **No regression**: `npm --prefix runtime test` → **267 tests, 12 files, all
  passed** (unchanged; only the test harness `run.mjs` was touched, not runtime src).

### Reported for human attention (font-fixture provenance)

`conformance/corpus/cjk-hostfont/WasmTeXStubCJK-Regular.ttf` is a NEW binary checked
into the repo. It is **original work, MIT** (under the repo `LICENSE`) — not derived
from any third-party font (every outline is a rectangle defined in the generator;
no fandol/Noto/Source-Han source consulted, DESIGN §2 clean). Because it is original
repo work, it needs **no** `THIRD_PARTY_NOTICES.md` entry (that file inventories
third-party material). Provenance is recorded in `conformance/fixtures/README.md` +
the generator's SPDX header. Flagged so the main session can confirm the classification
(original/MIT, no third-party notice) at review, and decide whether it prefers the
`.ttf` physically under `fixtures/` (would need a runner change to load a shared
fixture; today the runner only loads a corpus entry's own dir, so the font lives in
the entry as the §6.3 "host supplies it via `files`" contract intends).

### Coverage gaps noted

- `luatex` is not shipped (manifest `engines` = xetex/pdftex/bibtex8/xdvipdfmx/
  makeindex/kpsewhich), so the corpus exercises unicode-math/CJK via XeTeX only —
  the LuaTeX path is out of scope for v1.
- No entry drives the retry path to a SUCCESSFUL non-`\documentclass` miss beyond
  `cjk-ctex`; the new academic entries all use the scan (by design, per the task).
- The pinned `multi-include`/`known-bad` diagnostics (message + line) are
  rebase-sensitive by construction (like the `bib-cite` fixture) — a wording/line
  shift on a TL rebase is a finding to re-baseline, not a silent failure.

---

## Item 3 — Docs: README + embedding guide + runtime README flip

Dated 2026-07-24. Goal: make the shipped docs tell the truth for the imminent
`0.1.0` release. Rewrite the stale root README status; write a real embedding
guide for the DESIGN §10 profile; flip runtime/README's "no release channel
yet" language; reconcile the Node-version claim; and document (as prose) the
npm↔assets version convention that item 8 will code. Docs-only — no runtime or
build code touched. Accuracy bar: every API/option documented is grep-verified
present in `runtime/src/client.ts` / `index.ts` / `protocol.ts`; nothing
aspirational is presented as shipped.

### What was written

- **`README.md` (root)** — rewritten. The old status table claimed "pre-code
  bootstrap … no engine or runtime code yet" and marked M3 in-progress /
  M4–M5 not started — all false. Now: M0–M4 **Done**, M5 **In progress**; the
  first release is `0.1.0` (imminent, not published); a new "What works today"
  section (XeTeX + pdfTeX end to end, bibtex8/makeindex auto passes, the
  `core`/`academic` tiers, §5.4 on-demand resolution, diagnostics, real
  cancel, cold start); an npm-JS-only + separately-hosted-assets note; links to
  the embedding guide and runtime README. Kept the (accurate) Why / License /
  Acknowledgments sections.
- **`docs/embedding.md`** — new, ~525 lines. The §10 hard-constraint profile end
  to end: the JS-package/hosted-assets split; install; where assets live
  (GitHub Release `assets-v<v>` archives, NOT the npm tarball) + the tree; the
  `application/wasm` MIME requirement; same-origin boot via `assetsBaseUrl`; the
  full real `createTypesetter` option table; the `preload:['core'] /
  onDemand:['academic']` model with the crucial "on-demand = a LOCAL bundle
  mount, no compile-time network" clarification and both §5.4 resolution paths;
  the job API (`typeset`/`onLog`/`diagnostics`/`cancel`/`dispose`,
  `stats.bundlesLoaded`) + a copy-pasteable minimal example mirroring the demo;
  cold start with zero browser storage; **host-side** integrity verification
  against `manifest.json` (with a Node/crypto sketch); the custom-scheme path
  (`locateAsset` + `workerUrl`, Electron `protocol.handle`); the version
  convention; the error taxonomy; guarantees/non-goals.
- **`runtime/README.md`** — three edits: Status section flipped ("assets ship as
  versioned GitHub Release archives `assets-v<v>`; host them, pass
  `assetsBaseUrl`" + embedding-guide link, replacing "no official release
  channel yet / build from source"); quickstart bundles `texlive-basic` →
  `core`/`academic`; the Node-version line reconciled (below).
- **`docs/plans/M5-journal.md`** — this entry.

### Node-version reconciliation (the decision)

Tension: `package.json` `engines.node` said `>=18`; runtime/README said
"Requires Node 24 (`engines`); CI runs the same major" — internally
contradictory and wrong about `engines`. **Determined the actual minimum and
kept `engines: ">=18"`; fixed the README to match.** Rationale:

- The published package is **browser-targeted** — consuming `wasmtex` runs it in
  a Worker via `fetch`+`WebAssembly` and needs no Node at all. `engines.node`
  only gates npm-install warnings, so inflating it to 24 would spuriously warn
  browser consumers whose Node only runs their bundler.
- The real **toolchain** floor is Node 18: `runtime/node_modules/vitest`
  (3.2.7) declares `engines.node ^18 || ^20 || >=22`, `esbuild` (0.28.1)
  declares `>=18`, TypeScript 5.9 needs ≥14.17. The runtime source uses only
  ES2022 (`Object.hasOwn` = Node 16.9+, `globalThis.crypto` with a
  `Math.random` fallback so no hard Node-19 dep) and tests use `structuredClone`
  (Node 17+) — all ≤18. Grepped `runtime/{src,worker,node,test}` for
  Node-20/22/24-only APIs (`Array.fromAsync`, `findLast`, `toSorted`, …): none.
- CI **does** pin Node 24 (`build.yml`, `runtime-tests.yml`,
  `artifacts-build.yml` all `node-version: 24`; no `.nvmrc`). So 24 is the
  single *tested* major, not the *minimum*. The README now says exactly that:
  consuming needs no particular Node; the dev floor is ≥18 (the true minimum);
  CI/the pinned toolchain run Node 24, use it to match CI.

Did NOT change `package.json` — `>=18` was already correct; the bug was the
README overclaim. (No code changes at all this item, per scope.)

### The version convention (documented; coded at item 8)

Documented as the **intended** `0.1.0` contract, explicitly flagged not-yet-
shipped: `wasmtex@X.Y.Z` will export an **`ASSETS_VERSION`** constant and
`createTypesetter` will **soft-verify** the fetched `manifest.json`'s declared
version matches (clear error on mismatch, overridable), so a consumer hosts the
matching `wasmtex-assets-X.Y.Z` archive. Today the pairing is a convention the
host upholds by hosting the right archive. **Item 8 implements the constant +
the soft verify** (and must add a lockstep `version` field to the manifest —
the current `manifest.json` carries `schemaVersion` and `texliveSnapshot` but
no package-lockstep version for `ASSETS_VERSION` to check against). Recorded in
both the embedding guide (§10) and this journal so item 8 has the spec.

### API details the code clarified (worth knowing)

- **No runtime integrity check.** The manifest carries per-asset `sha256`/`bytes`
  and a `SHA256SUMS` list, but the runtime does **not** re-hash assets at load —
  it validates the manifest's *shape* and loads by role. Grepped
  `runtime/{worker,src}`: no `crypto.subtle`/`digest`/hash-verify. This matches
  DESIGN §10 exactly ("an integrity manifest the host **can** verify after
  download") — so the guide documents integrity as a **host-side** step (with a
  Node sketch), not a runtime feature. Avoided the easy overclaim.
- **`locateAsset` does not relocate the worker script.** It is consulted for
  inventory entries and the manifest filename (`manifest.json`, fallback
  `assets.json`), but the default worker URL derives from `assetsBaseUrl` only
  (documented inline in `client.ts`). So the custom-scheme section stresses that
  `workerUrl` (or `workerFactory`) is **required** under a custom scheme —
  otherwise the worker would be fetched from the wrong origin.
- **`fontspec` is in `academic`, not `core`.** Verified every package-to-tier
  claim against `dist/manifest.json` `provides` (a Node one-liner). First draft
  put `fontspec` in core (intuitive — it's XeTeX's font front door); the
  manifest puts it in `academic`. Corrected both README and the guide, and added
  the note that a plain XeTeX doc typesets from `core` alone but explicit font
  selection pulls `academic`.
- **`provides` lists tlpdb package names, so `tikz` ≠ a provides key.** TikZ is
  shipped by the `pgf` package; `provides` lists `pgf`, not `tikz`. Fixed the
  manifest example (`"tikz"` → `"pgf"`) and kept the tier descriptions at the
  feature level ("TikZ/PGF"). `\usepackage{tikz}` resolves via the §5.4
  missing-file retry (`tikz.sty` not found → mount `academic`), not the static
  `\usepackage` name scan — the guide describes both paths without pinning a
  broken static-scan example.
- **Test count left unpinned.** The old README's "186 node tests" is stale (M4
  log cites 267); a grep-count undercounts parametrized cases. Per the repo's
  rebase-proofing philosophy (drifting numbers aren't hardcoded), described the
  coverage instead of pinning a number.

### Provenance

Original prose, MIT; per-file SPDX header on `docs/embedding.md`. No third-party
docs or other WASM-TeX wrapper consulted; every API shape traced to this repo's
own `runtime/src/*`. No GPL/AGPL source opened (none encountered).
