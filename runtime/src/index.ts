// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Public entry point for the `wasmtex` package. DESIGN.md §5 is the API
// contract this module implements. It re-exports the item-7 CLIENT surface —
// `createTypesetter` and the `Typesetter` / `Job` job objects (DESIGN.md §5.1) —
// plus the error taxonomy, and the item-3 protocol TYPES (`EngineName`, the
// payload/result shapes) that hosts type against. The validators/guards
// (`parseWorkerMessage`, `isForJob`, `transferablesOf`, `newJobId`) stay
// internal to the package: `runtime/worker` and `./client` import them directly
// from `./protocol`, so they are not part of the published value surface.

/**
 * Semantic version of the `wasmtex` package.
 *
 * Kept in lockstep with the `version` field of `package.json` — the invariant
 * is enforced by `test/index.test.ts`. Exposed as a plain constant (rather than
 * a runtime read of `package.json`) so the value survives bundling and needs no
 * filesystem or JSON-import support in the consumer.
 */
export const version = '0.0.1';

// Protocol version is a value; re-exported explicitly (a `export type *` would
// not carry it).
export { PROTOCOL_VERSION } from './protocol';

// The protocol TYPE surface — `EngineName`, the client/worker envelopes, and
// their payload types (`Diagnostic`, `CompileStats`, `AssetEntry`, …) — is the
// public subset hosts type against. `export type *` re-exports exactly
// protocol.ts's exported types (its value exports, the guards, are excluded).
export type * from './protocol';

// The §5.1 client: the value surface (createTypesetter + the error taxonomy +
// the debug accessor) and its API types. This is what a host actually imports.
export {
  createTypesetter,
  typesetterDiagnostics,
  CancelledError,
  WorkerCrashedError,
  FatalError,
  TypesetInputError,
} from './client';
export type {
  Typesetter,
  Job,
  TypesetJob,
  TypesetResult,
  CreateTypesetterOptions,
  AssetProgress,
  CancelReason,
  TypesetterDiagnostics,
  WorkerLike,
  WorkerFactory,
  FetchLike,
  FetchResponseLike,
} from './client';
