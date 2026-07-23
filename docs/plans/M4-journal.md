<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M4 — Bundles + manifests: build journal

Durable engineering record for the bundles-and-manifests milestone. One section
per work item, written as the work runs. Records every decision, verification,
failure → fix and standing note so a future maintainer can replay it. Feeds
`docs/LOG.md` (the terse milestone record); this is the long-form companion.

Items 1–3 (plan; tlpdb parser + tier map; multi-bundle build) are recorded in
`docs/plans/M4.md` (the checkbox list, with the real numbers) and `docs/LOG.md`.
This journal opens at item 4.

Provenance discipline (DESIGN.md §2): the manifest schema, the resolver, and the
side-channel are original work; the only inputs read are our own dist inventory
and TeX Live's own `texlive.tlpdb` (metadata, not third-party code). No GPL/AGPL
source and no other WASM-TeX wrapper was opened; encounters (none this item) are
noted so the audit trail shows avoidance.

---

## Item 4 — manifest.json (schemaVersion 2)

Dated 2026-07-24. Goal: evolve the M1 `assets.json` inventory into the DESIGN §7
top-level integrity manifest — keep the per-file inventory, ADD the TeX Live
snapshot id, the engine list, and a per-bundle provided-package index — and wire
the runtime to consume it (prefer `manifest.json`, expose the `provides` index
for the §5.4 resolution items 6–7 will implement). Local work only; validated
against the on-disk native `dist/` from item 3 (no container build).

### Decision 1 — file naming: `manifest.json` (v2) + `assets.json` (v1 alias)

**Chosen:** emit TWO files from one generator. `manifest.json` is the DESIGN §7
name and the schemaVersion-2 superset (assets + `texliveSnapshot` + `engines` +
`bundles`); the runtime PREFERS it. `assets.json` STAYS schemaVersion 1
(inventory only) — byte-shape identical to what M1/0.0.1 shipped — as a
back-compat alias retained for one release (dropped at M5).

**Rejected:** making `assets.json` a byte-copy of `manifest.json` (both v2). It
is superset-safe (an old parser drops unknown keys), but it would break the
DELIBERATE `assets.test.ts` real-file assertion `schemaVersion === 1` and
needlessly bump the schema a 0.0.1 consumer sees. Keeping `assets.json` a strict
v1 subset is the lowest-risk transitional path: the M1 contract is literally
unchanged, and only one file (`manifest.json`) carries the new surface. `assets`
is the identical array in both (verified: `a.assets === m.assets`, deep-equal).

### Decision 2 — `bundles[].provides` = the tier's full PACKAGE-NAME list

The task schema is `provides: [packageName…]` "from the resolver per-tier
`provides`", and its acceptance requires `academic` to provide `fandol`. These
conflict at the letter: the resolver's field named `provides` is a
`Record<pkg, [.sty/.cls/.def]>` MAP, and `fandol` ships only `.otf` fonts — so
`fandol ∉ Object.keys(academic.provides)` (confirmed against the real tlpdb).

