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

---

## Item 5 — Size budgets (DESIGN §8)

DESIGN §8 requires the engine wasm and core-bundle sizes to be "tracked with an
explicit budget file; CI flags growth". Built that as a fail-closed gate in the
dist stage of both build drivers, mirroring the M5 item-2 license-audit wiring.

### What was built

- **`build/budgets.json`** — checked-in, human-editable per-asset byte ceilings,
  keyed by manifest asset path. Prose lives in `_comment` / `_rationale` /
  `_units` (JSON has no comments). Structure: a top-level `budgets` map
  (`path -> { maxBytes, tier, note }`) plus `unbudgetedWarnBytes`. Five entries,
  the proposed defaults from `docs/plans/M5.md` item 5:

  | asset          | tier      | budget | now (native dist) | used  | headroom |
  | -------------- | --------- | -----: | ----------------: | ----: | -------: |
  | busytex.wasm   | preload   |  30 MB |          27.51 MB | 91.7% |  2.49 MB |
  | core.js        | preload   |   2 MB |           1.47 MB | 73.4% |  0.53 MB |
  | core.data      | preload   |  60 MB |          53.87 MB | 89.8% |  6.13 MB |
  | academic.js    | on-demand |  12 MB |           9.30 MB | 77.5% |  2.70 MB |
  | academic.data  | on-demand | 550 MB |         496.59 MB | 90.3% | 53.41 MB |

  (MB = decimal 1e6 bytes — the manifest/prompt convention; `maxBytes` in the
  file is exact bytes.) The PRELOAD path is strict (cold-start cost paid on every
  embed load); the on-demand academic tier loose (mounts only when a scan needs
  it — trades against corpus completeness, not latency; the budget is a drift
  tripwire on the ~2400-package tier, not a tight ceiling).

- **`build/audit/check-sizes.mjs`** — zero-dep node ESM, SPDX-MIT, original. Reads
  the per-file `bytes` from `dist/manifest.json` (the gen-assets integrity
  manifest — **not re-stat'd**, so the budget is measured against exactly what
  ships) and `build/budgets.json`. Pure `checkSizes(manifest, parsedBudgets)` core
  + a thin CLI (readable table, documented `--json`, `--quiet`, `--manifest` /
  `--budgets` overrides). FAILS (exit 1) naming each over-budget asset with
  actual-vs-budget; prints a clean aligned size table on success.

- **`build/audit/check-sizes.test.mjs`** — 24 tests, `node:test`, style-matched to
  `build/bundles/licenses.test.mjs`: under/over budget, the strict-`>` boundary,
  the absent-asset note, the unbudgeted-large warning incl. duplicate suppression,
  budget-doc shape validation, missing-file handling, `--json` shape + determinism,
  and a real-dist group (skips cleanly without a built dist/). Wired into
  `build.yml`'s `node --test` line (now 114 tests across 28 suites, all green).

### Key design decisions

- **Wiring: a separate dist-stage step, NOT folded into `license-audit.sh`.** The
  prompt offered either. Chose a standalone step in both drivers' `do_dist`
  (after gen-assets writes the manifest, before the verify gate), because (1)
  `license-audit.sh` is provenance/copyleft-scoped and size budgets are an
  orthogonal concern — mixing them muddies the script's identity; (2) the
  dist-stage step is the real enforcement point and, living there, is enforced by
  `artifacts-build.yml` (the container build via `make artifacts-container`) with
  **no workflow edit** — exactly the item-3 requirement; (3) the unit tests cover
  the logic in fast CI. Same manifest-dependency constraint as the aggregate
  license audit: it needs a built dist/, so it can't run in a stock-checkout CI
  job without a build — hence the dist stage, not `build.yml`.

