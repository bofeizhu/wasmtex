// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Unit tests for the pure §5.3 engine-sequencing machine (M1 item 6). Two
// layers: (1) the state machine driven by SYNTHETIC observations across every
// §5.3 branch — engine differences, bibliography on/off/auto, index with/without
// a non-empty .idx, rerun-until-quiescent, the hard cap, explicit-N exactness,
// and the failure/abort thresholds; (2) the rerun-marker detector + abort
// thresholds driven by REAL transcript FIXTURES captured from the pinned TL2023
// engine (fixtures/sequencing/, see GENERATOR.md) — so detector accuracy is
// proven against actual engine output, not folklore strings (M1 rebase-proofing
// rule 2). No wasm, no worker: the machine is a pure reducer.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BIBTEX_ABORT_EXIT,
  HARD_PASS_CAP,
  NO_FS_FACTS,
  advanceSequence,
  beginSequence,
  needsRerunFromTranscript,
  type SequencingOptions,
  type SequencingStep,
  type StepFsFacts,
  type StepObservation,
} from '../worker/sequencing';

// ---------------------------------------------------------------------------
// Driver + observation builders
// ---------------------------------------------------------------------------

function options(overrides: Partial<SequencingOptions> = {}): SequencingOptions {
  return {
    engine: 'xetex',
    passes: 'auto',
    bibliography: 'auto',
    index: 'auto',
    ...overrides,
  };
}

/** Build a step observation; unspecified FS facts default to "nothing happened". */
function obs(exitCode: number, extra: { transcript?: string; fs?: Partial<StepFsFacts> } = {}): StepObservation {
  return {
    exitCode,
    transcript: extra.transcript ?? '',
    fs: { ...NO_FS_FACTS, ...(extra.fs ?? {}) },
  };
}

type Responder = (step: SequencingStep, index: number) => StepObservation;

/** Drive the machine to termination, returning the full step trace + final pass count. */
function drive(opts: SequencingOptions, respond: Responder): { steps: SequencingStep[]; kinds: string[]; passes: number } {
  const steps: SequencingStep[] = [];
  let t = beginSequence(opts);
  steps.push(t.step);
  let i = 0;
  while (t.step.kind !== 'done' && t.step.kind !== 'abort') {
    const observation = respond(t.step, i++);
    t = advanceSequence(t.state, observation);
    steps.push(t.step);
    if (steps.length > 50) throw new Error('sequencing machine did not terminate (possible loop)');
  }
  return { steps, kinds: steps.map((s) => s.kind), passes: t.state.enginePasses };
}

/** A responder that returns the same observation for every step. */
const always = (o: StepObservation): Responder => () => o;

// A verified rerun marker (see fixtures) — for synthetic "please rerun" passes.
const RERUN_LINE = 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.';

// ---------------------------------------------------------------------------
// Engine differences (finalize)
// ---------------------------------------------------------------------------

