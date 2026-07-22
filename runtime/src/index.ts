// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Public entry point for the `wasmtex` package. DESIGN.md §5 is the API
// contract this module implements; M1 items 3–7 grow it into
// `createTypesetter` / `Typesetter` / job objects over the correlated worker
// protocol. For the M1 item-2 scaffold it exports only the package version and
// the engine-name union, so the surface is honest, type-checked, and tested
// without pulling in the worker or wasm.

/**
 * Semantic version of the `wasmtex` package.
 *
 * Kept in lockstep with the `version` field of `package.json` — the invariant
 * is enforced by `test/index.test.ts`. Exposed as a plain constant (rather than
 * a runtime read of `package.json`) so the value survives bundling and needs no
 * filesystem or JSON-import support in the consumer.
 */
export const version = '0.0.0';

/**
 * Engines selectable via `typeset({ engine })` (DESIGN.md §5.1).
 *
 * - `xetex` — primary engine, fully supported end to end in v1 (engine pass →
 *   `xdvipdfmx` → PDF).
 * - `pdftex` — exposed in v1 only if it costs nothing beyond driver/format
 *   selection (DESIGN.md §9; `docs/plans/M1.md`).
 * - `luatex` — **reserved**. The enum member exists so the public surface is
 *   stable, but LuaTeX is unimplemented in v1: a job requesting it is rejected
 *   with a clear error. Its presence here is not a claim of support.
 */
export type EngineName = 'xetex' | 'pdftex' | 'luatex';
