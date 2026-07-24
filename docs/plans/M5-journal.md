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
