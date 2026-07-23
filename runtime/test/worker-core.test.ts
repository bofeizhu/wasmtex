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
  type AssetsInventory,
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
  readonly loadBundleCalls: string[] = [];
  /** Ordered call log (`load` / `loadBundle:<name>` / `run:<applet>`) — proves the §5.4 scan mounts BEFORE the first pass and the retry mounts AFTER a failed one. */
  readonly events: string[] = [];
  /** When set, `loadBundle` throws it (simulates an on-demand tier that fails to mount). */
  loadBundleError: unknown = null;
  scripts: FakeRunScript[] = [];
  private next = 0;

  async load(assets: AssetsConfig): Promise<void> {
    this.loadCalls.push(assets);
    this.events.push('load');
    if (this.loadError !== null) throw this.loadError;
  }

  async loadBundle(name: string): Promise<void> {
    this.loadBundleCalls.push(name);
    this.events.push(`loadBundle:${name}`);
    if (this.loadBundleError !== null) throw this.loadBundleError;
  }

  run(step: EngineRunStep, onLine: EngineLogSink): EngineRunResult {
    this.runCalls.push(step);
    this.events.push(`run:${step.applet}`);
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
// §5.4 automatic bundle resolution (M4 items 6–7): on-demand tiers mount LAZILY.
// (a) the static \usepackage scan preselects a tier BEFORE the first pass;
// (b) the missing-file retry mounts one AFTER a pass fails naming a not-found
// file. The fake host's ordered `events` log proves WHEN each mount happens, and
// scripted failing-then-succeeding runs drive the retry independently of the scan.
// ---------------------------------------------------------------------------

/** An init message whose bundle selection overrides the default ASSETS. */
function initMessageWithBundles(
  jobId: JobId,
  bundles: { preload: string[]; onDemand: string[] },
): InitMessage {
  return { type: 'init', v: 1, jobId, assets: { ...ASSETS, bundles } };
}

/** Two scripts for a xelatex → xdvipdfmx happy-path compile that yields a PDF result. */
function happyCompileScripts(): FakeRunScript[] {
  return [
    { exitCode: 0, stdout: ['This is XeTeX'] },
    { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
  ];
}

// A manifest-style inventory carrying a per-bundle provided-package index, so the
// §5.4(a) scan can resolve a \usepackage name to an on-demand tier. `siunitx`
// etc. live in academic; `longtable` is DELIBERATELY absent from every `provides`
// (it ships in core but its NAME is not a provided-package name) — the
// unknown-name policy fixture. `texlive-basic` is an alias of core.
const TIERED_INVENTORY: AssetsInventory = {
  schemaVersion: 2,
  assets: [
    { path: 'busytex.js', role: 'engine-js' },
    { path: 'busytex.wasm', role: 'engine-wasm' },
    { path: 'core.js', role: 'bundle-js' },
    { path: 'core.data', role: 'bundle-data' },
    { path: 'academic.js', role: 'bundle-js' },
    { path: 'academic.data', role: 'bundle-data' },
  ],
  bundles: [
    { name: 'core', files: ['core.js', 'core.data'], provides: ['latex', 'amsmath', 'geometry', 'natbib'] },
    { name: 'academic', files: ['academic.js', 'academic.data'], provides: ['siunitx', 'ctex', 'xecjk', 'mathtools'] },
    { name: 'texlive-basic', aliasOf: 'core' },
  ],
};

/** Init with the tiered inventory: preload core, on-demand academic (overridable). */
function initTiered(jobId: JobId, onDemand: string[] = ['academic']): InitMessage {
  return {
    type: 'init',
    v: 1,
    jobId,
    assets: { baseUrl: '/dist', inventory: TIERED_INVENTORY, bundles: { preload: ['core'], onDemand } },
  };
}

/** A minimal document with a single \usepackage of `pkg` (entry stays hello.tex). */
function docUsing(pkg: string): ProjectFiles {
  return { 'hello.tex': `\\documentclass{article}\n\\usepackage{${pkg}}\n\\begin{document}x\\end{document}\n` };
}
/** A document that loads NO package the scan can resolve (drives the retry, not the scan). */
const PLAIN_DOC: ProjectFiles = { 'hello.tex': '\\documentclass{article}\n\\begin{document}x\\end{document}\n' };
/** The LaTeX "file not found" line for a missing `.sty` (the §5.4(b) retry trigger). */
const notFound = (sty: string): string => `! LaTeX Error: File \`${sty}' not found.`;

describe('core — §5.4(a) static \\usepackage scan (item 6)', () => {
  it('preselects the on-demand tier a \\usepackage names, BEFORE the first pass (no probe pass)', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    expect(host.loadBundleCalls).toEqual([]); // nothing mounted at init (lazy)

    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', docUsing('siunitx')));

    // academic mounted BEFORE the first engine run (scan), so the pass never fails.
    expect(host.events).toEqual(['load', 'loadBundle:academic', 'run:xelatex', 'run:xdvipdfmx']);
    expect(host.runCalls).toHaveLength(2); // NO failed probe pass
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']);
    }
  });

  it('an UNMATCHED name loads NO on-demand tier (unknown → do nothing; core serves it)', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));

    // longtable is in NO tier's `provides` → the scan does nothing; core (the
    // fake host succeeds) serves it. This is the load-bearing item-4 policy: a
    // "load academic on any unmatched name" rule would download the 496 MB tier.
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', docUsing('longtable')));

    expect(host.loadBundleCalls).toEqual([]); // NO academic download
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.stats.bundlesLoaded).toEqual(['core']);
    }
  });

  it('a name a PRELOAD tier provides is not re-loaded (natbib → core, already mounted)', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    await core.handle(compileMessage(newJobId(), 'xetex', docUsing('natbib')));
    expect(host.loadBundleCalls).toEqual([]); // natbib is provided by core (preloaded)
  });

  it('skips a scanned name the host supplied as a project-local .sty (local shadow of a tier package)', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    // \usepackage{siunitx} would normally preselect academic, but the host
    // supplied its own siunitx.sty — it resolves locally, so no tier is pulled.
    await core.handle(
      compileMessage(newJobId(), 'xetex', {
        'hello.tex': '\\documentclass{article}\n\\usepackage{siunitx}\n\\begin{document}x\\end{document}\n',
        'siunitx.sty': '% a local override of siunitx',
      }),
    );
    expect(host.loadBundleCalls).toEqual([]);
  });

  it('scans \\RequirePackage inside a project-local .cls too (a class that pulls an on-demand package)', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    // The class file itself \RequirePackages an academic package — the scan reads
    // project-local .cls content, so it preselects academic. (`myclass` is local,
    // so it is not itself looked up as a tier package.)
    await core.handle(
      compileMessage(newJobId(), 'xetex', {
        'hello.tex': '\\documentclass{myclass}\n\\begin{document}x\\end{document}\n',
        'myclass.cls': '\\RequirePackage{mathtools}\n',
      }),
    );
    expect(host.loadBundleCalls).toEqual(['academic']); // mathtools → academic
  });

  it('ignores a commented-out \\usepackage line', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    await core.handle(
      compileMessage(newJobId(), 'xetex', {
        'hello.tex': '\\documentclass{article}\n% \\usepackage{siunitx}\n\\begin{document}x\\end{document}\n',
      }),
    );
    expect(host.loadBundleCalls).toEqual([]); // the commented line is not scanned
  });
});

