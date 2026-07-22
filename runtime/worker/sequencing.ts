// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   The §5.3 engine-sequencing state machine is an ORIGINAL design (DESIGN.md
//   §2.4, §5.3 is our spec). The vendored busytex `busytex_pipeline.js` (MIT)
//   was consulted ONLY as a BEHAVIOURAL reference for applet argv and the fact
//   that a bibtex compile needs multiple engine passes — and its flow DIFFERS
//   from ours: upstream runs a FIXED command list (one xetex pass without
//   bibtex; xetex → bibtex8 → xetex → xetex with bibtex) and has NO rerun
//   detection at all. Our machine reruns *until quiescent* driven by real
//   transcript markers + `.aux`/`.toc` change, bounded by `passes`. No code,
//   field names, or control flow were copied (busytex is MIT, so this is
//   posture, not obligation). Not derived from any GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// The §5.3 engine-sequencing decision machine (M1 item 6).
//
// PURE: no filesystem, no engine, no `self`/`postMessage`/`fetch`/DOM, and no
// protocol import beyond TYPES. It is a deterministic reducer over an explicit,
// immutable state — the caller (worker/core.ts) executes each returned step
// against the wasm engine, gathers observations (exit code, per-step transcript,
// and FS facts read back between steps), and threads the state forward. All
// engine/FS side effects live in the caller; this module only DECIDES.
//
// §5.3 encoded exactly (per-job): engine pass 1 → (bibtex8 on the `.aux` when
// `bibliography` resolves on AND the `.aux` requests it) → (makeindex when
// `index` resolves on AND a non-empty `.idx` exists) → engine reruns while the
// log shows unresolved references / TOC changes (bounded by `passes`) →
// finalize. XeTeX finalizes through `xdvipdfmx`; pdfTeX writes the PDF directly
// and finalizes with `done`. The per-engine applet/argv/format mapping is NOT
// here — it stays in core.ts (this machine speaks in abstract steps).
//
// Passes policy (DESIGN.md §5.1): `'auto'` reruns until quiescent with a HARD
// CAP of 5 engine passes; an explicit N runs exactly N engine passes with NO
// rerun logic (the transcript/FS rerun signals are ignored — the count is
// authoritative). The bibliography/index tools are gated by their OWN options +
// FS facts, independent of the passes policy; with an explicit N too small to
// incorporate a tool's output (e.g. N=1 with a bibliography) the tool still runs
// once but its `.bbl`/`.ind` is not re-read — the caller's explicit choice.
// ---------------------------------------------------------------------------

import type { AutoOff, PassPolicy } from '../src/protocol';

// ---------------------------------------------------------------------------
// Public inputs/outputs
// ---------------------------------------------------------------------------

/** Engines this machine sequences. `luatex` is rejected upstream (core), never here. */
export type SequencingEngine = 'xetex' | 'pdftex';

/** The job knobs that shape the sequence (a projection of the compile message). */
export interface SequencingOptions {
  readonly engine: SequencingEngine;
  /** `'auto'` → rerun until quiescent (cap {@link HARD_PASS_CAP}); N → exactly N engine passes. */
  readonly passes: PassPolicy;
  /** `'auto'` → run bibtex8 when the `.aux` requests it; `'off'` → never. */
  readonly bibliography: AutoOff;
  /** `'auto'` → run makeindex when a non-empty `.idx` exists; `'off'` → never. */
  readonly index: AutoOff;
}

/**
 * Filesystem facts the caller reads back after a step. Only meaningful after an
 * ENGINE step (tool steps do not touch these files); the machine ignores them
 * for bibtex8/makeindex/xdvipdfmx observations, so the caller may pass
 * {@link NO_FS_FACTS} there.
 */
