#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. This is a small headless node
//   harness for the M0 item-5N EXECUTION GATE; it is NOT part of the shipped
//   runtime (M1 provides the real worker/pipeline). It only knows the vendored
//   busytex engine's public emscripten surface (MODULARIZE factory + callMain),
//   learned from the engine's own build flags (Makefile OPTS_BUSYTEX_LINK_wasm).
//
// WHY THIS EXISTS
// ---------------
// The first 5N run shipped a busytex.wasm that passed WebAssembly.validate and a
// size check yet was FUNCTIONALLY HOLLOW: on macOS the non-libtool dependency
// libraries (harfbuzz, libpng, zlib, graphite2, teckit, xpdf, libpaper, zziplib)
// archived EMPTY (BSD `ar` drops non-Mach-O wasm objects), and the final link's
// -Wl,--unresolved-symbols=ignore-all stubbed all 363 now-missing `env` imports
// to abort(-1). The engine aborted at _png_get_header_ver the first time it was
// ever executed (the 6N demo). This gate makes such a binary fail the BUILD, not
// a downstream demo, by actually running the engine.
//
// TWO CHECKS (either failing exits non-zero -> `set -e` in build-native.sh aborts):
//   1. env-import sanity: a soundly-linked engine imports a few dozen legitimate
//      emscripten JS helpers; the hollow one imported 363. Cheap; catches this
//      exact regression class directly.
//   2. real execution: `xetex --version` runs to exit 0 and prints the expected
//      TeX Live 2023 banner.
//
// Usage:  node verify-engine.mjs [distDir]      (distDir defaults to ./dist)

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

const require = createRequire(import.meta.url);

// --- knobs -------------------------------------------------------------------
// Ceiling for legitimate `env` imports in a soundly-linked engine. A healthy
// build imports a few dozen emscripten runtime helpers (syscalls, invoke_*
// trampolines, emscripten_* helpers); the empty-archive defect produced 363.
// This sits well above a healthy build and well below the defect so it cannot
// pass a hollow binary. (Measured healthy count is logged on every run.)
const MAX_ENV_IMPORTS = 150;
const APPLET = 'xetex';
const EXPECT_VERSION = 'TeX Live 2023';

const distDir = resolve(process.argv[2] || 'dist');
const wasmPath = join(distDir, 'busytex.wasm');
const jsPath = join(distDir, 'busytex.js');

function fail(msg) {
  console.error(`\n!! [verify] FAIL: ${msg}`);
  process.exit(1);
}
function pass(msg) {
  console.log(`   [verify] ok: ${msg}`);
}

// --- preflight ---------------------------------------------------------------
for (const p of [wasmPath, jsPath]) {
  if (!existsSync(p)) fail(`missing artifact: ${p} (run the dist stage first)`);
}
console.log(`   [verify] dist: ${distDir}`);

// --- check 1: env-import sanity (cheap; catches the empty-archive class) ------
const wasmBytes = readFileSync(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes).catch((e) =>
  fail(`busytex.wasm did not compile: ${e && e.message ? e.message : e}`),
);
const allImports = WebAssembly.Module.imports(wasmModule);
const envImports = allImports.filter((i) => i.module === 'env');
console.log(
  `   [verify] wasm imports: ${allImports.length} total, ${envImports.length} from "env" (ceiling ${MAX_ENV_IMPORTS})`,
);
if (envImports.length > MAX_ENV_IMPORTS) {
  const sample = envImports
    .slice(0, 24)
    .map((i) => i.name)
    .join(', ');
  fail(
    `env-import count ${envImports.length} exceeds ceiling ${MAX_ENV_IMPORTS}.\n` +
      `   This is the hollow-archive signature: unresolved dependency symbols were\n` +
      `   stubbed to abort(-1). The dependency libraries linked EMPTY. Sample:\n` +
      `   ${sample} ...`,
  );
}
pass(`env-import count ${envImports.length} within sane range (not the hollow-archive 363)`);

// --- check 2: actually run `xetex --version` ---------------------------------
// The engine is built -sMODULARIZE=1 -sEXPORT_NAME=busytex -sINVOKE_RUN=0
// -sEXIT_RUNTIME=0, exporting callMain. It has no ENVIRONMENT restriction, so it
// runs under node. busytex is a multicall binary: callMain(['xetex','--version'])
// -> argv[1]='xetex' -> busymain_xetex(['--version']) (see busytex.c).
const factory = require(jsPath); // MODULARIZE=1 => module.exports = factory(Module)->Promise

let out = '';
const capture = (s) => {
  out += s + '\n';
};

let moduleInstance;
try {
  moduleInstance = await factory({
    noInitialRun: true, // INVOKE_RUN=0 already; be explicit
    print: capture,
    printErr: capture,
    // Resolve busytex.wasm next to busytex.js regardless of cwd.
    locateFile: (p) => join(distDir, p),
  });
} catch (e) {
  fail(`engine module failed to instantiate: ${e && e.stack ? e.stack : e}\ncaptured output:\n${out}`);
}

// callMain catches the engine's exit() internally and returns the exit code
// (handleException -> EXITSTATUS). Guard against any path that re-throws.
let exitCode = null;
try {
  exitCode = moduleInstance.callMain([APPLET, '--version']);
} catch (e) {
  if (e && (e.name === 'ExitStatus' || typeof e.status === 'number')) {
    exitCode = e.status;
  } else {
    fail(
      `callMain(['${APPLET}','--version']) threw: ${e && e.stack ? e.stack : e}\n` +
        `captured output:\n${out}`,
    );
  }
}
if (exitCode === null || exitCode === undefined) exitCode = 0; // main returned normally, no exit()

// Echo the engine's own output, indented, for the build log.
process.stdout.write(
  out
    .split('\n')
    .map((l) => `       | ${l}`)
    .join('\n') + '\n',
);

if (exitCode !== 0) {
  fail(`${APPLET} --version exited ${exitCode} (want 0)\noutput:\n${out}`);
}
pass(`${APPLET} --version exit 0`);

if (!out.includes(EXPECT_VERSION)) {
  fail(`${APPLET} --version output does not contain "${EXPECT_VERSION}"\noutput:\n${out}`);
}
pass(`${APPLET} --version reports "${EXPECT_VERSION}"`);

console.log('\n== [verify] EXECUTION GATE PASSED ==');
