# demo/

A minimal static page — paste LaTeX, get a PDF — that also serves as the CI
smoke test. Since M1 item 9 the page drives the `wasmtex` **runtime** (the §5
`createTypesetter` API over a correlated worker), not the vendored busytex glue.
Playwright drives it across the DESIGN.md §8 **browser matrix** — Chromium
(primary; Electron-equivalent), Firefox, and WebKit (all three run the same
smoke suite as of M5 item 6).

## What it loads

The page (`index.html`) imports the built runtime as a native ES module from
`/runtime/dist/src/index.js` and calls:

```js
createTypesetter({
  assetsBaseUrl: '/dist/',                 // engine wasm + core (preload) + academic (on-demand)
  workerUrl: '/runtime/dist/worker.js',    // our classic worker (replaces the glue)
  bundles: { preload: ['core'], onDemand: ['academic'] },
})
```

The page drives the **tiered** asset model (DESIGN.md §5.4): `core` is preloaded
at init; `academic` mounts **on demand** at compile time, only when a document
needs it. The default document is core-only; the **"siunitx units" example** (the
`example` dropdown) uses an academic-only package, so compiling it pulls the
academic tier on demand — the stats row then shows `bundles=[core, academic]`,
demonstrating the split live. This replaces the retired `texlive-basic`
byte-alias of `core`, which was dropped from the build at M5 item 6.

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

CI's `demo-smoke` job (`.github/workflows/artifacts-build.yml`, M3 item 7 slice
B2) does the same explicitly (`npm ci` + `npm run build` in `runtime/`) before the
smoke. It runs `needs: artifacts-build`, downloading the `dist/` engine artifacts
that workflow built and asserting they landed before driving the smoke — the
functional release gate, not the earlier green-skip stub.

The **on-demand browser test** (siunitx → academic mount) needs the `academic`
tier present in the served `dist/`. If `dist/` is a core-only (partial) build, it
**skips gracefully** (it reads the tier list from `dist/manifest.json` first).

## Commands

```
npm --prefix ../runtime ci        # once: install the runtime's build tools
npx playwright install --with-deps # once: install the chromium/firefox/webkit browsers
npm run build:runtime             # build runtime/dist (client ESM + worker.js)
npm run serve                     # http://127.0.0.1:8099/demo/
npm test                          # pretest builds the runtime, then the Playwright smoke (chromium + firefox + webkit)
```
