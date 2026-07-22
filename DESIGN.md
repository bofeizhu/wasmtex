# WasmTeX — a current-TeX-Live WASM typesetter for embedding

Status: founding design (pre-code). License: MIT for everything authored in
this repository. Named `wasmtex` at bootstrap
(2026-07-22): the original working name `motex` was taken on npm (a v0.0.0
placeholder) and as a GitHub org, so it was renamed per the bootstrap rule;
`wasmtex` was verified free on both. Nothing below depends on the name.

WasmTeX compiles LaTeX projects to PDF entirely inside a browser-class runtime
(web page, Web Worker, Electron renderer or hidden view). It packages the
TeX Live engines as a single WebAssembly multicall binary plus tiered TeX
Live data bundles, and exposes a small, typed, job-oriented API designed for
*embedding in host applications* rather than for building an online editor.

## 1. Why this exists

- **Current TeX Live.** Existing MIT-licensed WASM TeX builds pin old TeX
  Live snapshots. WasmTeX tracks a pinned *current* TeX Live (starting with
  TL 2026) and treats the rebase-to-next-year as a first-class, scripted
  operation, not an archaeology project.
- **License clarity for proprietary hosts.** The repository's own code —
  build scripts, runtime library, tooling — is MIT. The compiled artifacts
  are an *aggregate distribution of TeX Live programs* under their own free
  licenses (see §7); hosts interact with them as separate programs (argv in,
  files out) across a process/worker boundary. No copyleft wrapper layer
  sits in between.
- **Embedding-first runtime.** The API is built for host apps that need
  deterministic assets, integrity manifests, custom URL schemes, request
  correlation, cancellation, and streaming logs — and that must never depend
  on browser persistence (IndexedDB/localStorage) being available.

## 2. Provenance and derivation rules (constitutional)

1. Code may derive from exactly two sources: **busytex/busytex (MIT)** — the
   upstream project that established the multicall WASM TeX binary and its
   Emscripten build approach — and **original work authored in this repo**.
   Upstream attribution is preserved in LICENSE/NOTICE.
2. Engine and tool sources come from **TeX Live upstream** (pinned snapshot)
   and their normal dependencies (harfbuzz, icu, freetype, zlib, …), under
   their own licenses, inventoried in `THIRD_PARTY_NOTICES.md`.
3. **No code, prose, or API shapes may be read from, copied from, or adapted
   from any GPL/AGPL-licensed project**, including other WASM TeX wrappers.
   If research surfaces a copyleft repository, do not open its source. This
   keeps the MIT claim on this repo's code unimpeachable.
4. The public API is an original design (§5). It is intentionally structured
   differently from prior wrappers: map-shaped inputs, job objects,
   streaming logs, correlated worker protocol, explicit lifecycle.

## 3. Goals and non-goals

**Goals**

- One combined WASM binary carrying: `xetex`, `pdftex`, `luahbtex`,
  `bibtex8`, `xdvipdfmx`, `makeindex`, `kpsewhich` (multicall dispatch by
  argv[0], the upstream busytex technique).
- Pinned, reproducible builds: same inputs ⇒ byte-identical artifacts, with
  a CI check that builds twice and diffs hashes.
- Tiered TeX Live bundles (`core` / `extended` / `full`) generated from TeX
  Live's own package database (tlpdb), each with a machine-readable manifest
  (file list, sizes, sha256, provided package names).
- A typed ESM runtime (`wasmtex` npm package) with: multi-file projects,
  engine choice, auto bibliography (bibtex8) / index / rerun passes, SyncTeX
  opt-in, streaming logs, parsed diagnostics, cancellation, progress events.
- On-demand bundle resolution driven by tlpdb data plus missing-file
  feedback from the engine log (§5.4) — no network at compile time, ever;
  "on demand" means loading another local bundle.
- Works in any same-origin asset context: plain http(s), or a host-provided
  custom scheme (Electron `protocol.handle`) — assets addressed relative to
  one base URL, workers classic (no SharedArrayBuffer / COOP-COEP needs).

**Non-goals (v1)**

- biber (bibtex8 only), shell-escape or any host-command execution,
  TeX-Live-on-demand network package servers, DVI/PS outputs, a Node-native
  (non-browser) execution path, collaborative-editor features, bundled CJK
  fonts (§6.3), latexmk emulation beyond the auto-pass loop.

## 4. Repository layout