**Resolved** by reading "provided package names" (DESIGN §3) as the tier's full
claimed content-package list — the resolver's `t.packages` (Collections/Schemes
excluded; every content package INCLUDING font-only ones). This is the only
reading that satisfies both "from the resolver" and "academic provides fandol",
and it matches §3 verbatim. `t.packages` is already sorted + disjoint (the
resolver's first-tier-wins guarantee), carried verbatim. Real numbers: core =
157 provided packages, academic = 2414, intersection ∅. The finer
package→`.sty` map stays available in the resolver for a later item that needs
filename-level resolution; item 4 exposes package NAMES, which serve the §5.4(a)
`\usepackage{X}` scan (X ≈ package name) via a case-insensitive lookup helper.

### Decision 3 — alias represented by `aliasOf`, detected by `.data` sha256

`texlive-basic.{js,data}` are byte-identical copies of `core.{js,data}` (the M4
item-3 back-compat alias). The manifest must not present it as a third tier. The
generator detects it STRUCTURALLY: within a set of bundles whose `.data` share a
sha256, the primary is the side-channel (real) tier — else the
lexicographically-smallest name — and the rest emit `{ name, aliasOf: primary }`
(no `files`/`bytes`/`provides`). This needs no extra config, self-verifies the
copy is actually identical, and works with OR without the side-channel. Verified:
`{ name: "texlive-basic", aliasOf: "core" }`.

### Decision 4 — resolver data reaches gen-assets via a stage-tiers side-channel

gen-assets must stay a pure DIST-INVENTORY tool (walk + classify + SHA256SUMS
cross-check) and never re-parse the tlpdb. But `provides` + the tlpdb
revision/release are tlpdb-derived. `stage-tiers.mjs` ALREADY parses the tlpdb
and resolves tiers during staging, so it is the natural emitter: a new
`--manifest build/stage/tiers.json` writes a compact side-channel
(`{ schemaVersion, texlive:{release,tlpdbRevision}, tiers:[{name,provides}] }`)
alongside `tiers.txt`. gen-assets reads it via `--tiers` and populates `bundles`
+ `texliveSnapshot`; the freeze date + epoch it derives itself from
`SOURCE_DATE_EPOCH` (reusing its existing `generated` logic). A given-but-missing
`--tiers` path fails loud (a wiring guard); no `--tiers` at all is the standalone
dist-inventory mode (a valid v2 manifest with provides/snapshot omitted). New
`resolve.mjs` export `extractRelease(db)` reads `00texlive.config`
`depend release/YYYY` (sibling to `extractRevision`'s `revision/N`).

### texliveSnapshot value produced

Against the pinned TL 2026 tlpdb (`00texlive.config`: `depend release/2026`,
`depend revision/78233`) with `SOURCE_DATE_EPOCH=1772323200`:

```json
"texliveSnapshot": {
  "release": "2026",
  "tlpdbRevision": 78233,
  "sourceDateEpoch": 1772323200,
  "freeze": "2026-03-01"
}
```

`freeze` is the snapshot DAY (epoch → `YYYY-MM-DD`); `release`/`tlpdbRevision`
are the tlpdb's self-declared identity (the authoritative in-tlpdb counterpart to
the pinned `[texlive-*-2026]` id).

### bundles/provides section produced (trimmed)

```json
"bundles": [
  { "name": "academic", "files": ["academic.data","academic.js"],
    "bytes": 505887127, "provides": ["12many", …, "siunitx", …, "fandol", …, "xecjk", … (2414)] },
  { "name": "core", "files": ["core.data","core.js"],
    "bytes": 55334848, "provides": ["ae", …, "amsmath", …, "latex", … (157)] },
  { "name": "texlive-basic", "aliasOf": "core" }
]
```

Placement verified disjoint: academic provides siunitx / ctex / xecjk / pgf /
fandol / mathtools / unicode-math / pgfplots (all absent from core); core
provides latex / amsmath / graphics (all absent from academic); core ∩ academic
= ∅.

### Runtime consumer + types

`runtime/src/protocol.ts`: added `TexliveSnapshot` + `BundleManifestEntry`
interfaces, extended `AssetsInventory` with optional `texliveSnapshot`/`engines`/
`bundles`, and extended the trust-boundary `parseAssetsInventory` to CARRY them
(the schemaVersion-1 parser silently dropped unknown top-level keys — a
round-trip test now guards the extension). These fields are informational /
on-demand data, NOT load-critical (the worker still loads by `role` from
`assets`), so a malformed `bundles` entry is DROPPED rather than failing the whole
inventory — the trust boundary stays total without being brittle. Added the pure
exported helper `bundleProvidingPackage(inventory, name)` — case-insensitive,
alias-skipping — the data accessor items 6–7 will consume; it does no loading.
`runtime/src/client.ts`: `resolveInventory` now fetches `manifest.json` first and
FALLS BACK to `assets.json`, so a pre-M4 asset tree still boots (without the
on-demand data). Storage-less/cold-start contract unchanged; no worker logic
change (engine-host reads only `inventory.assets`).

### Tests

- `build/manifest/gen-assets.test.mjs` (NEW, node:test, subprocess against a
  synthetic dist + side-channel): v2 shape, texliveSnapshot, engines, per-bundle
  provides, alias-by-sha256, the v1 `assets.json` subset, determinism (byte-
  identical rerun), standalone-no-sidecar mode, and the two guards (missing
  `--tiers`, stale SHA256SUMS). Wired into `build.yml` CI.
- `build/bundles/resolve.test.mjs`: `extractRelease` — synthetic
  `00texlive.config` parse + the real-tlpdb baseline `release === "2026"`.
- `build/bundles/stage-tiers.test.mjs`: `manifestSidecar` — per-tier provides =
  packages (incl. fandol), tier selection, null release.
- `runtime/test/manifest.test.ts` (NEW, vitest): compile-time `satisfies`
  witnesses + field pins for the new types; a v2 manifest round-trips
  `parseClientMessage` carrying snapshot/engines/bundles; lenient drop of a
  malformed bundle entry; `bundleProvidingPackage` (case-insensitive, alias-
  skipping, disjoint, misses); and a real-file check of `dist/manifest.json`.
- `runtime/test/client.test.ts`: the "manifest fetch path" block rewritten for
  the prefer-manifest-then-fall-back-to-assets.json contract.

### Verification

- `node --test build/bundles/*.test.mjs build/manifest/gen-assets.test.mjs` — 57
  pass.
- `cd runtime && npm run typecheck && npm test` — typecheck clean; 195 tests pass
  (incl. the 8 new manifest tests; the `dist/manifest.json` real-file check ran).
- gen-assets against the on-disk native `dist/`: cross-checked 10 payload files;
  emitted `dist/manifest.json` (57219 B, schemaVersion 2) + `dist/assets.json`
  (2048 B, schemaVersion 1, byte-identical to before); reran byte-identical.

### Standing notes / deferred

- `bundles[].provides` carries package NAMES only (per the item-4 schema). The
  §5.4(b) missing-file retry (item 7) keys on FILENAMES; with the shipped 2-tier
  set it needs no filename→bundle index (one on-demand tier ⇒ "load academic and
  retry"), but a future `full` tier or precise multi-tier retry would want the
  resolver's package→`.sty` map added to the manifest. Left for items 6–7.
- `conformance/run.mjs` + the `artifacts-build.yml` presence check still key on
  `assets.json` (still emitted). Not extended to `manifest.json` this item — the
  runtime falls back to `assets.json`, so manifest.json absence is non-fatal, and
  the presence check's comment is tied to run.mjs's five required files. A
  follow-up could promote `manifest.json` to first-class there once `assets.json`
  is dropped at M5.

---

## Item 5 — On-demand mount (worker)

Dated 2026-07-24. Goal: make `bundles.onDemand` real — load a tier's file_packager
`.data` into the RUNNING engine AFTER init, wire `stats.bundlesLoaded`, fire
`onAssetProgress` for on-demand fetches. The two hard parts (flagged in M4.md) were
(1) the post-init data-package mount — a technical unknown — and (2) its interaction
with the §5.3 memory snapshot/restore. Runtime-only; validated against the on-disk
native tiered `dist/` (core + academic); no container build. This was SPIKED before
implementing, per the plan.

### Spike verdict — post-init mount WORKS NATIVELY (no fallback needed)

Threw a Node harness (scratchpad, not committed) that mimics `engine-host.ts`:
load engine + core (preRun), snapshot the low 64 MiB, then post-init mount academic
and reset/compile. The decisive finding is in the generated loader itself — the
file_packager script (`dist/academic.js`) ends with:

```js
if (Module['calledRun']) { runWithFS(); }         // POST-init: mount into the live FS now
else { Module['preRun'].push(runWithFS); }         // PRE-init: defer to the factory's run()
```

So the packaged loader **already handles the post-init case**: after `run()` has
executed (`Module.calledRun === true`), re-executing the data-package script calls
`runWithFS()` directly, which `FS_createPath`s the tree and `LZ4.loadPackage`s the
files into the LIVE Emscripten FS. No WORKERFS fallback, no re-init-with-more-preloads
— the straightforward path works. Spike results (node, native dist):

| step | outcome |
| --- | --- |
| before mount: `siunitx.sty` in FS | **false**; a siunitx doc compiles `ok:false` (missing package) |
| post-init mount academic (496 MB `.data`) | `siunitx.sty`/`ctex.sty` now in FS; ~3.6 s (async `fs.readFile` + LZ4) |
| siunitx doc after mount | **ok, exit 0, valid PDF** |
| CJK ctex + bundled fandol doc | **ok, exit 0, valid PDF** |
| siunitx again (3rd job) | **ok** — tier still alive after two resets |

### Snapshot interaction — the mount is JS-HEAP-ONLY, so NO re-snapshot is needed

The load-bearing subtlety: the worker snapshots LINEAR memory after init and rolls it
back (`fill(0)` + restore the 64 MiB header) after every `callMain`. The fear was that
a tier mounted AFTER the snapshot would be LOST on the next reset. It is not — and the
spike proved WHY, not just that:

- After a post-init mount, the low-64 MiB header is **byte-identical** to the
  snapshot, AND the zero-past-header invariant **still holds**. I.e. the mount writes
  **nothing** to linear memory.
- That is because the Emscripten FS is pure JS: `FS_createPath` builds JS-heap nodes,
  `LZ4.loadPackage` holds the compressed `.data` as a JS `ArrayBuffer` and maps the
  file table in the JS heap. Reads decompress on demand into per-`callMain` wasm
  scratch that the reset then zeroes. This is the SAME reason the *preload* tier and
  the MEMFS survive resets today (M1 study) — the on-demand tier is that identical
  operation at a later time.
- **Chosen approach: mount, do NOT re-snapshot.** The snapshot is linear-memory-only
  and the mount is JS-heap-only, so they are orthogonal — the existing snapshot stays
  valid and the tier persists across every future reset. Re-snapshotting would be a
  harmless no-op (the header is unchanged), so it is pure cost; omitted. Proven by a
  committed real-wasm test that mounts academic MID-SESSION (after init, between two
  jobs) and compiles a doc that had just failed against core alone, then a CJK doc,
  then siunitx again — three jobs, three resets, all green.

### Completion detection — `monitorRunDependencies`

Post-init the mount finishes asynchronously (Emscripten fetches the `.data`: worker
XHR / node `fs.readFile`), so the host must AWAIT it. `runWithFS` adds exactly one run
dependency for the `.data` and removes it once `LZ4.loadPackage` has mounted; Emscripten
calls `Module.monitorRunDependencies(n)` on each transition. Post-init the count starts
and ends at 0 (`callMain` asserts 0), and `dependenciesFulfilled` is null after init
(the run-caller nulls itself once `calledRun`), so a completing dependency does NOT
re-trigger `run()`. The shared, environment-agnostic `mountViaRunDependencies(module,
execute)` helper installs the hook, runs the script, and resolves on the first return
to 0 (or rejects on a synchronous throw), restoring any prior hook. One place, both
loaders (worker `importScripts`, node scoped eval) funnel through it.

### Trigger + wiring (item-5 scope)

- **Host seam:** new `EngineHost.loadBundle(name)` (real impl in `engine-host.ts`)
  mounts one tier post-init, idempotent per name (preload tiers seeded at `load`, prior
  on-demand tiers remembered), resolving once FS-visible. This is the reusable seam
  items 6–7 will call lazily.
- **Loader seam:** new `EngineModuleLoader.mountDataPackage(module, location):
  Promise<void>` (the post-init sibling of `installDataPackage`), implemented for both
  the worker and node loaders via `mountViaRunDependencies`.
- **Wired trigger:** `core.onInit` eagerly mounts each configured `onDemand` tier AFTER
  `host.load` (i.e. after the snapshot), then sets `bundlesLoaded` to the actually-mounted
  set in preload-then-on-demand order. Eager-at-init is the sanctioned item-5 trigger
  (M4.md); the point it proves is post-SNAPSHOT mount + survival, which it does. A tier
  that fails to mount fails init (`init-failed`) — the caller explicitly asked for it;
  items 6–7's lazy path makes a genuine miss recoverable instead.
- **`onAssetProgress`:** `client.ts initLoadedAssets` now includes the `onDemand` tiers
  (they load during init under the eager trigger), so the existing init progress bracket
  reports each on-demand `*.js`/`*.data` as start (0) → done (= manifest bytes). Same
  fidelity as M1 (start/end, no per-byte — Emscripten fetches internally); items 6–7 will
  report lazy-load progress from the load point instead.

### API / type changes (no wire-protocol change)

All runtime-internal — the `ClientMessage`/`WorkerMessage` wire is UNCHANGED (no
`PROTOCOL_VERSION` bump). Added: `EngineHost.loadBundle`; `EngineModuleLoader.mount
DataPackage`; the exported `mountViaRunDependencies` helper; `EngineModule.monitor
RunDependencies?`/`calledRun?` (structural Emscripten fields). Refactored
`preloadBundleLocations` onto a shared single-name `resolveBundleJsLocation` (used by
both preload and `loadBundle`). `bundlesLoaded` now reflects on-demand tiers.

### Tests + verification (all green)

- `typecheck` clean; full runtime suite **213 pass** (was 195; +18):
  - worker-core (fake host): eager on-demand mount → `loadBundle` called + `bundlesLoaded`
    = preload-then-on-demand; multiple tiers in order; none → no calls; a mount failure →
    correlated `init-failed` + the next compile rejected as not-initialised.
  - engine-host (fake loader): `loadBundle` resolves the tier's bundle-js and routes to
    `mountDataPackage` (baseUrl+path and `entry.url`); idempotent; preload tier = no-op;
    pre-`load()` rejects; unknown name rejects; a mount failure is not cached (retry
    re-mounts). Plus `mountViaRunDependencies` unit tests (async/sync resolve, throw
    rejects, prior-hook restore+chain).
  - typeset-integration (REAL wasm, core + academic, skips if academic absent): siunitx
    FAILS against core alone (`bundlesLoaded=['core']`); `host.loadBundle` mounts academic
    mid-session and the failed doc then compiles + a CJK doc + siunitx again survive three
    resets; public API (`createTypesetter`, onDemand:['academic']) compiles siunitx AND a
    CJK doc across two jobs with `bundlesLoaded=['core','academic']` and `onAssetProgress`
    reporting `academic.data` start(0)/done(=bytes).
- Worker IIFE rebuilt: **no `node:` leakage**, carries the mount logic. `build:node-harness`
  rebuilt. `license-audit.sh` all checks pass (no new files; touched files keep SPDX MIT;
  no GPL/AGPL). Provenance: original work; the only third-party artifact READ was our own
  generated `dist/*.js` file_packager loader (behavioural inspection of an Emscripten build
  output, MIT-derived) — no GPL/AGPL or other-wrapper source opened.
- Real numbers (native dist, node): init engine+core ≈ 0.6 s; academic post-init mount
  ≈ 3.6–8.5 s (496 MB `.data` via async `fs.readFile` + LZ4, cold vs. under concurrent
  test load); siunitx PDF 7313 B; CJK (ctex+fandol) PDF 4336 B.

### Standing notes / deferred

- **Browser-worker path is validated STRUCTURALLY, not yet in a real browser.** The
  worker `mountDataPackage` is the same `carrier + importScripts` as preload, routed
  through the same `mountViaRunDependencies` completion the node path exercises, against
  the identical file_packager `calledRun→runWithFS` branch. A real-browser on-demand mount
  belongs to the demo/Playwright smoke (as with the M1 worker path); node is the item-5
  gate. Noted for the demo-smoke follow-up.
- **On-demand fetch-error UX is coarse for item 5.** A mount that fails to FETCH surfaces
  as: worker → a thrown `NetworkError` from Emscripten's XHR (→ worker `onerror` →
  `WorkerCrashedError`, no silent hang); node → local files that were inventory-validated,
  so `fs.readFile` does not fail in practice. Under the eager-at-init trigger a mount
  failure is `init-failed`. Granular, recoverable on-demand error handling (retry/continue,
  distinguishing "not in any tier" from "fetch failed") is items 6–7, where lazy §5.4
  resolution makes it matter. No wall-clock mount timeout was added (it would false-fail on
  a large tier over a slow link); completion rests on the run-dependency signal.
- **Eager-at-init is a stand-in trigger.** It proves the mechanism (post-snapshot mount +
  survival + progress + `bundlesLoaded`) but is not lazy. Items 6–7 replace it with the
  §5.4 static `\usepackage` scan and the missing-file retry, both calling the same
  `host.loadBundle` seam; `initLoadedAssets`'s on-demand inclusion and the `onAssetProgress`
  bracket move to the lazy-load point then.

---

## Items 6 + 7 — §5.4 automatic bundle resolution (both halves)

Dated 2026-07-24. Goal: replace item 5's eager-at-init stand-in with the real §5.4
LAZY resolution — (a) a static `\usepackage`/`\RequirePackage` scan that PRESELECTS a
matching on-demand tier before the first pass, and (b) a missing-file retry that mounts
an un-loaded tier and re-runs a pass that failed naming a not-found file. Both drive the
same `host.loadBundle` seam item 5 built. Implemented together because they are two
halves of ONE mechanism (the scan is an optimisation; the retry is the correctness net).
Runtime-only; validated against the on-disk native tiered `dist/` (core + academic +
`manifest.json`); no container build.

Provenance: original work. The `\usepackage` grammar is public LaTeX syntax; the
"File `x' not found" wording is our own transcript-capture (fixtures). No GPL/AGPL or
other-wrapper source opened.

### Where the code lives (and why)

- **`worker/bundle-resolution.ts` (NEW)** — the pure §5.4 helpers: `scanRequiredPackages`
  (source scan), `selectBundlesForPackages` (item 6 name→tier resolve + the unknown-name
  policy), `selectBundlesForMissingFiles` (item 7 filename→tier chooser). No engine/FS/DOM;
  reads only TYPES + `bundleProvidingPackage`. 27 unit tests.
- **`src/diagnostics.ts`** — ADDED `extractMissingFiles(log)` (+ `MAX_MISSING_FILES`). The
  "File `x' not found" / "I can't find file `x'" wording lives with the rest of the
  transcript-parsing knowledge (rebase-proofing rule 2), so a rebase that reworded it
  touches ONE file. The worker imports just this function; esbuild TREE-SHAKES `parseDiagnostics`
  out of `dist/worker.js` (verified: 0 refs), so the client-only parser never bloats the bundle.
- **`worker/core.ts`** — the orchestration: `onCompile` is now `async`; before the sequence
  it runs the scan + preselect; inside the loop it runs the retry. New session state:
  `assetsConfig` (stash for the scan's `provides` lookup), `handledBundles` (the scan skip-set
  AND the retry bound), `bundlesLoaded` (now a mutable, deduped, in-load-order array), and an
  `ensureBundle(name, onLine)` lazy seam. `onInit` no longer eagerly mounts on-demand tiers.
- **`src/client.ts`** — `initLoadedAssets` now brackets engine + PRELOAD only (on-demand tiers
  load lazily at compile time, so reporting them at init would lie).

### Decision 1 — the LOAD-BEARING unknown-name policy, enforced structurally

The manifest `provides` is a package-NAME index, not a filename index. `selectBundlesForPackages`
resolves a scanned name via `bundleProvidingPackage`; an UNMATCHED name (returns `undefined`)
is skipped — "unknown → do nothing" — NOT mapped to a default tier. This is enforced by the
data accessor's semantics, not a special case. Verified against the real `dist/manifest.json`:
`longtable`/`graphicx`/`amssymb` are in NO tier's `provides` (they ship in core, but their
`.sty` NAMES are not provided-package names — they come from `tools`/`graphics`/`amsfonts`),
yet their `.sty` files ARE in `core.js`. So a `\usepackage{longtable}` doc: the scan does
nothing → core serves `longtable.sty` → the first pass succeeds → NO retry → academic (496 MB)
NEVER downloaded. A "load academic on any unmatched name" rule would have downloaded it. The
real-wasm test proves this in 2.3 s (no academic mount) with `bundlesLoaded=['core']`.
`selectBundlesForPackages` additionally restricts to bundles named in `onDemand` (a
preload-provided name like `natbib`→`core` is skipped) and honours the DESIGN §5.4(1) rule to
skip a package the host supplied as a project-local `.sty`/`.cls` (guards a local file
SHADOWING a tier package — otherwise `\usepackage{siunitx}` with a host `siunitx.sty` would
needlessly pull academic).

