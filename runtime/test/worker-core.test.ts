// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Worker orchestration-core tests (M1 item 5). Pure Node — no worker, no wasm:
// the core is driven with a FAKE EngineHost, so init/compile sequencing, engine
// selection, and fatal mapping are tested deterministically. Every outbound
// message is asserted to be wire-valid (round-trips through parseWorkerMessage)
// and correlated to its request's jobId — the constitutional §5.2 property at
// the worker layer. The real-wasm path is the typeset integration test.

import { describe, expect, it } from 'vitest';
import {
  newJobId,
  parseWorkerMessage,
  type AssetsConfig,
  type CompileMessage,
  type EngineName,
  type InitMessage,
  type JobId,
  type ProjectFiles,
  type WorkerMessage,
} from '../src/protocol';
import {
  EngineAborted,
  createWorkerCore,
  type EngineHost,
  type EngineLogSink,
  type EngineRunResult,
  type EngineRunStep,
} from '../worker/core';

// ---------------------------------------------------------------------------
// A scripted fake host — records calls, replays per-run outcomes.
// ---------------------------------------------------------------------------

interface FakeRunScript {
  readonly exitCode?: number;
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly outputs?: Readonly<Record<string, Uint8Array>>;
  readonly throw?: unknown;
}

class FakeHost implements EngineHost {
  loadError: unknown = null;
  readonly loadCalls: AssetsConfig[] = [];
  readonly runCalls: EngineRunStep[] = [];
  scripts: FakeRunScript[] = [];
  private next = 0;

  async load(assets: AssetsConfig): Promise<void> {
    this.loadCalls.push(assets);
    if (this.loadError !== null) throw this.loadError;
  }

  run(step: EngineRunStep, onLine: EngineLogSink): EngineRunResult {
    this.runCalls.push(step);
    const script = this.scripts[this.next++] ?? {};
    if (script.throw !== undefined) throw script.throw;
    for (const line of script.stdout ?? []) onLine('stdout', line);
    for (const line of script.stderr ?? []) onLine('stderr', line);
    return {
      exitCode: script.exitCode ?? 0,
      stdout: (script.stdout ?? []).join('\n'),
      stderr: (script.stderr ?? []).join('\n'),
      outputs: new Map(Object.entries(script.outputs ?? {})),
    };
  }
}

// ---------------------------------------------------------------------------
// Recorder: every posted message must be wire-valid (parseWorkerMessage).
// ---------------------------------------------------------------------------

function recorder(): { messages: WorkerMessage[]; post: (m: WorkerMessage) => void } {
  const messages: WorkerMessage[] = [];
  return {
    messages,
    post(message: WorkerMessage): void {
      // A message the client could not re-validate would be a protocol break.
      expect(parseWorkerMessage(message)).toEqual(message);
      messages.push(message);
    },
  };
}

/** Deterministic clock: start=1000, end=1001 ⇒ elapsedMs=1 per compile. */
function fakeClock(): () => number {
  let t = 1000;
  return () => t++;
}

const ASSETS: AssetsConfig = {
  baseUrl: '/dist',
  inventory: {
    schemaVersion: 1,
    assets: [
      { path: 'busytex.js', role: 'engine-js' },
      { path: 'busytex.wasm', role: 'engine-wasm' },
      { path: 'texlive-basic.js', role: 'bundle-js' },
      { path: 'texlive-basic.data', role: 'bundle-data' },
    ],
  },
  bundles: { preload: ['texlive-basic'], onDemand: [] },
};

function initMessage(jobId: JobId): InitMessage {
  return { type: 'init', v: 1, jobId, assets: ASSETS };
}

function compileMessage(
  jobId: JobId,
  engine: EngineName,
  files: ProjectFiles = { 'hello.tex': '\\documentclass{article}\\begin{document}hi\\end{document}' },
  entry = 'hello.tex',
): CompileMessage {
  return {
    type: 'compile',
    v: 1,
    jobId,
    files,
    entry,
    engine,
    passes: 'auto',
    bibliography: 'auto',
    index: 'auto',
    synctex: false,
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]); // "%PDF-1.5"