- **Unbudgeted-large WARN with sha256-duplicate suppression.** Only listed assets
  are enforced; a manifest asset over `unbudgetedWarnBytes` (5 MB) with no entry
  is *warned* (never failed) so a new large artifact can't ship unbudgeted
  unnoticed. But the `texlive-basic.*` back-compat aliases are byte-identical
  copies of `core.*` — the checker recognises them by **equal sha256** (already in
  the manifest, zero extra config) and suppresses the warning, since their bytes
  are already budgeted via `core.*`. Robust to any future alias, and name-agnostic
  (the `texlive-basic` alias's manifest bundle entry carries no `files`, so a
  name-based link wasn't available anyway). Verified against the real dist: 5
  checked (all OK), 2 duplicates noted, **zero** warnings.

- **Budgeted-but-absent is a note, not a failure.** A budget for an asset missing
  from the dist (a core-only build, or the `texlive-basic` alias when it's dropped
  at item 6/8, or a future retiered academic) is vacuously satisfied — noted, never
  a size breach. Keeps the budget file stable across tier changes.

- **Strict `>`.** Equal-to-budget passes; one byte over fails. `maxBytes` is an
  exact ceiling, validated as a positive integer at load (a malformed budget file
  aborts fail-closed rather than degrading to "nothing budgeted").

- **Container mounts.** `build/audit` → `/audit` (ro) and `build/budgets.json` →
  `/budgets.json` (ro) added to `build/artifacts/build.sh`, with a preflight
  existence check (a single-file bind mount of a missing host file would make
  Docker create a *directory* at the mount point — fail loud instead, mirroring
  the `$engines/Makefile` check). `run-in-container.sh` passes explicit
  `--manifest /dist/manifest.json --budgets /budgets.json`; the native driver uses
  repo-relative paths. Determinism preserved (no timestamps; sorted output).

### Validation (local, against the on-disk native dist/)

- `node build/audit/check-sizes.mjs` against the real native `dist/` → **PASS**,
  exit 0, prints the table above; 2 alias duplicates noted, 0 warnings.
- Forced breach (temp budget file, `busytex.wasm` ceiling lowered to 25 MB) →
  **FAIL**, exit 1, row shows `OVER` / `110.0%` / `-2.51 MB` and the failure line
  names `busytex.wasm: 27.51 MB exceeds budget 25.00 MB (over by 2.51 MB)`. The
  checked-in `build/budgets.json` was not touched (breach tested via `--budgets`).
- `--json` → deterministic (two runs byte-identical); carries
  `checked/failures/absent/warnings/unbudgeted`.
- `node --test build/audit/check-sizes.test.mjs` → 24/24. Full `build.yml` line →
  114/114. `bash -n` on all three edited drivers → clean.
  `build/audit/license-audit.sh` → all checks pass (the new `.mjs` files carry the
  SPDX-MIT header check (e) requires; the aggregate audit (f) still PASS, 2545
  packages).

### Deferred / noted

- **`academic.data` at 90.3% of its 550 MB budget** is the tightest on-demand
  headroom in percentage terms (53 MB absolute). Left at the proposed default; if
  the next rebase grows academic, this is the entry to revisit (it's on-demand, so
  a breach degrades corpus completeness, not cold-start — but it should be a
  conscious bump, which is exactly what the gate forces).
- **`M5.md` item 5 checkbox left unchecked** — flipped by the orchestrator on
  review/acceptance, per the established item-2/3/4 pattern.

### Provenance

Original work, SPDX-MIT headers on `check-sizes.mjs` + its test; `build/budgets.json`
is data (JSON, exempt from the header scan). Inputs read are our own
`dist/manifest.json` and `build/budgets.json` only — no third-party code. No
GPL/AGPL source and no other WASM-TeX wrapper opened or consulted (none
encountered); the budget model is original.

---

## Item 6 — soak + browser matrix + real-browser on-demand mount + demo migration + alias drop

Dated 2026-07-24. The hardening finale (five parts): a real-wasm soak test (50
sequential jobs, seeded cancellations, no cross-job contamination, dispose frees
the engine); the DESIGN §8 browser matrix (Chromium + Firefox + WebKit); the
M4-deferred real-browser on-demand academic mount; migrating the demo off the
`texlive-basic` alias to the tiered `preload:['core'], onDemand:['academic']`
model; and dropping the `texlive-basic` byte-alias emission from the build. All
validated locally against a freshly-regenerated native `dist/` (no container
build). Runtime/demo/build work; the release/publish steps stay user-gated.

### Part 1 — soak test (`runtime/test/soak.test.ts`, real wasm, node)

Drives the PUBLIC §5.1 API over the real busytex wasm (the in-process
`WorkerFactory` the integration suite already uses). 50 sequential jobs on ONE
typesetter (`preload:['core']`), each a DISTINCT pdfLaTeX document with a unique
marker (`SOAKUID####MARK`) in both a `\typeout` (→ `result.log`) and the body
(→ the PDF). Engine choice **pdfTeX**: the soak stresses the LIFECYCLE, not engine
coverage (XeTeX is already soaked by integration + conformance + the demo), and
pdfTeX's literal `(...)` content stream makes the per-job content proof a
self-contained inflate + string scan (no ToUnicode CMap). Skips cleanly without
`dist/`, like `typeset-integration`.

- **Seeded, deterministic cancels.** A tiny inlined LCG (Numerical-Recipes
  constants — public-domain math, not copied) drives a fixed cancel pattern
  (seed `0x50a1c0de`, ~30 %). No `Math.random`. Result: **37 completed / 13
  cancelled**, stable run to run.
- **Cancels are REAL worker terminations, not queued-drops.** First cut showed
  `workerSpawns=3`: a synchronous `cancel()` after `typeset()` races the dispatch
  pump, which drains on microtasks AFTER `await job.done` resolves — so the job
  was usually still QUEUED (a queued-drop, no worker kill). Fix: drain the pump
  with a macrotask (`setTimeout(…,0)`) before each job, so the next `typeset()`
  dispatches against an IDLE pump + ready worker → the job is ACTIVE (posted) the
  instant `typeset()` returns → a synchronous `cancel()` is a genuine
  `Worker.terminate()` mid-flight, respawning a fresh engine. After the fix:
  **`workerSpawns=12`** (11 real terminate+reinit cycles) — a genuine soak of the
  §5.2 respawn path.
- **No cross-job contamination.** Each completed job asserts its own marker is
  present in BOTH transcript and recovered PDF text, and — O(n) per job — that
  EVERY other job index's marker (prior, cancelled, or future) is ABSENT from
  both. A stale-worker / spliced-log leak from a terminated job would trip it.
  All 37 completions clean.
- **Memory: what was measured + the deterministic gate.** An instrumented factory
  counts every spawned worker and its `terminate()`; `live = spawned − terminated`
  is the engine instances still referenced. After `dispose()`: **`live===0` and
  `terminated===spawned` (12/12)** — every ~64 MiB-linear-memory + 54 MB-core-MEMFS
  engine is dereferenced — and a FRESH typesetter then compiles cleanly. That
  object-lifecycle gate is the meaningful, non-flaky "dispose frees the ~80 MB
  engine" proof. I ALSO measured `process.memoryUsage()` (rss / external /
  arrayBuffers) at baseline / peak / post-dispose+gc and log them. **EMPIRICAL
  FINDING (documented, not gated):** none return to baseline in the Node
  in-process harness — e.g. rss `92 → 1283 → 1283 MB`, external `4 → 1321 →
  1321 MB`, arrayBuffers `0.2 → 243 → 243 MB`, even with `--expose-gc`. V8 retains
  freed wasm linear memory and collects dropped Emscripten modules lazily (no
  memory-pressure trigger). That is UN-COLLECTED GARBAGE, not a reference leak
  (`live` oscillates 0↔1 during the run, 0 after dispose) — exactly the "RSS too
  noisy in Node" case the task anticipates, so the lifecycle gate is the assertion
  and the numbers are reported. Loose non-flaky sanity: post-dispose arrayBuffers
  < peak + slack. Wall ~27 s.

