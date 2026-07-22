# runtime/ — the `wasmtex` package

`wasmtex` is a typed, framework-free ESM library that typesets TeX to PDF inside
a Worker. It implements the original API defined in **DESIGN.md §5**:
`createTypesetter`, `Typesetter.typeset()` job objects (`done` / `onLog` /
`cancel()`), streaming line-buffered logs, parsed diagnostics, engine choice,
and automatic bibliography / index / rerun passes over a **correlated worker
protocol** (every message carries a `jobId`). No DOM, no network after asset
load, no required browser storage (§5.2).

## Status: scaffold

This package is being built out over M1 (see `docs/plans/M1.md`). Today it
exports only the package `version` and the `EngineName` union
(`'xetex' | 'pdftex' | 'luatex'`, with `luatex` **reserved** — the enum value
exists but LuaTeX is unimplemented in v1). The typesetter, worker, protocol,
engine sequencing (§5.3), bundle resolution (§5.4), and the diagnostics parser
land in M1 items 3–8, replacing this scaffold.

## Not published yet

`"private": true` in `package.json`. The package is not on npm, and publishing
is a **user-only** action performed at M5's publish dry-run — no CI job and no
agent publishes it.

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
