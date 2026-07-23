// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ---------------------------------------------------------------------------
// The Node harness: the single entry Node consumers import to drive the PUBLIC
// `wasmtex` runtime over the real busytex wasm, in-process, without a Web
// Worker. It pairs the public `createTypesetter` (§5.1) with a Node
// `WorkerFactory` built from the in-process adapter + the Node engine loader +
// the real `EmscriptenEngineHost`.
//
// TWO consumers, ONE definition (no duplication):
//   * `runtime/test/typeset-integration.test.ts` imports `createNodeWorkerFactory`
//     from HERE (source; vitest/esbuild resolves the extensionless imports).
//   * `conformance/run.mjs` imports the esbuild-BUNDLED form of this module,
//     `runtime/dist/node-harness.mjs` (built dist; a single self-contained ESM
//     file, since the compiled `runtime/dist/**` is bundler-targeted and not
//     Node-native — see runtime/tsconfig.json). The bundle is the Node-delivery
//     twin of `dist/worker.js` (the browser IIFE): same source, different
//     target. The 27 MB `busytex.js` / 52 MB `.data` are loaded at RUNTIME by
//     the Node loader (createRequire/readFileSync on absolute paths), NOT
//     bundled.
//
// This module is Node-only (its dependency graph reaches `node:fs`/`node:module`
// via the loader) and is NEVER imported by `src/` or `worker/`, so the browser
// worker bundle stays free of Node builtins.
// ---------------------------------------------------------------------------

import type { WorkerFactory } from '../src/client';
import { EmscriptenEngineHost } from '../worker/engine-host';
import { createNodeModuleLoader } from './node-engine-loader';
import { InProcessWorker } from './in-process-worker';

// Re-export the PUBLIC entry point so a Node consumer gets `createTypesetter`
// (and the package version) from the same import as the factory — the API
// surface exercised is byte-for-byte the one the browser demo drives; only the
// worker adapter differs (in-process Node vs. a real Web Worker).
export { createTypesetter, version } from '../src/index';

/**
 * A {@link WorkerFactory} that spawns an {@link InProcessWorker} wrapping a fresh
 * real {@link EmscriptenEngineHost} (loaded by the Node engine loader). Each
 * spawn is a new wasm instance — exactly what a real `Worker.terminate()` +
 * respawn maps to, so the client's cancel/re-init contract holds.
 */
export function createNodeWorkerFactory(): WorkerFactory {
  return () => new InProcessWorker(new EmscriptenEngineHost(createNodeModuleLoader()));
}

export { InProcessWorker } from './in-process-worker';
export { createNodeModuleLoader } from './node-engine-loader';
