// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Public entry point for the `wasmtex` package. DESIGN.md §5 is the API
// contract this module implements; M1 items 3–7 grow it into
// `createTypesetter` / `Typesetter` / job objects over the correlated worker
// protocol. Today it re-exports the item-3 protocol surface — `PROTOCOL_VERSION`
// and the wire/API TYPES (envelopes, payloads, `EngineName`) — so hosts and the
// forthcoming client can type against the protocol. The validators/guards
// (`parseWorkerMessage`, `isForJob`, `transferablesOf`, `newJobId`) stay
// internal to the package: `runtime/worker` and the client import them directly
// from `./protocol`, so they are not part of the published value surface yet.

/**
 * Semantic version of the `wasmtex` package.
 *
 * Kept in lockstep with the `version` field of `package.json` — the invariant
 * is enforced by `test/index.test.ts`. Exposed as a plain constant (rather than
 * a runtime read of `package.json`) so the value survives bundling and needs no
 * filesystem or JSON-import support in the consumer.
 */
export const version = '0.0.0';

// Protocol version is a value; re-exported explicitly (a `export type *` would
// not carry it).
export { PROTOCOL_VERSION } from './protocol';

// The protocol TYPE surface — `EngineName`, the client/worker envelopes, and
// their payload types — is the public subset hosts type against. `export type *`
// re-exports exactly protocol.ts's exported types (its value exports, the
// guards, are intentionally excluded).
export type * from './protocol';