### Part 2 — browser matrix (`demo/playwright.config.mjs`)

Added `firefox` (Desktop Firefox) + `webkit` (Desktop Safari) projects; Chromium
stays primary. The whole smoke suite runs on all three (workers:1, one shared
`serve.mjs`). **Result: 15/15 (5 tests × 3 browsers), all green.** No
per-browser limitation to report — everything the task asked to run honestly runs
on all three. Only performance note: Firefox's on-demand academic mount (496 MB
file_packager into the JS heap) took **~14.6 s** vs ~5 s on Chromium/WebKit — a
heavier large-ArrayBuffer path in Firefox, but a full pass, not a skip.

### Part 3 — real-browser on-demand academic mount (the M4 deferral)

New smoke test: with `preload:['core'], onDemand:['academic']`, compile a
`\usepackage{siunitx}` doc (academic-only) IN A REAL BROWSER → the §5.4(a) static
scan preselects academic → the tier is fetched + mounted into the LIVE engine's
JS heap in-browser → a valid PDF, `bundlesLoaded === [core, academic]`. This
proves the JS-heap mount works in a browser, not just Node (the M4-deferred
proof). **Passes on Chromium, Firefox, AND WebKit.** Guarded: it reads the
served `dist/manifest.json` bundle list first and green-skips if the served dist
is core-only (a partial CI build), so it never spuriously fails — no
multi-hundred-MB probe download.

