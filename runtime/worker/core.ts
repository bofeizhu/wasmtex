// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   The §5 worker design is ORIGINAL (DESIGN.md §2.4, §5). The vendored busytex
//   glue (busytex_pipeline.js / busytex_worker.js, MIT) was consulted ONLY as a
//   BEHAVIOURAL reference — what argv sequence typesets a document, and how a
//   multicall engine is driven — never for message shapes or API structure; no
//   field names or code were copied (busytex is MIT, so this is posture, not
//   obligation). Not derived from any GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// Worker orchestration core (M1 item 5). Pure-ish: it turns a validated
// ClientMessage into a stream of correlated WorkerMessages, delegating every
// wasm/filesystem side effect to an injected {@link EngineHost}. That keeps the
// orchestration logic unit-testable in Node with a fake host — no worker, no
// wasm — while the real host (`engine-host.ts`) carries the Emscripten details.
// Nothing here touches `self`, `postMessage`, `importScripts`, `fetch`, the DOM,
// or the network (DESIGN.md §5.2, §10); the only outward channel is `post`.
//
// EXECUTION MODEL (chosen empirically for this artifact — see the M0 item-4
// journal "execution-model study"; the EngineHost contract below assumes it):
//
//   * ONE persistent MODULARIZE engine instance is loaded once (`host.load`),
//     carrying the ~79 MB texlive-basic bundle so it is NOT reloaded per run.
//   * A compile is several applet runs (xetex, then xdvipdfmx; later bibtex8 /
//     makeindex) sharing ONE Emscripten MEMFS. The MEMFS lives in the JS heap,
//     so intermediate outputs (e.g. the `.xdv`) survive between runs — that is
//     what lets a later applet read an earlier applet's output.
//   * The engine's LINEAR memory is snapshotted after load and rolled back
//     after EVERY `callMain` (host-side). This is REQUIRED, not optional: the
//     study showed a second same-applet run OOMs without it (the allocator brk
//     never resets), and the rollback also clears TeX's global state so reruns
//     are deterministic (byte-identical `.xdv` across two runs).
//   * Each new job gets a freshly-cleaned MEMFS job dir; the engine instance and
//     the preloaded bundle persist across jobs (warm state is a cache, never a
//     correctness dependency — DESIGN.md §5.2).
//
// SEQUENCING (M1 item 6): the §5.3 decision machine lives in `sequencing.ts` (a
// pure reducer — no FS, no engine). This core DRIVES it: it maps each abstract
// step the machine returns (engine pass N / bibtex8 / makeindex / xdvipdfmx) to
// a concrete applet run (per-engine argv + format, below), executes it, reads
// back the `.aux`/`.toc`/`.idx` snapshots the machine needs as observations, and
// threads the state forward until the machine says `done` or `abort`. bibtex8
// runs when the `.aux` cites (`\citation`+`\bibdata`) and `bibliography` is on;
// makeindex when a non-empty `.idx` exists and `index` is on; engine reruns
// while the transcript shows a rerun marker or the `.aux`/`.toc` changed, bounded
// by `passes`. XeTeX finalizes through xdvipdfmx; pdfTeX writes the PDF directly.
// The abstract-step → applet mapping (`toRunStep`) is the ONLY per-engine
// argv/format knowledge; the decision logic is entirely in `sequencing.ts`.
// ---------------------------------------------------------------------------

import {
  fatalMessage,
  initializedMessage,
  logMessage,
  progressMessage,
  resultMessage,
  type AssetsConfig,
  type ClientMessage,
  type CompileMessage,
  type EngineName,
  type LogStream,
  type ProgressPhase,
  type ProjectFiles,
  type ResultFields,
  type WorkerMessage,
} from '../src/protocol';
import {
  advanceSequence,
  beginSequence,
  NO_FS_FACTS,
  type SequencingEngine,
  type SequencingOptions,
  type SequencingStep,
  type StepFsFacts,
  type StepObservation,
} from './sequencing';

// ---------------------------------------------------------------------------
// The injected engine host contract
// ---------------------------------------------------------------------------

/** The outcome of one applet run: exit code, captured streams, and any collected outputs. */
export interface EngineRunResult {
  /** The applet's process exit code (0 = success). A wasm `abort()` throws {@link EngineAborted} instead. */
  readonly exitCode: number;
  /** Full stdout captured for this run (also streamed line-by-line via the `onLine` sink). */
  readonly stdout: string;
  /** Full stderr captured for this run (also streamed line-by-line via the `onLine` sink). */
  readonly stderr: string;
  /** The requested `collect` paths that exist on the FS after the run, `path → bytes`. */
  readonly outputs: ReadonlyMap<string, Uint8Array>;
}