/** Every message carries the expected jobId (correlation gate at the worker). */
function expectAllCorrelated(messages: readonly WorkerMessage[], jobId: JobId): void {
  for (const m of messages) expect(m.jobId).toBe(jobId);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('core — init', () => {
  it('loads the engine and answers `initialized`, correlated', async () => {
    const host = new FakeHost();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    const jobId = newJobId();
    await core.handle(initMessage(jobId));

    expect(host.loadCalls).toHaveLength(1);
    expect(host.loadCalls[0]).toEqual(ASSETS);
    expect(messages.map((m) => m.type)).toEqual(['initialized']);
    expectAllCorrelated(messages, jobId);
  });

  it('maps a host load failure to a `fatal` init-failed, correlated', async () => {
    const host = new FakeHost();
    host.loadError = new Error('core.data 404');
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    const jobId = newJobId();
    await core.handle(initMessage(jobId));

    expect(messages).toHaveLength(1);
    const fatal = messages[0];
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') {
      expect(fatal.code).toBe('init-failed');
      expect(fatal.message).toContain('core.data 404');
    }
    expectAllCorrelated(messages, jobId);
  });

  it('a second init re-acks without reloading the engine (no double load / leak)', async () => {
    const host = new FakeHost();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const secondId = newJobId();
    await core.handle(initMessage(secondId));

    expect(host.loadCalls).toHaveLength(1); // host.load NOT called a second time
    expect(messages.filter((m) => m.type === 'initialized')).toHaveLength(2);
    // The second init is acknowledged, correlated to its own id.
    expect(messages.filter((m) => m.jobId === secondId).map((m) => m.type)).toEqual(['initialized']);
  });
});

// ---------------------------------------------------------------------------
// compile — happy paths
// ---------------------------------------------------------------------------

describe('core — compile (xetex, happy path)', () => {
  it('runs xelatex → xdvipdfmx over one shared FS and returns a pdf result', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, stdout: ['This is XeTeX'] }, // xelatex → .xdv
      { exitCode: 0, stdout: ['xdvipdfmx: wrote hello.pdf'], outputs: { 'hello.pdf': PDF_BYTES } },
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    const initId = newJobId();
    await core.handle(initMessage(initId));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    // The two applet steps: xelatex stages + emits an .xdv; xdvipdfmx reuses the
    // FS (no stage) and collects the pdf.
    expect(host.runCalls).toHaveLength(2);
    const [xelatex, xdvipdfmx] = host.runCalls;
    expect(xelatex?.applet).toBe('xelatex');
    expect(xelatex?.stage?.files).toEqual({
      'hello.tex': '\\documentclass{article}\\begin{document}hi\\end{document}',
    });
    expect(xelatex?.argv).toContain('--no-pdf');
    expect(xelatex?.argv).toContain('hello.tex');
    expect(xelatex?.argv.some((a) => a.endsWith('xelatex.fmt'))).toBe(true);
    expect(xdvipdfmx?.applet).toBe('xdvipdfmx');
    expect(xdvipdfmx?.stage).toBeUndefined();
    expect(xdvipdfmx?.argv).toEqual(['-o', 'hello.pdf', 'hello.xdv']);
    expect(xdvipdfmx?.collect).toEqual(['hello.pdf']);

    // The message stream: progress(engine) → log → progress(xdvipdfmx) → log → result.
    const compileMessages = messages.filter((m) => m.jobId === jobId);
    expect(compileMessages.map((m) => m.type)).toEqual([
      'progress',
      'log',
      'progress',
      'log',
      'result',
    ]);
    expectAllCorrelated(compileMessages, jobId);

    const result = compileMessages.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.pdf).toEqual(PDF_BYTES);
      expect(result.log).toBe('This is XeTeX\nxdvipdfmx: wrote hello.pdf');
      expect(result.stats.passes).toBe(1);
      expect(result.stats.elapsedMs).toBe(1);
      expect(result.stats.bundlesLoaded).toEqual(['texlive-basic']);
    }
  });
});