### Part 4 — demo migration (`demo/index.html`, `demo/README.md`)

`preload:['texlive-basic']` → `preload:['core'], onDemand:['academic']`. The
DEFAULT document stays core-only (so the existing content proof + negative
control + `bundlesLoaded=[core]` all hold — the smoke's `not.toContain('academic')`
is a new tripwire that the default doc does NOT pull academic). Added an
**`example` dropdown**: "siunitx units" fills the textarea with an academic-only
doc, so compiling it mounts academic on demand and the stats row visibly shows
`bundles=[core, academic]` — the tiering demonstrated for a human, live. README
rewritten (browser matrix, the tiered model, the on-demand skip-guard, the
`playwright install` step).

### Part 5 — drop the `texlive-basic` alias

Removed the `cp core.{js,data} texlive-basic.{js,data}` emission from BOTH
drivers (`build-native.sh` + `run-in-container.sh`), with a comment recording the
drop + the breaking-change note. **The runtime's `aliasOf` mechanism STAYS**
(`engine-host.ts` + the gen-assets/check-sizes alias detection + their synthetic
tests): a consumer that still supplies an alias inventory keeps working; the
BUILD simply no longer produces one. Regenerated the native `dist/` WITHOUT the
alias: regenerated `build/stage/tiers.json` with the canonical repo `stage-tiers.mjs`
(the work-tree synced copy predated `--manifest`; verified the repo `resolve.mjs`
only ADDED `extractRelease` — `resolveTiers`/the split/provides are byte-identical,
and core=157 / academic=2414 provides + rev 78233 match the packed bundles and the
pre-drop manifest), then `make artifacts STAGE=dist` (native, sanctioned — copies
the already-packed bundles, no re-`file_packager`, no non-determinism churn on the
conformance-validated bundles). `dist/` now ships **only `core` + `academic`**
(manifest bundles `[academic, core]`, no alias); the execution gate passed
(XeTeX → TeX Live 2026 banner). Migrated `typeset-integration.test.ts` off the
alias → `core` (it REQUIRED `texlive-basic.{js,data}`; would otherwise silently
skip post-drop). `.github/workflows` + `conformance/run.mjs` REQUIRED were already
`core`+`academic` (M4 item 8 — verified). **Breaking change for any 0.0.1 consumer
that named `texlive-basic`** — flagged here for the release notes / M5 acceptance.