/** Instructions to open a fresh job before an applet run. */
export interface EngineStageInfo {
  /** Project inputs to write into a freshly-cleaned job dir (`path → contents`). */
  readonly files: ProjectFiles;
  /** Job-dir-relative working directory to `chdir` into (the entry's directory, or `.`). */
  readonly cwd: string;
}

/**
 * One applet run. When `stage` is present the host opens a NEW job first (clean
 * MEMFS job dir, write `files`, `chdir` to `cwd`); when absent the run reuses
 * the current job's FS so it sees the previous applet's outputs. `collect` names
 * output files (relative to the current `cwd`) to read back after the run.
 */
export interface EngineRunStep {
  /** Multicall applet selector — busytex dispatches on this (`xelatex`, `xdvipdfmx`, …). */
  readonly applet: string;
  /** Arguments AFTER the applet name (the host prepends the applet as argv[1]). */
  readonly argv: readonly string[];
  /** Present ⇒ open a fresh job before running. */
  readonly stage?: EngineStageInfo;
  /** Output paths (relative to `cwd`) to read back into {@link EngineRunResult.outputs}. */
  readonly collect?: readonly string[];
}

/** A line-buffered transcript sink; the host calls it once per complete line as a run streams. */
export type EngineLogSink = (stream: LogStream, line: string) => void;

/**
 * The wasm engine, abstracted so {@link createWorkerCore} is testable with a
 * fake. The real implementation is `engine-host.ts`. `run` is synchronous: a
 * `callMain` runs to completion on the worker thread (cancellation is worker
 * termination, DESIGN.md §5.2 — there is no cooperative yield to honour).
 */
export interface EngineHost {
  /** Load + instantiate the engine and preload the configured bundle(s). Called once per session. */
  load(assets: AssetsConfig): Promise<void>;
  /** Run one applet against the (possibly freshly-staged) job FS, streaming lines to `onLine`. */
  run(step: EngineRunStep, onLine: EngineLogSink): EngineRunResult;
}

/**
 * Thrown by an {@link EngineHost} when the wasm engine calls `abort()` mid-run
 * (a `RuntimeError`, not a clean process exit). The core maps it to a `fatal`
 * with code `engine-aborted`; any other thrown value maps to `internal`.
 */
export class EngineAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineAborted';
  }
}

// ---------------------------------------------------------------------------
// Engine support + the abstract-step → applet mapping (item 6)
// ---------------------------------------------------------------------------

/**
 * Engines implemented end-to-end in v1. `luatex` is deliberately absent — it is
 * a reserved enum member (DESIGN.md §9), rejected with `unsupported-engine`.
 * `pdftex` is included because it costs only a different format + direct output
 * (no `xdvipdfmx`), needing no engine-specific branching beyond the mapping
 * below (M1 plan "pdfTeX near-free" test).
 */
const SUPPORTED_ENGINES: ReadonlySet<EngineName> = new Set<EngineName>(['xetex', 'pdftex']);

// The engine build's fixed TeX Live TDS layout for the preloaded format dumps
// (convention: texmf-var/web2c/<engine>/<format>.fmt). These are paths INSIDE
// the texlive bundle's MEMFS, not asset-inventory names, and follow a
// rebase-stable TDS convention — the M2 rebase re-validates them via the
// conformance corpus, not by chasing string constants (M1 rebase-proofing).
const FORMAT_XELATEX = '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';
const FORMAT_PDFLATEX = '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt';

/** A runnable step the caller executes (the machine's `done`/`abort` are terminal, never run). */
type RunnableStep = Extract<SequencingStep, { kind: 'engine' | 'bibtex8' | 'makeindex' | 'xdvipdfmx' }>;

/** Immutable per-job naming context (derived once from the compile message). */
interface JobContext {
  readonly engine: SequencingEngine;
  /** The entry file's basename (the argv the engine is invoked on, after chdir). */
  readonly entryBase: string;
  /** The TeX jobname (entry basename minus `.tex`) — names every output (`<job>.aux`, …). */
  readonly jobname: string;
  /** The job-dir-relative directory to chdir into (the entry's directory, or `.`). */
  readonly cwd: string;
}

