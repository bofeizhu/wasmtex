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
import {
  createTypesetter,
  typesetterDiagnostics,
  CancelledError,
  type AssetProgress,
  type WorkerFactory,
} from '../src/index';
import { createWorkerCore, type EngineLogSink } from '../worker/core';
import { EmscriptenEngineHost } from '../worker/engine-host';
import { createNodeModuleLoader, createNodeWorkerFactory } from '../node/harness';

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

  // The §5.3 rerun loop end to end (item 6): a \tableofcontents + forward
  // \ref/\pageref document is unresolved on pass 1 (undefined refs, TOC not yet
  // written) and resolves on pass 2. The machine must detect the pass-1 rerun
  // markers and run exactly a second engine pass, then finalize.
  it.runIf(present)(
    'reruns a \\label/\\ref document a second time until cross-references resolve',
    async () => {
      const messages: WorkerMessage[] = [];
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      const core = createWorkerCore({ host, post: (m) => messages.push(m) });
      await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: assetsFromDist() });

      const CROSSREF =
        '\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n' +
        '\\section{First}\\label{sec:first}\n' +
        'See section~\\ref{sec:second} on page~\\pageref{sec:second}.\n' +
        '\\newpage\n\\section{Second}\\label{sec:second}\nBack to~\\ref{sec:first}.\n\\end{document}\n';
      const jobId = newJobId();
      await core.handle({
        type: 'compile',
        v: 1,
        jobId,
        files: { 'main.tex': CROSSREF },
        entry: 'main.tex',
        engine: 'xetex',
        passes: 'auto',
        bibliography: 'off',
        index: 'off',
        synctex: false,
      });

      const forJob = messages.filter((m) => m.jobId === jobId);
      const phases = forJob
        .filter((m) => m.type === 'progress')
        .map((m) => (m.type === 'progress' ? m.phase.kind : ''));
      // TWO engine passes, then the driver — the machine reran once and stopped.
      expect(phases).toEqual(['engine', 'engine', 'xdvipdfmx']);

      const result = forJob.at(-1);
      if (result?.type !== 'result') throw new Error('no result message');
      expect(result.ok).toBe(true);
      expect(result.stats.passes).toBe(2);
      expect(result.pdf).toBeInstanceOf(Uint8Array);

      // Started unresolved (pass 1 warned) and converged (the final pass — the
      // text after the last engine banner — carries no undefined-reference line).
      expect(result.log).toContain('There were undefined references');
      const lastPass = result.log.slice(result.log.lastIndexOf('This is XeTeX'));
      expect(lastPass).not.toContain('There were undefined references');

      const pdf = result.pdf!;
      expect(pdf.length).toBeGreaterThan(1000);
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
      console.log(`[typeset-integration] crossref rerun: ${result.stats.passes} passes, pdf ${pdf.length} B`);
    },
    120_000,
  );

  // bibtex8 end to end (item 6). The texlive-basic bundle carries plain.bst
  // (verified: build/… bundle inventory), so a \bibliographystyle{plain} +
  // \bibliography document compiles fully: xelatex → bibtex8 (on the .aux) →
  // reruns to incorporate the .bbl and resolve citations → xdvipdfmx.
  it.runIf(present)(
    'compiles a bibtex8 document end to end (xelatex → bibtex8 → reruns → xdvipdfmx)',
    async () => {
      const messages: WorkerMessage[] = [];
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      const core = createWorkerCore({ host, post: (m) => messages.push(m) });
      await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: assetsFromDist() });

      const MAIN =
        '\\documentclass{article}\n\\begin{document}\n' +
        'Text citing~\\cite{knuth1984} and~\\cite{lamport1994}.\n' +
        '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
      const BIB =
        '@book{knuth1984, author = {Donald E. Knuth}, title = {The {\\TeX}book}, ' +
        'publisher = {Addison-Wesley}, year = {1984}}\n' +
        '@book{lamport1994, author = {Leslie Lamport}, title = {{\\LaTeX}: A Document ' +
        'Preparation System}, publisher = {Addison-Wesley}, year = {1994}}\n';
      const jobId = newJobId();
      await core.handle({
        type: 'compile',
        v: 1,
        jobId,
        files: { 'main.tex': MAIN, 'refs.bib': BIB },
        entry: 'main.tex',
        engine: 'xetex',
        passes: 'auto',
        bibliography: 'auto',
        index: 'off',
        synctex: false,
      });

      const forJob = messages.filter((m) => m.jobId === jobId);
      const phases = forJob
        .filter((m) => m.type === 'progress')
        .map((m) => (m.type === 'progress' ? m.phase.kind : ''));
      // pass 1 → bibtex8 → pass 2 (incorporate .bbl) → pass 3 (resolve) → driver.
      expect(phases).toEqual(['engine', 'bibtex8', 'engine', 'engine', 'xdvipdfmx']);

      const result = forJob.at(-1);
      if (result?.type !== 'result') throw new Error('no result message');
      expect(result.ok).toBe(true);
      expect(result.stats.passes).toBe(3);
      expect(result.pdf).toBeInstanceOf(Uint8Array);

      // bibtex8 resolved the citations: the citations were undefined earlier
      // (the .bbl did not exist yet) but the final pass has no undefined line.
      expect(result.log).toContain('There were undefined references');
      const lastPass = result.log.slice(result.log.lastIndexOf('This is XeTeX'));
      expect(lastPass).not.toContain('There were undefined references');
      // bibtex8 itself ran and found the style + database (its own transcript).
      expect(result.log).toContain('The style file: plain.bst');

      const pdf = result.pdf!;
      expect(pdf.length).toBeGreaterThan(1000);
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
      const tail = new TextDecoder().decode(pdf.slice(-1024));
      expect(tail).toContain('%%EOF');
      console.log(`[typeset-integration] bibtex8 e2e: ${result.stats.passes} passes, pdf ${pdf.length} B`);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Full-stack PUBLIC API (M1 item 7): client + in-process worker-core adapter +
