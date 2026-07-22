// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Protocol-level correlation & validation tests (DESIGN.md §8; M1 item 3). Pure
// node — no worker, no wasm. These are the constitutional §5.2 tests at the
// protocol layer: a late/foreign jobId can never resolve a newer job, and the
// boundary validator is total and hostile-input-proof. The client-side
// correlation tests (in-flight cancel, transparent reinit) arrive with item 7.

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  isForJob,
  newJobId,
  parseWorkerMessage,
  transferablesOf,
  type CompileMessage,
  type FatalMessage,
  type InitMessage,
  type LogMessage,
  type ProgressMessage,
  type ResultMessage,
} from '../src/protocol';

describe('newJobId — session-unique correlation tokens', () => {
  it('mints unique, non-empty strings across a large loop', () => {
    const n = 100_000;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const id = newJobId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      seen.add(id);
    }
    expect(seen.size).toBe(n);
  });

  it('does not collide within a single millisecond (no Date.now dependence)', () => {
    // A tight synchronous loop mints many ids inside one wall-clock ms; the
    // monotonic counter keeps them distinct with no reliance on the clock.
    const ids = Array.from({ length: 1000 }, () => newJobId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isForJob — the correlation gate (DESIGN §5.2)', () => {
  it('rejects a foreign jobId and accepts the owning one', () => {
    const active = newJobId();
    const foreign = newJobId();
    const msg: LogMessage = {
      type: 'log',
      v: PROTOCOL_VERSION,
      jobId: foreign,
      stream: 'stdout',
      line: 'hello',
    };
    expect(isForJob(msg, active)).toBe(false);
    expect(isForJob(msg, foreign)).toBe(true);
  });

  it('never attributes a cancelled job’s late result to a newer job', () => {
    // The §5.2 scenario, concretely. Job A starts; it is cancelled (the worker
    // is terminated) and the client moves on to job B. A `result` for A — which
    // was already in flight, or is a timed-out straggler — arrives afterwards.
    const jobA = newJobId();
    const jobB = newJobId();
    expect(jobA).not.toBe(jobB);

    const lateResultForA: ResultMessage = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId: jobA,
      ok: true,
      exitCode: 0,
      log: '(stale transcript from the cancelled job)',
      stats: { passes: 1, elapsedMs: 1, bundlesLoaded: [] },
    };

    // The client is now waiting on B and gates on B: the stale message is
    // dropped and can NEVER resolve B.
    expect(isForJob(lateResultForA, jobB)).toBe(false);
    // Correlation is exact identity, not fuzzy: it genuinely is A's message.
    expect(isForJob(lateResultForA, jobA)).toBe(true);
  });
});

describe('parseWorkerMessage — accepts well-formed messages', () => {
  const jobId = newJobId();

  it('initialized', () => {
    const raw = { type: 'initialized', v: PROTOCOL_VERSION, jobId };
    expect(parseWorkerMessage(raw)).toEqual(raw);
  });

  it('log (both streams)', () => {
    const out = { type: 'log', v: PROTOCOL_VERSION, jobId, stream: 'stdout', line: 'a' };
    const err = { type: 'log', v: PROTOCOL_VERSION, jobId, stream: 'stderr', line: 'b' };
    expect(parseWorkerMessage(out)).toEqual(out);
    expect(parseWorkerMessage(err)).toEqual(err);
  });

  it('progress (engine pass carries an ordinal; tool phases do not)', () => {
    const engine = { type: 'progress', v: PROTOCOL_VERSION, jobId, phase: { kind: 'engine', pass: 3 } };
    expect(parseWorkerMessage(engine)).toEqual(engine);
    for (const kind of ['bibtex8', 'makeindex', 'xdvipdfmx'] as const) {
      const msg = { type: 'progress', v: PROTOCOL_VERSION, jobId, phase: { kind } };
      expect(parseWorkerMessage(msg)).toEqual(msg);
    }
  });

  it('result (with and without optional byte payloads)', () => {
    const pdf = new Uint8Array([1, 2]);
    const synctex = new Uint8Array([3]);
    const full = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId,
      ok: true,
      exitCode: 0,
      log: 'L',
      stats: { passes: 2, elapsedMs: 5, bundlesLoaded: ['core', 'extended'] },
      pdf,
      synctex,
    };
    expect(parseWorkerMessage(full)).toEqual(full);

    const bare = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId,
      ok: false,
      exitCode: 1,
      log: '',
      stats: { passes: 0, elapsedMs: 0, bundlesLoaded: [] },
    };
    expect(parseWorkerMessage(bare)).toEqual(bare);
  });

  it('fatal (with and without detail)', () => {
    const withDetail = {
      type: 'fatal',
      v: PROTOCOL_VERSION,
      jobId,
      code: 'init-failed',
      message: 'asset load failed',
      detail: 'core.data',
    };
    expect(parseWorkerMessage(withDetail)).toEqual(withDetail);

    const bare = { type: 'fatal', v: PROTOCOL_VERSION, jobId, code: 'internal', message: 'boom' };
    expect(parseWorkerMessage(bare)).toEqual(bare);
  });

  it('reconstructs a fresh, exact object (strips unexpected extra keys)', () => {
    const parsed = parseWorkerMessage({
      type: 'log',
      v: PROTOCOL_VERSION,
      jobId,
      stream: 'stdout',
      line: 'hi',
      injected: 'X',
      extra: 42,
    });
    expect(parsed).toEqual({ type: 'log', v: PROTOCOL_VERSION, jobId, stream: 'stdout', line: 'hi' });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual(['jobId', 'line', 'stream', 'type', 'v']);
  });
});

