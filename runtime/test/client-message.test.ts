// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// The client→worker trust boundary (M1 item 5). `parseClientMessage` mirrors
// `parseWorkerMessage` in the other direction: it is the worker's total,
// hostile-input-proof validator for the two `init`/`compile` envelopes (a
// malicious page in the same realm can post to the Worker too — DESIGN.md §5.2
// / §10 defence in depth). Also pins the outbound-envelope CONSTRUCTORS: every
// message the worker builds must round-trip through `parseWorkerMessage`, so
// what the worker emits and what the client accepts cannot drift.

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  fatalMessage,
  initializedMessage,
  logMessage,
  newJobId,
  parseClientMessage,
  parseWorkerMessage,
  progressMessage,
  resultMessage,
  type ProgressPhase,
} from '../src/protocol';

const jobId = newJobId();

const VALID_ASSETS = {
  baseUrl: '/dist',
  inventory: {
    schemaVersion: 1,
    generated: '2026-06-16T14:06:37.000Z',
    assets: [
      { path: 'busytex.js', bytes: 10, sha256: 'ab', role: 'engine-js' },
      { path: 'texlive-basic.data', role: 'bundle-data' },
    ],
  },
  bundles: { preload: ['texlive-basic'], onDemand: ['extended'] },
};

function validInit(): Record<string, unknown> {
  return { type: 'init', v: PROTOCOL_VERSION, jobId, assets: VALID_ASSETS };
}

function validCompile(): Record<string, unknown> {
  return {
    type: 'compile',
    v: PROTOCOL_VERSION,
    jobId,
    files: { 'main.tex': '\\documentclass{article}', 'logo.bin': new Uint8Array([1, 2, 3]) },
    entry: 'main.tex',
    engine: 'xetex',
    passes: 'auto',
    bibliography: 'auto',
    index: 'off',
    synctex: false,
  };
}

// ---------------------------------------------------------------------------
// Well-formed
// ---------------------------------------------------------------------------

