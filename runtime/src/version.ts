// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// The package's version constants, in one leaf module so both the public entry
// (`./index`) and the client (`./client`, which soft-verifies the asset manifest)
// read the SAME value without an import cycle (index → client → version, version
// imports nothing). DESIGN.md §4 binds the npm version and the asset archives in
// LOCKSTEP from the first real `assets-vX.Y.Z` release onward.

/**
 * Semantic version of the `wasmtex` package.
 *
 * Kept in lockstep with the `version` field of `package.json` — the invariant is
 * enforced by `test/index.test.ts`. Exposed as a plain constant (rather than a
 * runtime read of `package.json`) so the value survives bundling and needs no
 * filesystem or JSON-import support in the consumer.
 */
export const version = '0.0.1';

/**
 * The version of the WasmTeX **asset archives** (`wasmtex-assets-<v>.tar.gz`,
 * GitHub tag `assets-v<v>`) this build is meant to run against.
 *
 * Equal to {@link version} by construction: DESIGN.md §4 binds the npm package and
 * the assets in LOCKSTEP, so the single source of truth is `package.json`'s
 * version, and `build/manifest/gen-assets.mjs` stamps the SAME value into the
 * shipped `manifest.json` as its top-level `version` field. `createTypesetter`
 * soft-verifies the fetched manifest's `version` against this constant so a
 * mismatched pairing fails clearly at boot instead of as a confusing mid-compile
 * error (overridable via `expectAssetsVersion`). A host discovers the assets to
 * host by reading this value and fetching the matching `assets-v<ASSETS_VERSION>`
 * archive.
 */
export const ASSETS_VERSION = version;