describe('core — compile (pdftex direct)', () => {
  it('runs a single pdflatex pass that writes the pdf itself (no xdvipdfmx)', async () => {
    const host = new FakeHost();
    host.scripts = [{ exitCode: 0, stdout: ['This is pdfTeX'], outputs: { 'hello.pdf': PDF_BYTES } }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'pdftex'));

    expect(host.runCalls).toHaveLength(1);
    const [pdflatex] = host.runCalls;
    expect(pdflatex?.applet).toBe('pdflatex');
    expect(pdflatex?.argv).toContain('--output-format=pdf');
    expect(pdflatex?.collect).toEqual(['hello.pdf']);

    const compileMessages = messages.filter((m) => m.jobId === jobId);
    expect(compileMessages.map((m) => m.type)).toEqual(['progress', 'log', 'result']);
    const result = compileMessages.at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.pdf).toEqual(PDF_BYTES);
      expect(result.stats.passes).toBe(1);
    }
  });

  it('emits an advisory (not silence) when synctex is requested', async () => {
    const host = new FakeHost();
    host.scripts = [{ exitCode: 0 }, { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle({ ...compileMessage(jobId, 'xetex'), synctex: true });

    const logs = messages.filter((m): m is Extract<WorkerMessage, { type: 'log' }> => m.type === 'log');
    expect(logs.some((m) => m.line.toLowerCase().includes('synctex'))).toBe(true);
    // The compile still succeeds (synctex is skipped, not fatal).
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') expect(result.ok).toBe(true);
  });

  it('derives output/working paths from a subdir entry', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0 },
      { exitCode: 0, outputs: { 'main.pdf': PDF_BYTES } },
    ];
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    await core.handle(
      compileMessage(newJobId(), 'xetex', { 'src/main.tex': 'x' }, 'src/main.tex'),
    );

    const [xelatex, xdvipdfmx] = host.runCalls;
    expect(xelatex?.stage?.cwd).toBe('src');
    expect(xelatex?.argv).toContain('main.tex'); // basename, not the full path
    expect(xdvipdfmx?.argv).toEqual(['-o', 'main.pdf', 'main.xdv']);
  });
});

// ---------------------------------------------------------------------------
// compile — rejections & failures
// ---------------------------------------------------------------------------

describe('core — compile rejections and failures', () => {
  it('rejects luatex with fatal unsupported-engine and never runs an applet', async () => {
    const host = new FakeHost();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'luatex'));

    expect(host.runCalls).toHaveLength(0);
    const compileMessages = messages.filter((m) => m.jobId === jobId);
    expect(compileMessages).toHaveLength(1);
    const fatal = compileMessages[0];
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') {
      expect(fatal.code).toBe('unsupported-engine');
      expect(fatal.message).toContain('luatex');
    }
  });

  it('rejects a compile received before a successful init', async () => {
    const host = new FakeHost();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    expect(host.runCalls).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const fatal = messages[0];
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') {
      expect(fatal.code).toBe('internal');
      expect(fatal.message).toContain('initialised');
    }
  });

  it('maps a wasm abort (EngineAborted) to fatal engine-aborted', async () => {
    const host = new FakeHost();
    host.scripts = [{ throw: new EngineAborted("applet 'xelatex' aborted: RuntimeError") }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    const fatal = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') {
      expect(fatal.code).toBe('engine-aborted');
      expect(fatal.message).toContain('aborted');
    }
  });

  it('maps any other host throw to fatal internal', async () => {
    const host = new FakeHost();
    host.scripts = [{ throw: new Error('unexpected host failure') }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    const fatal = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(fatal?.type).toBe('fatal');
    if (fatal?.type === 'fatal') expect(fatal.code).toBe('internal');
  });

  it('stops the sequence on a non-zero engine exit and reports ok=false, no pdf', async () => {
    const host = new FakeHost();
    host.scripts = [{ exitCode: 1, stderr: ['! LaTeX Error'] }]; // xelatex fails
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    // xdvipdfmx must NOT run after a failed engine pass.
    expect(host.runCalls).toHaveLength(1);
    const compileMessages = messages.filter((m) => m.jobId === jobId);
    expect(compileMessages.map((m) => m.type)).toEqual(['progress', 'log', 'result']);
    const result = compileMessages.at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.pdf).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// cross-cutting: correlation across interleaved jobs
// ---------------------------------------------------------------------------

describe('core — correlation across jobs', () => {
  it('tags each job’s messages with only that job’s id', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessage(newJobId()));
    const jobA = newJobId();
    const jobB = newJobId();
    await core.handle(compileMessage(jobA, 'xetex'));
    await core.handle(compileMessage(jobB, 'xetex'));

    const forA = messages.filter((m) => m.jobId === jobA);
    const forB = messages.filter((m) => m.jobId === jobB);
    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    // No message for A carries B's id or vice versa (exact-identity correlation).
    expect(forA.every((m) => m.jobId !== jobB)).toBe(true);
    expect(forB.every((m) => m.jobId !== jobA)).toBe(true);
  });
});
