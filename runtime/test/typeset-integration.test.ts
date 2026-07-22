// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// The typeset-path integration test (M1 acceptance; M0 gap #2). It drives the
// REAL EngineHost — the actual busytex wasm + the 79 MB texlive-basic bundle —
// under Node via the test-only node loader, compiling hello-world through the
// full xetex → xdvipdfmx sequence and asserting a valid %PDF- result. This is
// the node-driven cousin of the Playwright demo smoke (DESIGN.md §8; runtime
// README "Test philosophy"): it exercises core.ts + engine-host.ts end to end
// against wasm, not a fake.
//
// It SKIPS cleanly when dist/ is absent (CI runs the runtime tests without
// built artifacts), exactly like test/assets.test.ts. Wall-time target < 60 s
// (a single instance loads + compiles in ~1.2 s locally).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  newJobId,
  type AssetsConfig,
  type AssetsInventory,
  type WorkerMessage,
} from '../src/protocol';
import { createWorkerCore } from '../worker/core';
import { EmscriptenEngineHost } from '../worker/engine-host';
import { createNodeModuleLoader } from './support/node-engine-loader';

// dist/ lives at the repo root; this file is runtime/test/, two levels down.
const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
const REQUIRED = [
  'assets.json',
  'busytex.js',
  'busytex.wasm',
  'texlive-basic.js',
  'texlive-basic.data',
];
const present = REQUIRED.every((f) => existsSync(distDir + f));

if (!present) {
  console.warn(
    `[typeset-integration] dist/ artifacts not all present under ${distDir}; ` +
      'skipping the real-wasm typeset test. Run `make artifacts STAGE=dist` to ' +
      'produce them. CI runs the runtime tests without dist/, so this skip is expected there.',
  );
}

const HELLO = '\\documentclass[11pt]{article}\n\\begin{document}\nHello, WasmTeX!\n\\end{document}\n';

/** Build the init AssetsConfig from the real generated inventory, base = dist dir. */
function assetsFromDist(): AssetsConfig {
  const inventory = JSON.parse(readFileSync(distDir + 'assets.json', 'utf8')) as AssetsInventory;
  return {
    baseUrl: distDir,
    inventory,
    bundles: { preload: ['texlive-basic'], onDemand: [] },
  };
}

describe('typeset integration (real wasm engine, node)', () => {
  it.runIf(present)(
    'compiles hello-world through xetex → xdvipdfmx to a valid PDF',
    async () => {
      const startedAt = Date.now();
      const messages: WorkerMessage[] = [];
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      const core = createWorkerCore({ host, post: (m) => messages.push(m) });

      // init
      await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: assetsFromDist() });
      const initMsg = messages.at(-1);
      expect(initMsg?.type).toBe('initialized');

      // compile
      const jobId = newJobId();
      await core.handle({
        type: 'compile',
        v: 1,
        jobId,
        files: { 'hello.tex': HELLO },
        entry: 'hello.tex',
        engine: 'xetex',
        passes: 'auto',
        bibliography: 'off',
        index: 'off',
        synctex: false,
      });

      const forJob = messages.filter((m) => m.jobId === jobId);
      // Coarse progress for both applet phases was announced.
      const phases = forJob
        .filter((m) => m.type === 'progress')
        .map((m) => (m.type === 'progress' ? m.phase.kind : ''));
      expect(phases).toEqual(['engine', 'xdvipdfmx']);

      const result = forJob.at(-1);
      expect(result?.type).toBe('result');
      if (result?.type !== 'result') throw new Error('no result message');

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.pdf).toBeInstanceOf(Uint8Array);
      expect(result.log.length).toBeGreaterThan(0);
      expect(result.stats.passes).toBe(1);
      expect(result.stats.bundlesLoaded).toEqual(['texlive-basic']);

      const pdf = result.pdf!;
      expect(pdf.length).toBeGreaterThan(1000);
      // %PDF- magic and a %%EOF trailer — a structurally real PDF, not a stub.
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
      const tail = new TextDecoder().decode(pdf.slice(-1024));
      expect(tail).toContain('%%EOF');

      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[typeset-integration] xetex→xdvipdfmx hello-world: pdf ${pdf.length} B, ` +
          `wall ${elapsedMs} ms`,
      );
      expect(elapsedMs).toBeLessThan(60_000);
    },
    120_000,
  );

  it.runIf(present)(
    'multiple jobs on one host: a failing compile surfaces the TeX error; logs stay isolated',
    async () => {
      const messages: WorkerMessage[] = [];
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      const core = createWorkerCore({ host, post: (m) => messages.push(m) });
      // A successful init also enforces the zero-past-header memory invariant
      // against the REAL wasm (engine-host load() scans HEAP32 past the 64 MiB
      // header). A rebase whose static segment outgrows MEM_HEADER_SIZE throws
      // there → this test fails loud, which is the point.
      await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: assetsFromDist() });

      const compileJob = async (name: string, body: string) => {
        const jobId = newJobId();
        await core.handle({
          type: 'compile',
          v: 1,
          jobId,
          files: { [`${name}.tex`]: body },
          entry: `${name}.tex`,
          engine: 'xetex',
          passes: 'auto',
          bibliography: 'off',
          index: 'off',
          synctex: false,
        });
        const result = messages.filter((m) => m.jobId === jobId).at(-1);
        if (result?.type !== 'result') throw new Error(`no result message for ${name}`);
        return result;
      };
      const good = (n: string) => `\\documentclass{article}\n\\begin{document}\n${n}\n\\end{document}\n`;
      const bad = '\\documentclass{article}\n\\begin{document}\n\\undefinedcmd\n\\end{document}\n';

      const alpha = await compileJob('alpha', good('alpha'));
      expect(alpha.ok).toBe(true);

      // #1: a failing compile carries the TeX error text in result.log
      // (nonstopmode; batchmode would leave only the banner).
      const broken = await compileJob('broken', bad);
      expect(broken.ok).toBe(false);
      expect(broken.exitCode).toBe(1);
      expect(broken.pdf).toBeUndefined();
      expect(broken.log).toContain('Undefined control sequence');
      expect(broken.log).not.toContain('alpha'); // job 1 did not leak into job 2

      // The host recovers after a failing job (memory reset after every callMain).
      const bravo = await compileJob('bravo', good('bravo'));
      expect(bravo.ok).toBe(true);

      // #2: no earlier job's transcript leaks into a later one (the flush_streams
      // fix — a dangling partial line would otherwise surface under this jobId).
      expect(bravo.log).not.toContain('alpha');
      expect(bravo.log).not.toContain('broken');
    },
    120_000,
  );

  it.runIf(present)('rejects luatex with a fatal (real host loaded)', async () => {
    const messages: WorkerMessage[] = [];
    const host = new EmscriptenEngineHost(createNodeModuleLoader());
    const core = createWorkerCore({ host, post: (m) => messages.push(m) });

    await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: assetsFromDist() });
    const jobId = newJobId();
    await core.handle({
      type: 'compile',
      v: 1,
      jobId,
      files: { 'hello.tex': HELLO },
      entry: 'hello.tex',
      engine: 'luatex',
      passes: 'auto',
      bibliography: 'off',
      index: 'off',
      synctex: false,
    });

    const fatal = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') expect(fatal.code).toBe('unsupported-engine');
  }, 120_000);
});