describe('parseWorkerMessage — rejects malformed / hostile input (null, never throws)', () => {
  const jobId = newJobId();

  it('non-objects', () => {
    const bads = [null, undefined, 0, 1, -1, NaN, 'str', '', true, false, Symbol('x'), [], [1, 2]];
    for (const bad of bads) {
      expect(parseWorkerMessage(bad)).toBeNull();
    }
  });

  it('wrong or missing protocol version', () => {
    expect(parseWorkerMessage({ type: 'log', v: 2, jobId, stream: 'stdout', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: '1', jobId, stream: 'stdout', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: 1.0000001, jobId, stream: 'stdout', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', jobId, stream: 'stdout', line: 'x' })).toBeNull();
  });

  it('missing or blank jobId', () => {
    expect(parseWorkerMessage({ type: 'log', v: 1, stream: 'stdout', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId: '', stream: 'stdout', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId: 123, stream: 'stdout', line: 'x' })).toBeNull();
  });

  it('unknown, missing, or client-side type', () => {
    expect(parseWorkerMessage({ type: 'nope', v: 1, jobId })).toBeNull();
    expect(parseWorkerMessage({ v: 1, jobId })).toBeNull();
    // `init` / `compile` are CLIENT→worker; they are not worker messages.
    expect(parseWorkerMessage({ type: 'init', v: 1, jobId, assets: {} })).toBeNull();
    expect(parseWorkerMessage({ type: 'compile', v: 1, jobId })).toBeNull();
  });

  it('type values inherited from Object.prototype are rejected, never invoked', () => {
    // Without an own-key guard, a plain-object parser table resolves these to
    // Object.prototype members — "constructor" would return the hostile
    // object BY REFERENCE via `Object(data, jobId)`. Each must parse to null.
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const hostile = { type, v: 1, jobId, evil: 'payload' };
      const parsed = parseWorkerMessage(hostile);
      expect(parsed).toBeNull();
      // And specifically: never the input object itself.
      expect(parsed).not.toBe(hostile as unknown);
    }
  });

  it('SharedArrayBuffer-backed views are excluded from transferables', () => {
    const sab = new Uint8Array(new SharedArrayBuffer(4));
    sab.set([1, 2, 3, 4]);
    const msg = {
      type: 'result', v: 1, jobId, ok: true, exitCode: 0,
      pdf: sab, log: '', stats: { passes: 1, elapsedMs: 1, bundlesLoaded: [] },
    };
    const parsed = parseWorkerMessage(msg);
    expect(parsed).not.toBeNull();
    expect(transferablesOf(parsed!)).toEqual([]);
  });

  it('per-type shape violations', () => {
    // log
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId, stream: 'other', line: 'x' })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId, stream: 'stdout', line: 5 })).toBeNull();
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId, stream: 'stdout' })).toBeNull();
    // progress
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId, phase: { kind: 'engine' } })).toBeNull();
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId, phase: { kind: 'engine', pass: 0 } })).toBeNull();
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId, phase: { kind: 'engine', pass: 1.5 } })).toBeNull();
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId, phase: { kind: 'bogus' } })).toBeNull();
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId, phase: 'engine' })).toBeNull();
    expect(parseWorkerMessage({ type: 'progress', v: 1, jobId })).toBeNull();
    // result
    const okStats = { passes: 1, elapsedMs: 0, bundlesLoaded: [] };
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: 'yes', exitCode: 0, log: '', stats: okStats })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 1.2, log: '', stats: okStats })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 0, log: 5, stats: okStats })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 0, log: '' })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 0, log: '', stats: { passes: -1, elapsedMs: 0, bundlesLoaded: [] } })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 0, log: '', stats: { passes: 1, elapsedMs: -1, bundlesLoaded: [] } })).toBeNull();
    expect(parseWorkerMessage({ type: 'result', v: 1, jobId, ok: true, exitCode: 0, log: '', stats: { passes: 1, elapsedMs: 0, bundlesLoaded: [7] } })).toBeNull();
    // fatal
    expect(parseWorkerMessage({ type: 'fatal', v: 1, jobId, code: 'nope', message: 'm' })).toBeNull();
    expect(parseWorkerMessage({ type: 'fatal', v: 1, jobId, code: 'internal', message: 5 })).toBeNull();
    expect(parseWorkerMessage({ type: 'fatal', v: 1, jobId, code: 'internal', message: 'm', detail: 5 })).toBeNull();
    expect(parseWorkerMessage({ type: 'fatal', v: 1, jobId, message: 'm' })).toBeNull();
  });

  it('oversized wrong-typed payloads (rejected by type, not by size)', () => {
    const bigBytes = new Uint8Array(1_000_000);
    // Bytes where a string is required → rejected.
    expect(parseWorkerMessage({ type: 'log', v: 1, jobId, stream: 'stdout', line: bigBytes })).toBeNull();
    // A string where bytes are required → rejected.
    expect(
      parseWorkerMessage({
        type: 'result',
        v: 1,
        jobId,
        ok: true,
        exitCode: 0,
        log: 'ok',
        stats: { passes: 1, elapsedMs: 0, bundlesLoaded: [] },
        pdf: 'not-bytes',
      }),
    ).toBeNull();
    // A genuinely large but correctly-typed payload is NOT a defect: accepted.
    const bigButValid = parseWorkerMessage({
      type: 'result',
      v: 1,
      jobId,
      ok: true,
      exitCode: 0,
      log: 'x'.repeat(500_000),
      stats: { passes: 1, elapsedMs: 0, bundlesLoaded: new Array(50_000).fill('b') },
    });
    expect(bigButValid).not.toBeNull();
  });
});

