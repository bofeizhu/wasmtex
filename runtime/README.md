# runtime/ — the `wasmtex` package

`wasmtex` is a typed, framework-free ESM library that typesets TeX to PDF inside
a Worker. It implements the original API defined in **DESIGN.md §5**:
`createTypesetter`, `Typesetter.typeset()` job objects (`done` / `onLog` /
`cancel()`), streaming line-buffered logs, parsed diagnostics, engine choice,
and automatic bibliography / index / rerun passes over a **correlated worker
protocol** (every message carries a `jobId`). No DOM, no network after asset
load, no required browser storage (§5.2).

## Status

**Published on npm** — `npm install wasmtex`. The runtime is fully implemented
and tested: a Node unit suite over the correlated protocol, engine sequencing,
bundle resolution, and diagnostics, plus a Node-driven typeset integration test
and a real-browser Playwright smoke across **chromium + firefox + webkit**.
XeTeX and pdfTeX are proven end to end against TeX Live 2026 engines, including
bibliography via bibtex8, makeindex, and automatic on-demand mounting of the
`academic` tier. Still pre-1.0 — the API may still change before 1.0.
`'luatex'` in the `EngineName` union is **reserved** — LuaTeX is not
implemented in v1 (a job requesting it is rejected with a clear error).

The compiled ESM carries explicit `.js` specifiers, so `wasmtex` loads under a
bundler, native browser ESM (no import map), and bare Node alike.

**The assets ship separately.** The engine (`busytex.wasm`), preloaded formats,
and the `core`/`academic` data bundles this library loads at runtime are
published as **versioned GitHub Release archives** tagged `assets-v<version>`.
Host the archive that matches your installed `wasmtex` version and point the
runtime at it via `assetsBaseUrl` — or, for a custom URL scheme, `locateAsset` +
`workerUrl`. The full walkthrough (hosting, the `application/wasm` MIME
requirement, integrity verification, custom scheme, cold start, the bundle
model) is the **[embedding guide](../docs/embedding.md)**.

## Quickstart

```js
import { createTypesetter } from 'wasmtex';

const tex = await createTypesetter({
  assetsBaseUrl: '/wasmtex-assets/',            // where you serve the unpacked asset archive
  workerUrl: '/node_modules/wasmtex/dist/worker.js',
  bundles: { preload: ['core'], onDemand: ['academic'] },
});

const job = tex.typeset({
  engine: 'xetex',
  entry: 'main.tex',
  files: { 'main.tex': source },
});
job.onLog((line) => console.log(line));
const result = await job.done;   // { ok, exitCode, pdf, log, diagnostics, stats }
```

## Layout

- `src/` — the public library (main-thread API). In the tsc build scope.
- `worker/` — the classic-worker entry and correlated message protocol. In the
  tsc build scope.
- `test/` — vitest unit tests. Excluded from the emitted build (`tsconfig.json`
  does not list `test/` in `include`), but genuinely type-checked by
  `npm run typecheck` and executed by `npm test`.
- `dist/` — generated `.js` + `.d.ts` (git-ignored; never committed).

## Dev commands

Consuming `wasmtex` needs no particular Node — the package is browser-targeted
(it runs in a Worker via `fetch` + `WebAssembly`). These **dev** commands have a
toolchain floor of **Node ≥18** — the `engines` field, and the real minimum:
vitest 3 and esbuild both support Node 18, and the runtime source uses only
ES2022 features. CI and the pinned dev toolchain run **Node 24** (the single
tested major), so use Node 24 if you want to match CI exactly.

```sh
npm ci            # install from the committed lockfile (as CI does)
npm run typecheck # tsc --noEmit over src/ + worker/ + test/ (tsconfig.test.json)
npm test          # vitest run — behavioural unit tests
npm run build     # tsc -> dist/ (.js + .d.ts), src/ + worker/ only
```

Typecheck and test are **separate gates**: `npm run typecheck` proves the types
(including the tests), `npm test` proves behaviour. Vitest's own `typecheck`
mode is deliberately not used — it is a type-*assertion* feature
(`expectTypeOf`) and does not fail on ordinary type errors in test bodies, so it
would be a false green; real `tsc` is the typechecker here.

## Test philosophy

The correctness-critical pieces — the correlated protocol, engine sequencing
(§5.3), bundle resolution (§5.4), diagnostics parsing, and client-side job
correlation — are **pure modules unit-tested in Node**, with no browser and no
wasm. That keeps `npm test` fast and deterministic. The wasm compile path is
covered separately: a Node-driven typeset-path integration test and the
Playwright demo smoke (see `demo/`) across the full **chromium + firefox +
webkit** matrix. Diagnostics are tested against fixtures captured from real
engine transcripts, regenerated at each rebase (M1 plan, rebase-proofing rule 2).