```
wasmtex/
  build/            # reproducible artifact pipeline (Docker + bash/python)
    toolchain/      #   pinned emsdk, container definition
    sources/        #   fetch + verify TeX Live snapshot & deps (pins.lock)
    patches/        #   our patches against TL sources (each with a header
                    #   explaining why; rebased per TL release)
    engines/        #   per-program builds -> combined multicall link
    formats/        #   .fmt dumps for each engine (part of core bundle)
    bundles/        #   tlpdb-driven tiering + Emscripten file packager
    manifest/       #   manifest.json generator (sha256, sizes, provides)
  runtime/          # the npm package (TypeScript, ESM, d.ts)
    src/
    worker/         # worker entry + correlated message protocol
    test/
  conformance/      # golden-document corpus + expected assertions
  demo/             # minimal static page: paste LaTeX -> PDF (CI smoke)
  .github/workflows # build, test, release, reproducibility, license-audit
  DESIGN.md  LICENSE  THIRD_PARTY_NOTICES.md  README.md
```

Release artifacts (GitHub Releases, tag `assets-vX.Y.Z` in lockstep with the
npm version):

- `wasmtex-assets-<version>.tar.gz` — engine wasm/js + formats + all bundles
- `manifest.json` — top-level integrity manifest: texlive snapshot id,
  engine list, per-file `{ bytes, sha256 }`, per-bundle provided-package
  index. Hosts verify installs against this instead of trusting the tarball.
- Per-bundle archives (`wasmtex-bundle-core-<version>.tar.gz`, …) so hosts can
  ship minimal footprints.

## 5. Runtime API (original design)

### 5.1 Shape

```ts
import { createTypesetter, type Typesetter } from 'wasmtex'

const tex: Typesetter = await createTypesetter({
  assetsBaseUrl: 'wasmtex-assets://dist',      // any same-origin base URL
  bundles: { preload: ['core'], onDemand: ['extended', 'full'] },
  onAssetProgress: (p) => {},                // { assetId, loadedBytes, totalBytes }
  locateAsset: (name) => undefined,          // optional per-file URL override
})

const job = tex.typeset({
  engine: 'xetex',                           // 'xetex' | 'pdftex' | 'luatex'
  entry: 'main.tex',
  files: {                                   // map, not array; Uint8Array ok
    'main.tex': source,
    'refs.bib': bibSource,
    'fonts/NotoSerifCJKsc-Regular.otf': fontBytes,
  },
  passes: 'auto',                            // or an exact number 1..5
  bibliography: 'auto',                      // 'auto' | 'off'
  index: 'auto',                             // 'auto' | 'off'
  synctex: false,
})

job.onLog((line) => {})                      // engine transcript, line-buffered
const result = await job.done
// result: {
//   ok: boolean, exitCode: number,
//   pdf?: Uint8Array, synctex?: Uint8Array,
//   log: string,
//   diagnostics: Array<{ severity: 'error'|'warning', message: string,
//                        file?: string, line?: number }>,
//   stats: { passes: number, elapsedMs: number, bundlesLoaded: string[] }
// }

job.cancel()                                 // deterministic: kills the worker,
                                             // next typeset() reinitializes
await tex.dispose()
```

### 5.2 Contract points that are deliberate

- **Correlated protocol.** Every worker message carries a `jobId`; a late
  message from a cancelled or timed-out job can never be attributed to a
  newer job. (Single-worker v1 still serializes jobs internally — the
  correlation makes the protocol safe by construction, not by scheduling.)
- **Cancellation is real.** `cancel()` terminates the worker and the library
  transparently re-initializes on the next job. Engine warm-state (loaded
  formats/bundles) is a cache, never a correctness dependency.
- **No hidden persistence.** The library never *requires* IndexedDB,
  localStorage, or Cache API. If present, an optional adapter may cache
  bundle bytes; correctness and tests assume a cold, storage-less context.
- **No DOM.** Runs entirely via `Worker` + `fetch` + `WebAssembly`. No
  script-tag injection mode.
- **Diagnostics are part of the API.** A tested log parser extracts errors
  and warnings with file/line where TeX reports them, so hosts don't regex
  transcripts themselves.

### 5.3 Engine sequencing (v1)

Per job: engine pass → (bibtex8 on `.aux` when `bibliography` resolves to
on) → (makeindex when a non-empty `.idx` exists) → engine reruns while the
log shows unresolved references/TOC changes, bounded by `passes`. XeTeX
output goes through `xdvipdfmx`. Formats are preloaded `.fmt` dumps from the
assets, so first-pass latency is engine start, not format building.

### 5.4 Bundle resolution

At build time, the tlpdb gives an exact mapping *package → files → bundle*;
each bundle manifest embeds its provided-package index. At runtime:

1. Static scan of project sources for `\usepackage`/`\RequirePackage`
   (best-effort, cheap; project-local `.sty`/`.cls` files excluded).