/** Last path segment of a project-relative path. */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Directory portion of a project-relative path (`''` when the path is a bare name). */
function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '' : path.slice(0, slash);
}

/** Drop a trailing `.tex` to derive the TeX jobname (which names the outputs). */
function jobnameOf(entryBasename: string): string {
  return entryBasename.endsWith('.tex')
    ? entryBasename.slice(0, -'.tex'.length)
    : entryBasename;
}

/** Project the compile message onto the machine's option surface (engine already validated). */
function sequencingOptionsOf(msg: CompileMessage): SequencingOptions {
  return {
    engine: msg.engine as SequencingEngine, // luatex rejected before this point
    passes: msg.passes,
    bibliography: msg.bibliography,
    index: msg.index,
  };
}

/** The coarse progress phase to announce before running a runnable step. */
function progressOf(step: RunnableStep): ProgressPhase {
  switch (step.kind) {
    case 'engine':
      return { kind: 'engine', pass: step.pass };
    case 'bibtex8':
      return { kind: 'bibtex8' };
    case 'makeindex':
      return { kind: 'makeindex' };
    case 'xdvipdfmx':
      return { kind: 'xdvipdfmx' };
  }
}

// Files an engine pass produces that the machine observes: the `.aux` (citations
// + cross-reference state), the `.toc` (TOC change), and the `.idx` (index).
// pdfTeX also writes the final PDF on every pass, so it is collected too (the
// latest pass's PDF wins); XeTeX produces an `.xdv` consumed by xdvipdfmx.
function engineCollect(ctx: JobContext): string[] {
  const base = [`${ctx.jobname}.aux`, `${ctx.jobname}.toc`, `${ctx.jobname}.idx`];
  return ctx.engine === 'pdftex' ? [...base, `${ctx.jobname}.pdf`] : base;
}

/**
 * Map one abstract {@link RunnableStep} to a concrete {@link EngineRunStep}: the
 * applet, its argv (per-engine format/driver knowledge — the only place it
 * lives), and the files to read back. `stage` is passed ONLY for the first step
 * (engine pass 1) to open a fresh job; every later step reuses the job FS so it
 * sees the previous applet's outputs (`.xdv`, `.aux`, `.bbl`, `.ind`).
 */
function toRunStep(step: RunnableStep, ctx: JobContext, stage?: EngineStageInfo): EngineRunStep {
  const withStage = <T extends object>(s: T): T & { stage?: EngineStageInfo } =>
    stage ? { ...s, stage } : s;

  switch (step.kind) {
    case 'engine':
      return ctx.engine === 'pdftex'
        ? withStage({
            applet: 'pdflatex',
            // pdfTeX writes the PDF directly — no xdvipdfmx step.
            argv: [
              '--no-shell-escape',
              '--interaction=nonstopmode',
              '--halt-on-error',
              '--output-format=pdf',
              '--fmt',
              FORMAT_PDFLATEX,
              ctx.entryBase,
            ],
            collect: engineCollect(ctx),
          })
        : withStage({
            applet: 'xelatex',
            // nonstopmode (not batchmode): TeX then prints its full transcript —
            // crucially the "! …" error lines with l.N AND the "Rerun to get …"
            // markers the machine reads — to the terminal, which the host
            // captures and streams. batchmode would write them only to <job>.log.
            argv: [
              '--no-shell-escape',
              '--interaction=nonstopmode',
              '--halt-on-error',
              '--no-pdf',
              '--fmt',
              FORMAT_XELATEX,
              ctx.entryBase,
            ],
            collect: engineCollect(ctx),
          });
    case 'bibtex8':
      // Runs on the `.aux` (with extension), reusing the job FS; the bundle
      // resolves the `.bst` via kpathsea. `--8bit` matches upstream busytex.
      return { applet: 'bibtex8', argv: ['--8bit', `${ctx.jobname}.aux`], collect: [] };
    case 'makeindex':
      // Reads `<job>.idx`, writes `<job>.ind` into the job FS for the next pass.
      return { applet: 'makeindex', argv: [`${ctx.jobname}.idx`], collect: [] };
    case 'xdvipdfmx':
      // Turns the engine's `.xdv` into the final PDF (XeTeX only).
      return {
        applet: 'xdvipdfmx',
        argv: ['-o', `${ctx.jobname}.pdf`, `${ctx.jobname}.xdv`],
        collect: [`${ctx.jobname}.pdf`],
      };
  }
}