describe('sequencing — engine finalize', () => {
  it('xetex quiescent hello: one engine pass then xdvipdfmx', () => {
    const { kinds, passes } = drive(options({ engine: 'xetex' }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(1);
  });

  it('pdftex quiescent hello: one engine pass, NO xdvipdfmx (PDF is direct)', () => {
    const { kinds, passes } = drive(options({ engine: 'pdftex' }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'done']);
    expect(passes).toBe(1);
  });

  it('the first step is always engine pass 1', () => {
    const first = beginSequence(options()).step;
    expect(first).toEqual({ kind: 'engine', pass: 1 });
  });
});

// ---------------------------------------------------------------------------
// Bibliography branch
// ---------------------------------------------------------------------------

describe('sequencing — bibliography', () => {
  const citesThenQuiet: Responder = (step, i) => {
    if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
    return obs(0);
  };

  it('bib=auto + .aux cites: bibtex8 after pass 1, then a forced incorporate pass', () => {
    const { kinds } = drive(options({ bibliography: 'auto' }), citesThenQuiet);
    // engine1 → bibtex8 → engine2 (incorporate, quiescent) → xdvipdfmx → done
    expect(kinds).toEqual(['engine', 'bibtex8', 'engine', 'xdvipdfmx', 'done']);
  });

  it('bib=auto but .aux does NOT cite: no bibtex8', () => {
    const { kinds } = drive(options({ bibliography: 'auto' }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
  });

  it('bib=off overrides a citing .aux: never runs bibtex8', () => {
    const { kinds } = drive(options({ bibliography: 'off' }), citesThenQuiet);
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
  });

  it('bibtex8 warning (exit 1) is tolerated — the sequence continues', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
      if (step.kind === 'bibtex8') return obs(1); // undefined-entry warning
      return obs(0);
    };
    const { kinds } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'bibtex8', 'engine', 'xdvipdfmx', 'done']);
  });

  it('bibtex8 error (exit >= threshold) aborts with a reason', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
      if (step.kind === 'bibtex8') return obs(BIBTEX_ABORT_EXIT); // missing .bst/.bib
      return obs(0);
    };
    const { steps, kinds } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'bibtex8', 'abort']);
    const abort = steps.at(-1);
    expect(abort?.kind).toBe('abort');
    if (abort?.kind === 'abort') expect(abort.reason).toContain('bibtex8');
  });

  it('the threshold is exactly 2: exit 1 continues, exit 2 aborts (BibTeX history)', () => {
    expect(BIBTEX_ABORT_EXIT).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Index branch
// ---------------------------------------------------------------------------

describe('sequencing — index', () => {
  const idxThenQuiet: Responder = (step, i) => {
    if (step.kind === 'engine' && i === 0) return obs(0, { fs: { idxNonEmpty: true } });
    return obs(0);
  };

  it('index=auto + non-empty .idx: makeindex after pass 1, then an incorporate pass', () => {
    const { kinds } = drive(options({ index: 'auto' }), idxThenQuiet);
    expect(kinds).toEqual(['engine', 'makeindex', 'engine', 'xdvipdfmx', 'done']);
  });

  it('index=auto but .idx empty/absent: no makeindex', () => {
    const { kinds } = drive(options({ index: 'auto' }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
  });

  it('index=off overrides a non-empty .idx: never runs makeindex', () => {
    const { kinds } = drive(options({ index: 'off' }), idxThenQuiet);
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
  });

  it('makeindex failure (non-zero) aborts', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { fs: { idxNonEmpty: true } });
      if (step.kind === 'makeindex') return obs(1);
      return obs(0);
    };
    const { steps, kinds } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'makeindex', 'abort']);
    const abort = steps.at(-1);
    if (abort?.kind === 'abort') expect(abort.reason).toContain('makeindex');
  });
});

// ---------------------------------------------------------------------------
// Bibliography + index together (ordering)
// ---------------------------------------------------------------------------

describe('sequencing — bib + index', () => {
  it('runs bibtex8 BEFORE makeindex, both after pass 1, then one incorporate pass', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) {
        return obs(0, { fs: { auxRequestsBib: true, idxNonEmpty: true } });
      }
      return obs(0);
    };
    const { kinds } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'bibtex8', 'makeindex', 'engine', 'xdvipdfmx', 'done']);
  });
});

// ---------------------------------------------------------------------------
// Rerun-until-quiescent (auto) + the hard cap
// ---------------------------------------------------------------------------