### Decision 2 — the retry over-approximates soundly (no filename index yet)

With ONE on-demand tier the item-7 mapping is trivial: any genuine miss COULD be in academic,
so `selectBundlesForMissingFiles` loads every un-handled on-demand tier and retries once. This
is a SOUND over-approximation — a missing file whose basename ≠ its package name (a `.fd`,
`.tfm`, a `-abbreviations.cfg`) still resolves after the tier mounts, which a package-NAME
shortcut on the missing filename would get WRONG (it would refuse to load and fail a resolvable
doc). Consequence, accepted per the plan: a genuinely-missing package (in NO tier) DOES download
academic once, then fails cleanly with the real diagnostic — bounded, no loop. The chooser
already takes `missingFiles`; a future `full` (≥2 on-demand tiers) swaps the blanket load for a
filename→bundle index (resolve.mjs's package→`.sty` map, carried into the manifest) — additive,
not a rewrite.

### Decision 3 — the retry is BOUNDED by a `handledBundles` set, not a flag

`ensureBundle` adds a tier to `handledBundles` BEFORE awaiting `host.loadBundle`, so a tier is
attempted at most once per session (a mount that throws is never re-attempted — otherwise a
persistently-failing mount would loop). The scan and the retry share this set, so the retry
never re-tries a tier the scan already tried. Once every on-demand tier is handled, the retry
condition (`selectBundlesForMissingFiles` returns `[]`) is false — the natural bound. A lazy
mount FAILURE is best-effort: `ensureBundle` streams an advisory and the compile proceeds (the
pass then surfaces the real missing-file diagnostic); it does NOT fail the compile — only a
PRELOAD tier failing fails init now (`onInit` no longer mounts on-demand tiers, so init cannot
fail on an on-demand tier).

### Decision 4 — the probe pass is SPLICED from the final log (live stream stays honest)

When a pass fails "not found" and the retry runs, the failed probe's transcript lines were
already STREAMED live (real-time truth — the probe genuinely happened), but they are a lazy-load
DISCOVERY, not a document error. So `onCompile` splices them out of the FINAL consolidated
`transcript` (a `transcript.splice(logMark, probeLines)` after the retry), leaving `result.log`
+ the client's diagnostics to reflect the AUTHORITATIVE retry: a resolved miss shows no spurious
"File not found" on a successful compile; a still-missing file shows the retry's single error.
The sequencing machine already sees only the retry's per-run observation (the probe's `result`
is reassigned before the observation is built), so the splice is purely the final-log fix. The
retry re-runs the IDENTICAL runStep — so a failed FIRST pass re-stages a pristine job FS, and the
just-mounted tier (which lives in `/texlive`, orthogonal to the job dir) is available. The retry
does not re-post a progress phase (it is the same logical §5.3 step).