/** Byte-exact equality of two optional buffers (both absent ⇒ equal; one absent ⇒ different). */
function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link createWorkerCore} (all side effects are here). */
export interface WorkerCoreDeps {
  /** The wasm engine (real: `engine-host.ts`; tests: a fake). */
  readonly host: EngineHost;
  /** The single outward channel — every correlated WorkerMessage goes through here. */
  readonly post: (message: WorkerMessage) => void;
  /** Monotonic clock for `stats.elapsedMs`; injectable for deterministic tests (default `Date.now`). */
  readonly now?: () => number;
}

/** The message handler returned by {@link createWorkerCore}. */
export interface WorkerCore {
  /** Handle one validated client message, emitting correlated responses via `post`. */
  handle(message: ClientMessage): Promise<void>;
}

/** Reduce an unknown thrown value to a short, non-sensitive message string. */
export function describeError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * Build the worker core over its injected dependencies. The returned handler is
 * called once per inbound (already validated) {@link ClientMessage}; it emits a
 * stream of correlated {@link WorkerMessage}s through `post`. Jobs are handled
 * one at a time (the worker is single-threaded and serialises by construction);
 * correlation on `jobId` makes stale/foreign messages safe regardless.
 */
export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  const { host, post } = deps;
  const now = deps.now ?? Date.now;

  // Session state. `loaded` gates compiles; `bundlesLoaded` feeds result stats.
  // Warm state is a cache: the client re-inits on a fresh worker after cancel.
  let loaded = false;
  let bundlesLoaded: readonly string[] = [];

  async function onInit(msg: ClientMessage & { type: 'init' }): Promise<void> {
    if (loaded) {
      // Idempotent re-ack. A second init on an already-loaded worker must NOT
      // call host.load again — that would instantiate a second engine and leak
      // the first instance's memory. A genuine reset uses a FRESH worker after
      // cancel (DESIGN.md §5.2), so this only guards a redundant client init.
      post(initializedMessage(msg.jobId));
      return;
    }
    try {
      await host.load(msg.assets);
      bundlesLoaded = [...msg.assets.bundles.preload];
      loaded = true;
      post(initializedMessage(msg.jobId));
    } catch (error) {
      loaded = false;
      post(fatalMessage(msg.jobId, 'init-failed', describeError(error)));
    }
  }

  function onCompile(msg: CompileMessage): void {
    const { jobId, engine } = msg;

    if (!SUPPORTED_ENGINES.has(engine)) {
      post(
        fatalMessage(
          jobId,
          'unsupported-engine',
          `engine '${engine}' is not implemented in v1 (XeTeX-first; '${engine}' is a reserved enum value)`,
        ),
      );
      return;
    }
    if (!loaded) {
      // The client (item 7) always initialises first; a compile before a
      // successful init is a client-side ordering bug, surfaced structurally.
      post(fatalMessage(jobId, 'internal', 'compile received before the engine was initialised'));
      return;
    }

    const startedAt = now();
    const transcript: string[] = [];
    const onLine: EngineLogSink = (stream, line) => {
      transcript.push(line);
      post(logMessage(jobId, stream, line));
    };

    // synctex is accepted by the API but not yet wired into argv/collection
    // (item-5 scope). Surface an explicit advisory rather than silently
    // dropping it, so a host that asked for it is told (and it lands in the log).
    if (msg.synctex) {
      onLine(
        'stderr',
        'wasmtex: synctex output was requested but is not yet implemented in this build; continuing without it',
      );
    }

    const entryBase = basename(msg.entry);
    const ctx: JobContext = {
      engine: msg.engine as SequencingEngine, // luatex rejected above
      entryBase,
      jobname: jobnameOf(entryBase),
      cwd: dirname(msg.entry) || '.',
    };
    const stageInfo: EngineStageInfo = { files: msg.files, cwd: ctx.cwd };
    const decoder = new TextDecoder();

    const collected = new Map<string, Uint8Array>();
    let lastExit = 0;
    // Previous engine pass's `.aux`/`.toc`, for the change signal (item 6). Kept
    // out of the pure machine (which sees only the derived booleans); `hasPrev`
    // distinguishes "first pass" (no comparison) from "previous had no such file".
    let prevAux: Uint8Array | undefined;
    let prevToc: Uint8Array | undefined;
    let hasPrevEngine = false;
    // The first step (always engine pass 1) opens a fresh job FS by staging the
    // project files; every later step reuses it (sees the prior applet's output).
    let staged = false;

    // Drive the §5.3 machine: run each step, observe, feed back, until terminal.
    // Defense-in-depth iteration bound: termination normally rests on the
    // machine's own monotonic-progress invariants (5 engine passes + 3 tool
    // steps max); this guard turns a future regression there into a loud
    // fatal instead of a worker spinning wasm forever.
    const MAX_STEPS = 5 + 3 + 2;
    let steps = 0;
    let { state, step } = beginSequence(sequencingOptionsOf(msg));
    try {
      while (step.kind !== 'done' && step.kind !== 'abort') {
        if (++steps > MAX_STEPS) {
          post(fatalMessage(jobId, 'internal', 'sequencing exceeded the step bound (machine invariant regression)'));
          return;
        }
        post(progressMessage(jobId, progressOf(step)));
        const stage = staged ? undefined : stageInfo;
        staged = true;
        const runStep = toRunStep(step, ctx, stage);
        const result = host.run(runStep, onLine);
        lastExit = result.exitCode;
        for (const [path, bytes] of result.outputs) collected.set(path, bytes);

        // Build the observation. FS facts are meaningful only after an engine
        // pass (the machine ignores them otherwise); the transcript is this
        // run's captured output — the rerun-marker source.
        let fs: StepFsFacts = NO_FS_FACTS;
        if (step.kind === 'engine') {
          const curAux = result.outputs.get(`${ctx.jobname}.aux`);
          const curToc = result.outputs.get(`${ctx.jobname}.toc`);
          const curIdx = result.outputs.get(`${ctx.jobname}.idx`);
          const auxText = curAux ? decoder.decode(curAux) : '';
          fs = {
            // v1 limitation (documented, journal item 6): only the ROOT aux is
            // scanned. In \include projects LaTeX writes \citation lines into
            // the chapter's own .aux (root has \@input{chapter.aux}), so the
            // bib gate misses them and citations render [?]. Fix would scan
            // \@input-referenced aux files; deferred (needs dynamic collect).
            auxRequestsBib: auxText.includes('\\citation') && auxText.includes('\\bibdata'),
            idxNonEmpty: curIdx !== undefined && decoder.decode(curIdx).trim().length > 0,
            auxChanged: hasPrevEngine && !bytesEqual(curAux, prevAux),
            tocChanged: hasPrevEngine && !bytesEqual(curToc, prevToc),
          };
          prevAux = curAux;
          prevToc = curToc;
          hasPrevEngine = true;
        }
        const observation: StepObservation = { exitCode: result.exitCode, transcript: `${result.stdout}\n${result.stderr}`, fs };
        ({ state, step } = advanceSequence(state, observation));
      }
    } catch (error) {
      const code = error instanceof EngineAborted ? 'engine-aborted' : 'internal';
      post(fatalMessage(jobId, code, describeError(error)));
      return;
    }

    // `done` ⇒ the sequence completed and the terminal driver/engine step exited
    // 0; `abort` ⇒ a step failed (engine ≠ 0, bibtex8 ≥ 2, makeindex ≠ 0, or
    // xdvipdfmx ≠ 0) and `lastExit` holds that failing code (item-5 semantics:
    // stop, ok:false, surface the transcript). A tolerated bibtex8 warning
    // (exit 1) never ends the sequence, so `done` implies a real success.
    const succeeded = step.kind === 'done';
    // Only a fully successful sequence may deliver bytes: pdfTeX collects a
    // PDF on every pass, so an abort after a successful pass N-1 would
    // otherwise attach that stale PDF (e.g. citations as [?]) to ok:false.
    const pdf = succeeded ? collected.get(`${ctx.jobname}.pdf`) : undefined;
    const ok = succeeded && pdf !== undefined;

    const fields: ResultFields = {
      ok,
      exitCode: succeeded ? 0 : lastExit,
      log: transcript.join('\n'),
      stats: {
        passes: state.enginePasses,
        elapsedMs: now() - startedAt,
        bundlesLoaded: [...bundlesLoaded],
      },
      ...(pdf !== undefined ? { pdf } : {}),
    };
    post(resultMessage(jobId, fields));
  }

  return {
    async handle(message: ClientMessage): Promise<void> {
      switch (message.type) {
        case 'init':
          await onInit(message);
          return;
        case 'compile':
          onCompile(message);
          return;
      }
    },
  };
}