### A gap the regen surfaced: the `license-inventory` asset role

The regen ran the CURRENT `do_dist`, which (M5 item 2) emits `dist/licenses.json`
(role `license-inventory`) — a file the OLD on-disk dist the runtime tests ran
against never had. So the runtime real-dist tests saw the role for the first
time. The protocol's `AssetRole` is an OPEN union (`(string & {})`), so the
runtime TOLERATES it (conformance + the on-demand tests loaded the dist fine),
but the named-hints list didn't include it and `assets.test.ts`'s strict
`KNOWN_ROLES` gate rejected it. Fix: added `'license-inventory'` to the protocol
`AssetRole` hints + `KNOWN_ROLES` (the runtime should NAME every role that ships
in its manifest). Also updated the two real-dist alias assertions (`manifest.test.ts`
now asserts the alias is GONE — exactly `[academic, core]`; `assets.test.ts`'s
synthetic witness de-references the retired alias → `core.data`). An item-2
loose end, surfaced (not silently) by a correctly-built dist.

### Validation (local, against the regenerated alias-free `dist/`)

- **Soak green** (measurement + gate above): 37 completed / 13 cancelled,
  workerSpawns=12, live-after-dispose=0, fresh reinit clean; memory reported.
- **Runtime suite: 268/268** (13 files), incl. the migrated integration, the
  soak, the on-demand-tier tests, and the fixed real-dist assertions. `typecheck`
  clean.
- **Conformance: 12/12** against the alias-free dist (manifest integrity preflight
  OK; `sci-paper`/`unicode-math`/`tikz-standalone`/`cjk-*` mount academic on
  demand as before).
- **Browser matrix: 15/15** — chromium + firefox + webkit, incl. the new
  on-demand test (per-browser results above).
- **Build tooling: 54/54** (`gen-assets` + `check-sizes` + `licenses` unit tests
  — the retained alias-detection code still passes with synthetic fixtures).
- **Drivers**: `bash -n` clean; alias `cp` gone (0 lines); `texlive-basic` in
  `build/artifacts/*.sh` is now comment-only.

### Flagged for the orchestrator / release notes

- **BREAKING (release notes):** `texlive-basic` is dropped at v0.1.0 — a 0.0.1
  consumer that named the `texlive-basic` bundle must switch to `core`
  (+ `academic` on demand). Acceptable pre-1.0 (name-reservation release).
- **`M5.md` item 6 checkbox** left unchecked — flipped by the orchestrator on
  review/acceptance (the item-2/3/4/5 pattern).
- The `license-inventory` role addition touches `runtime/src/protocol.ts` (the
  constitutional trust module) — a one-line, additive, type-only union member;
  worth a reviewer glance even though it is behaviourally inert (types erased).

### Provenance

Original work, SPDX-MIT. The soak PRNG is textbook LCG math (public domain,
inlined, not copied); the soak's pdfTeX text extractor is a self-contained
reduction of `conformance/pdf-probe.mjs` (our own module — it can't be imported
into the typechecked runtime tree, which is outside its rootDir and plain JS).
No GPL/AGPL source and no other WASM-TeX wrapper opened or consulted (none
encountered).

## Item 7 — versioned-archive packer (DESIGN.md §7 release archives)

Dated 2026-07-24. Turns a built `dist/` into the DESIGN §7 release archives,
deterministically, each VERIFIED byte-for-byte against `dist/manifest.json`
before it is trusted. Version-parameterized (the tool hardcodes no release
number; `--version`/`VERSION=` supplies it). Validated locally against the
on-disk, alias-free native `dist/` (core + academic; no container build).

### What was built

