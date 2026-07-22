// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Client tests (M1 item 7). Pure Node — no worker, no wasm: the client is driven
// with a FAKE WorkerLike so the §5.2 contract points are tested deterministically
// against the PUBLIC §5.1 surface (createTypesetter / Typesetter / Job). The
// named §8 acceptance cases live here:
//   (i)   a late/stale message for a cancelled job can never resolve a newer job;
//   (ii)  cancel() terminates the worker, rejects with CancelledError, and the
//         next typeset() reinitialises on a fresh worker;
//   (iii) jobs serialize — a second typeset() is queued until the first settles;
//   (iv)  dispose() terminates and rejects the active + queued jobs.
// Plus: fatal handling, a worker crash mid-job, the locateAsset url override,
// log-stream ordering, coarse asset progress, the assets.json fetch path, and
// strict client-side input validation. The real-wasm cousin is the full-stack
// public-API test in typeset-integration.test.ts.

import { describe, expect, it } from 'vitest';
import {
  createTypesetter,
  typesetterDiagnostics,
  CancelledError,
  WorkerCrashedError,
  FatalError,
  TypesetInputError,
  type AssetProgress,
  type CreateTypesetterOptions,
  type FetchLike,
  type Typesetter,
  type TypesetJob,
  type WorkerFactory,
  type WorkerLike,
} from '../src/index';
import {
  fatalMessage,
  initializedMessage,
  logMessage,
  parseClientMessage,
  progressMessage,
  resultMessage,
  type AssetsInventory,
  type ClientMessage,
  type CompileMessage,
  type InitMessage,
  type ResultFields,
  type WorkerMessage,
} from '../src/protocol';

// ---------------------------------------------------------------------------
// Test fixtures + fake worker
// ---------------------------------------------------------------------------

const INVENTORY: AssetsInventory = {
  schemaVersion: 1,
  assets: [
    { path: 'busytex.js', bytes: 100, role: 'engine-js' },
    { path: 'busytex.wasm', bytes: 30_000_000, role: 'engine-wasm' },
    { path: 'texlive-basic.js', bytes: 1_700_000, role: 'bundle-js' },
    { path: 'texlive-basic.data', bytes: 79_000_000, role: 'bundle-data' },
  ],
};
const BUNDLES = { preload: ['texlive-basic'], onDemand: [] };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

/** Drain all pending microtasks (the pump/handshake schedule work on them). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake WorkerLike: records what the client sent, lets the test emit replies. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: ClientMessage[] = [];
  terminateCalls = 0;
  #autoInit: boolean;

  constructor(opts: { autoInit?: boolean } = {}) {
    this.#autoInit = opts.autoInit ?? true;
  }

  postMessage(message: unknown): void {
    // Every message the client sends must round-trip the worker's own validator
    // (the client→worker contract cannot silently drift).
    const parsed = parseClientMessage(message);
    expect(parsed).toEqual(message);
    this.sent.push(message as ClientMessage);
    if (this.#autoInit && parsed?.type === 'init') {
      const { jobId } = parsed;
      void Promise.resolve().then(() => this.emit(initializedMessage(jobId)));
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.onmessage = null;
    this.onerror = null;
  }

  /** Deliver a worker→client message (no-op once terminated — onmessage is nulled). */
  emit(message: WorkerMessage): void {
    this.onmessage?.({ data: message });
  }

  /** Simulate an unexpected worker failure (onerror). */
  crash(detail = 'boom'): void {
    this.onerror?.({ message: detail });
  }

  compiles(): CompileMessage[] {
    return this.sent.filter((m): m is CompileMessage => m.type === 'compile');
  }

  lastCompile(): CompileMessage {
    const all = this.compiles();
    const last = all.at(-1);
    if (last === undefined) throw new Error('no compile sent to this worker');
    return last;
  }

  init(): InitMessage {
    const found = this.sent.find((m): m is InitMessage => m.type === 'init');
    if (found === undefined) throw new Error('no init sent to this worker');
    return found;
  }
}

/** A factory that records every worker it builds (for reinit assertions). */
function recordingFactory(opts: { autoInit?: boolean } = {}): {
  workers: FakeWorker[];
  factory: WorkerFactory;
} {
  const workers: FakeWorker[] = [];
  const factory: WorkerFactory = () => {
    const w = new FakeWorker(opts);
    workers.push(w);
    return w;
  };
  return { workers, factory };
}

