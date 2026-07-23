# runtime/ — the `wasmtex` package

`wasmtex` is a typed, framework-free ESM library that typesets TeX to PDF inside
a Worker. It implements the original API defined in **DESIGN.md §5**:
`createTypesetter`, `Typesetter.typeset()` job objects (`done` / `onLog` /
`cancel()`), streaming line-buffered logs, parsed diagnostics, engine choice,
and automatic bibliography / index / rerun passes over a **correlated worker
protocol** (every message carries a `jobId`). No DOM, no network after asset
load, no required browser storage (§5.2).

## Status: 0.0.x — early, real, but assets not yet released

The runtime itself is **fully implemented and tested** (186 node tests + a
real-browser Playwright suite; XeTeX and pdfTeX proven end to end against
TeX Live 2026 engines, including bibliography via bibtex8 and makeindex).
This 0.0.x release exists primarily to claim the package name while release
engineering completes.

**What is NOT yet available:** the engine assets (`busytex.wasm`, formats,
the `texlive-basic` data bundle) that this library loads at runtime have **no
official release channel yet** — versioned, integrity-manifested asset
archives arrive with the project's release-engineering milestone. Until then,
using this package requires building the assets from source (see the
repository's `docs/rebase.md` Phase 0 + `make artifacts`; the native dev
build is documented but development-only).

Expect breaking changes before 1.0. `'luatex'` in the `EngineName` union is
**reserved** — LuaTeX is not implemented in v1 (a job requesting it is
rejected with a clear error).

## Quickstart (once you have assets)

```js
import { createTypesetter } from 'wasmtex';

const tex = await createTypesetter({
  assetsBaseUrl: '/dist/',                      // where your assets live
  workerUrl: '/node_modules/wasmtex/dist/worker.js',
  bundles: { preload: ['texlive-basic'], onDemand: [] },
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

Requires Node 24 (`engines`); CI runs the same major.

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
Playwright demo smoke (see `demo/`), with the full browser matrix deferred to
M5. Diagnostics are tested against fixtures captured from real engine
transcripts, regenerated at each rebase (M1 plan, rebase-proofing rule 2).
