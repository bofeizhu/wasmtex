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
// SEQUENCING (M1 item-5 scope is the MINIMAL single pass): xetex → xdvipdfmx,
// or pdftex direct. The §5.3 state machine (bibtex8 when `.aux` cites, makeindex
// on a non-empty `.idx`, reruns while the log shows unresolved refs, bounded by
// `passes`) is item 6. The `planCompile` function below is the SEAM: item 6
// replaces its hardcoded plan with the state machine, and nothing else in this
// file needs to change.
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
// Engine support + the (item-5 minimal) compile plan
// ---------------------------------------------------------------------------

/**
 * Engines implemented end-to-end in v1. `luatex` is deliberately absent — it is
 * a reserved enum member (DESIGN.md §9), rejected with `unsupported-engine`.
 * `pdftex` is included because it costs only a different format + direct output
 * (no `xdvipdfmx`), needing no engine-specific branching beyond this plan
 * (M1 plan "pdfTeX near-free" test).
 */
const SUPPORTED_ENGINES: ReadonlySet<EngineName> = new Set<EngineName>(['xetex', 'pdftex']);

// The engine build's fixed TeX Live TDS layout for the preloaded format dumps
// (convention: texmf-var/web2c/<engine>/<format>.fmt). These are paths INSIDE
// the texlive bundle's MEMFS, not asset-inventory names, and follow a
// rebase-stable TDS convention — the M2 rebase re-validates them via the
// conformance corpus, not by chasing string constants (M1 rebase-proofing).
const FORMAT_XELATEX = '/texlive/texmf-dist/texmf-var/web2c/xetex/xelatex.fmt';
const FORMAT_PDFLATEX = '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt';

/** A planned applet run plus the coarse progress phase to announce before it. */
interface CompileStage {
  readonly progress: ProgressPhase;
  readonly step: EngineRunStep;
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

/**
 * THE SEAM (item 6). Produce the ordered applet sequence for a supported engine.
 * Item-5 scope is the minimal single pass; item 6 replaces THIS function with
 * the §5.3 state machine (bibtex8 / makeindex / bounded reruns) — the run loop
 * in {@link createWorkerCore} stays unchanged because it only consumes stages.
 *
 * Precondition: `msg.engine ∈ SUPPORTED_ENGINES` (the caller rejects the rest).
 */
function planCompile(msg: CompileMessage): readonly CompileStage[] {
  const entryBase = basename(msg.entry);
  const jobname = jobnameOf(entryBase);
  const cwd = dirname(msg.entry) || '.';
  const stage: EngineStageInfo = { files: msg.files, cwd };
  const pdf = `${jobname}.pdf`;

  if (msg.engine === 'pdftex') {
    // pdfTeX writes the PDF directly — no xdvipdfmx step.
    return [
      {
        progress: { kind: 'engine', pass: 1 },
        step: {
          applet: 'pdflatex',
          argv: [
            '--no-shell-escape',
            '--interaction=nonstopmode',
            '--halt-on-error',
            '--output-format=pdf',
            '--fmt',
            FORMAT_PDFLATEX,
            entryBase,
          ],
          stage,
          collect: [pdf],
        },
      },
    ];
  }

  // xetex (default): engine produces an .xdv, xdvipdfmx turns it into the PDF.
  const xdv = `${jobname}.xdv`;
  return [
    {
      progress: { kind: 'engine', pass: 1 },
      step: {
        applet: 'xelatex',
        argv: [
          '--no-shell-escape',
          // nonstopmode (not batchmode): TeX then prints its full transcript —
          // crucially the "! …" error lines with l.N — to the terminal, which
          // the host captures and streams, so result.log carries the errors a
          // failing compile needs (batchmode writes them only to <job>.log and
          // leaves result.log a bare banner). Matches the pdflatex step and is
          // the source the diagnostics parser (item 8) reads.
          '--interaction=nonstopmode',
          '--halt-on-error',
          '--no-pdf',
          '--fmt',
          FORMAT_XELATEX,
          entryBase,
        ],
        stage,
        collect: [],
      },
    },
    {
      progress: { kind: 'xdvipdfmx' },
      step: {
        applet: 'xdvipdfmx',
        argv: ['-o', pdf, xdv],
        collect: [pdf],
      },
    },
  ];
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

    const collected = new Map<string, Uint8Array>();
    let lastExit = 0;
    let enginePasses = 0;

    try {
      for (const { progress, step } of planCompile(msg)) {
        post(progressMessage(jobId, progress));
        if (progress.kind === 'engine') enginePasses += 1;
        const result = host.run(step, onLine);
        lastExit = result.exitCode;
        for (const [path, bytes] of result.outputs) collected.set(path, bytes);
        if (result.exitCode !== 0) break; // stop the sequence on the first failure
      }
    } catch (error) {
      const code = error instanceof EngineAborted ? 'engine-aborted' : 'internal';
      post(fatalMessage(jobId, code, describeError(error)));
      return;
    }

    const jobname = jobnameOf(basename(msg.entry));
    const pdf = collected.get(`${jobname}.pdf`);
    const ok = lastExit === 0 && pdf !== undefined;

    const fields: ResultFields = {
      ok,
      exitCode: lastExit,
      log: transcript.join('\n'),
      stats: {
        passes: enginePasses,
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