function baseOptions(factory: WorkerFactory): CreateTypesetterOptions {
  return { assetsBaseUrl: '/dist', bundles: BUNDLES, inventory: INVENTORY, workerFactory: factory };
}

function resultFields(opts: { pdf?: Uint8Array; ok?: boolean; exitCode?: number; log?: string } = {}): ResultFields {
  return {
    ok: opts.ok ?? true,
    exitCode: opts.exitCode ?? 0,
    log: opts.log ?? '',
    stats: { passes: 1, elapsedMs: 5, bundlesLoaded: ['texlive-basic'] },
    ...(opts.pdf !== undefined ? { pdf: opts.pdf } : {}),
  };
}

/** Boot a typesetter over a recording fake-worker factory (auto-init). */
async function spawn(extra?: Partial<CreateTypesetterOptions>): Promise<{
  tex: Typesetter;
  workers: FakeWorker[];
}> {
  const { workers, factory } = recordingFactory({ autoInit: true });
  const tex = await createTypesetter({ ...baseOptions(factory), ...extra });
  return { tex, workers };
}

const job = (entry: string): TypesetJob => ({ engine: 'xetex', entry, files: { [entry]: 'x' } });

// ---------------------------------------------------------------------------
// createTypesetter / init handshake
// ---------------------------------------------------------------------------