describe('parseClientMessage — accepts well-formed messages', () => {
  it('init (rebuilt exactly, inventory fields preserved)', () => {
    expect(parseClientMessage(validInit())).toEqual(validInit());
  });

  it('compile (bytes and text file payloads preserved by reference)', () => {
    const parsed = parseClientMessage(validCompile());
    expect(parsed).toEqual(validCompile());
    if (parsed?.type === 'compile') {
      expect(parsed.files['logo.bin']).toBeInstanceOf(Uint8Array);
      expect(parsed.files['main.tex']).toBe('\\documentclass{article}');
    }
  });

  it('accepts every engine name and every pass policy', () => {
    for (const engine of ['xetex', 'pdftex', 'luatex'] as const) {
      expect(parseClientMessage({ ...validCompile(), engine })).not.toBeNull();
    }
    for (const passes of ['auto', 1, 2, 3, 4, 5] as const) {
      expect(parseClientMessage({ ...validCompile(), passes })).not.toBeNull();
    }
  });

  it('reconstructs a fresh object, stripping unexpected top-level keys', () => {
    const parsed = parseClientMessage({ ...validCompile(), injected: 'X', extra: 42 });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual([
      'bibliography',
      'engine',
      'entry',
      'files',
      'index',
      'jobId',
      'passes',
      'synctex',
      'type',
      'v',
    ]);
  });

  it('drops inventory forward-compat extras but keeps path (worker-relevant subset)', () => {
    const parsed = parseClientMessage({
      ...validInit(),
      assets: {
        baseUrl: '/dist',
        inventory: {
          assets: [{ path: 'x.js', role: 'engine-js', providesPackages: ['a', 'b'], future: 1 }],
        },
        bundles: { preload: [], onDemand: [] },
      },
    });
    expect(parsed).not.toBeNull();
    if (parsed?.type === 'init') {
      expect(parsed.assets.inventory.assets[0]).toEqual({ path: 'x.js', role: 'engine-js' });
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / hostile — null, never throws
// ---------------------------------------------------------------------------

describe('parseClientMessage — rejects malformed / hostile input', () => {
  it('non-objects', () => {
    for (const bad of [null, undefined, 0, 1, NaN, 'str', '', true, false, Symbol('x'), [], [1]]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });

  it('wrong or missing protocol version', () => {
    expect(parseClientMessage({ ...validInit(), v: 2 })).toBeNull();
    expect(parseClientMessage({ ...validInit(), v: '1' })).toBeNull();
    expect(parseClientMessage({ ...validInit(), v: 1.5 })).toBeNull();
    const noV = validInit();
    delete noV['v'];
    expect(parseClientMessage(noV)).toBeNull();
  });

  it('missing or blank jobId', () => {
    expect(parseClientMessage({ ...validInit(), jobId: '' })).toBeNull();
    expect(parseClientMessage({ ...validInit(), jobId: 123 })).toBeNull();
    const noJob = validInit();
    delete noJob['jobId'];
    expect(parseClientMessage(noJob)).toBeNull();
  });

  it('unknown, missing, or worker→client type', () => {
    expect(parseClientMessage({ type: 'nope', v: 1, jobId })).toBeNull();
    expect(parseClientMessage({ v: 1, jobId })).toBeNull();
    // These five are WORKER→client — not valid inbound client messages.
    for (const type of ['initialized', 'log', 'progress', 'result', 'fatal']) {
      expect(parseClientMessage({ type, v: 1, jobId })).toBeNull();
    }
  });

  it('type values inherited from Object.prototype are rejected, never invoked', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const hostile = { type, v: 1, jobId, evil: 'payload' };
      const parsed = parseClientMessage(hostile);
      expect(parsed).toBeNull();
      expect(parsed).not.toBe(hostile as unknown);
    }
  });

  it('init: assets shape violations', () => {
    expect(parseClientMessage({ ...validInit(), assets: undefined })).toBeNull();
    expect(parseClientMessage({ ...validInit(), assets: 'x' })).toBeNull();
    expect(parseClientMessage({ ...validInit(), assets: { ...VALID_ASSETS, baseUrl: '' } })).toBeNull();
    expect(parseClientMessage({ ...validInit(), assets: { ...VALID_ASSETS, baseUrl: 5 } })).toBeNull();
    // inventory.assets not an array / entry lacking a path
    expect(
      parseClientMessage({
        ...validInit(),
        assets: { ...VALID_ASSETS, inventory: { assets: 'x' } },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        ...validInit(),
        assets: { ...VALID_ASSETS, inventory: { assets: [{ role: 'engine-js' }] } },
      }),
    ).toBeNull();
    // bundles: preload / onDemand must be string arrays
    expect(
      parseClientMessage({
        ...validInit(),
        assets: { ...VALID_ASSETS, bundles: { preload: [1], onDemand: [] } },
      }),
    ).toBeNull();
    expect(
      parseClientMessage({
        ...validInit(),
        assets: { ...VALID_ASSETS, bundles: { preload: [] } },
      }),
    ).toBeNull();
  });

  it('compile: per-field violations', () => {
    expect(parseClientMessage({ ...validCompile(), files: undefined })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), files: [] })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), files: { 'a.tex': 5 } })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), entry: '' })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), entry: 5 })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), engine: 'latex' })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), engine: 5 })).toBeNull();
    for (const passes of [0, 6, 1.5, -1, '1', 'always']) {
      expect(parseClientMessage({ ...validCompile(), passes })).toBeNull();
    }
    expect(parseClientMessage({ ...validCompile(), bibliography: 'yes' })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), index: true })).toBeNull();
    expect(parseClientMessage({ ...validCompile(), synctex: 'false' })).toBeNull();
  });

  it('rejects path traversal / absolute / empty-segment file keys AND entry (item 3 bar)', () => {
    const badPaths = ['../leak.tex', '../../texlive/x', '/etc/passwd', 'a/../b.tex', 'a//b.tex', 'sub/', '', '..'];
    for (const bad of badPaths) {
      // As a file key (paired with a valid key so the bad key is the only cause).
      expect(
        parseClientMessage({ ...validCompile(), files: { [bad]: 'x', 'main.tex': 'y' }, entry: 'main.tex' }),
      ).toBeNull();
      // As the entry (which steers chdir/jobname).
      expect(parseClientMessage({ ...validCompile(), entry: bad })).toBeNull();
    }
    // A legitimate subdirectory path is still accepted (not over-rejected).
    const ok = parseClientMessage({
      ...validCompile(),
      files: { 'src/main.tex': '\\documentclass{article}', 'src/fig/a.pdf': new Uint8Array([1]) },
      entry: 'src/main.tex',
    });
    expect(ok).not.toBeNull();
  });

  it('does not pollute Object.prototype and skips a hostile __proto__ file key', () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"type":"compile","v":1,"jobId":"j1",' +
        '"files":{"__proto__":{"x":1},"main.tex":"hi"},"entry":"main.tex",' +
        '"engine":"xetex","passes":1,"bibliography":"off","index":"off","synctex":false}',
    ) as unknown;
    const parsed = parseClientMessage(raw);
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(parsed).not.toBeNull();
    if (parsed?.type === 'compile') {
      expect(parsed.files).toEqual({ 'main.tex': 'hi' }); // __proto__ file key skipped
      expect(Object.prototype.hasOwnProperty.call(parsed.files, '__proto__')).toBe(false);
    }
  });

  it('never throws — even on a throwing getter (totality backstop)', () => {
    const evil = {
      v: 1,
      jobId: 'j1',
      get type(): string {
        throw new Error('boom');
      },
    };
    expect(() => parseClientMessage(evil)).not.toThrow();
    expect(parseClientMessage(evil)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outbound constructors round-trip through parseWorkerMessage
// ---------------------------------------------------------------------------

describe('worker-message constructors — every output is wire-valid', () => {
  it('initialized / log / progress / fatal', () => {
    const built = [
      initializedMessage(jobId),
      logMessage(jobId, 'stdout', 'line'),
      logMessage(jobId, 'stderr', 'err'),
      progressMessage(jobId, { kind: 'engine', pass: 1 }),
      progressMessage(jobId, { kind: 'xdvipdfmx' }),
      fatalMessage(jobId, 'unsupported-engine', 'no luatex'),
      fatalMessage(jobId, 'init-failed', 'boom', 'core.data'),
    ];
    for (const message of built) {
      expect(parseWorkerMessage(message)).toEqual(message);
      expect(message.v).toBe(PROTOCOL_VERSION);
      expect(message.jobId).toBe(jobId);
    }
  });

  it('progress carries every §5.3 phase', () => {
    const phases: ProgressPhase[] = [
      { kind: 'engine', pass: 3 },
      { kind: 'bibtex8' },
      { kind: 'makeindex' },
      { kind: 'xdvipdfmx' },
    ];
    for (const phase of phases) {
      const message = progressMessage(jobId, phase);
      expect(parseWorkerMessage(message)).toEqual(message);
    }
  });

  it('result — with and without optional byte payloads', () => {
    const stats = { passes: 2, elapsedMs: 12, bundlesLoaded: ['texlive-basic'] };
    const withPdf = resultMessage(jobId, {
      ok: true,
      exitCode: 0,
      log: 'done',
      stats,
      pdf: new Uint8Array([37, 80, 68, 70]),
      synctex: new Uint8Array([1]),
    });
    expect(parseWorkerMessage(withPdf)).toEqual(withPdf);
    expect(withPdf.pdf).toBeInstanceOf(Uint8Array);

    const bare = resultMessage(jobId, { ok: false, exitCode: 1, log: '', stats });
    expect(parseWorkerMessage(bare)).toEqual(bare);
    expect('pdf' in bare).toBe(false);
    expect('synctex' in bare).toBe(false);
  });

  it('fatal — detail omitted when not provided', () => {
    const bare = fatalMessage(jobId, 'internal', 'boom');
    expect('detail' in bare).toBe(false);
    expect(parseWorkerMessage(bare)).toEqual(bare);
  });
});