describe('core — §5.4(b) missing-file retry (item 7)', () => {
  it('mounts academic and retries ONCE when a pass fails "File not found" (scan off), splicing the probe from the final log', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 1, stderr: [notFound('siunitx.sty')] }, // probe fails
      { exitCode: 0, stdout: ['This is XeTeX (retry)'] }, // retry succeeds
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }, // xdvipdfmx
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));

    // PLAIN_DOC names no package the scan can resolve → the scan preselects
    // nothing; the RETRY must carry it (proves §5.4(b) independent of the scan).
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', PLAIN_DOC));

    // Mount happened AFTER the failed first pass (retry), unlike the scan.
    expect(host.events).toEqual(['load', 'run:xelatex', 'loadBundle:academic', 'run:xelatex', 'run:xdvipdfmx']);
    expect(host.runCalls).toHaveLength(3); // probe + retry + xdvipdfmx

    const forJob = messages.filter((m) => m.jobId === jobId);
    const result = forJob.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']);
      // The probe's error is DROPPED from the final consolidated log (the retry is
      // authoritative) — a successful compile shows no spurious "not found".
      expect(result.log).not.toContain('not found');
      expect(result.log).toContain('This is XeTeX (retry)');
    }
    // ...but the probe DID stream live (honest real-time event log).
    expect(forJob.some((m) => m.type === 'log' && m.line.includes("File `siunitx.sty' not found"))).toBe(true);
  });

  it('does NOT retry on a non-missing-file error (undefined control sequence): no tier download', async () => {
    const host = new FakeHost();
    host.scripts = [{ exitCode: 1, stderr: ['! Undefined control sequence.', 'l.3 \\foo'] }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', PLAIN_DOC));

    expect(host.loadBundleCalls).toEqual([]); // no "not found" ⇒ no retry ⇒ no download
    expect(host.runCalls).toHaveLength(1);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.stats.bundlesLoaded).toEqual(['core']);
    }
  });

  it('a genuinely-missing package retries once then fails cleanly — bounded, no loop, not re-attempted next job', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 1, stderr: [notFound('nosuchpkgxyz.sty')] }, // job1 probe
      { exitCode: 1, stderr: [notFound('nosuchpkgxyz.sty')] }, // job1 retry — STILL missing
      { exitCode: 1, stderr: [notFound('anothermissing.sty')] }, // job2 pass — academic already handled
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId()));

    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', docUsing('nosuchpkgxyz')));
    // Scan: nosuchpkgxyz ∉ provides → no preselect. Probe fails → retry mounts
    // academic ONCE → still fails → abort. loadBundle called exactly once.
    expect(host.loadBundleCalls).toEqual(['academic']);
    expect(host.runCalls).toHaveLength(2); // probe + retry, no third attempt
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.stats.bundlesLoaded).toEqual(['core', 'academic']); // downloaded once (bounded)
      expect(result.log).toContain('not found'); // the real diagnostic surfaces
    }

    // Session bound: a SECOND missing-package job does NOT re-attempt academic.
    const job2 = newJobId();
    await core.handle(compileMessage(job2, 'xetex', docUsing('anothermissing')));
    expect(host.loadBundleCalls).toEqual(['academic']); // still exactly one mount
    const r2 = messages.filter((m) => m.jobId === job2).at(-1);
    if (r2?.type === 'result') expect(r2.ok).toBe(false);
  });

  it('a lazy on-demand mount FAILURE is best-effort: init unaffected, the compile fails with the real diagnostic', async () => {
    const host = new FakeHost();
    host.loadBundleError = new Error('academic.data 404');
    host.scripts = [{ exitCode: 1, stderr: [notFound('siunitx.sty')] }]; // probe; no retry run (mount failed)
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initTiered(newJobId()));
    expect(messages.map((m) => m.type)).toEqual(['initialized']); // init OK — on-demand NOT mounted at init

    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', PLAIN_DOC));
    // The retry attempted the mount once; it failed, so no retry run happened.
    expect(host.loadBundleCalls).toEqual(['academic']);
    expect(host.runCalls).toHaveLength(1);
    const forJob = messages.filter((m) => m.jobId === jobId);
    const result = forJob.at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.stats.bundlesLoaded).toEqual(['core']); // academic NOT loaded (mount failed)
    }
    // A best-effort advisory names the tier that could not be loaded.
    expect(
      forJob.some((m) => m.type === 'log' && m.line.includes("on-demand bundle 'academic' could not be loaded")),
    ).toBe(true);
  });

  it('with no on-demand tiers configured, a missing-file failure does not retry', async () => {
    const host = new FakeHost();
    host.scripts = [{ exitCode: 1, stderr: [notFound('siunitx.sty')] }];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId(), [])); // onDemand: []
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex', docUsing('siunitx')));
    expect(host.loadBundleCalls).toEqual([]);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.stats.bundlesLoaded).toEqual(['core']);
    }
  });
});