### Scan grammar (best-effort, an optimisation)

Single-line regex `\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}` over the
entry + every TeX-source file (`.tex/.ltx/.sty/.cls/.def/.clo`; `Uint8Array` content decoded),
comma-lists split, comments stripped (`%`, honouring `\%`). Deliberately PARTIAL — a name hidden
behind a macro, a multi-line optional arg, or an `\input` of a NON-source file (e.g. a `.cfg`)
falls through to the item-7 retry. That partiality is what lets path (b) be tested INDEPENDENTLY:
a `\documentclass{ctexart}` doc is invisible to the scan (it reads `\usepackage`/`\RequirePackage`,
not `\documentclass`), so the CJK path drives the retry, not the scan — a real, natural scan-off case.

### Tests + verification (all green)

- `typecheck` clean; full runtime suite **266 pass** (251 non-integration + 15 real-wasm):
  - `bundle-resolution.test.ts` (NEW, 27): the scan grammar (comma lists, optional args,
    `\RequirePackage`, comment stripping incl. `\%`, source-extension gating, `Uint8Array`,
    dedup/order); `selectBundlesForPackages` (matched→tier, case-insensitive, UNKNOWN→[],
    preload-provided→[], local-`.sty`/`.cls` shadow skip, handled skip, dedup, no-bundles
    fallback); `selectBundlesForMissingFiles` (un-handled tiers, empty→[], all-handled→[] bound,
    basename≠package soundness, dedup).
  - `diagnostics.test.ts` (+10): `extractMissingFiles` against the REAL `missing-*` fixtures
    (both engines), no false positive on clean / undefined-control-sequence (an ordinary error
    must not trigger a download), the plain-TeX form, class files, multi-file order+dedup,
    totality, `MAX_MISSING_FILES` bound.
  - `worker-core.test.ts` (rewrote the item-5 eager block → item 6/7, +): scan preselects
    BEFORE the first pass (ordered `events` log proves it); UNMATCHED name → no download (policy);
    preload-provided name → no re-load; local-`.sty` shadow skip; `.cls` `\RequirePackage` scanned;
    commented-out line ignored; retry mounts + retries once AFTER a failed pass with the probe
    SPLICED from the final log (present in the LIVE stream); no retry on a non-missing-file error;
    genuinely-missing → bounded (one mount) + not re-attempted next job; best-effort mount failure;
    onDemand=[] → no retry; lazy-not-at-init; preload dedupe (no `['core','core']`).
  - `engine-host.test.ts` (+3): concurrent in-flight idempotency (3 concurrent mounts → 1 LZ4
    load); alias canonicalisation (`texlive-basic`→`core` no-ops against preloaded core; mounting
    an alias mounts the CANONICAL `core.js`).
  - `typeset-integration.test.ts` (real wasm, core + academic): BOTH §5.4 paths INDEPENDENTLY —
    (a) scan-preselect siunitx (first-try, no probe pass; live log has no "not found"), (b) retry
    ctexart (scan-invisible class; the probe's "ctexart.cls not found" streamed LIVE but SPLICED
    from `result.log`); core-only `longtable` compiles with `bundlesLoaded=['core']` and NO academic
    mount (2.3 s — the policy proof); genuinely-missing → academic mounted once, still fails cleanly.
    Updated `tieredAssets` to read `manifest.json` (the v1 `assets.json` alias lacks the `provides`
    index the scan needs) and the public-API on-demand test for lazy loading (academic no longer in
    the init `onAssetProgress` bracket).