2. Missing-file feedback: when a pass fails with kpathsea "not found" lines
   naming files that the manifests map to a not-yet-loaded on-demand bundle,
   load it and retry once.

Step 2 makes resolution robust to macros the static scan can't see, using
only engine output plus local data — an original mechanism with no network
component.

## 6. Build pipeline

### 6.1 Reproducibility

Everything is pinned in `build/sources/pins.lock`: TeX Live snapshot id (a
dated historic-archive snapshot, not "latest"), dependency tarball hashes,
emsdk version, container digest. CI runs the full build twice and fails on
any artifact-hash mismatch. `SOURCE_DATE_EPOCH` and stable file ordering in
archives are mandatory.

### 6.2 The annual rebase

`build/patches/` holds our TL patches; each has a header (what, why,
upstream-able?). A scripted `make rebase TL=2027` applies patches to the new
snapshot, surfacing conflicts as the year's work list. The conformance
corpus (§8) is the acceptance gate for a rebase.

### 6.3 CJK and fonts

The engines fully support CJK (XeTeX/LuaTeX + the `ctex`/`xeCJK` packages,
which live in `extended`). Fonts are **not** bundled — CJK font files are
enormous and host apps have opinions. Hosts pass font files as project
inputs (`files`) and reference them by path (`\setCJKmainfont` with a
project-relative file name). The conformance corpus includes a CJK document
using a small open font checked into `conformance/fixtures`.

## 7. Licensing

- `LICENSE` — MIT, covering all code authored in this repository.
- `THIRD_PARTY_NOTICES.md` — generated inventory: upstream busytex (MIT);
  TeX Live programs and macro/font packages with their respective licenses
  (Knuth license, LPPL, GPL for some engines/tools, OFL for fonts, …); build
  dependencies.
- Release notes state plainly: *the release artifacts are an aggregate
  distribution of TeX Live programs compiled to WebAssembly; their sources
  are the pinned TeX Live snapshot plus the patches and scripts in this
  repository* — which satisfies source-availability obligations for the
  GPL-licensed members of that aggregate and preserves the separate-program
  boundary for hosts.
- CI runs a license audit that fails if any file lacks provenance or any
  dependency introduces a copyleft obligation into `runtime/`.

## 8. Verification

- **Conformance corpus** (per engine where applicable): hello-world; math +
  `unicode-math`; TikZ figure; bibliography via bibtex8; makeindex; multi
  chapter `\include` project; CJK document; a known-bad document asserting
  diagnostics extraction. Assertions: exit code, PDF page count, extracted
  text snippets (via a small PDF text probe), diagnostics shape — no pixel
  comparisons in v1.
- **Runtime unit tests**: protocol correlation (late/foreign jobId ignored),
  cancellation (in-flight kill, next job clean), bundle resolution incl. the
  missing-file retry, diagnostics parser, manifest verification.
- **Browser matrix**: Playwright against the demo page in Chromium (primary;
  Electron-equivalent) + Firefox and WebKit as advisory.
- **Budgets**: engine wasm and core-bundle sizes tracked with an explicit
  budget file; CI flags growth.

## 9. Milestones

- **M0 — Faithful baseline.** Reproduce upstream busytex's build (its pinned
  TL) inside our pinned container, unchanged; artifacts boot in the demo
  page and compile hello-world. *Proves the toolchain before changing it.*
- **M1 — Rebase to TL 2026.** Port patches to the pinned TL 2026 snapshot;
  all engines build; formats dump; corpus seeds pass.
- **M2 — Runtime v1.** The §5 API over a correlated worker protocol, with
  unit tests and the demo migrated to it.
- **M3 — Bundles + manifests.** tlpdb-driven tiering, per-bundle manifests,
  top-level integrity manifest, on-demand resolution with log feedback.
- **M4 — Release engineering.** Versioned archives, license audit,
  reproducibility gate, README/docs, npm publish dry-run.
- **M5 — Hardening.** Full conformance corpus, browser matrix, size
  budgets, cancellation/timeout soak tests.

## 10. Embedding profile (design target)

The first consumer is a desktop app embedding WasmTeX in a hidden Electron
view behind a custom scheme. The requirements below are therefore hard
constraints, not nice-to-haves:

- assets served from an arbitrary same-origin base URL with correct
  `application/wasm` MIME; no absolute-path assumptions;
- a machine-readable integrity manifest the host can verify after download;
- cold-start correctness with zero browser storage available;
- strictly serialized jobs with correlated results and real cancellation;
- log tails and structured diagnostics suitable for surfacing to an LLM
  agent that authored the document;
- no network access attempted at any point after asset load.