// REAL engine host. This drives the actual §5.1 surface — createTypesetter /
// typeset() / job.done / cancel() / dispose() — over the real busytex wasm, so
// the whole stack (client correlation/serialization → core → sequencing →
// engine-host → wasm) is exercised end to end, not a fake. Skips when dist/ is
// absent, like the tests above.
// ---------------------------------------------------------------------------

/**
 * A fresh in-process worker each call → a fresh EngineHost + wasm instance (what
 * terminate() maps to). Delegates to the shared node-harness factory — the SAME
 * definition the conformance runner (`conformance/run.mjs`, via the bundled
 * `dist/node-harness.mjs`) drives, so there is one in-process/Node-loader path.
 */
function inProcessFactory(): WorkerFactory {
  return createNodeWorkerFactory();
}

describe('public API over real wasm (createTypesetter, in-process adapter, node)', () => {
  it.runIf(present)(
    'compiles hello-world through the PUBLIC createTypesetter API to a valid PDF',
    async () => {
      const startedAt = Date.now();
      const config = assetsFromDist();
      const tex = await createTypesetter({
        assetsBaseUrl: config.baseUrl,
        bundles: config.bundles,
        inventory: config.inventory,
        workerFactory: inProcessFactory(),
      });

      const logLines: string[] = [];
      const jobHandle = tex.typeset({ engine: 'xetex', entry: 'hello.tex', files: { 'hello.tex': HELLO } });
      jobHandle.onLog((line) => logLines.push(line));
      const result = await jobHandle.done;

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stats.passes).toBe(1);
      expect(result.stats.bundlesLoaded).toEqual(['texlive-basic']);
      expect(result.diagnostics).toEqual([]); // item 8: a clean compile parses to zero diagnostics
      expect(logLines.length).toBeGreaterThan(0); // the transcript streamed through onLog

      const pdf = result.pdf;
      expect(pdf).toBeInstanceOf(Uint8Array);
      if (!(pdf instanceof Uint8Array)) throw new Error('no pdf');
      expect(pdf.length).toBeGreaterThan(1000);
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
      const tail = new TextDecoder().decode(pdf.slice(-1024));
      expect(tail).toContain('%%EOF');

      await tex.dispose();
      const elapsedMs = Date.now() - startedAt;
      console.log(`[typeset-integration] public-API hello-world: pdf ${pdf.length} B, wall ${elapsedMs} ms`);
      expect(elapsedMs).toBeLessThan(60_000);
    },
    120_000,
  );

  it.runIf(present)(
    'public API: cancelling a just-dispatched compile rejects cleanly (terminate before the core receives it — in-process delivery is a microtask), and the next job compiles on a fresh instance',
    async () => {
      const config = assetsFromDist();
      const tex = await createTypesetter({
        assetsBaseUrl: config.baseUrl,
        bundles: config.bundles,
        inventory: config.inventory,
        workerFactory: inProcessFactory(),
      });

      // Start a compile and cancel it while it is the active job. The in-process
      // adapter's terminate() is a permanent DETACH (documented there): it cannot
      // preempt a synchronous callMain, but it discards the detached core's I/O and
      // the client builds a FRESH in-process instance for the next job — so the
      // OBSERVABLE contract (clean rejection + next job clean) holds, exactly as a
      // real Worker.terminate() would give.
      const cancelled = tex.typeset({ engine: 'xetex', entry: 'hello.tex', files: { 'hello.tex': HELLO } });
      cancelled.cancel();
      const err: unknown = await cancelled.done.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CancelledError);
      expect((err as CancelledError).reason).toBe('cancelled');

      // The next job transparently re-initialises on a fresh in-process instance.
      const followUp = tex.typeset({ engine: 'xetex', entry: 'hello.tex', files: { 'hello.tex': HELLO } });
      const result = await followUp.done;
      expect(result.ok).toBe(true);
      const pdf = result.pdf;
      expect(pdf).toBeInstanceOf(Uint8Array);
      if (!(pdf instanceof Uint8Array)) throw new Error('no pdf');
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
      // Two workers spawned proves the transparent reinit actually happened.
      expect(typesetterDiagnostics(tex).workerSpawns).toBe(2);

      await tex.dispose();
      console.log(`[typeset-integration] public-API cancel+reinit: follow-up pdf ${pdf.length} B`);
    },
    120_000,
  );

  // §8 acceptance (iii), M1 plan item 8: a deliberately broken MULTI-FILE
  // document, compiled through the PUBLIC createTypesetter API over the real
  // wasm engine, yields structured diagnostics whose file/line point at the
  // \input'd SUBFILE — not the root — proving the whole stack (worker log →
  // client parseDiagnostics) surfaces §5.1 diagnostics end to end.
  it.runIf(present)(
    'a deliberately broken document yields structured diagnostics with file and line (subfile attribution)',
    async () => {
      const config = assetsFromDist();
      const tex = await createTypesetter({
        assetsBaseUrl: config.baseUrl,
        bundles: config.bundles,
        inventory: config.inventory,
        workerFactory: inProcessFactory(),
      });

      // Error \undefinedsubcmd is on line 4 of the \input'd subfile, not the root.
      const job = tex.typeset({
        engine: 'xetex',
        entry: 'main.tex',
        files: {
          'main.tex':
            '\\documentclass{article}\n\\begin{document}\nIntro in the root file.\n' +
            '\\input{chapters/broken}\nAfter.\n\\end{document}\n',
          'chapters/broken.tex':
            'Some prose in the subfile.\n\nAnother paragraph, then a bad macro:\n' +
            '\\undefinedsubcmd\ntrailing text.\n',
        },
      });
      const result = await job.done;

      // The compile failed (no PDF), and the raw transcript is present.
      expect(result.ok).toBe(false);
      expect(result.pdf).toBeUndefined();
      expect(result.log).toContain('Undefined control sequence');

      // The structured diagnostic: concrete severity / message / file / line,
      // attributed to the SUBFILE (the case naive log scanners get wrong).
      expect(result.diagnostics).toEqual([
        { severity: 'error', message: 'Undefined control sequence.', file: 'chapters/broken.tex', line: 4 },
      ]);

      // Same typesetter (no re-init): a document missing \end{document} fails with
      // ONLY `! Emergency stop.` in the transcript — the promoted-terminator path,
      // proving a failed compile never surfaces an empty diagnostics array (§5.2).
      const noEnd = await tex
        .typeset({
          engine: 'xetex',
          entry: 'main.tex',
          files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nHello, this document has no end.\n' },
        })
        .done;
      expect(noEnd.ok).toBe(false);
      expect(noEnd.log).toContain('! Emergency stop.');
      expect(noEnd.log).not.toContain('Undefined control sequence'); // job 1 did not leak
      expect(noEnd.diagnostics).toEqual([{ severity: 'error', message: 'Emergency stop.' }]);

      await tex.dispose();
      console.log(
        `[typeset-integration] public-API broken-doc diagnostics: ${JSON.stringify(result.diagnostics)}; ` +
          `no-end: ${JSON.stringify(noEnd.diagnostics)}`,
      );
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// On-demand tier mounting over real wasm (M4 item 5). These drive the tiered
// dist (core + academic) — the post-init file_packager mount of a second tier
// into the LIVE engine, and its survival across the per-job memory reset. They
// skip unless BOTH tiers are present (academic is ~496 MB — not always built in
// CI), like the tests above skip without dist/.
// ---------------------------------------------------------------------------

const ON_DEMAND_DEPS = [
  'manifest.json', // the schemaVersion-2 manifest carries the `provides` index the §5.4(a) scan needs
  'busytex.js',
  'busytex.wasm',
  'core.js',
  'core.data',
  'academic.js',
  'academic.data',
];
const onDemandPresent = ON_DEMAND_DEPS.every((f) => existsSync(distDir + f));

if (!onDemandPresent) {
  console.warn(
    `[typeset-integration] tiered dist (core + academic) not all present under ${distDir}; ` +
      'skipping the on-demand mount tests. Build the tiered artifact (make artifacts) to run them.',
  );
}

/**
 * Init AssetsConfig from the real MANIFEST with an explicit tier selection. Reads
 * `manifest.json` (schemaVersion 2), NOT `assets.json` — the §5.4(a) static scan
 * resolves a \usepackage name against the manifest's per-bundle `provides` index,
 * which the v1 `assets.json` alias does not carry. This mirrors what a real host
 * loads (the client prefers manifest.json).
 */
function tieredAssets(preload: string[], onDemand: string[]): AssetsConfig {
  const inventory = JSON.parse(readFileSync(distDir + 'manifest.json', 'utf8')) as AssetsInventory;
  return { baseUrl: distDir, inventory, bundles: { preload, onDemand } };
}

// A doc whose \usepackage{siunitx} is served ONLY by academic (absent from core).
const SIUNITX_DOC =
  '\\documentclass{article}\n\\usepackage{siunitx}\n\\begin{document}\n' +
  'The speed of light is \\SI{299792458}{\\meter\\per\\second}.\n\\end{document}\n';
// A Chinese doc via ctex + the bundled fandol font — both academic-only.
const CJK_DOC = '\\documentclass{ctexart}\n\\begin{document}\n你好，世界。\n\\end{document}\n';
const XELATEX_FMT = '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';

describe('on-demand tier mounting (real wasm, core + academic)', () => {
  it.runIf(onDemandPresent)(
    'a siunitx doc FAILS against core alone (the academic tier is not loaded)',
    async () => {
      const messages: WorkerMessage[] = [];
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      const core = createWorkerCore({ host, post: (m) => messages.push(m) });
      await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: tieredAssets(['core'], []) });
      expect(messages.at(-1)?.type).toBe('initialized');

      const jobId = newJobId();
      await core.handle({
        type: 'compile',
        v: 1,
        jobId,
        files: { 'main.tex': SIUNITX_DOC },
        entry: 'main.tex',
        engine: 'xetex',
        passes: 'auto',
        bibliography: 'off',
        index: 'off',
        synctex: false,
      });

      const result = messages.filter((m) => m.jobId === jobId).at(-1);
      if (result?.type !== 'result') throw new Error('no result message');
      expect(result.ok).toBe(false);
      expect(result.pdf).toBeUndefined();
      // The failure names the missing package/file (kpathsea / LaTeX error).
      expect(/siunitx/i.test(result.log) && /not found|Package|Error|undefined/i.test(result.log)).toBe(true);
      // bundlesLoaded reflects reality: only core is mounted.
      expect(result.stats.bundlesLoaded).toEqual(['core']);
      console.log('[typeset-integration] siunitx-without-academic: ok=false (expected)');
    },
    120_000,
  );

  it.runIf(onDemandPresent)(
    'host.loadBundle mounts academic mid-session: a doc that failed against core alone then compiles, and the tier survives a later job',
    async () => {
      const host = new EmscriptenEngineHost(createNodeModuleLoader());
      // core only — the memory snapshot is taken here, BEFORE academic exists.
      await host.load(tieredAssets(['core'], []));

      const compile = (
        entry: string,
        body: string,
      ): { ok: boolean; code: number; pdf?: Uint8Array | undefined; log: string } => {
        const job = entry.replace(/\.tex$/, '');
        const lines: string[] = [];
        const sink: EngineLogSink = (_stream, line) => lines.push(line);
        const r1 = host.run(
          {
            applet: 'xelatex',
            argv: [
              '--no-shell-escape',
              '--interaction=nonstopmode',
              '--halt-on-error',
              '--no-pdf',
              '--fmt',
              XELATEX_FMT,
              entry,
            ],
            stage: { files: { [entry]: body }, cwd: '.' },
            collect: [],
          },
          sink,
        );
        if (r1.exitCode !== 0) return { ok: false, code: r1.exitCode, log: lines.join('\n') };
        const r2 = host.run(
          { applet: 'xdvipdfmx', argv: ['-o', `${job}.pdf`, `${job}.xdv`], collect: [`${job}.pdf`] },
          sink,
        );
        const pdf = r2.outputs.get(`${job}.pdf`);
        return { ok: r2.exitCode === 0 && pdf !== undefined, code: r2.exitCode, pdf, log: lines.join('\n') };
      };

      // BEFORE the mount: siunitx cannot resolve against core alone.
      const before = compile('main.tex', SIUNITX_DOC);
      expect(before.ok).toBe(false);

      // Mount academic INTO THE LIVE ENGINE, post-snapshot, between jobs (§5.4).
      const tMount = Date.now();
      await host.loadBundle('academic');
      const mountMs = Date.now() - tMount;

      // AFTER the mount: the identical doc now compiles (the reset before this job
      // did NOT lose the just-mounted tier — the crux of the snapshot interaction).
      const after = compile('main.tex', SIUNITX_DOC);
      expect(after.ok).toBe(true);
      const pdf = after.pdf!;
      expect(pdf.length).toBeGreaterThan(1000);
      expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);

      // The tier SURVIVES yet another job (another memory reset): a CJK ctex +
      // bundled-fandol doc compiles too.
      const cjk = compile('cjk.tex', CJK_DOC);
      expect(cjk.ok).toBe(true);
      expect(cjk.pdf!.length).toBeGreaterThan(1000);

      // Idempotent: a redundant loadBundle is a no-op and the engine still works.
      await host.loadBundle('academic');
      const again = compile('again.tex', SIUNITX_DOC);
      expect(again.ok).toBe(true);

      console.log(
        `[typeset-integration] mid-session mount: academic in ${mountMs} ms; ` +
          `post-mount pdf ${pdf.length} B, CJK pdf ${cjk.pdf!.length} B (survived 3 resets)`,
      );
    },
    180_000,
  );

  it.runIf(onDemandPresent)(
    'public API: preload core + onDemand academic — siunitx (scan) AND a CJK doc (retry) compile across jobs; academic loads LAZILY, not at init',
    async () => {
      const config = tieredAssets(['core'], ['academic']);
      const progress: AssetProgress[] = [];
      const tex = await createTypesetter({
        assetsBaseUrl: config.baseUrl,
        bundles: config.bundles,
        inventory: config.inventory,
        onAssetProgress: (p) => progress.push(p),
        workerFactory: inProcessFactory(),
      });

      // Job A: siunitx (academic-only) — the §5.4(a) scan preselects + mounts
      // academic during THIS compile (not at init).
      const a = await tex.typeset({ engine: 'xetex', entry: 'main.tex', files: { 'main.tex': SIUNITX_DOC } }).done;
      expect(a.ok).toBe(true);
      expect(a.stats.bundlesLoaded).toEqual(['core', 'academic']); // preload then lazily-loaded on-demand
      expect(a.pdf!.length).toBeGreaterThan(1000);
      expect(Array.from(a.pdf!.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);

      // Job B on the SAME typesetter (academic already mounted, survives the
      // per-job memory reset): CJK ctexart + bundled fandol.
      const b = await tex.typeset({ engine: 'xetex', entry: 'cjk.tex', files: { 'cjk.tex': CJK_DOC } }).done;
      expect(b.ok).toBe(true);
      expect(b.stats.bundlesLoaded).toEqual(['core', 'academic']);
      expect(b.pdf!.length).toBeGreaterThan(1000);

      // Under lazy §5.4 loading the on-demand academic tier mounts during JOB A's
      // scan, NOT at init — so it is absent from the init progress bracket
      // (client.ts initLoadedAssets reports engine + PRELOAD only; lazy-load
      // progress is a deferred follow-up). The PRELOAD core tier IS reported;
      // bundlesLoaded above already proves academic came in.
      expect(progress.some((p) => p.assetId === 'core.data')).toBe(true);
      expect(progress.some((p) => p.assetId === 'academic.data')).toBe(false);
      expect(progress.some((p) => p.assetId === 'academic.js')).toBe(false);

      await tex.dispose();
      console.log(
        `[typeset-integration] public-API on-demand (lazy): siunitx ${a.pdf!.length} B, CJK ${b.pdf!.length} B, ` +
          `bundlesLoaded=${JSON.stringify(a.stats.bundlesLoaded)}`,
      );
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// §5.4 automatic bundle resolution end to end (M4 items 6–7). Both halves of the
// mechanism proven INDEPENDENTLY against the real tiered dist: (a) the static
// \usepackage scan preselects academic first-try (no probe pass); (b) the
// missing-file retry recovers a scan-INVISIBLE \documentclass{ctexart} (the scan
// reads \usepackage/\RequirePackage, not \documentclass). Plus the two policy
// proofs: a core-served \usepackage{longtable} downloads NO academic, and a
// genuinely-missing package fails cleanly after one bounded retry. Driven through
// the core with the real host so the LIVE log stream (vs the spliced final log)
// distinguishes the scan path from the retry path. Skips without both tiers.
// ---------------------------------------------------------------------------

const LONGTABLE_DOC =
  '\\documentclass{article}\n\\usepackage{longtable}\n\\begin{document}\n' +
  '\\begin{longtable}{ll}a & b \\\\\\end{longtable}\n\\end{document}\n';
const MISSING_PKG_DOC =
  '\\documentclass{article}\n\\usepackage{nosuchpackagexyz}\n\\begin{document}x\\end{document}\n';

describe('§5.4 automatic bundle resolution (real wasm, both paths independently)', () => {
  /** Compile one doc through the core with the real host; return the result + the LIVE log stream. */
  async function compileWithTiers(
    onDemand: string[],
    entry: string,
    body: string,
  ): Promise<{ result: Extract<WorkerMessage, { type: 'result' }>; liveLog: string }> {
    const messages: WorkerMessage[] = [];
    const host = new EmscriptenEngineHost(createNodeModuleLoader());
    const core = createWorkerCore({ host, post: (m) => messages.push(m) });
    await core.handle({ type: 'init', v: 1, jobId: newJobId(), assets: tieredAssets(['core'], onDemand) });
    const jobId = newJobId();
    await core.handle({
      type: 'compile',
      v: 1,
      jobId,
      files: { [entry]: body },
      entry,
      engine: 'xetex',
      passes: 'auto',
      bibliography: 'off',
      index: 'off',
      synctex: false,
    });
    const forJob = messages.filter((m) => m.jobId === jobId);
    const result = forJob.at(-1);
    if (result?.type !== 'result') throw new Error('no result message');
    const liveLog = forJob
      .filter((m) => m.type === 'log')
      .map((m) => (m.type === 'log' ? m.line : ''))
      .join('\n');
    return { result, liveLog };
  }

  it.runIf(onDemandPresent)(
    'path (a): the static scan preselects academic for \\usepackage{siunitx} — first-try, NO probe pass',
    async () => {
      const { result, liveLog } = await compileWithTiers(['academic'], 'main.tex', SIUNITX_DOC);
      expect(result.ok).toBe(true);
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']);
      // The scan mounted academic BEFORE pass 1, so siunitx resolved first try —
      // "not found" NEVER streamed (no failed probe pass). Distinguishes (a) from (b).
      expect(liveLog).not.toMatch(/not found/i);
      expect(result.pdf!.length).toBeGreaterThan(1000);
      console.log('[typeset-integration] §5.4(a) scan-preselect siunitx: first-try, no probe, bundlesLoaded=[core,academic]');
    },
    180_000,
  );

  it.runIf(onDemandPresent)(
    'path (b): the missing-file retry recovers a scan-INVISIBLE \\documentclass{ctexart} (probe streamed live, spliced from final log)',
    async () => {
      // The scan reads \usepackage/\RequirePackage, NOT \documentclass — so
      // ctexart is invisible to it. This drives §5.4(b) INDEPENDENTLY of the scan.
      const { result, liveLog } = await compileWithTiers(['academic'], 'cjk.tex', CJK_DOC);
      expect(result.ok).toBe(true);
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']);
      // The probe pass FAILED against core alone and streamed the miss LIVE...
      expect(liveLog).toMatch(/ctexart\.cls['`]? not found/i);
      // ...but the retry is authoritative: the final log has the probe spliced out.
      expect(result.log).not.toMatch(/not found/i);
      expect(result.pdf!.length).toBeGreaterThan(1000);
      console.log('[typeset-integration] §5.4(b) retry ctexart (scan off): probe streamed then spliced, bundlesLoaded=[core,academic]');
    },
    180_000,
  );

  it.runIf(onDemandPresent)(
    'core-only \\usepackage{longtable} compiles WITHOUT downloading academic (unknown-name policy)',
    async () => {
      const { result } = await compileWithTiers(['academic'], 'main.tex', LONGTABLE_DOC);
      expect(result.ok).toBe(true);
      // longtable ∉ any provides → the scan does nothing; core ships longtable.sty
      // → no failed pass → academic NEVER downloaded. THE unknown-name policy proof.
      expect(result.stats.bundlesLoaded).toEqual(['core']);
      expect(result.pdf!.length).toBeGreaterThan(1000);
      console.log('[typeset-integration] core-only longtable: bundlesLoaded=[core], academic NOT downloaded');
    },
    120_000,
  );

  it.runIf(onDemandPresent)(
    'a genuinely-missing package retries once then fails cleanly — bounded, no download loop',
    async () => {
      const { result } = await compileWithTiers(['academic'], 'main.tex', MISSING_PKG_DOC);
      // The retry loaded academic ONCE (bounded); it still lacks the package → a
      // clean failure surfacing the real diagnostic. No loop.
      expect(result.ok).toBe(false);
      expect(result.pdf).toBeUndefined();
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']);
      expect(result.log).toMatch(/nosuchpackagexyz\.sty['`]? not found/i);
      console.log('[typeset-integration] genuinely-missing: retried once, academic loaded, still failed cleanly (bounded)');
    },
    180_000,
  );
});