export interface StepFsFacts {
  /** The `.aux` requests a bibliography: it carries BOTH a `\citation` and a `\bibdata` line. */
  readonly auxRequestsBib: boolean;
  /** A non-empty `.idx` exists (has at least one non-whitespace character). */
  readonly idxNonEmpty: boolean;
  /** The `.aux` content differs from the previous engine pass (first pass ⇒ false — nothing to compare). */
  readonly auxChanged: boolean;
  /** The `.toc` content differs from the previous engine pass (first pass ⇒ false). */
  readonly tocChanged: boolean;
}

/** FS facts for a step whose FS facts are irrelevant (tool/driver steps). */
export const NO_FS_FACTS: StepFsFacts = {
  auxRequestsBib: false,
  idxNonEmpty: false,
  auxChanged: false,
  tocChanged: false,
};

/** What the caller observed after executing the last issued step. */
export interface StepObservation {
  /** The applet's process exit code. */
  readonly exitCode: number;
  /** The transcript (stdout+stderr) streamed DURING THIS step — the rerun-marker source. */
  readonly transcript: string;
  /** FS facts read back after this step (see {@link StepFsFacts}). */
  readonly fs: StepFsFacts;
}

/**
 * The next thing to do. `engine`/`bibtex8`/`makeindex`/`xdvipdfmx` are runnable
 * steps the caller executes; `done` (success) and `abort` (failure) are terminal
 * — the caller stops and does NOT call {@link advanceSequence} again. `abort`
 * carries a short human-readable `reason` for the log tail and diagnostics.
 */
export type SequencingStep =
  | { readonly kind: 'engine'; readonly pass: number }
  | { readonly kind: 'bibtex8' }
  | { readonly kind: 'makeindex' }
  | { readonly kind: 'xdvipdfmx' }
  | { readonly kind: 'done' }
  | { readonly kind: 'abort'; readonly reason: string };

/** Hard cap on engine passes in `'auto'` mode (DESIGN.md §5.3, §5.1). */
export const HARD_PASS_CAP = 5;

/**
 * bibtex8's exit code is BibTeX's `history`: 0 spotless, 1 warning, 2 error,
 * 3 fatal. Warnings (1) — e.g. a missing database entry — are common and leave a
 * usable `.bbl`, so the sequence CONTINUES; errors/fatals (≥ 2) mean the `.bbl`
 * is absent or unusable (bad/missing `.bst`/`.bib`), so the sequence ABORTS.
 * Verified against the real engine (see fixtures/sequencing/GENERATOR.md).
 */
export const BIBTEX_ABORT_EXIT = 2;

// ---------------------------------------------------------------------------
// The rerun-marker detector (fixture-grounded — NOT folklore)
// ---------------------------------------------------------------------------

/**
 * Verified TL 2023 rerun markers (see fixtures/sequencing/GENERATOR.md). Matched
 * as whitespace-normalized substrings so a marker that TeX wrapped across log
 * lines (its warnings sit right at the ~79-col boundary) is still detected:
 *
 *  - `Rerun to get` — anchor of the kernel's `Rerun to get <X> right` family
 *    (verified instance: "Rerun to get cross-references right").
 *  - `Label(s) may have changed` — the kernel emits this whenever this run's
 *    labels differ from the `.aux` it read at start (i.e. a rerun will help).
 *  - `There were undefined references` — §5.3's "unresolved references". NOTE:
 *    a *permanently* undefined `\ref`/`\cite` keeps emitting this, so on its own
 *    it would rerun forever; the HARD CAP is the deliberate bound for that case
 *    (this is exactly how latexmk's bounded repeat behaves). Resolvable forward
 *    references also trip `Label(s) may have changed`, so this marker only ever
 *    *adds* passes for the genuinely-unresolvable case, never removes them.
 */
const RERUN_MARKERS: readonly string[] = [
  'Rerun to get',
  'Label(s) may have changed',
  'There were undefined references',
];

/** Collapse every run of whitespace (incl. newlines) to a single space. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * True iff the engine transcript shows a §5.3 rerun marker. Pure and total;
 * exported so the fixture corpus can test the detector in isolation. Combined
 * with the `.aux`/`.toc` change signal by {@link advanceSequence} (either
 * triggers a rerun).
 */
