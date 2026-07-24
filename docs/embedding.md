<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 WasmTeX contributors
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# Embedding WasmTeX

This is the operational guide for putting WasmTeX inside a host application. It
covers the DESIGN.md §10 embedding profile end to end: install the package,
host the (separately-published) asset archives, point the runtime at them —
over a plain same-origin base URL *or* a custom scheme — verify the download
against the integrity manifest, and drive the job API. Every API shape below
exists in the shipped `wasmtex` package today (`runtime/src/client.ts`); where
a detail is *intended for the first release* rather than already coded, it is
called out explicitly.

The concrete target is a desktop app that embeds WasmTeX in a **hidden Electron
view behind a custom scheme** — so the requirements are hard constraints:
arbitrary same-origin base URL, correct `application/wasm` MIME, a verifiable
integrity manifest, cold start with **zero browser storage**, serialized jobs
with correlated results and real cancellation, and **no network access after
asset load**. But nothing here is Electron-specific; any same-origin host (a
web page, a Web Worker host, a packaged app) drives the same API.

## Table of contents

1. [The two halves: JS package + hosted assets](#1-the-two-halves-js-package--hosted-assets)
2. [Install the package](#2-install-the-package)
3. [Host the asset archives](#3-host-the-asset-archives)
4. [Boot the typesetter (same-origin base URL)](#4-boot-the-typesetter-same-origin-base-url)
5. [The bundle model: preload vs. on-demand](#5-the-bundle-model-preload-vs-on-demand)
6. [The job API](#6-the-job-api)
7. [Cold start with zero browser storage](#7-cold-start-with-zero-browser-storage)
8. [Integrity: verifying the download against the manifest](#8-integrity-verifying-the-download-against-the-manifest)
9. [Custom scheme (Electron `protocol.handle`)](#9-custom-scheme-electron-protocolhandle)
10. [Versioning: matching the package to its assets](#10-versioning-matching-the-package-to-its-assets)
11. [Error handling](#11-error-handling)
12. [Guarantees and non-goals](#12-guarantees-and-non-goals)

---

## 1. The two halves: JS package + hosted assets

WasmTeX ships as two independently-versioned pieces:

| Piece | Contents | Where it comes from | Size |
| --- | --- | --- | --- |
| **`wasmtex` npm package** | the typed ESM runtime + the classic Worker script (`dist/worker.js`) — **JavaScript only** | npm | ~0.4 MB |
| **asset archives** | the engine `busytex.wasm` + its JS loader, the preloaded `.fmt` formats, the `core`/`academic` data bundles, and `manifest.json` | GitHub Release, tag `assets-v<version>` | tens–hundreds of MB |

This split is deliberate (DESIGN.md §4): the package that goes to npm carries
**no** multi-hundred-megabyte engine or TeX Live data. The host downloads the
matching asset archive once, stores it wherever it likes, and serves it to the
runtime over a same-origin URL. The runtime never fetches assets from a CDN or
package server — it only reads the base URL (or custom-scheme URLs) you give it.

## 2. Install the package

```sh
npm install wasmtex
```

The package is framework-free ESM with bundled type declarations. The only file
a host imports is the public entry:

```js
import { createTypesetter } from 'wasmtex';
```

The package also contains the **worker script** at `wasmtex/dist/worker.js`.
This is a classic (non-module) Worker the runtime spawns; you point the runtime
at it (see [§4](#4-boot-the-typesetter-same-origin-base-url) and
[§9](#9-custom-scheme-electron-protocolhandle)). It is *not* one of the hosted
assets — it lives in the npm package next to the runtime.

To *consume* the package you need no particular Node version — it runs in the
browser/Worker. Node ≥18 is only relevant if you run the package's own tooling
(see `runtime/README.md`).

## 3. Host the asset archives

The engine and data are published as versioned archives on a GitHub Release
tagged `assets-v<version>` (the first release: **`assets-v0.1.0`**):

- `wasmtex-assets-0.1.0.tar.gz` — the full set: engine + formats + **both**
  bundles + `manifest.json`.
- `wasmtex-bundle-core-0.1.0.tar.gz` and `wasmtex-bundle-academic-0.1.0.tar.gz`
  — the per-tier archives, if you want to host the tiers separately.

Unpack the archive under a directory your host serves. The tree is flat, with a
`formats/` subdirectory:

```
<assets-dir>/
  manifest.json          # the integrity + resolution manifest (schemaVersion 2)
  SHA256SUMS             # plain checksum list (role: checksums)
  busytex.wasm           # the multicall engine        (~27 MB)
  busytex.js             # its Emscripten JS loader
  core.js  core.data     # the 'core' bundle           (~55 MB total)
  academic.js academic.data  # the 'academic' bundle   (~506 MB total)
  formats/
    xelatex.fmt          # preloaded XeTeX format dump
    pdflatex.fmt         # preloaded pdfTeX format dump
```

**Serve `.wasm` with `Content-Type: application/wasm`.** This is a hard
requirement, not a nicety: the engine is instantiated with
`WebAssembly.compileStreaming`, and Chromium (hence Electron) *rejects* the
stream if the response carries any other MIME type. The `.data` bundle blobs
should be served as `application/octet-stream`; `manifest.json` as
`application/json`. The repo's `demo/serve.mjs` is a minimal reference server
that gets this MIME map right.

Everything must be **same-origin** with the page/host that constructs the
typesetter — the runtime spawns a classic Worker and loads the engine into it,
and both operations are same-origin-bound. "Same origin" can be a custom scheme
you own (see [§9](#9-custom-scheme-electron-protocolhandle)); it does not have
to be `http(s)`.

## 4. Boot the typesetter (same-origin base URL)

The simplest host serves the assets and the package under one origin and passes
a base URL. This mirrors the runnable example in `demo/index.html` +
`demo/serve.mjs`.

```js
import { createTypesetter } from 'wasmtex';

const tex = await createTypesetter({
  // Where the unpacked asset archive lives (same-origin). The runtime fetches
  // `manifest.json` from here, then loads busytex.wasm + the preload bundles.
  assetsBaseUrl: '/wasmtex-assets/',

  // The classic Worker script that ships INSIDE the npm package. Point at
  // wherever your host serves node_modules/wasmtex/dist/worker.js. If omitted,
  // it defaults to `${assetsBaseUrl}worker.js` — so either pass it explicitly
  // or copy worker.js next to your assets.
  workerUrl: '/node_modules/wasmtex/dist/worker.js',

  // Which data tiers to load up front vs. leave available for on-demand mount.
  bundles: { preload: ['core'], onDemand: ['academic'] },
});
```

`createTypesetter` fetches the manifest, spawns the worker, instantiates the
engine, mounts the `preload` bundles, and resolves once the worker reports
ready. It **rejects** (without leaking a worker) on bad options
(`TypesetInputError`), a fatal init such as a missing/mistyped asset
(`FatalError`, code `init-failed`), or a worker crash (`WorkerCrashedError`).

`createTypesetter` options actually available (from `runtime/src/client.ts`):

| Option | Type | Purpose |
| --- | --- | --- |
| `assetsBaseUrl` (required) | `string` | Same-origin base URL the worker loads assets from. |
| `bundles` | `{ preload: string[]; onDemand: string[] }` | Tiers to preload vs. leave on-demand. Default: none preloaded (a working typesetter needs at least one preload tier). |
| `workerUrl` | `string` | Classic-worker script URL for the default factory. Defaults to `${assetsBaseUrl}worker.js`. |
| `workerFactory` | `() => WorkerLike` | Build the worker yourself (e.g. wrap your bundler's `new Worker(new URL(...))`). Overrides `workerUrl`. |
| `locateAsset` | `(name: string) => string \| undefined` | Per-file URL override — see [§9](#9-custom-scheme-electron-protocolhandle). |
| `onAssetProgress` | `(p: { assetId: string; loadedBytes: number; totalBytes: number }) => void` | Coarse load progress — see the fidelity note below. |
| `inventory` | `AssetsInventory` | Supply the parsed manifest directly and skip the fetch (hosts that already hold it). |
| `fetchImpl` | `(url: string) => Promise<{ ok; status; json() }>` | `fetch` replacement used only for the manifest. Defaults to `globalThis.fetch`. |

**Progress fidelity.** `onAssetProgress` is coarse: the engine wasm/JS and the
preload bundles are fetched *inside* the worker by Emscripten, which exposes no
per-byte callback to the main thread. So the runtime emits, per init-loaded
asset, exactly two events — `loadedBytes: 0` at start and
`loadedBytes === totalBytes` at completion — with `totalBytes` taken from the
manifest (never a fabricated intermediate). On-demand tiers are *not* reported
here (they mount lazily at compile time, not during init); observe them via
`stats.bundlesLoaded` instead ([§6](#6-the-job-api)).

## 5. The bundle model: preload vs. on-demand

WasmTeX ships two disjoint data tiers (DESIGN.md §5.4, §4):

- **`core`** (~55 MB) — always preloaded. The LaTeX base and the everyday
  working set: `amsmath`, `hyperref`, `geometry`, `babel`, `graphics`, the
  XeTeX/pdfTeX formats, `natbib`/`bibtex`, `makeindex`, and the fonts (`lm`,
  `cm`) a plain document needs. A basic XeTeX/LaTeX document typesets from
  `core` alone (as the demo's hello-world does).
- **`academic`** (~506 MB) — on-demand. The rich research/publishing set:
  `fontspec` (so any document doing explicit font selection pulls this tier),
  TikZ/PGF, `beamer`, `biblatex`, `unicode-math`, `siunitx`, `tcolorbox`,
  `booktabs`, `tabularray`, `pgfplots`, CJK via `xeCJK`/`ctex`/`fandol`, and
  ~2400 more packages.

```js
bundles: { preload: ['core'], onDemand: ['academic'] }
```

**What "on-demand" means here is important: it is not a network fetch.** When a
compile needs a package that lives in `academic`, the runtime mounts the
`academic` bundle from the **same local asset source** you already configured
(`assetsBaseUrl` / `locateAsset`) and retries — no package server, no download
at compile time, no network. Resolution happens two ways (DESIGN.md §5.4):

1. **Static scan** — before the first pass, the runtime scans the project
   sources for `\usepackage`/`\RequirePackage`; if a named package is provided
   by an on-demand tier (per the manifest's per-bundle `provides` index), that
   tier is mounted before compiling. Unknown names (project-local `.sty`/`.cls`,
   or names no tier provides) do nothing.
2. **Missing-file retry** — if a pass still fails with kpathsea "file not
   found" lines that the manifest maps to a not-yet-loaded on-demand tier, the
   runtime mounts that tier and retries the pass **once**. This catches packages
   pulled in by macros the static scan can't see.

So a host can preload only `core` for fast cold starts and let documents that
actually need the heavy set pull `academic` transparently — while a plain
document never pays for it and never hits the network.

> Earlier `0.0.x` builds also shipped a `texlive-basic` bundle as a back-compat
> **alias** of `core`; it was removed at `v0.1.0`. Use `core` (+ `academic` on
> demand). The runtime still honors an `aliasOf` entry if a custom inventory you
> supply defines one, but the shipped manifest no longer contains it.

## 6. The job API

One typesetter serves many jobs; jobs **serialize** through it (one compile at a
time) and results are correlated to their request, so a late message from a
cancelled job can never resolve a newer one.

```js
const job = tex.typeset({
  engine: 'xetex',                 // 'xetex' (full) | 'pdftex' — 'luatex' is reserved, rejected
  entry: 'main.tex',               // safe project-relative path
  files: {                         // a map (not an array); values are string or Uint8Array
    'main.tex': source,
    'refs.bib': bibSource,
    'fonts/NotoSerifCJKsc-Regular.otf': fontBytes,   // host-supplied fonts ride in `files`
  },
  passes: 'auto',                  // 'auto' (rerun until quiescent, cap 5) or an exact 1..5
  bibliography: 'auto',            // 'auto' (run bibtex8 when the .aux asks) | 'off'
  index: 'auto',                   // 'auto' (run makeindex on a non-empty .idx) | 'off'
  synctex: false,                  // accepted; SyncTeX output not produced in v1
});

// Streaming transcript, line-buffered. A late registration replays prior lines.
job.onLog((line) => appendToConsole(line));

const result = await job.done;
// result: {
//   ok: boolean,
//   exitCode: number,
//   pdf?: Uint8Array,             // present when ok
//   synctex?: Uint8Array,         // absent in v1
//   log: string,                  // the full transcript
//   diagnostics: Array<{ severity: 'error'|'warning', message: string, file?: string, line?: number }>,
//   stats: { passes: number, elapsedMs: number, bundlesLoaded: string[] }
// }
```

Notes that matter for a host:

- **`typeset(...)` returns synchronously** and throws `TypesetInputError`
  *synchronously* on malformed input (bad engine, unsafe path, empty `files`,
  out-of-range `passes`). A *TeX-level* failure (a broken document) is **not**
  an exception — it resolves with `ok: false` and populated `diagnostics`. Only
  cancel/crash/fatal reject `done`.
- **`diagnostics`** are parsed from the transcript by a tested parser — hosts
  should *not* regex the log themselves. They are the structured tail you can
  surface to a user (or to an LLM agent that authored the document).
- **`stats.bundlesLoaded`** lists the tiers actually mounted for the job. If it
  contains `academic`, an on-demand mount happened — the way to confirm the
  resolver pulled the heavy tier.
- **Cancellation is real.** `job.cancel()` *terminates the worker* mid-compile;
  `done` rejects with `CancelledError` (`reason: 'cancelled'`). The next
  `typeset()` transparently re-initializes on a fresh worker. Engine warm state
  is a cache, never a correctness dependency. `cancel()` is idempotent.
- **`tex.dispose()`** terminates the worker and rejects every in-flight and
  queued job with `CancelledError` (`reason: 'disposed'`). Idempotent.

### Minimal end-to-end example

A trimmed version of `demo/index.html` — boot once, then compile:

```js
import { createTypesetter, CancelledError } from 'wasmtex';

const tex = await createTypesetter({
  assetsBaseUrl: '/wasmtex-assets/',
  workerUrl: '/node_modules/wasmtex/dist/worker.js',
  bundles: { preload: ['core'], onDemand: ['academic'] },
});

const source = String.raw`
\documentclass[11pt]{article}
\begin{document}
Hello, WasmTeX! Typeset in the browser by XeTeX, written to PDF by xdvipdfmx.
\end{document}
`;

const job = tex.typeset({ engine: 'xetex', entry: 'main.tex', files: { 'main.tex': source } });
job.onLog((line) => console.log(line));

try {
  const { ok, pdf, diagnostics, stats } = await job.done;
  if (ok && pdf) {
    // pdf is a Uint8Array — write it, or preview via a Blob URL:
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    // ... use url ...
  } else {
    console.warn('compile failed', diagnostics);
  }
  console.log('bundles loaded:', stats.bundlesLoaded);   // ['core'] for this doc
} catch (err) {
  if (err instanceof CancelledError) { /* expected on cancel/dispose */ }
  else { /* FatalError | WorkerCrashedError — see §11 */ }
} finally {
  await tex.dispose();
}
```

## 7. Cold start with zero browser storage

The runtime **never requires** IndexedDB, localStorage, or the Cache API.
Correctness and every test assume a cold, storage-less context: on each boot it
fetches the manifest, loads the engine and preload bundles into worker memory,
and runs. There is no hidden persistence and no "first run populates a cache"
step you must account for.

This is a first-class constraint for the Electron embedding profile, where the
hidden view may run with storage disabled or wiped. It also means **you** own
any caching: if you want to avoid re-reading the asset bytes across launches,
cache them at the *host* layer (on disk, behind your scheme handler) — the
runtime will happily read the same local bytes every cold start.

## 8. Integrity: verifying the download against the manifest

The asset archive carries a machine-readable **integrity manifest**,
`manifest.json` (schemaVersion 2). It is the input to *host-side* verification —
the runtime loads assets by role and validates the manifest's *shape*, but it
does **not** re-hash asset bytes at load time. Verifying the download is the
host's job (DESIGN.md §10: "an integrity manifest the host can verify after
download"), and it is exactly where a host should fail closed before serving a
tampered or truncated asset to the engine.

The manifest's relevant shape:

```jsonc
{
  "schemaVersion": 2,
  "texliveSnapshot": { "release": "2026", "tlpdbRevision": 78233, "freeze": "2026-03-01" },
  "engines": ["bibtex8", "kpsewhich", "makeindex", "pdftex", "xdvipdfmx", "xetex"],
  "bundles": [
    { "name": "core",     "files": ["core.data", "core.js"],         "bytes": 55334848,  "provides": ["amsmath", "hyperref", ...] },
    { "name": "academic", "files": ["academic.data", "academic.js"], "bytes": 505887127, "provides": ["pgf", "beamer", "fontspec", ...] }
  ],
  "assets": [
    { "path": "busytex.wasm", "bytes": 27508145, "sha256": "1c9b96dc…", "role": "engine-wasm" },
    { "path": "core.data",    "bytes": 53867624, "sha256": "6cc342a9…", "role": "bundle-data" },
    // … one entry per file, each with bytes + sha256 + role …
    { "path": "SHA256SUMS",   "bytes": 825,      "sha256": "a36f9bb9…", "role": "checksums" }
  ]
}
```

Every asset entry carries `bytes` and a hex `sha256`; a plain `SHA256SUMS` list
(role `checksums`) is included too. To verify after download, hash each file and
compare against its manifest entry (fail if any file is missing, wrong-sized, or
mismatched). Sketch in Node/Electron:

```js
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function verifyAssets(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  for (const a of manifest.assets) {
    if (a.path === 'manifest.json') continue;
    const bytes = await readFile(join(dir, a.path));            // path is POSIX-relative
    if (a.bytes != null && bytes.length !== a.bytes) throw new Error(`size mismatch: ${a.path}`);
    if (a.sha256) {
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== a.sha256) throw new Error(`sha256 mismatch: ${a.path}`);
    }
  }
}
```

Run this once after unpacking (or after any update) and refuse to serve assets
that fail. The `texliveSnapshot` block lets you additionally assert you are
serving the TeX Live snapshot you expect.

## 9. Custom scheme (Electron `protocol.handle`)

The embedding target serves assets from a custom scheme (e.g.
`wasmtex-assets://`) inside a hidden Electron view, not from `http`. Two knobs
make this work: **`locateAsset`** relocates the assets, and **`workerUrl`**
relocates the worker script.

**`locateAsset(name)`** is called with each asset's manifest path — and with
the manifest filename itself (`'manifest.json'`, falling back to `'assets.json'`)
for the bootstrap fetch. Return an absolute URL to use verbatim, or `undefined`
to fall back to `assetsBaseUrl + path`. This is the seam that turns every asset
reference into a custom-scheme URL:

```js
const tex = await createTypesetter({
  assetsBaseUrl: 'wasmtex-assets://dist/',        // still required; used when locateAsset returns undefined
  locateAsset: (name) => `wasmtex-assets://dist/${name}`,
  workerUrl: 'wasmtex-assets://dist/worker.js',   // see the caveat below
  bundles: { preload: ['core'], onDemand: ['academic'] },
});
```

**Caveat — `locateAsset` does *not* relocate the worker script.** It is
consulted for inventory entries and the manifest, but the default worker URL is
derived from `assetsBaseUrl` only. Under a custom scheme you must therefore set
`workerUrl` explicitly (or supply a `workerFactory`) so the worker is fetched
from a scheme your handler serves. The worker script (`dist/worker.js`) comes
from the npm package — copy it into the directory your scheme serves, or map its
path in the handler.

On the Electron side, register the scheme as privileged before the app is ready,
then answer it with `protocol.handle`, setting the right `Content-Type`
(especially `application/wasm`):

```js
const { app, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const { extname } = require('node:path');

// Before app 'ready':
protocol.registerSchemesAsPrivileged([
  { scheme: 'wasmtex-assets', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.data': 'application/octet-stream',
                '.json': 'application/json', '.fmt': 'application/octet-stream' };

app.whenReady().then(() => {
  protocol.handle('wasmtex-assets', async (request) => {
    const url = new URL(request.url);                 // wasmtex-assets://dist/<path>
    const filePath = resolveWithinAssetsDir(url.pathname);  // YOUR safe join; reject traversal
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Type', TYPES[extname(filePath)] ?? 'application/octet-stream');
    return new Response(res.body, { status: res.status, headers });
  });
});
```

The page/hidden view loads from `wasmtex-assets://…` too, so it is same-origin
with the worker and the assets. Because a privileged custom scheme behaves like
a secure origin, `new Worker('wasmtex-assets://dist/worker.js')`, the engine's
streaming wasm instantiation, and the on-demand bundle mounts all resolve
through your handler — and nothing ever leaves it. (Reject path traversal in
your handler exactly as `demo/serve.mjs` does for the `http` case.)

## 10. Versioning: matching the package to its assets

The npm package and the asset archives are versioned **in lockstep**:
`wasmtex@X.Y.Z` is meant to run against `wasmtex-assets-X.Y.Z` (GitHub tag
`assets-vX.Y.Z`). For the first release that is `wasmtex@0.1.0` ↔
`assets-v0.1.0`.

To make a mismatch fail *clearly* instead of as a confusing mid-compile error,
the package makes the pairing checkable:

- it exports an **`ASSETS_VERSION`** constant (equal to the package version), and
- `createTypesetter` **soft-verifies** that the fetched `manifest.json` declares a
  matching `version` — throwing a clear, typed `AssetVersionMismatchError` on a
  mismatch, *before* it spawns anything.

The build stamps the same version into the shipped `manifest.json` (a top-level
`version` field, in lockstep with `runtime/package.json`), so at boot the runtime
compares the manifest's `version` against its own `ASSETS_VERSION`:

```js
import { ASSETS_VERSION, createTypesetter, AssetVersionMismatchError } from 'wasmtex';

console.log(ASSETS_VERSION); // e.g. "0.1.0" — host the assets-v0.1.0 archive

try {
  const tex = await createTypesetter({ assetsBaseUrl: '…', preload: ['core'] });
} catch (err) {
  if (err instanceof AssetVersionMismatchError) {
    // err.expected === ASSETS_VERSION, err.actual === the manifest's version
    console.error(`host the wasmtex-assets-${err.expected} archive (you served ${err.actual})`);
  }
}
```

The check is **soft** — it never gets in your way when it shouldn't:

- an asset tree whose `manifest.json` has **no `version`** (an older build) is
  accepted without a check (back-compat);
- `expectAssetsVersion: '<v>'` requires the manifest to declare `<v>` *instead of*
  `ASSETS_VERSION` — for a host that has deliberately pinned a different asset
  build but still wants the guard against a wrong/corrupt manifest;
- `expectAssetsVersion: false` disables the check entirely (no version coupling).

So the discovery flow a host implements is simply: read `ASSETS_VERSION` (or the
installed package version), download the matching `assets-v<version>` archive,
host it, and point `assetsBaseUrl` (or `locateAsset`) at it — the runtime confirms
the match for you at boot. The `manifest.json` you host must be the one from that
archive.

## 11. Error handling

Every failure surfaces as one of four exported error types (all importable from
`wasmtex`):

| Error | When | Key fields |
| --- | --- | --- |
| `TypesetInputError` | Thrown **synchronously** by `createTypesetter` (bad options) or `typeset()` (malformed job) | — |
| `AssetVersionMismatchError` | `createTypesetter` — the fetched `manifest.json` `version` does not match this build (see [§10](#10-versioning-matching-the-package-to-its-assets)) | `expected`, `actual` |
| `FatalError` | A structured engine/init failure; rejects `done` (or `createTypesetter`) | `code`, `detail?` |
| `WorkerCrashedError` | The worker terminated unexpectedly (not a structured fatal) | `detail?` |
| `CancelledError` | `job.cancel()` or `tex.dispose()` | `reason: 'cancelled' \| 'disposed'` |

`FatalError.code` is a closed set you can branch on:
`'init-failed'` (asset load / instantiation — e.g. wrong MIME, missing file,
manifest not found), `'unsupported-engine'` (a reserved engine like `luatex`),
`'engine-aborted'` (a wasm `abort()`), `'protocol'`, `'internal'`. A
`WorkerCrashedError` or an `engine-aborted`/`internal` fatal drops the worker;
the next `typeset()` re-initializes transparently.

A broken *document* is not any of these — it comes back as `ok: false` with
`diagnostics`, from a resolved `done`.

## 12. Guarantees and non-goals

The runtime holds these contracts (DESIGN.md §5.2, §10), and a host can rely on
them:

- **No DOM.** Runs entirely via `Worker` + `fetch` + `WebAssembly`. No
  script-tag injection mode; nothing here touches `document`.
- **No network after asset load.** Once the engine and needed bundles are
  loaded (including any on-demand tier, which is still a *local* load), a
  compile makes no network request. There is no telemetry, no font/package
  fetch, no phone-home.
- **No required browser storage.** See [§7](#7-cold-start-with-zero-browser-storage).
- **Serialized, correlated, cancellable jobs.** See [§6](#6-the-job-api).

Non-goals for v1 worth setting expectations around: LuaTeX (reserved, not
implemented), SyncTeX *output* (the flag is accepted but no bytes are produced
yet), per-byte asset progress, and pixel-level output comparison. See DESIGN.md
§3 and §9 for the full non-goal list.

---

*Provenance: original work, MIT (see `LICENSE`). The API shapes here are those
of `runtime/src/client.ts` in this repository.*