- **loadBundle hardening (item-5 review nits)**: (1) in-flight idempotency — a `Map<canonical,
  Promise>` so concurrent `loadBundle` share one mount (no double `LZ4.loadPackage` → EEXIST),
  cleared on settle, a failed mount NOT cached; (2) alias canonicalisation — `canonicalBundleName`
  reads the manifest `aliasOf` so `texlive-basic` mounts/no-ops against `core`, and `load()` seeds
  `loadedBundles` with canonical names; (3) preload/onDemand dedupe — the core seeds `bundlesLoaded`
  through a membership guard.
- Worker IIFE rebuilt: **no `node:` leakage** (0), no `require(` (0), `parseDiagnostics`
  tree-shaken out (0), `extractMissingFiles` + the scan present. `license-audit.sh` all checks
  pass (new `bundle-resolution.ts` carries SPDX MIT + provenance; no GPL/AGPL).
- Real numbers (native dist, node): core-only longtable 2.3 s (no academic mount); scan-preselect
  siunitx 12.2 s (incl. academic mount); retry ctexart 12.2 s; genuinely-missing 12.6 s;
  siunitx PDF 7313 B, CJK (ctex+fandol) PDF 4336 B.

### Standing notes / deferred

- **Lazy-load `onAssetProgress` is deferred.** On-demand tiers now mount at COMPILE time, so
  they are out of the init progress bracket (`initLoadedAssets` = engine + preload). Per-tier
  progress for a lazy load would need a compile-time asset-progress signal from the worker (a
  new wire message — none in M4); `stats.bundlesLoaded` still reflects what mounted. Noted.