describe('sequencing — auto reruns', () => {
  it('reruns while the transcript shows a marker, then finalizes when quiescent (3 passes)', () => {
    const respond: Responder = (step, i) => {
      if (step.kind !== 'engine') return obs(0);
      return i < 2 ? obs(0, { transcript: RERUN_LINE }) : obs(0); // passes 1,2 rerun; pass 3 quiet
    };
    const { kinds, passes } = drive(options({ passes: 'auto' }), respond);
    expect(kinds).toEqual(['engine', 'engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(3);
  });

  it('an .aux change alone (no transcript marker) triggers a rerun', () => {
    const respond: Responder = (step, i) => {
      if (step.kind !== 'engine') return obs(0);
      if (i === 0) return obs(0, { transcript: RERUN_LINE }); // reach pass 2
      if (i === 1) return obs(0, { fs: { auxChanged: true } }); // quiet transcript, aux changed → pass 3
      return obs(0);
    };
    const { kinds, passes } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(3);
  });

  it('a .toc change alone triggers a rerun', () => {
    const respond: Responder = (step, i) => {
      if (step.kind !== 'engine') return obs(0);
      if (i === 0) return obs(0, { transcript: RERUN_LINE });
      if (i === 1) return obs(0, { fs: { tocChanged: true } });
      return obs(0);
    };
    const { passes } = drive(options(), respond);
    expect(passes).toBe(3);
  });

  it('never-quiescent document is bounded by the hard cap of 5 engine passes', () => {
    const respond: Responder = (step) => (step.kind === 'engine' ? obs(0, { transcript: RERUN_LINE }) : obs(0));
    const { kinds, passes } = drive(options({ passes: 'auto' }), respond);
    expect(kinds).toEqual(['engine', 'engine', 'engine', 'engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(HARD_PASS_CAP);
    expect(HARD_PASS_CAP).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Explicit N (exact passes, no rerun logic)
// ---------------------------------------------------------------------------

describe('sequencing — explicit pass count', () => {
  it('passes=1: exactly one engine pass even with a quiescent doc', () => {
    const { kinds, passes } = drive(options({ passes: 1 }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(1);
  });

  it('passes=3: exactly three engine passes even when every pass is quiescent', () => {
    const { kinds, passes } = drive(options({ passes: 3 }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(3);
  });

  it('passes=2: caps at two even when every pass asks to rerun', () => {
    const respond: Responder = (step) => (step.kind === 'engine' ? obs(0, { transcript: RERUN_LINE }) : obs(0));
    const { kinds, passes } = drive(options({ passes: 2 }), respond);
    expect(kinds).toEqual(['engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(2);
  });

  it('passes=2 + bibliography: pass1 → bibtex8 → pass2 (bbl incorporated) → finalize', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
      return obs(0);
    };
    const { kinds, passes } = drive(options({ passes: 2 }), respond);
    expect(kinds).toEqual(['engine', 'bibtex8', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(2);
  });

  it('passes=1 + bibliography (degenerate): bibtex8 still runs once but nothing re-reads it', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
      return obs(0);
    };
    const { kinds, passes } = drive(options({ passes: 1 }), respond);
    expect(kinds).toEqual(['engine', 'bibtex8', 'xdvipdfmx', 'done']);
    expect(passes).toBe(1);
  });

  it('pdftex explicit passes=3 has no xdvipdfmx', () => {
    const { kinds } = drive(options({ engine: 'pdftex', passes: 3 }), always(obs(0)));
    expect(kinds).toEqual(['engine', 'engine', 'engine', 'done']);
  });
});

// ---------------------------------------------------------------------------
// Engine / driver failures
// ---------------------------------------------------------------------------

describe('sequencing — failures abort', () => {
  it('engine pass 1 non-zero exit aborts immediately', () => {
    const { kinds, steps, passes } = drive(options(), always(obs(1)));
    expect(kinds).toEqual(['engine', 'abort']);
    expect(passes).toBe(1);
    const abort = steps.at(-1);
    if (abort?.kind === 'abort') expect(abort.reason).toContain('engine pass 1');
  });

  it('engine pass 2 non-zero exit aborts after two passes', () => {
    const respond: Responder = (step, i) => {
      if (step.kind === 'engine' && i === 0) return obs(0, { transcript: RERUN_LINE });
      if (step.kind === 'engine') return obs(2);
      return obs(0);
    };
    const { kinds, passes, steps } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'engine', 'abort']);
    expect(passes).toBe(2);
    const abort = steps.at(-1);
    if (abort?.kind === 'abort') expect(abort.reason).toContain('engine pass 2');
  });

  it('xdvipdfmx non-zero exit aborts', () => {
    const respond: Responder = (step) => (step.kind === 'xdvipdfmx' ? obs(1) : obs(0));
    const { kinds, steps } = drive(options({ engine: 'xetex' }), respond);
    expect(kinds).toEqual(['engine', 'xdvipdfmx', 'abort']);
    const abort = steps.at(-1);
    if (abort?.kind === 'abort') expect(abort.reason).toContain('xdvipdfmx');
  });
});

// ---------------------------------------------------------------------------
// Detector — driven by REAL captured fixtures (rebase-proofing rule 2)
// ---------------------------------------------------------------------------

const fixturesDir = fileURLToPath(new URL('./fixtures/sequencing/', import.meta.url));

function readFixture(name: string): { exit: number; text: string } {
  const raw = readFileSync(fixturesDir + name, 'utf8');
  const nl = raw.indexOf('\n');
  const header = raw.slice(0, nl);
  const m = /^# exit=(-?\d+)$/.exec(header);
  if (!m) throw new Error(`fixture ${name} missing "# exit=" header`);
  return { exit: Number(m[1]), text: raw.slice(nl + 1) };
}

describe('sequencing — rerun detector over real TL2023 fixtures', () => {
  it.each([
    'rerun-crossref-pass1.txt', // "Label(s) may have changed. Rerun to get cross-references right." + undefined refs
    'rerun-citations-pass2.txt', // "Rerun to get cross-references right." after bibtex
    'undefined-refs-only-pass1.txt', // "There were undefined references." only
  ])('detects a rerun marker in %s', (name) => {
    expect(needsRerunFromTranscript(readFixture(name).text)).toBe(true);
  });

  it.each([
    'quiescent-crossref-pass2.txt', // all refs resolved — no marker
    'quiescent-hello-pass1.txt', // trivial doc — no marker
    'bibtex8-clean.txt', // tool transcript — must not false-positive
    'bibtex8-warning-undefined-entry.txt',
    'bibtex8-error-missing-bst.txt',
    'makeindex-clean.txt',
  ])('reports NO rerun in %s', (name) => {
    expect(needsRerunFromTranscript(readFixture(name).text)).toBe(false);
  });

  it('matches each verified marker string exactly (as it appears in the engine output)', () => {
    expect(needsRerunFromTranscript('LaTeX Warning: There were undefined references.')).toBe(true);
    expect(
      needsRerunFromTranscript('LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'),
    ).toBe(true);
  });

  it('is robust to a marker that TeX wrapped across log lines (whitespace-normalized)', () => {
    // TeX can wrap a warning near col 79; the detector normalizes whitespace.
    const wrapped = 'LaTeX Warning: Label(s) may have changed. Rerun to get\ncross-references right.';
    expect(needsRerunFromTranscript(wrapped)).toBe(true);
  });

  it('does not fire on unrelated transcript noise', () => {
    expect(needsRerunFromTranscript('This is XeTeX\n(./main.aux)\nOutput written on main.xdv')).toBe(false);
    expect(needsRerunFromTranscript('program exited (with status: 0)')).toBe(false);
    expect(needsRerunFromTranscript('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detector + machine, end to end over fixtures (real transcript drives a rerun)
// ---------------------------------------------------------------------------

describe('sequencing — machine driven by real fixtures', () => {
  it('a real "Rerun" pass-1 transcript makes the auto machine run a second pass', () => {
    const rerun = readFixture('rerun-crossref-pass1.txt');
    const quiet = readFixture('quiescent-crossref-pass2.txt');
    const respond: Responder = (step, i) => {
      if (step.kind !== 'engine') return obs(0);
      return obs(0, { transcript: i === 0 ? rerun.text : quiet.text });
    };
    const { kinds, passes } = drive(options(), respond);
    expect(kinds).toEqual(['engine', 'engine', 'xdvipdfmx', 'done']);
    expect(passes).toBe(2);
  });

  it("real bibtex8 exit codes gate abort vs continue (warning fixture exit=1, error fixture exit=2)", () => {
    const warn = readFixture('bibtex8-warning-undefined-entry.txt');
    const err = readFixture('bibtex8-error-missing-bst.txt');
    expect(warn.exit).toBe(1);
    expect(err.exit).toBe(2);

    const withBibExit = (bibExit: number): string[] => {
      const respond: Responder = (step, i) => {
        if (step.kind === 'engine' && i === 0) return obs(0, { fs: { auxRequestsBib: true } });
        if (step.kind === 'bibtex8') return obs(bibExit);
        return obs(0);
      };
      return drive(options(), respond).kinds;
    };
    // exit 1 (warning) → continue to an incorporate pass; exit 2 (error) → abort.
    expect(withBibExit(warn.exit)).toEqual(['engine', 'bibtex8', 'engine', 'xdvipdfmx', 'done']);
    expect(withBibExit(err.exit)).toEqual(['engine', 'bibtex8', 'abort']);
  });
});
