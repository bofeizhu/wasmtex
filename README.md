# wasmtex

**wasmtex** is an MIT-licensed, current-TeX-Live WebAssembly typesetter for
embedding in host applications. It compiles LaTeX projects to PDF entirely
inside browser-class runtimes — web pages, Web Workers, Electron renderers or
hidden views — via a single multicall engine binary, tiered TeX Live data
bundles, and a typed, job-oriented ESM API.

## Why

- **Current TeX Live.** Tracks a pinned *current* TeX Live snapshot (the first
  release pins TL 2026) and treats the rebase to the next year's release as a
  first-class, scripted operation rather than an archaeology project.
- **License clarity for proprietary hosts.** The repository's own code is MIT;
  the compiled artifacts are an *aggregate distribution of TeX Live programs*
  under their own free licenses, which hosts drive as separate programs (argv
  in, files out) with no copyleft wrapper layer in between.
- **Embedding-first runtime.** The API is built for host apps that need
  deterministic assets, integrity manifests, custom URL schemes, request
  correlation, cancellation, and streaming logs — never depending on browser
  persistence (IndexedDB/localStorage) being available.

## Status

**Published** — the runtime is on npm as
[`wasmtex`](https://www.npmjs.com/package/wasmtex), and its matching engine +
data assets are on GitHub Releases (tag `assets-v<version>`). Still pre-1.0 and
honest about it: the API may still change before 1.0, and the design targets
**one embedder** (a desktop app embedding WasmTeX in a hidden Electron view
behind a custom scheme; see DESIGN.md §10). The engine, runtime, bundle system,
release pipeline, and CI are all built, tested, and shipping.

```sh
npm install wasmtex
```

| Milestone | Goal | Status |
| --- | --- | --- |
| Bootstrap | Repo scaffolding, licensing posture, CI skeletons | Done |
| M0 | Faithful baseline — reproduce upstream busytex's build natively on the dev host | Done |
| M1 | Runtime v1 — typed ESM API, XeTeX-first (LuaTeX dropped from v1) (MVP core) | Done |
| M2 | Rebase to TeX Live 2026 — port patches, dump formats; LuaTeX exits the build | Done |
| M3 | Build logistics & CI — pinned arm64 container as canonical builder | Done |
| M4 | Bundles + manifests — tlpdb-driven tiering and on-demand resolution | Done |
| M5 | Release engineering + hardening — versioned archives, license audit, docs, conformance corpus, size budgets, browser matrix | Done |

(Milestone order revised 2026-07-22 — native-first bootstrap pivot; see
DESIGN.md §9.)

## What works today

Against the pinned TeX Live 2026 snapshot, proven end to end by the runtime
test suite, the Node conformance corpus, and a real-browser Playwright smoke:

- **XeTeX** (primary; engine pass → `xdvipdfmx` → PDF) and **pdfTeX**, driven
  through the typed `createTypesetter` API.
- **Automatic multi-pass sequencing**: `bibtex8` when the `.aux` requests a
  bibliography, `makeindex` on a non-empty `.idx`, and engine reruns until
  references/TOC quiesce (bounded).
- **Two data tiers**: `core` (~55 MB, always preloaded — the LaTeX base,
  `amsmath`/`hyperref`/`geometry`/`babel`, `natbib`/`bibtex`, `makeindex`, the
  `lm`/`cm` fonts, and the XeTeX/pdfTeX formats) and `academic` (~506 MB,
  on-demand — `fontspec`, TikZ/PGF, `beamer`, `biblatex`, `unicode-math`,
  `siunitx`, `tcolorbox`, CJK via `xeCJK`/`ctex`/`fandol`, …).
- **On-demand resolution** (DESIGN.md §5.4): an up-front `\usepackage` scan
  plus a missing-file retry mount the `academic` tier automatically and *only*
  when a document needs it — loading another **local** bundle, never touching
  the network at compile time.
- **Structured diagnostics** parsed from the transcript (errors/warnings with
  file/line), streaming `onLog`, real `cancel()` (worker termination), and
  cold-start correctness with **zero browser storage**.

Host-supplied fonts and CJK work by passing font bytes in the job's `files`
map (DESIGN.md §6.3). `'luatex'` is reserved in the engine union but **not**
implemented in v1 (a job requesting it is rejected with a clear error).

## Using it / embedding

- **[`docs/embedding.md`](docs/embedding.md)** — the embedding guide: install
  the package, host the separately-published asset archives, point the runtime
  at them (`assetsBaseUrl`, or a custom scheme via `locateAsset` + `workerUrl`),
  verify the download against the integrity manifest, and drive the job API.
  Written for the DESIGN.md §10 hard-constraint profile (same-origin host,
  custom scheme, cold start, no network after load).
- **[`runtime/README.md`](runtime/README.md)** — the npm-package-facing README
  (`wasmtex`): quickstart, layout, dev commands, and test philosophy.

The npm package ships **JavaScript only** (no engine, no bundles). The engine
`wasm`, formats, and data bundles are published **separately** as versioned
GitHub Release archives (`assets-v<version>`) that a host serves same-origin;
`wasmtex@X.Y.Z` is designed to pair with `wasmtex-assets-X.Y.Z`. See the
embedding guide for the version contract.

## Design

[`DESIGN.md`](DESIGN.md) is the founding design document and the source of
truth for goals, non-goals, API shape, build pipeline, licensing posture, and
milestones. [`docs/rebase.md`](docs/rebase.md) is the annual-rebase runbook —
the operational sequence for tracking each new TeX Live release, seeded by the
TL 2026 rebase and honest about what is scripted versus a judgment call.

## License

Repository code is licensed [MIT](LICENSE). The compiled release artifacts are
an aggregate distribution of TeX Live programs under their own respective
licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the full
inventory.

## Acknowledgments

WasmTeX's build machinery derives from
[**busytex**](https://github.com/busytex/busytex) by Vadim Kantorov and
contributors (MIT) — the upstream project that established the multicall
WebAssembly TeX binary and its Emscripten build approach. WasmTeX would not
exist without that work. See [`NOTICE`](NOTICE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full attribution and the
vendored-file manifest.