describe('core — on-demand tiers load lazily, not at init', () => {
  it('does NOT mount on-demand tiers at init; init succeeds with only the preload tier', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initTiered(newJobId(), ['academic']));
    expect(host.loadCalls).toHaveLength(1);
    expect(host.loadBundleCalls).toEqual([]); // NOTHING mounted at init
    expect(messages.map((m) => m.type)).toEqual(['initialized']);
  });

  it('with no on-demand tiers, mounts nothing and bundlesLoaded is just the preload set', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });

    await core.handle(initMessageWithBundles(newJobId(), { preload: ['core'], onDemand: [] }));
    expect(host.loadBundleCalls).toEqual([]); // loadBundle never called

    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.stats.bundlesLoaded).toEqual(['core']);
    }
  });

  it('deduplicates a preload tier repeated in the config (never reports [core, core])', async () => {
    const host = new FakeHost();
    host.scripts = happyCompileScripts();
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessageWithBundles(newJobId(), { preload: ['core', 'core'], onDemand: [] }));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') expect(result.stats.bundlesLoaded).toEqual(['core']);
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
    // pdfTeX writes the PDF directly; item 6 also snapshots the observation files
    // (.aux/.toc/.idx) each pass so the machine can detect reruns / bib / index.
    expect(pdflatex?.collect).toEqual(['hello.aux', 'hello.toc', 'hello.idx', 'hello.pdf']);

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

// ---------------------------------------------------------------------------
// §5.3 sequencing wiring (item 6): the core drives the pure machine, gathering
// FS-fact observations from each run's collected outputs (the .aux/.idx bytes)
// and streaming the right progress phases. The decision logic itself is unit
// tested in sequencing.test.ts; here we prove the core feeds it real snapshots.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const AUX_CITES = enc.encode('\\citation{k}\n\\bibstyle{plain}\n\\bibdata{refs}\n');
const IDX_NONEMPTY = enc.encode('\\indexentry{k}{1}\n');
const RERUN_STDOUT = 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.';

/** The ordered progress-phase kinds emitted for a job. */
function progressKinds(messages: readonly WorkerMessage[], jobId: JobId): string[] {
  return messages
    .filter((m): m is Extract<WorkerMessage, { type: 'progress' }> => m.type === 'progress' && m.jobId === jobId)
    .map((m) => m.phase.kind);
}

describe('core — §5.3 sequencing (item 6)', () => {
  it('bibliography: a citing .aux drives xelatex → bibtex8 → incorporate pass → xdvipdfmx', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } }, // pass 1 writes a citing .aux
      { exitCode: 0 }, // bibtex8 clean
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } }, // pass 2: same .aux ⇒ quiescent
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }, // xdvipdfmx
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    expect(host.runCalls.map((s) => s.applet)).toEqual(['xelatex', 'bibtex8', 'xelatex', 'xdvipdfmx']);
    expect(host.runCalls[1]?.argv).toEqual(['--8bit', 'hello.aux']); // bibtex8 on the .aux, --8bit
    expect(host.runCalls[1]?.stage).toBeUndefined(); // reuses the job FS
    expect(progressKinds(messages, jobId)).toEqual(['engine', 'bibtex8', 'engine', 'xdvipdfmx']);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.stats.passes).toBe(2);
    }
  });

  it('bibliography: bibtex8 error (exit 2) aborts — no xdvipdfmx, ok:false, exitCode 2', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } },
      { exitCode: 2, stderr: ["I couldn't open style file nosuch.bst"] },
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    // The sequence stops at bibtex8; xdvipdfmx never runs.
    expect(host.runCalls.map((s) => s.applet)).toEqual(['xelatex', 'bibtex8']);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.pdf).toBeUndefined();
      expect(result.log).toContain("couldn't open style file");
    }
  });

  it('pdftex: bibtex8 abort does NOT attach the stale pass-1 PDF to ok:false', async () => {
    // pdfTeX collects a PDF on EVERY pass (unlike xetex, whose PDF only comes
    // from the terminal xdvipdfmx step). A bibtex8 exit-2 abort after a
    // successful pass 1 must not deliver that pass-1 PDF (citations as [?]).
    const host = new FakeHost();
    host.scripts = [
      {
        exitCode: 0,
        outputs: { 'hello.aux': AUX_CITES, 'hello.pdf': new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      },
      { exitCode: 2, stderr: ["I couldn't open style file nosuch.bst"] },
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'pdftex'));

    expect(host.runCalls.map((s) => s.applet)).toEqual(['pdflatex', 'bibtex8']);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.pdf).toBeUndefined();
    }
  });

  it('index: a non-empty .idx drives xelatex → makeindex → incorporate pass → xdvipdfmx', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.idx': IDX_NONEMPTY } }, // pass 1 writes a non-empty .idx
      { exitCode: 0 }, // makeindex
      { exitCode: 0 }, // pass 2 quiescent
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }, // xdvipdfmx
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    expect(host.runCalls.map((s) => s.applet)).toEqual(['xelatex', 'makeindex', 'xelatex', 'xdvipdfmx']);
    expect(host.runCalls[1]?.argv).toEqual(['hello.idx']);
    expect(progressKinds(messages, jobId)).toEqual(['engine', 'makeindex', 'engine', 'xdvipdfmx']);
  });

  it('rerun: a "Rerun to get…" transcript marker drives a second engine pass', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, stdout: [RERUN_STDOUT] }, // pass 1 asks to rerun
      { exitCode: 0 }, // pass 2 quiescent
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }, // xdvipdfmx
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle(compileMessage(jobId, 'xetex'));

    expect(host.runCalls.map((s) => s.applet)).toEqual(['xelatex', 'xelatex', 'xdvipdfmx']);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') {
      expect(result.ok).toBe(true);
      expect(result.stats.passes).toBe(2);
    }
  });

  it('explicit passes=1 with a citing .aux still runs bibtex8 but no incorporate pass', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } }, // pass 1
      { exitCode: 0 }, // bibtex8
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } }, // xdvipdfmx (no engine pass 2)
    ];
    const { messages, post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    const jobId = newJobId();
    await core.handle({ ...compileMessage(jobId, 'xetex'), passes: 1 });

    expect(host.runCalls.map((s) => s.applet)).toEqual(['xelatex', 'bibtex8', 'xdvipdfmx']);
    const result = messages.filter((m) => m.jobId === jobId).at(-1);
    if (result?.type === 'result') expect(result.stats.passes).toBe(1);
  });

  it('staging happens once: only the first step opens a fresh job FS', async () => {
    const host = new FakeHost();
    host.scripts = [
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } },
      { exitCode: 0 },
      { exitCode: 0, outputs: { 'hello.aux': AUX_CITES } },
      { exitCode: 0, outputs: { 'hello.pdf': PDF_BYTES } },
    ];
    const { post } = recorder();
    const core = createWorkerCore({ host, post, now: fakeClock() });
    await core.handle(initMessage(newJobId()));
    await core.handle(compileMessage(newJobId(), 'xetex'));

    const staged = host.runCalls.filter((s) => s.stage !== undefined);
    expect(staged).toHaveLength(1);
    expect(host.runCalls[0]?.stage).toBeDefined(); // the first (engine pass 1) step stages
  });
});
