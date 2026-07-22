# demo/

A minimal static page — paste LaTeX, get a PDF — that also serves as the CI
smoke test. Since M1 item 9 the page drives the `wasmtex` **runtime** (the §5
`createTypesetter` API over a correlated worker), not the vendored busytex glue.
Playwright drives it in Chromium (primary; Electron-equivalent), with Firefox
and WebKit as an advisory matrix deferred to M5.

## What it loads

The page (`index.html`) imports the built runtime as a native ES module from
`/runtime/dist/src/index.js` and calls:

```js
createTypesetter({
  assetsBaseUrl: '/dist/',                 // engine wasm + texlive-basic bundle
  workerUrl: '/runtime/dist/worker.js',    // our classic worker (replaces the glue)
  bundles: { preload: ['texlive-basic'], onDemand: [] },
})
```

`serve.mjs` serves the **repo root** on one origin, so `/dist/…` (engine
artifacts) and `/runtime/dist/…` (built runtime) resolve same-origin — the
no-network, custom-scheme embedding profile from DESIGN.md §10. The runtime is
authored as ESM for bundler consumption (tsc emits extensionless specifiers), so
`index.html` carries a small **import map** that bridges those specifiers to
their `.js` files; if the runtime's internal module graph changes, module
loading fails loudly in the smoke.

The vendored `busytex_worker.js` / `busytex_pipeline.js` glue is **no longer
shipped** — it was dropped from `/dist` at M2 item 3 (the runtime replaced its
role at M1, and M2 makes the build config ours).

## Requires the runtime to be built

The demo needs `runtime/dist/` (the ESM client + `worker.js`). `npm test` builds
it automatically via a `pretest` hook (`npm --prefix ../runtime run build`),
which assumes `runtime/node_modules` already exists — install it once with
`npm --prefix ../runtime ci`. To rebuild the runtime by hand: `npm run
build:runtime`.

CI's guarded `demo-smoke` job (`.github/workflows/build.yml`) does the same
explicitly (`npm ci` + `npm run build` in `runtime/`) before the smoke, and only
when the `dist/` engine artifacts are present; it skips cleanly otherwise.

## Commands

```
npm --prefix ../runtime ci   # once: install the runtime's build tools
npm run build:runtime        # build runtime/dist (client ESM + worker.js)
npm run serve                # http://127.0.0.1:8099/demo/
npm test                     # pretest builds the runtime, then the Playwright smoke
```
