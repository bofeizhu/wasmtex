# wasmtex

**wasmtex** is an MIT-licensed, current-TeX-Live WebAssembly typesetter for
embedding in host applications. It compiles LaTeX projects to PDF entirely
inside browser-class runtimes — web pages, Web Workers, Electron renderers or
hidden views — via a single multicall engine binary, tiered TeX Live data
bundles, and a typed, job-oriented ESM API.

## Why

- **Current TeX Live.** Tracks a pinned *current* TeX Live snapshot (starting
  with TL 2026) and treats the rebase to the next year's release as a
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

Pre-code bootstrap: scaffolding the repository, licensing, and CI skeletons;
no engine or runtime code yet.

| Milestone | Goal | Status |
| --- | --- | --- |
| Bootstrap | Repo scaffolding, licensing posture, CI skeletons | Done |
| M0 | Faithful baseline — reproduce upstream busytex's build natively on the dev host | Done |
| M1 | Runtime v1 — typed ESM API, XeTeX-first (LuaTeX dropped from v1) (MVP core) | Done |
| M2 | Rebase to TeX Live 2026 — port patches, dump formats; LuaTeX exits the build | Done |
| M3 | Build logistics & CI — pinned arm64 container as canonical builder, repro gate | In progress |
| M4 | Bundles + manifests — tlpdb-driven tiering and on-demand resolution | Not started |
| M5 | Release engineering + hardening — archives, audit, npm dry-run, corpus, budgets | Not started |

(Milestone order revised 2026-07-22 — native-first bootstrap pivot; see
DESIGN.md §9.)

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
