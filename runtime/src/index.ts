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

// The package version + the lockstep asset-archive version (DESIGN.md §4). Both
// live in the leaf `./version` module so the client can read `ASSETS_VERSION`
// without an import cycle; re-exported here as the public value surface. `version`
// is kept in lockstep with package.json (enforced by test/index.test.ts).
export { version, ASSETS_VERSION } from './version.js';

// Protocol version is a value; re-exported explicitly (a `export type *` would
// not carry it).
export { PROTOCOL_VERSION } from './protocol.js';

// The protocol TYPE surface — `EngineName`, the client/worker envelopes, and
// their payload types (`Diagnostic`, `CompileStats`, `AssetEntry`, …) — is the
// public subset hosts type against. `export type *` re-exports exactly
// protocol.ts's exported types (its value exports, the guards, are excluded).
export type * from './protocol.js';

// The §5.1 client: the value surface (createTypesetter + the error taxonomy +
// the debug accessor) and its API types. This is what a host actually imports.
export {
  createTypesetter,
  typesetterDiagnostics,
  CancelledError,
  WorkerCrashedError,
  FatalError,
  TypesetInputError,
  AssetVersionMismatchError,
} from './client.js';
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
} from './client.js';
