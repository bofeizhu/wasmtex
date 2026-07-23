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