export function needsRerunFromTranscript(transcript: string): boolean {
  const normalized = normalizeWhitespace(transcript);
  return RERUN_MARKERS.some((marker) => normalized.includes(marker));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Normalized, sequence-relevant view of the options (computed once in {@link beginSequence}). */
interface NormalizedOptions {
  readonly engine: SequencingEngine;
  readonly bib: boolean;
  readonly index: boolean;
  /** `passes === 'auto'`. */
  readonly autoPasses: boolean;
  /** Ceiling on engine passes: {@link HARD_PASS_CAP} in auto, else the explicit N. */
  readonly maxPasses: number;
}

/**
 * The machine's immutable state. Threaded by the caller between steps; carries
 * no file contents (the caller computes {@link StepFsFacts.auxChanged} /
 * `tocChanged` from its own snapshots), only the derived booleans and counters.
 * `enginePasses` is the §5.1 stats bookkeeping — read it after the loop.
 */
export interface SequenceState {
  /** Engine passes ISSUED so far (each is run before the next `advance`, so this = passes RUN). */
  readonly enginePasses: number;
  readonly options: NormalizedOptions;
  /** The step just issued — how the next observation is interpreted. */
  readonly last: SequencingStep;
  /** The bibtex8 gate has been settled (ran or skipped) — it opens once, right after pass 1. */
  readonly bibResolved: boolean;
  /** The makeindex gate has been settled (ran or skipped). */
  readonly indexResolved: boolean;
  /** Latest engine pass's `.aux`-requests-bibliography fact. */
  readonly auxRequestsBib: boolean;
  /** Latest engine pass's non-empty-`.idx` fact. */
  readonly idxNonEmpty: boolean;
}

/** A state transition: the next step to run, plus the state to thread into the following `advance`. */
export interface SequenceTransition {
  readonly state: SequenceState;
  readonly step: SequencingStep;
}

// ---------------------------------------------------------------------------
// Transition helpers (all pure)
// ---------------------------------------------------------------------------

function normalize(options: SequencingOptions): NormalizedOptions {
  const autoPasses = options.passes === 'auto';
  return {
    engine: options.engine,
    bib: options.bibliography === 'auto',
    index: options.index === 'auto',
    autoPasses,
    maxPasses: autoPasses ? HARD_PASS_CAP : options.passes,
  };
}

/** Record a step as issued (sets `last`) and return the transition. */
function issue(state: SequenceState, step: SequencingStep): SequenceTransition {
  return { state: { ...state, last: step }, step };
}

function done(state: SequenceState): SequenceTransition {
  return issue(state, { kind: 'done' });
}

function abort(state: SequenceState, reason: string): SequenceTransition {
  return issue(state, { kind: 'abort', reason });
}

/** XeTeX drives the `.xdv` through `xdvipdfmx`; pdfTeX has already written the PDF. */
function finalize(state: SequenceState): SequenceTransition {
  return state.options.engine === 'xetex'
    ? issue(state, { kind: 'xdvipdfmx' })
    : done(state);
}

/**
 * Decide whether to run another engine pass or finalize. In `'auto'` mode a pass
 * runs iff `rerunWanted` and we are under the cap; with an explicit N it runs
 * until exactly N passes have been issued (rerun signals ignored).
 */
function engineOrFinalize(state: SequenceState, rerunWanted: boolean): SequenceTransition {
  const underCap = state.enginePasses < state.options.maxPasses;
  const rerun = state.options.autoPasses ? rerunWanted && underCap : underCap;
  if (!rerun) return finalize(state);
  const pass = state.enginePasses + 1;
  return issue({ ...state, enginePasses: pass }, { kind: 'engine', pass });
}

/**
 * The post-step decision cascade: settle the bibtex8 gate (once, right after
 * pass 1), then the makeindex gate, then engine-rerun-vs-finalize. `rerunWanted`
 * is the caller-independent rerun hint for the finalize decision — from the last
 * engine pass's transcript/FS signals, or forced `true` after a tool ran (its
 * `.bbl`/`.ind` must be incorporated).
 */
function decideNext(state: SequenceState, rerunWanted: boolean): SequenceTransition {
  if (!state.bibResolved) {
    const resolved: SequenceState = { ...state, bibResolved: true };
    if (resolved.options.bib && resolved.auxRequestsBib) {
      return issue(resolved, { kind: 'bibtex8' });
    }
    return decideNext(resolved, rerunWanted); // gate skipped — settle the next one
  }
  if (!state.indexResolved) {
    const resolved: SequenceState = { ...state, indexResolved: true };
    if (resolved.options.index && resolved.idxNonEmpty) {
      return issue(resolved, { kind: 'makeindex' });
    }
    return decideNext(resolved, rerunWanted);
  }
  return engineOrFinalize(state, rerunWanted);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a sequence. Returns the initial state and the first step — ALWAYS engine
 * pass 1 (§5.3 "engine pass → …"). The caller runs the step, builds a
 * {@link StepObservation}, then calls {@link advanceSequence} to get the next.
 */
export function beginSequence(options: SequencingOptions): SequenceTransition {
  const first: SequencingStep = { kind: 'engine', pass: 1 };
  const state: SequenceState = {
    enginePasses: 1,
    options: normalize(options),
    last: first,
    bibResolved: false,
    indexResolved: false,
    auxRequestsBib: false,
    idxNonEmpty: false,
  };
  return { state, step: first };
}

/**
 * Fold the observation of the just-run step into the state and return the next
 * step. Pure and total. The caller MUST stop once the returned step is `done` or
 * `abort` and MUST NOT call this again with a terminal `state.last`.
 *
 * Failure handling (item-5 semantics — stop and surface the transcript):
 *  - engine pass exits non-zero → abort;
 *  - bibtex8 exits ≥ {@link BIBTEX_ABORT_EXIT} → abort (warnings, exit 1, continue);
 *  - makeindex exits non-zero → abort;
 *  - xdvipdfmx exits non-zero → abort.
 */
export function advanceSequence(
  state: SequenceState,
  observation: StepObservation,
): SequenceTransition {
  const last = state.last;
  switch (last.kind) {
    case 'engine': {
      if (observation.exitCode !== 0) {
        return abort(state, `engine pass ${last.pass} exited ${observation.exitCode}`);
      }
      const updated: SequenceState = {
        ...state,
        auxRequestsBib: observation.fs.auxRequestsBib,
        idxNonEmpty: observation.fs.idxNonEmpty,
      };
      const rerunWanted =
        needsRerunFromTranscript(observation.transcript) ||
        observation.fs.auxChanged ||
        observation.fs.tocChanged;
      return decideNext(updated, rerunWanted);
    }
    case 'bibtex8': {
      if (observation.exitCode >= BIBTEX_ABORT_EXIT) {
        return abort(state, `bibtex8 exited ${observation.exitCode} (error; see transcript)`);
      }
      // exit 0 (spotless) or 1 (warnings) — continue; a tool ran ⇒ force an
      // incorporate pass (in auto mode) so the fresh `.bbl` reaches the PDF.
      return decideNext({ ...state, bibResolved: true }, true);
    }
    case 'makeindex': {
      if (observation.exitCode !== 0) {
        return abort(state, `makeindex exited ${observation.exitCode}`);
      }
      return decideNext({ ...state, indexResolved: true }, true);
    }
    case 'xdvipdfmx': {
      if (observation.exitCode !== 0) {
        return abort(state, `xdvipdfmx exited ${observation.exitCode}`);
      }
      return done(state);
    }
    default:
      // `done`/`abort` are terminal; a well-behaved caller never re-enters here.
      // Return the terminal step unchanged so the function stays total.
      return { state, step: last };
  }
}
