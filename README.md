<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/wordmark-dark.svg">
    <img alt="WasmTeX" src=".github/wordmark-light.svg" height="56">
  </picture>
</h1>

<p align="center"><strong>Current-TeX-Live LaTeX → PDF, entirely in the browser.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/wasmtex"><img alt="npm" src="https://img.shields.io/npm/v/wasmtex.svg"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/wasmtex.svg"></a>
  <img alt="types" src="https://img.shields.io/npm/types/wasmtex.svg">
</p>

wasmtex packages the genuine **XeTeX** and **pdfTeX** engines from **TeX Live 2026** — plus `bibtex8`, `makeindex`, and automatic engine reruns — behind one small, friendly JavaScript API. Point it at your `.tex` sources, get back a `Uint8Array` PDF, entirely client-side: no server, and no network at compile time. The same code that runs on your laptop runs offline in your users' tabs.

> Pre-1.0: published on npm and usable today; the API may still change before 1.0.

## Install

```sh
npm install wasmtex
```

The npm package is **JavaScript only (~160 KB)**. The engine WebAssembly and TeX data ship separately as versioned GitHub Release archives — see [Assets](#assets).

## Quickstart

```js
import { createTypesetter } from 'wasmtex';

const tex = await createTypesetter({
  assetsBaseUrl: '/wasmtex-assets/',                 // where you serve the unpacked asset archive
  workerUrl: '/node_modules/wasmtex/dist/worker.js',
  bundles: { preload: ['core'], onDemand: ['academic'] },
});

const job = tex.typeset({
  engine: 'xetex',                                    // 'xetex' | 'pdftex'
  entry: 'main.tex',
  files: { 'main.tex': source },                      // path -> string | Uint8Array
});

job.onLog((line) => console.log(line));               // streaming logs
const { ok, pdf, log, diagnostics } = await job.done; // pdf is a Uint8Array
```

That's the whole loop: create a typesetter once, hand `typeset` your files, await the PDF. The bibliography, index, and engine-rerun passes all happen for you.

## Features

|  |  |
| --- | --- |
| **Real engines** | XeTeX (primary) and pdfTeX, built from TeX Live 2026 — not a reimplementation. (`'luatex'` is reserved in the type union but not implemented in v1; a job requesting it is rejected with a clear error.) |
| **Automatic multi-pass** | `bibtex8` for bibliographies, `makeindex` for indexes, and engine reruns until cross-references and the TOC settle — automatic and bounded. |
| **Structured diagnostics** | Errors and warnings with file + line, plus streaming `onLog` and the raw `log`. |
| **On-demand packages** | The `academic` tier mounts automatically, from a local bundle, only when a document needs it — never the network. |
| **CJK ready** | xeCJK, ctex, and fandol ship in the academic tier; supply your own font bytes through the job's `files` map. |
| **Real `cancel()`** | Backed by worker termination — no zombie compiles. |
| **Zero browser storage** | Cold-start correct with no IndexedDB or localStorage; a fresh tab produces the same PDF as a warm one. |
| **Native ESM everywhere** | Works under a bundler, as native browser ESM (no import map), and in bare Node. |

### Two data tiers

| Tier | Size | Loading | Contents |
| --- | --- | --- | --- |
| `core` | ~55 MB | always preloaded | LaTeX base, amsmath / hyperref / geometry / babel, natbib / bibtex, Latin Modern & Computer Modern fonts, the XeTeX + pdfTeX formats |
| `academic` | ~506 MB | on-demand, local | fontspec, TikZ / PGF, beamer, biblatex, unicode-math, siunitx, tcolorbox, CJK (xeCJK / ctex / fandol) |

The academic tier mounts **automatically, only when a document requires it**, by loading another local bundle — never from the network.

## Assets

wasmtex splits the tiny driver from the large payload:

- The **npm package** is JavaScript only (~160 KB) — it does not bundle the hundreds of MB of engine and data.
- The **engine wasm, preloaded formats, and data bundles** ship as GitHub Release archives tagged `assets-v<version>`, kept in **lockstep** with the npm version: `wasmtex@X.Y.Z` ↔ `assets-vX.Y.Z`.

You host the unpacked archive yourself and point `assetsBaseUrl` at it, so you control hosting, caching, and offline behavior. An integrity manifest plus an exported `ASSETS_VERSION` constant let the runtime **soft-verify** that the assets match the library at boot. See the [embedding guide](docs/embedding.md) for hosting layout, custom URL schemes, integrity verification, and cold-start details.

## Documentation

- **[Embedding guide](docs/embedding.md)** — hosting assets, custom URL schemes, integrity verification, cold start, and the bundle model.
- **[DESIGN.md](DESIGN.md)** — the design source of truth.

## License

wasmtex's own code is **MIT** — see [LICENSE](LICENSE). The compiled artifacts are an **aggregate distribution of TeX Live programs** under their own free licenses, driven as separate programs (argv in, files out) with no copyleft wrapper layer around your code — proprietary hosts included. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full picture.

## Acknowledgment

The build machinery derives from [**busytex**](https://github.com/busytex/busytex) by Vadim Kantorov (MIT) — the upstream project that established the multicall WebAssembly TeX binary.