describe('parseWorkerMessage — prototype pollution & totality', () => {
  it('does not pollute Object.prototype and rebuilds a clean object', () => {
    // JSON.parse defines an OWN "__proto__" data property (it does not invoke
    // the setter); the parser must ignore it and never leak it.
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"type":"log","v":1,"jobId":"j1","stream":"stdout","line":"hi"}',
    ) as unknown;
    const parsed = parseWorkerMessage(raw);
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed).toEqual({ type: 'log', v: 1, jobId: 'j1', stream: 'stdout', line: 'hi' });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'polluted')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
  });

  it('ignores a constructor/prototype pollution attempt', () => {
    const raw = JSON.parse(
      '{"constructor":{"prototype":{"polluted":true}},"type":"progress","v":1,"jobId":"j1","phase":{"kind":"bibtex8"}}',
    ) as unknown;
    const parsed = parseWorkerMessage(raw);
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed).toEqual({ type: 'progress', v: 1, jobId: 'j1', phase: { kind: 'bibtex8' } });
  });

  it('never throws — even on a throwing getter (totality backstop)', () => {
    const evil = {
      v: 1,
      jobId: 'j1',
      get type(): string {
        throw new Error('boom');
      },
    };
    expect(() => parseWorkerMessage(evil)).not.toThrow();
    expect(parseWorkerMessage(evil)).toBeNull();
  });
});

