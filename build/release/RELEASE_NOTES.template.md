<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 WasmTeX contributors
  Original work authored in the WasmTeX repository (see LICENSE).

  RELEASE-NOTES TEMPLATE (DESIGN.md §7). The release workflow (M5 item 8) fills the
  {{PLACEHOLDERS}} from the tag + the `node build/release/pack.mjs --json` report:

    {{VERSION}}            release version, e.g. 0.1.0        (from the assets-v* tag)
    {{TAG}}                the git tag, e.g. assets-v0.1.0    (= assets-v{{VERSION}})
    {{REPO_URL}}           repo URL, e.g. https://github.com/bofeizhu/wasmtex
    {{RELEASE_DATE}}       ISO date, e.g. 2026-07-24
    {{TL_RELEASE}}         TeX Live release, e.g. 2026        (manifest.texliveSnapshot.release)
    {{TLPDB_REVISION}}     tlpdb revision, e.g. 78233         (manifest.texliveSnapshot.tlpdbRevision)
    {{ASSETS_GZ}} / {{ASSETS_SHA256}}       assets archive gzip size + sha256
    {{BUNDLE_CORE_GZ}} / {{BUNDLE_CORE_SHA256}}
    {{BUNDLE_ACADEMIC_GZ}} / {{BUNDLE_ACADEMIC_SHA256}}

  The "Breaking changes" section is per-release: it is seeded below with the
  0.1.0 change (texlive-basic removed) and edited each release.
-->

# WasmTeX {{VERSION}}

A current-TeX-Live WebAssembly typesetter for embedding. This release publishes the
engine + asset archives; the npm package (`wasmtex@{{VERSION}}`, JS only) points at
them via `assetsBaseUrl`.

Built from the **TeX Live {{TL_RELEASE}}** snapshot (tlpdb revision
`{{TLPDB_REVISION}}`), reproducibly, inside the pinned build container.

## Distribution & licensing (DESIGN.md §7)

The release archives are an **aggregate distribution of TeX Live programs** compiled
to WebAssembly, each carried under its own free license; WasmTeX adds no wrapper
license over them. Their sources are the pinned TeX Live {{TL_RELEASE}} snapshot plus
the patches and scripts in this repository, which satisfies the source-availability
obligations of the GPL-licensed members of that aggregate and preserves the
separate-program boundary for host applications. The complete per-package license
inventory of everything shipped is in `licenses.json` (inside the assets archive)
and enumerated in [`THIRD_PARTY_NOTICES.md`]({{REPO_URL}}/blob/{{TAG}}/THIRD_PARTY_NOTICES.md); the release
gate fails closed if any shipped package lacks a recorded free license.

## What's in the release

Two disjoint bundles (DESIGN.md §5.4):

| Tier | Ships | Loaded | Covers |
| --- | --- | --- | --- |
| **core** | `core.js` + `core.data` + the engine (`busytex.wasm`/`.js`) + `.fmt` formats | **preloaded** | LaTeX + `pdflatex`/`xelatex`, basic docs |
| **academic** | `academic.js` + `academic.data` | **on demand** | scientific-journal + math + CJK working set (incl. `ctex`/`xeCJK`, `fandol` bundled) |

## Archives

| Archive | Size (gz) | Contents | sha256 |
| --- | --- | --- | --- |
| `wasmtex-assets-{{VERSION}}.tar.gz` | {{ASSETS_GZ}} | the full asset set — engine + both bundles + `.fmt` + `manifest.json` + `assets.json` + `licenses.json` + `SHA256SUMS` | `{{ASSETS_SHA256}}` |
| `wasmtex-bundle-core-{{VERSION}}.tar.gz` | {{BUNDLE_CORE_GZ}} | `core.js` + `core.data` | `{{BUNDLE_CORE_SHA256}}` |
| `wasmtex-bundle-academic-{{VERSION}}.tar.gz` | {{BUNDLE_ACADEMIC_GZ}} | `academic.js` + `academic.data` | `{{BUNDLE_ACADEMIC_SHA256}}` |

Each archive is deterministic (sorted entries, `SOURCE_DATE_EPOCH` mtime, canonical
gzip) and verified byte-for-byte against `manifest.json` at pack time.

## How to use the assets

The npm package ships **JS only** (no engine/bundles, by design — DESIGN.md §4). A
consumer hosts the assets and points the package at them:

1. **Host the assets.** Extract `wasmtex-assets-{{VERSION}}.tar.gz` onto static
   hosting (a CDN, an origin, or bundled with your app). It contains everything the
   runtime fetches. To split load, host `core.*` from the assets archive (or the
   `wasmtex-bundle-core` archive) on the preload path and fetch `academic.*` on
   demand.
2. **Point the runtime at them** via `assetsBaseUrl` and preload only what you need:

   ```js
   import { createTypesetter } from 'wasmtex';
   const tex = await createTypesetter({
     assetsBaseUrl: 'https://your-cdn.example/wasmtex/{{VERSION}}/',
     preload: ['core'],
     onDemand: ['academic'],   // mounted the first time a doc needs it
   });
   ```

3. **Verify integrity** (recommended). The host can check the fetched
   `manifest.json` against the archive, or extract the assets archive and run
   `shasum -a 256 -c SHA256SUMS`. Every asset's `bytes` + `sha256` are in
   `manifest.json`.

The full embedding profile — hosted-assets split, custom asset scheme, cold-start,
host-side integrity verification, the no-network-after-load contract — is in
[`docs/embedding.md`]({{REPO_URL}}/blob/{{TAG}}/docs/embedding.md).

## Breaking changes

<!-- Per-release. Seeded with the 0.1.0 change; edit each release. -->

- **`texlive-basic` bundle removed** (was an alias of `core` in `0.0.1`). Consumers
  that named `texlive-basic` must switch to `preload: ['core']` (plus
  `onDemand: ['academic']` if they need the academic set). This is a
  name-reservation break, acceptable pre-1.0. The tier-alias mechanism itself is
  retained for custom inventories; only the shipped `texlive-basic` alias is gone.

## Verifying this release

- `manifest.json` (in the assets archive) records every asset's `bytes` + `sha256`,
  the engine set, the per-bundle package index, and the TeX Live snapshot id.
- The archive sha256s above are reproduced by
  `node build/release/pack.mjs --version {{VERSION}} --json` against the
  container-built `dist/`.