describe('createTypesetter — boot + validation', () => {
  it('spawns a worker, sends a validated init, and resolves once initialized', async () => {
    const { tex, workers } = await spawn();
    expect(workers).toHaveLength(1);
    const init = workers[0]!.init();
    expect(init.assets.baseUrl).toBe('/dist');
    expect(init.assets.bundles.preload).toEqual(['texlive-basic']);
    expect(typesetterDiagnostics(tex).workerSpawns).toBe(1);
    await tex.dispose();
  });

  it('rejects a malformed inventory with TypesetInputError (before any worker work)', async () => {
    const { factory } = recordingFactory();
    const err = await createTypesetter({
      assetsBaseUrl: '/dist',
      bundles: BUNDLES,
      workerFactory: factory,
      inventory: { assets: [{ role: 'engine-js' }] } as unknown as AssetsInventory, // entry lacks `path`
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypesetInputError);
  });

  it('rejects an empty assetsBaseUrl with TypesetInputError', async () => {
    const { factory } = recordingFactory();
    const err = await createTypesetter({ assetsBaseUrl: '', bundles: BUNDLES, inventory: INVENTORY, workerFactory: factory }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypesetInputError);
  });

  it('a fatal during init rejects createTypesetter with FatalError(init-failed) and terminates the worker', async () => {
    const { workers, factory } = recordingFactory({ autoInit: false });
    const pending = createTypesetter(baseOptions(factory));
    await flush();
    const init = workers[0]!.init();
    workers[0]!.emit(fatalMessage(init.jobId, 'init-failed', 'texlive-basic.data 404', 'texlive-basic.data'));
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).code).toBe('init-failed');
    expect((err as FatalError).detail).toBe('texlive-basic.data');
    expect(workers[0]!.terminateCalls).toBe(1); // no worker leaked
  });

  it('a crash during init rejects createTypesetter with WorkerCrashedError', async () => {
    const { workers, factory } = recordingFactory({ autoInit: false });
    const pending = createTypesetter(baseOptions(factory));
    await flush();
    workers[0]!.crash('load failed');
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect((err as WorkerCrashedError).detail).toContain('load failed');
    expect(workers[0]!.terminateCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (iii) Serialization
// ---------------------------------------------------------------------------

describe('client — job serialization (§5.2)', () => {
  it('queues a second typeset() until the first settles, on one worker', async () => {
    const { tex, workers } = await spawn();
    const w = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    const b = tex.typeset(job('b.tex'));
    await flush();

    // Only A is on the wire; B waits.
    expect(w.compiles().map((m) => m.entry)).toEqual(['a.tex']);

    w.emit(resultMessage(w.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await a.done).ok).toBe(true);
    await flush();

    // Now B dispatches — same worker, no reinit.
    expect(w.compiles().map((m) => m.entry)).toEqual(['a.tex', 'b.tex']);
    expect(workers).toHaveLength(1);

    w.emit(resultMessage(w.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await b.done).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (ii) Real cancellation + transparent reinit
// ---------------------------------------------------------------------------

describe('client — cancel() (§5.2 real cancellation)', () => {
  it('terminates the worker, rejects with CancelledError, and the next job reinits on a fresh worker', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    await flush();
    expect(w0.compiles()).toHaveLength(1); // A running

    a.cancel();
    const err = await a.done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).reason).toBe('cancelled');
    expect(w0.terminateCalls).toBe(1); // real termination

    // Next job: a NEW worker + re-init, then a clean compile.
    const b = tex.typeset(job('b.tex'));
    await flush();
    expect(workers).toHaveLength(2);
    expect(typesetterDiagnostics(tex).workerSpawns).toBe(2);
    const w1 = workers[1]!;
    w1.emit(resultMessage(w1.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await b.done).ok).toBe(true);
  });

  it('cancelling a queued (not-yet-running) job drops it without touching the running worker', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    const b = tex.typeset(job('b.tex'));
    await flush(); // A running, B queued

    b.cancel(); // queued → just dropped
    await expect(b.done).rejects.toBeInstanceOf(CancelledError);
    expect(w0.terminateCalls).toBe(0); // A's worker untouched
    expect(workers).toHaveLength(1);

    w0.emit(resultMessage(w0.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await a.done).ok).toBe(true);
    await flush();
    // B never ran: only A's compile ever reached the worker.
    expect(w0.compiles().map((m) => m.entry)).toEqual(['a.tex']);
  });
});

// ---------------------------------------------------------------------------
// (i) Correlation gate: a stale message can never resolve a newer job
// ---------------------------------------------------------------------------

describe('client — correlation gate (§5.2, constitutional)', () => {
  it('a stale result for a cancelled job A cannot resolve a newer job B', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    await flush();
    const staleAJobId = w0.lastCompile().jobId;

    a.cancel();
    await expect(a.done).rejects.toBeInstanceOf(CancelledError); // A already rejected

    // B starts on the fresh worker.
    const b = tex.typeset(job('b.tex'));
    await flush();
    const w1 = workers[1]!;
    const bJobId = w1.lastCompile().jobId;

    // A stale A-result arriving on the current channel must be dropped by the gate.
    const droppedBefore = typesetterDiagnostics(tex).droppedMessages;
    w1.emit(resultMessage(staleAJobId, resultFields({ pdf: new Uint8Array([1, 2, 3]) })));
    await flush();
    expect(typesetterDiagnostics(tex).droppedMessages).toBe(droppedBefore + 1);

    // A message on the OLD (terminated) worker is inert too (onmessage nulled).
    expect(() => w0.emit(resultMessage(staleAJobId, resultFields({ pdf: PDF })))).not.toThrow();

    // B resolves ONLY from its own result — never A's stale bytes.
    w1.emit(resultMessage(bJobId, resultFields({ pdf: PDF })));
    const rb = await b.done;
    expect(rb.pdf).toEqual(PDF);
  });

  it('drops unparseable / foreign inbound messages (counted for debugging)', async () => {
    const { tex, workers } = await spawn();
    const before = typesetterDiagnostics(tex).droppedMessages;
    // After init, #currentJobId is null, so everything drops.
    workers[0]!.onmessage?.({ data: { not: 'a message' } });
    workers[0]!.onmessage?.({ data: 'garbage' });
    workers[0]!.onmessage?.({ data: initializedMessage('some-foreign-id' as never) });
    expect(typesetterDiagnostics(tex).droppedMessages).toBe(before + 3);
    await tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// (iv) dispose()
// ---------------------------------------------------------------------------

describe('client — dispose()', () => {
  it('terminates the worker and rejects the active + queued jobs, then forbids typeset()', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    const b = tex.typeset(job('b.tex'));
    const c = tex.typeset(job('c.tex'));
    await flush(); // A running, B/C queued

    await tex.dispose();
    expect(w0.terminateCalls).toBe(1);

    for (const j of [a, b, c]) {
      const err = await j.done.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CancelledError);
      expect((err as CancelledError).reason).toBe('disposed');
    }

    expect(() => tex.typeset(job('d.tex'))).toThrow(TypesetInputError);
    await tex.dispose(); // idempotent
  });
});

// ---------------------------------------------------------------------------
// Fatal handling + worker crash mid-job
// ---------------------------------------------------------------------------

describe('client — fatal + crash', () => {
  it('a worker fatal rejects the job with FatalError carrying the protocol code (worker reusable)', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    // luatex is a valid PROTOCOL engine (reserved), so it passes client validation
    // and the WORKER rejects it — the client surfaces that as FatalError.
    const j = tex.typeset({ engine: 'luatex', entry: 'a.tex', files: { 'a.tex': 'x' } });
    await flush();
    w0.emit(fatalMessage(w0.lastCompile().jobId, 'unsupported-engine', "engine 'luatex' is not implemented in v1"));
    const err = await j.done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).code).toBe('unsupported-engine');

    // unsupported-engine does not corrupt the engine → the next job REUSES the worker.
    const k = tex.typeset(job('b.tex'));
    await flush();
    expect(workers).toHaveLength(1);
    w0.emit(resultMessage(w0.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await k.done).ok).toBe(true);
  });

  it('an engine-aborted fatal tears the worker down so the next job reinits', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const j = tex.typeset(job('a.tex'));
    await flush();
    w0.emit(fatalMessage(w0.lastCompile().jobId, 'engine-aborted', "applet 'xelatex' aborted: RuntimeError"));
    await expect(j.done).rejects.toBeInstanceOf(FatalError);
    expect(w0.terminateCalls).toBe(1); // corrupt engine dropped

    const k = tex.typeset(job('b.tex'));
    await flush();
    expect(workers).toHaveLength(2); // reinit
    const w1 = workers[1]!;
    w1.emit(resultMessage(w1.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await k.done).ok).toBe(true);
  });

  it('a worker crash mid-job rejects the active job with WorkerCrashedError; the next job reinits', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const a = tex.typeset(job('a.tex'));
    await flush();
    w0.crash('worker segfault');
    const err = await a.done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect((err as WorkerCrashedError).detail).toContain('segfault');
    expect(w0.terminateCalls).toBe(1);

    const b = tex.typeset(job('b.tex'));
    await flush();
    expect(workers).toHaveLength(2);
    const w1 = workers[1]!;
    w1.emit(resultMessage(w1.lastCompile().jobId, resultFields({ pdf: PDF })));
    expect((await b.done).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Result assembly + log streaming
// ---------------------------------------------------------------------------

describe('client — result + log streaming', () => {
  it('assembles the §5.1 result (pdf/log/stats) with an empty diagnostics seam (item 8)', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const j = tex.typeset(job('a.tex'));
    await flush();
    w0.emit(
      resultMessage(w0.lastCompile().jobId, {
        ok: true,
        exitCode: 0,
        log: 'This is XeTeX',
        stats: { passes: 2, elapsedMs: 42, bundlesLoaded: ['texlive-basic'] },
        pdf: PDF,
      }),
    );
    const r = await j.done;
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.pdf).toEqual(PDF);
    expect(r.synctex).toBeUndefined();
    expect(r.log).toBe('This is XeTeX');
    expect(r.stats).toEqual({ passes: 2, elapsedMs: 42, bundlesLoaded: ['texlive-basic'] });
    expect(r.diagnostics).toEqual([]); // seam: item 8 wires the parser
    await tex.dispose();
  });

  it('streams log lines in order; a late onLog replays earlier lines', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    const j = tex.typeset(job('a.tex'));
    const early: string[] = [];
    j.onLog((line) => early.push(line));
    await flush();
    const jobId = w0.lastCompile().jobId;

    w0.emit(logMessage(jobId, 'stdout', 'line 1'));
    w0.emit(logMessage(jobId, 'stderr', 'line 2'));
    // A progress message is correlated but not surfaced (no-op, not a log line).
    w0.emit(progressMessage(jobId, { kind: 'xdvipdfmx' }));

    const late: string[] = [];
    j.onLog((line) => late.push(line)); // registered mid-stream → replays 1,2 then live 3
    w0.emit(logMessage(jobId, 'stdout', 'line 3'));
    w0.emit(resultMessage(jobId, resultFields({ pdf: PDF, log: 'line 1\nline 2\nline 3' })));

    await j.done;
    expect(early).toEqual(['line 1', 'line 2', 'line 3']);
    expect(late).toEqual(['line 1', 'line 2', 'line 3']);
    await tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// Strict client-side input validation (reuses the protocol validator)
// ---------------------------------------------------------------------------

describe('client — input validation (typed, before postMessage)', () => {
  it('throws TypesetInputError synchronously for bad engine / passes / paths / values', async () => {
    const { tex, workers } = await spawn();
    const rejects = (input: unknown): void =>
      expect(() => tex.typeset(input as TypesetJob)).toThrow(TypesetInputError);

    rejects({ engine: 'latex', entry: 'a.tex', files: { 'a.tex': 'x' } }); // unknown engine
    rejects({ engine: 'xetex', entry: '../escape.tex', files: { 'a.tex': 'x' } }); // traversal entry
    rejects({ engine: 'xetex', entry: '/etc/passwd', files: { 'a.tex': 'x' } }); // absolute entry
    rejects({ engine: 'xetex', entry: 'a.tex', files: { '../leak.tex': 'x', 'a.tex': 'y' } }); // traversal file key
    rejects({ engine: 'xetex', entry: 'a.tex', files: { 'a.tex': 'x' }, passes: 7 }); // passes out of range
    rejects({ engine: 'xetex', entry: 'a.tex', files: { 'a.tex': 'x' }, passes: 0 });
    rejects({ engine: 'xetex', entry: 'a.tex', files: { 'a.tex': 42 } }); // non ProjectFile value
    rejects({ engine: 'xetex', entry: 'a.tex', files: { 'a.tex': 'x' }, bibliography: 'yes' }); // bad AutoOff

    // No bad job ever reached the worker.
    expect(workers[0]!.compiles()).toHaveLength(0);
    await tex.dispose();
  });

  it('accepts a legitimate subdirectory entry + files, and defaults the optional knobs', async () => {
    const { tex, workers } = await spawn();
    const w0 = workers[0]!;
    tex.typeset({ engine: 'xetex', entry: 'src/main.tex', files: { 'src/main.tex': 'x', 'src/fig/a.pdf': new Uint8Array([1]) } });
    await flush();
    const c = w0.lastCompile();
    expect(c.entry).toBe('src/main.tex');
    expect(c.passes).toBe('auto'); // defaulted
    expect(c.bibliography).toBe('auto');
    expect(c.index).toBe('auto');
    expect(c.synctex).toBe(false);
    await tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// locateAsset override — client injects a per-entry url into the init inventory
// ---------------------------------------------------------------------------

describe('client — locateAsset override (DESIGN §5.1)', () => {
  it('injects the returned URLs as per-entry `url` on the init inventory; leaves others alone', async () => {
    const overrides: Record<string, string> = {
      'busytex.wasm': 'https://cdn.example/xetex.wasm',
      'texlive-basic.data': 'wasmtex-assets://custom/tl.data',
    };
    const { workers, factory } = recordingFactory({ autoInit: true });
    const tex = await createTypesetter({ ...baseOptions(factory), locateAsset: (name) => overrides[name] });

    const inv = workers[0]!.init().assets.inventory;
    const byPath = (p: string) => inv.assets.find((a) => a.path === p);
    expect(byPath('busytex.wasm')?.url).toBe('https://cdn.example/xetex.wasm');
    expect(byPath('texlive-basic.data')?.url).toBe('wasmtex-assets://custom/tl.data');
    expect(byPath('busytex.js')?.url).toBeUndefined(); // un-overridden
    await tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// Coarse asset progress (honest fidelity — no fabricated bytes)
// ---------------------------------------------------------------------------

describe('client — onAssetProgress (coarse per-phase)', () => {
  it('emits start (loadedBytes 0) then done (=totalBytes) for each init-loaded asset, using real sizes', async () => {
    const events: AssetProgress[] = [];
    const { factory } = recordingFactory({ autoInit: true });
    const tex = await createTypesetter({ ...baseOptions(factory), onAssetProgress: (p) => events.push(p) });

    const assetIds = new Set(events.map((e) => e.assetId));
    expect(assetIds).toEqual(new Set(['busytex.js', 'busytex.wasm', 'texlive-basic.js', 'texlive-basic.data']));

    // Honesty: every event is a boundary (0 or full), never a fabricated intermediate.
    expect(events.every((e) => e.loadedBytes === 0 || e.loadedBytes === e.totalBytes)).toBe(true);
    // totalBytes is the manifest's real size.
    const wasmDone = events.find((e) => e.assetId === 'busytex.wasm' && e.loadedBytes === e.totalBytes);
    expect(wasmDone?.totalBytes).toBe(30_000_000);
    // Both phases fired (start events with loadedBytes 0, done events with loadedBytes = total).
    expect(events.some((e) => e.loadedBytes === 0)).toBe(true);
    expect(events.some((e) => e.totalBytes > 0 && e.loadedBytes === e.totalBytes)).toBe(true);
    await tex.dispose();
  });
});

// ---------------------------------------------------------------------------
// assets.json fetch path (no inventory supplied)
// ---------------------------------------------------------------------------

describe('client — assets.json fetch path', () => {
  it('fetches assets.json from the base URL, honoring locateAsset(assets.json)', async () => {
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => INVENTORY };
    };
    const { workers, factory } = recordingFactory({ autoInit: true });
    const tex = await createTypesetter({
      assetsBaseUrl: 'wasmtex-assets://dist',
      bundles: BUNDLES,
      workerFactory: factory,
      fetchImpl,
      locateAsset: (name) => (name === 'assets.json' ? 'wasmtex-assets://custom/manifest.json' : undefined),
    });
    expect(fetched).toEqual(['wasmtex-assets://custom/manifest.json']);
    expect(workers[0]!.init().assets.inventory.assets.map((a) => a.path)).toContain('busytex.wasm');
    await tex.dispose();
  });

  it('defaults the assets.json URL to base + assets.json', async () => {
    const fetched: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => INVENTORY };
    };
    const { factory } = recordingFactory({ autoInit: true });
    const tex = await createTypesetter({ assetsBaseUrl: '/assets/', bundles: BUNDLES, workerFactory: factory, fetchImpl });
    expect(fetched).toEqual(['/assets/assets.json']);
    await tex.dispose();
  });

  it('surfaces an HTTP failure as FatalError(init-failed)', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const { factory } = recordingFactory();
    const err = await createTypesetter({ assetsBaseUrl: '/dist', bundles: BUNDLES, workerFactory: factory, fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FatalError);
    expect((err as FatalError).code).toBe('init-failed');
  });
});

// ---------------------------------------------------------------------------
// typesetterDiagnostics guard
// ---------------------------------------------------------------------------

describe('typesetterDiagnostics', () => {
  it('throws for an object that is not a wasmtex Typesetter', () => {
    const notOurs: Typesetter = { typeset: () => ({}) as never, dispose: async () => {} };
    expect(() => typesetterDiagnostics(notOurs)).toThrow(TypesetInputError);
  });
});

// ---------------------------------------------------------------------------
// Regression: queue integrity when a QUEUED job is cancelled during reinit.
// #cancelJob splices the cancelled handle out of the queue; the pump's
// settled-head path must therefore remove by IDENTITY — a shift() there
// removed the NEXT job, which was never dispatched and whose `done` hung
// forever (caught in the item-7 review with a live repro).
// ---------------------------------------------------------------------------

describe('regression: cancelling a queued job during reinit does not drop the next job', () => {
  it('C still dispatches and settles after B (queued ahead of it) is cancelled mid-init', async () => {
    // Worker 1 auto-inits; every later worker requires a manual `initialized`,
    // holding the queue in the awaiting-init window the bug lived in.
    const workers: FakeWorker[] = [];
    const factory: WorkerFactory = () => {
      const w = new FakeWorker({ autoInit: workers.length === 0 });
      workers.push(w);
      return w;
    };
    const tex = await createTypesetter({ ...baseOptions(factory), workerFactory: factory });

    // Job A active on worker 1; cancel tears worker 1 down.
    const a = tex.typeset({ engine: 'xetex', entry: 'a.tex', files: { 'a.tex': 'x' } });
    a.cancel();
    await expect(a.done).rejects.toBeInstanceOf(CancelledError);

    // B and C queue while worker 2's init is pending (manual init).
    const b = tex.typeset({ engine: 'xetex', entry: 'b.tex', files: { 'b.tex': 'x' } });
    const c = tex.typeset({ engine: 'xetex', entry: 'c.tex', files: { 'c.tex': 'x' } });
    await flush();
    const worker2 = workers[1];
    expect(worker2).toBeDefined();
    expect(worker2!.compiles()).toHaveLength(0); // still awaiting init

    // Cancel B while it is the queued head and init is in flight.
    b.cancel();
    await expect(b.done).rejects.toBeInstanceOf(CancelledError);

    // Init completes: C — not nothing — must dispatch.
    worker2!.emit(initializedMessage(worker2!.init().jobId));
    await flush();
    const compiles = worker2!.compiles();
    expect(compiles).toHaveLength(1);
    expect(compiles[0]!.entry).toBe('c.tex');

    // And C settles normally with its own result.
    worker2!.emit(resultMessage(compiles[0]!.jobId, resultFields({ pdf: new Uint8Array([1]) })));
    const rc = await c.done;
    expect(rc.ok).toBe(true);
    await tex.dispose();
  });
});
