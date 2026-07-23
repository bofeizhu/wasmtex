// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Mirrors the MODULARIZE + callMain
//   loading approach of build/artifacts/verify-engine.mjs (createRequire), plus
//   the file_packager data-package injection reverse-engineered from the (MIT)
//   busytex build's own loader contract — behavioural reference only.
//
// ---------------------------------------------------------------------------
// Node-only loader for EmscriptenEngineHost. This is deliberately NOT part of
// the worker bundle: it uses `node:module` / `node:fs`, which the shipped
// classic-worker IIFE must never carry. The browser worker uses
// `createWorkerModuleLoader` (importScripts) instead; this file lets the Node
// consumers (the integration test AND the conformance runner, both via
// `harness.ts`) drive the SAME real host offline from dist/.
//
// Loading the engine under Node:
//   * factory:      createRequire(...)(busytex.js) — the CJS MODULARIZE export.
//   * data package: the file_packager script reads a GLOBAL `BusytexPipeline`
//     carrier, calls `require('fs')` for its `.data`, and (in a browser/worker)
//     probes IndexedDB. Under Node it would throw at the IDB guard (no window/
//     location). We run it inside a scoped `Function` with `location`/`self`
//     injected so the IDB probe takes the worker branch and fails GRACEFULLY to
//     the Node `fs` read (the file_packager's own `preloadFallback`), and pass a
//     filtered `console` so that expected fallback chatter stays out of test
//     output. Nothing here is reachable from production/browser code.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mountViaRunDependencies } from '../worker/engine-host';
import type {
  BusytexFactory,
  EngineModule,
  EngineModuleLoader,
} from '../worker/engine-host';

const require = createRequire(import.meta.url);

/**
 * A console that swallows the file_packager's expected Node IDB-fallback
 * chatter. Under Node there is no IndexedDB, so its `openDatabase` probe throws
 * (`indexedDB.open` on `undefined`) and its `preloadFallback` logs both the
 * caught error and a "falling back…" notice before reading the `.data` from fs.
 * All of that is expected and cosmetic; the read still succeeds.
 */
function quietConsole(): Console {
  const shim: Console = Object.create(console) as Console;
  const benign = [
    'falling back to default preload',
    "reading 'open'", // indexedDB.open on undefined, under Node
    'using indexeddb to cache data',
  ];
  shim.error = (...args: unknown[]): void => {
    const first = args[0];
    const text = (first instanceof Error ? first.message : String(first)).toLowerCase();
    if (/indexeddb/i.test(text) || benign.some((b) => text.includes(b))) return;
    console.error(...args);
  };
  return shim;
}

/**
 * Build a Node {@link EngineModuleLoader}. `locations` are absolute filesystem
 * paths (the host joins `assets.baseUrl` — set to the dist dir by the Node
 * consumers — with each inventory path), so `require`/`readFileSync` resolve
 * them directly regardless of where this bundle is loaded from.
 */
export function createNodeModuleLoader(): EngineModuleLoader {
  return {
    async loadFactory(engineJsLocation: string): Promise<BusytexFactory> {
      const factory = require(engineJsLocation) as unknown;
      if (typeof factory !== 'function') {
        throw new Error(`engine JS at ${engineJsLocation} is not a MODULARIZE factory`);
      }
      return factory as BusytexFactory;
    },
    installDataPackage(module: EngineModule, dataPackageLocation: string): void {
      evalDataPackage(module, dataPackageLocation);
    },
    mountDataPackage(module: EngineModule, dataPackageLocation: string): Promise<void> {
      // POST-INIT: the same scoped eval, but `Module.calledRun` is now true, so
      // the file_packager's `if (Module['calledRun']) runWithFS()` branch mounts
      // into the live FS. `runWithFS` reads the `.data` via async `fs.readFile`,
      // so the mount completes on a later tick; resolve when it is FS-visible.
      return mountViaRunDependencies(module, () => evalDataPackage(module, dataPackageLocation));
    },
  };
}

/**
 * Execute a file_packager data-package script under Node with the carrier +
 * Node-safe stand-ins for the browser globals it probes. `location`/`self` (any
 * objects) steer its IndexedDB check onto the graceful-fallback path;
 * `require`/`process` drive its Node `.data` read. Shared by both the pre-init
 * (preRun) install and the post-init mount — the script self-selects via
 * `Module.calledRun`.
 */
function evalDataPackage(module: EngineModule, dataPackageLocation: string): void {
  const source = readFileSync(dataPackageLocation, 'utf8');
  const run = new Function(
    'BusytexPipeline',
    'require',
    'process',
    'location',
    'self',
    'console',
    source,
  );
  run(module, require, process, {}, {}, quietConsole());
}