- **`build/release/tar.mjs`** — a zero-dep, pure-node **deterministic USTAR
  writer + streaming reader/hasher**. `packTarGz` streams each source file
  through one gzip into the archive (a 474 MB bundle never lands in memory
  whole); `readTarGzEntries` streams untar+gunzip and hashes each entry without
  buffering it (CI-safe on the full asset set). Exports `ustarHeader` /
  `splitUstarPath` / `sha256File` too.
- **`build/release/pack.mjs`** — the CLI + importable `pack()` /
  `buildArchiveSpecs()` / `verifyArchive()` / `resolveEpoch()`. Reads
  `manifest.json`, packs the archive set, re-reads each archive and verifies it
  against the manifest, prints a per-archive report (`--json` for machine form).
- **`make pack VERSION=<v>`** (root Makefile) → `dist/release/*.tar.gz`; guards
  on `VERSION=` and a built `dist/`. Documented in the Makefile header +
  `build/release/README.md`.
- **`build/release/RELEASE_NOTES.template.md`** — the §7 aggregate-distribution
  statement, tier/size table, archive list + how-to-use (host + `assetsBaseUrl`,
  links `docs/embedding.md`), the 0.1.0 BREAKING note (texlive-basic removed),
  and `{{PLACEHOLDERS}}` (version / TL release / tlpdb rev / date / per-archive
  size+sha256) that item 8 fills from the pack `--json` report.
- **Tests**: `tar.test.mjs` (17) + `pack.test.mjs` (14) — 31 total, wired into
  `build.yml`'s tooling suite (now 145 tooling tests green).

### The archive set (data-driven, not hardcoded)

- `wasmtex-assets-<v>.tar.gz` = the **full `dist/` tree** (walked, output dir
  excluded) — engine + both bundles + `.fmt` + `manifest.json` + `assets.json` +
  `licenses.json` + `SHA256SUMS`.
- one `wasmtex-bundle-<name>-<v>.tar.gz` per **real (non-alias) bundle** the
  manifest lists — `core` + `academic` today; the file lists come from
  `manifest.bundles[].files`, so a rebase rename is followed with no code edit
  (DESIGN rebase-proofing: inventories are DATA). A future `full` tier packs for
  free.

### Key design decisions

- **Pure-node tar, not host `tar`.** macOS ships bsdtar, Linux GNU tar; their
  deterministic-flag spellings and default block-padding differ, so shelling out
  would make the bytes host-dependent. Owning a ~150-line USTAR encoder removes
  every host variance. Cross-checked BOTH directions against the system bsdtar
  during validation (bsdtar lists/extracts our archives; we read a bsdtar
  archive) — but the committed tests are self-contained (writer↔reader
  round-trip), so CI needs no `tar` on PATH.
- **Determinism knobs** (DESIGN §6.1): sorted entries (C-locale, matching
  SHA256SUMS), mode 0644 / uid-gid 0 / empty owner names / typeflag 0, two POSIX
  end blocks (no 20-block padding), `mtime = SOURCE_DATE_EPOCH`. Node's zlib
  already emits `MTIME=0`/no-FNAME (the `gzip -n` shape) but the **OS byte is
  host-specific** (0x13 on macOS, 0x03 on GNU/Linux) — so the gzip header is
  canonicalized post-write to `MTIME=0, XFL=0, OS=0xFF`, neutralizing host
  identity. Result: `1f 8b 08 00 00 00 00 00 00 ff`. Byte-repro is per fixed
  node/zlib version (same-host double-pack byte-identical — the proof below);
  cross-version not promised (§6.1 amendment descopes it for v1).