- **The filename→bundle index is deferred to ≥2 on-demand tiers.** With one tier the retry's
  blanket "load every un-handled on-demand tier" is exact; a future `full` adds the index
  (resolve.mjs's package→`.sty` map into the manifest) additively — the chooser already takes
  `missingFiles`.
- **Browser-worker lazy path validated STRUCTURALLY** (same as item 5): the scan/retry drive the
  identical `host.loadBundle`→`mountDataPackage`→`mountViaRunDependencies` path node exercises;
  a real-browser on-demand mount belongs to the demo/Playwright smoke.
- **The item-6/7 corpus entries (M4 item 8)** — a scientific paper (siunitx+mathtools+tikz +
  natbib/bibtex8) and a CJK doc as CONFORMANCE entries — remain item 8's scope; items 6–7 land
  the mechanism + its unit/integration coverage.

---

## Item 8 — Beyond-basic conformance corpus + integration (target-driven)

Dated 2026-07-24. Goal: turn the conformance corpus from a wholly-inside-basic seed
into one that EXERCISES the tiers end-to-end through the PUBLIC runtime — the
scientific-journal + CJK target — plus a shipped-manifest integrity check. Until
now the corpus preloaded the `texlive-basic` alias and every entry stayed in core;
item 8 makes it preload `core`, list `academic` on-demand, and adds entries that
drive BOTH §5.4 paths, the citation pipeline, and the bundled-fandol CJK path.
Validated against the on-disk native tiered `dist/` (core + academic +
manifest.json); no container build.

Provenance: the corpus `.tex`/`.bib` are ORIGINAL authored content (fictional
authors/data — not copied from any paper); `plainnat.bst` is a TeX Live file already
in the `core` bundle (REFERENCED by `\bibliographystyle{plainnat}`, not vendored into
the repo). `verify-manifest.mjs` + the `fontProbe` helper are original work. No
GPL/AGPL or other WASM-TeX wrapper opened.

### The runner change — from one preload tier to the real tiers

`conformance/run.mjs` now configures the typesetter with
`bundles: { preload: ['core'], onDemand: ['academic'] }` (was
`preload: ['texlive-basic']`) and reads **`manifest.json`** (schemaVersion 2), NOT
`assets.json`, as the inventory — the §5.4(a) scan resolves `\usepackage` names
against the manifest's per-bundle `provides` index, which the v1 `assets.json` alias
lacks. `REQUIRED` shifts from `texlive-basic.*`/`assets.json` to `core.{js,data}` +
`manifest.json` + engine; the whole-run green-skip is preserved. A **two-tier guard**
mirrors the integration test: base `REQUIRED` gates the whole run; an entry that
expects an on-demand tier (`bundlesLoaded` names it) is green-skipped PER-ENTRY when
that tier's `.js`/`.data` are absent (a core-only build still runs the basic corpus).

Each entry still gets a FRESH `createTypesetter`→`typeset`→`dispose` — the §8 cold,
storage-less contract. So each academic entry RE-mounts academic from scratch (the
honest cold cost, ~4–6 s/entry), and no basic entry can be tainted by a prior mount.

### New expectations surface (superset — old entries unchanged in meaning)

- **`bundlesLoaded`** — exact `result.stats.bundlesLoaded`. The basic entries now pin
  `["core"]` (the unknown-name policy at the corpus level); academic entries pin
  `["core","academic"]`.
- **`resolution`: `scan` | `retry` | `none`** — the §5.4 path, distinguished at the
  PUBLIC API by the LIVE log (`Job.onLog`) vs. the FINAL `result.log`. A scan
  preselects before pass 1 → no `not found` anywhere. A retry fails a probe pass
  (`not found` streamed LIVE) then the worker SPLICES it from `result.log` → live has
  `not found`, final is clean. `none` → no on-demand mount, no probe. This is the
  corpus-level, public-API proof that the two §5.4 halves are INDEPENDENT (the
  integration test proves it through the core; this proves it through `createTypesetter`).
- **`embeddedFonts` / `requireEmbeddedFontFile` / `minCidGlyphs`** — the CJK
  structural assertion (below).

### The three new entries

1. **`sci-paper`** (pdftex) — `\usepackage{siunitx,mathtools,pgfplots}` (all
   `academic`) + `natbib`/`\bibliographystyle{plainnat}`/`\bibliography{refs}`.
   Observed: `ok`, exit 0, 1 page, 114 KB, `passes=3`,
   `phases=[engine,bibtex8,engine,engine]`, `bundlesLoaded=[core,academic]`,
   `resolution=scan` (live log has NO `not found` — academic preselected). The
   rendered surnames **Zhang/Rossi** (`\citet{zhang2019}`) and **Nakamura/Okonkwo**
   (`\citep{nakamura2021}`) recover from the PDF ⇒ the `.bbl` reached the page ⇒
   citations resolved. This is SIMULTANEOUSLY the §5.4(a) scan proof, the full
   journal-pipeline proof, and the M4 citation acceptance criterion.
   - **`natbib`/`plainnat` are in `core`, not `academic`** (verified against the real
     manifest `provides`). So the citation pipeline resolves from the preloaded tier;
     the academic mount is driven purely by `siunitx`/`mathtools`/`pgfplots`. `tikz`
     is not a `provides` name, but `pgfplots` IS and pulls tikz in — so the scan still
     preselects academic. (A benign `epstopdf` "shell escape not enabled" warning
     appears — graphicx→epstopdf, no `.eps` to convert; `diagnostics` is not pinned
     for this entry, so it is noise-tolerant.)
2. **`cjk-ctex`** (xetex) — `\documentclass{ctexart}`, real Chinese, bundled fandol,
   no host font. Observed: `ok`, exit 0, 1 page, `passes=1`,
   `phases=[engine,xdvipdfmx]`, `bundlesLoaded=[core,academic]`, `resolution=retry`
   (live log HAS `ctexart.cls not found`; `result.log` is SPLICED clean). Because the
   scan reads `\usepackage`/`\RequirePackage` and NOT `\documentclass`, ctexart is
   invisible to it — so this drives §5.4(b) INDEPENDENTLY of the scan (the key
   independent-path proof). **fandol embedding is the "Chinese present" proof** (see
   the honesty note below): the PDF embeds `JRZBJV+FandolSong-Regular` (a
   CIDFontType0 subset) with an embedded `FontFile3` and a 54-glyph CID run.
3. **`pkg-core-only`** (pdftex) — `\usepackage{longtable}`. Observed: `ok`, exit 0,
   1 page, `passes=1`, `phases=[engine]`, `bundlesLoaded=[core]`, `resolution=none`.
   `longtable` is core-served but is NOT a `provides` name in any tier, so the scan
   does nothing and no retry fires — the corpus-level LOCK of the unknown-name policy
   (a core-served `\usepackage` must never pull the ~472 MB academic tier). The
   public-API counterpart to the integration test's longtable case. The 4 existing
   basic entries also gained `bundlesLoaded=["core"]`, so the guard is corpus-wide.

### Honesty note — the CJK text is verified STRUCTURALLY, not by extraction

The Chinese does NOT recover through `recoverText`. Inspecting the PDF: xdvipdfmx
embeds fandol as a CID-keyed CFF subset (`CIDFontType0`, `Identity-H`) WITHOUT a
ToUnicode CMap — only the Latin font (LMRoman10, used for `WasmTeX`/`fandol`) gets a
ToUnicode CMap. So the 37 CJK glyphs render (they are in the content stream as
2-byte CIDs `0b46 077a 0111 …` = 你好世界…) but are NOT reverse-mappable to Unicode.
This is honest PDF reality, not a probe defect. Rather than weaken the assertion (or
add a font-parsing dependency to chase the glyph→Unicode mapping), the `cjk-ctex`
entry asserts the STRUCTURE (DESIGN §8: "no pixel comparisons"): the bundled
`FandolSong` is embedded, its program is embedded (self-contained PDF), and a CID
glyph run was emitted. Since fandol is used for nothing but the CJK here (Latin uses
LMRoman10), fandol's embedding IS proof the Chinese was set with it. The Latin
snippets (`WasmTeX`, `fandol`) that DO recover keep the probe honest for that entry,
and the `Wittgenstein` negative control still discriminates. Recorded as a corpus
convention; a follow-up could add a CID→Unicode path to the probe if a later CJK
font ships a ToUnicode CMap (making direct extraction possible).

### Manifest verification — the shipped bytes, not just the parse contract

New `conformance/verify-manifest.mjs` (`verifyManifest(distDir)` + a standalone CLI):
for the shipped `dist/manifest.json`, every PRESENT asset's recorded `{bytes,sha256}`
is checked against the ACTUAL file (recomputed SHA-256 over the bytes), and the
per-bundle `provides` index is verified present, alias-correct (`texlive-basic`→
`core` carries no independent provides), and DISJOINT across real tiers. `run.mjs`
runs it as a PREFLIGHT (hard-fail before any compile — a truncated/corrupt download
is the real CI hazard). Guarded (manifest absent → green skip); a listed-but-absent
file is a skip (a partial dist is legitimate), a PRESENT-but-mismatched file is a
hard fail. Complements `runtime/test/manifest.test.ts` (parse/type contract + a shape
check); THIS checks the shipped BYTES.

### Verification (all green, deterministic)

- `node conformance/run.mjs`: manifest integrity **30 checks, 11 files verified**;
  **all 7 corpus entries pass** (4 basic + sci-paper + cjk-ctex + pkg-core-only).
  Re-run byte-for-byte identical structural results (pages/passes/bundlesLoaded/
  resolution/phases stable; only wall-times vary). Per-entry (native dist, node):

  | entry | engine | pages | passes | bundlesLoaded | resolution | phases | pdf |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | hello-pdftex | pdftex | 1 | 1 | core | none | engine | 15 KB |
  | hello-xetex | xetex | 1 | 1 | core | none | engine→xdvipdfmx | 4 KB |
  | bib-cite | pdftex | 1 | 3 | core | none | engine→bibtex8→engine→engine | 42 KB |
  | idx-makeindex | xetex | 2 | 3 | core | none | engine→makeindex→engine→engine→xdvipdfmx | 8 KB |
  | pkg-core-only | pdftex | 1 | 1 | **core** | **none** | engine | 16 KB |
  | **sci-paper** | pdftex | 1 | 3 | **core+academic** | **scan** | engine→bibtex8→engine→engine | 114 KB |
  | **cjk-ctex** | xetex | 1 | 1 | **core+academic** | **retry** | engine→xdvipdfmx | 15 KB |

- **Discrimination proven (the "never weaken an assertion" bar):** injecting WRONG
  expectations makes the harness FAIL with the right message —
  `cjk-ctex resolution=scan` fails (`liveLog "not found"=true` ⇒ it's a retry);
  `cjk-ctex embeddedFonts=[NotoSerifCJK]` fails (not among the embedded BaseFonts);
  `sci-paper bundlesLoaded=[core]` fails (`got [core,academic]`);
  `sci-paper resolution=retry` fails (`liveLog "not found"=false` ⇒ it's a scan).
  `verify-manifest` against a corrupted faux manifest fails on a wrong `sha256`, a
  wrong `bytes`, AND an injected `provides` overlap (exit 1). The assertions are real.
- **Runtime regression:** full `runtime` suite **267 tests pass** (12 files) —
  unchanged; item 8 touched only `conformance/`.
- `license-audit.sh`: all checks pass.

### CI note + the ~472 MB academic download (flagged)

The CI conformance gate (`.github/workflows/artifacts-build.yml` job `conformance`)
downloads the WHOLE `dist/` artifact (`path: dist`) built by `artifacts-build`, which
INCLUDES `academic.{js,data}` (academic.data ≈ 496 MB on disk / ~472 MB budgeted).
So in CI the new academic entries **run** (not per-entry-skip) and mount academic —
adding the ~500 MB download plus ~4–6 s/academic-entry of mount+compile; well inside
the job's `timeout-minutes: 20`. Two follow-ups for the orchestrator (NOT changed
here — out of item-8 scope + no-commit):
1. The gate's presence check still asserts `texlive-basic.js texlive-basic.data
   assets.json` (line ~457), which the runner no longer reads; it should assert
   `core.{js,data}` (+ optionally `academic.{js,data}` to prove the academic entries
   run rather than silently per-entry-skip). Harmless today (the alias + assets.json
   are still shipped), but it drifts when the alias is dropped at M5.
2. Consider whether the conformance gate needs the full academic tier or could run a
   core-only slice for speed — but exercising academic end-to-end IS the point of the
   new entries, so keeping the full download is the right call for the gate.