describe('structuredClone round-trips (Uint8Array preserved)', () => {
  it('a result with pdf/synctex survives the boundary and re-parses', () => {
    const jobId = newJobId();
    const pdf = new Uint8Array([37, 80, 68, 70, 45]); // "%PDF-"
    const synctex = new Uint8Array([1, 2, 3]);
    const result: ResultMessage = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId,
      ok: true,
      exitCode: 0,
      log: 'done',
      stats: { passes: 2, elapsedMs: 12, bundlesLoaded: ['core'] },
      pdf,
      synctex,
    };
    const clone = structuredClone(result);
    expect(clone.pdf).toBeInstanceOf(Uint8Array);
    expect(Array.from(clone.pdf ?? new Uint8Array())).toEqual([37, 80, 68, 70, 45]);
    expect(Array.from(clone.synctex ?? new Uint8Array())).toEqual([1, 2, 3]);
    expect(clone.jobId).toBe(jobId);
    expect(parseWorkerMessage(clone)).not.toBeNull();
  });

  it('a compile files map survives the boundary (bytes and text)', () => {
    const jobId = newJobId();
    const bytes = new Uint8Array([255, 0, 128]);
    const compile: CompileMessage = {
      type: 'compile',
      v: PROTOCOL_VERSION,
      jobId,
      files: { 'main.tex': '\\documentclass{article}', 'logo.bin': bytes },
      entry: 'main.tex',
      engine: 'xetex',
      passes: 'auto',
      bibliography: 'auto',
      index: 'auto',
      synctex: false,
    };
    const clone = structuredClone(compile);
    expect(clone.files['main.tex']).toBe('\\documentclass{article}');
    expect(clone.files['logo.bin']).toBeInstanceOf(Uint8Array);
    expect(Array.from(clone.files['logo.bin'] as Uint8Array)).toEqual([255, 0, 128]);
  });
});

describe('transferablesOf — exactly the underlying buffers, de-duplicated', () => {
  it('collects the buffers of Uint8Array compile inputs and ignores text', () => {
    const jobId = newJobId();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const compile: CompileMessage = {
      type: 'compile',
      v: PROTOCOL_VERSION,
      jobId,
      files: { 'a.bin': a, 'main.tex': 'text', 'b.bin': b },
      entry: 'main.tex',
      engine: 'xetex',
      passes: 1,
      bibliography: 'off',
      index: 'off',
      synctex: false,
    };
    const bufs = transferablesOf(compile);
    expect(bufs).toHaveLength(2);
    expect(bufs).toContain(a.buffer);
    expect(bufs).toContain(b.buffer);
  });

  it('collects pdf and synctex buffers from a result', () => {
    const jobId = newJobId();
    const pdf = new Uint8Array([1]);
    const synctex = new Uint8Array([2]);
    const result: ResultMessage = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId,
      ok: true,
      exitCode: 0,
      log: '',
      stats: { passes: 1, elapsedMs: 0, bundlesLoaded: [] },
      pdf,
      synctex,
    };
    const bufs = transferablesOf(result);
    expect(bufs).toHaveLength(2);
    expect(bufs).toContain(pdf.buffer);
    expect(bufs).toContain(synctex.buffer);
  });

  it('de-duplicates a buffer shared by multiple views', () => {
    const jobId = newJobId();
    const shared = new ArrayBuffer(8);
    const v1 = new Uint8Array(shared, 0, 4);
    const v2 = new Uint8Array(shared, 4, 4);
    const compile: CompileMessage = {
      type: 'compile',
      v: PROTOCOL_VERSION,
      jobId,
      files: { x: v1, y: v2 },
      entry: 'x',
      engine: 'xetex',
      passes: 'auto',
      bibliography: 'off',
      index: 'off',
      synctex: false,
    };
    const bufs = transferablesOf(compile);
    expect(bufs).toHaveLength(1);
    expect(bufs[0]).toBe(shared);
  });

  it('returns nothing for messages without byte payloads', () => {
    const jobId = newJobId();
    const log: LogMessage = { type: 'log', v: PROTOCOL_VERSION, jobId, stream: 'stdout', line: 'x' };
    const progress: ProgressMessage = { type: 'progress', v: PROTOCOL_VERSION, jobId, phase: { kind: 'bibtex8' } };
    const fatal: FatalMessage = { type: 'fatal', v: PROTOCOL_VERSION, jobId, code: 'internal', message: 'x' };
    const init: InitMessage = {
      type: 'init',
      v: PROTOCOL_VERSION,
      jobId,
      assets: { baseUrl: '/dist', inventory: { assets: [] }, bundles: { preload: [], onDemand: [] } },
    };
    const resultNoBytes: ResultMessage = {
      type: 'result',
      v: PROTOCOL_VERSION,
      jobId,
      ok: false,
      exitCode: 1,
      log: '',
      stats: { passes: 0, elapsedMs: 0, bundlesLoaded: [] },
    };
    expect(transferablesOf(log)).toEqual([]);
    expect(transferablesOf(progress)).toEqual([]);
    expect(transferablesOf(fatal)).toEqual([]);
    expect(transferablesOf(init)).toEqual([]);
    expect(transferablesOf(resultNoBytes)).toEqual([]);
  });
});