- **mtime precedence**: `SOURCE_DATE_EPOCH` env → `manifest.texliveSnapshot.
  sourceDateEpoch` (the build's own recorded epoch) → 0. All deterministic; no
  wall-clock. For the current dist that resolves to the TL freeze
  1772323200 (2026-03-01) with no env set.
- **Verify mirrors gen-assets' SHA256SUMS-exclusion rules.** Assets archive:
  every manifest asset present + `bytes`/`sha256` match; every archived file is
  a manifest asset OR a gen-assets output (`manifest.json`/`assets.json`, the
  two files gen-assets excludes from its own inventory). `SHA256SUMS` **is** a
  manifest asset (role `checksums`) so it is verified normally, NOT exempted.
  Bundle archives: exactly the declared files, each matching. Fail-closed
  (non-zero exit on any mismatch/missing/stray).
- **Item-8 mislabel guard, pre-wired.** If `manifest.json` gains a package
  `version` field (item 8 adds it for the npm↔assets lockstep) that disagrees
  with `--version`, the pack ABORTS. Absent today → packs with a note.
  `--version` is validated filename-safe (rejects `../evil`).

### Validation (local, native alias-free `dist/`, `VERSION=0.1.0`)

- **3 archives, all verified** (packed + re-read + checked vs manifest):

  | archive | entries | raw | gzip | sha256 (12) |
  | --- | --- | --- | --- | --- |
  | `wasmtex-assets-0.1.0.tar.gz` | 12 | 568.5 MB | **415.0 MB** | `c0c458fb5fd8` |
  | `wasmtex-bundle-academic-0.1.0.tar.gz` | 2 | 482.5 MB | **363.3 MB** | `3f24e9253b18` |
  | `wasmtex-bundle-core-0.1.0.tar.gz` | 2 | 52.8 MB | **36.0 MB** | `417d9a94b24b` |

  (`make pack` ≈ 27 s for the whole set; gzip level 6, pinned.)
- **Determinism proof**: packed the full set three times into different out dirs
  (rel1, rel2, dist/release) — all three archives `cmp`/sha256-**identical**
  across every pack. gzip header confirmed canonical (`1f8b0800 00000000 00 ff`).
- **Extraction cross-check**: `bsdtar -xf` the assets archive → the extracted
  file set equals `dist/` exactly (12 files); every file byte-identical to
  `dist/` (`cmp`); the extracted `SHA256SUMS` self-verifies (`shasum -c` all OK)
  — a host can extract + verify with stock tools.
- **Tests**: 31 new (tar round-trip incl. 0-byte + >chunk streaming, byte-identical
  double-pack, fixed header knobs, canonical gzip header, checksum/magic/truncation/
  typeflag rejection; pack verify-PASS, tamper/missing/stray FAIL, end-to-end
  tampered-dist CLI fail, double-pack cmp, epoch precedence, version guard).
  Full tooling suite **145/145**; **license audit PASS** (new `build/release/*.mjs`
  carry SPDX+provenance headers).

### Flagged for the orchestrator / item 8

- **`M5.md` item 7 checkbox** left unchecked — flip on review/acceptance (the
  item-2..6 pattern).
- **Item 8 needs `manifest.version`.** gen-assets must add a lockstep package
  `version` field to `manifest.json` (item 8, already noted at item 3). pack.mjs
  ALREADY honors it (the mislabel guard) the moment it appears — no pack change
  needed, just gen-assets.
- **Item 8 wiring**: run `node build/release/pack.mjs --version <tag> --json`
  after the container build; `SOURCE_DATE_EPOCH` is already exported by the build
  drivers (pack picks it up). The `--json` report carries each archive's
  size+sha256 to attach to the Release and fill the notes-template placeholders.
  Per DESIGN §9 the SHIPPED archives come from the container build, not a native
  `make pack` (dev convenience).
- The release-notes **Breaking changes** section is seeded 0.1.0-specific
  (texlive-basic removed); it is per-release and edited each release.

### Provenance

Original work, SPDX-MIT. The USTAR encoder + streaming reader are written from
the public POSIX ustar interchange format; gzip via node's `zlib`. No GPL/AGPL
source and no other WASM-TeX wrapper opened or consulted (none encountered). The
aggregate-distribution wording in the notes template reuses our own
`THIRD_PARTY_NOTICES.md` text (DESIGN §7), not a third party's.
