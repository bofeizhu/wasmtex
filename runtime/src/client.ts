// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   The §5.1 client surface (createTypesetter / Typesetter / job objects) is an
//   ORIGINAL design (DESIGN.md §2.4, §5.1). It consumes only this repo's own
//   protocol module (`./protocol`) across the worker boundary. The vendored
//   busytex glue was NEVER consulted for this file — the public API is the part
//   of the design deliberately unlike prior wrappers. Not derived from any
//   GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// The main-thread client (M1 item 7). This is the ONLY module a host imports:
// `createTypesetter(options)` boots a correlated worker, and `Typesetter` hands
// out `Job` objects ({ done, onLog, cancel }) per DESIGN.md §5.1.
//
// It lives in `src/` and imports ONLY from `./protocol` — never from `worker/`
// — so it is not part of the classic-worker bundle (`npm run build:worker`,
// built from `worker/entry.ts`). The worker never imports the client either;
// the two halves meet only at the wire (`ClientMessage`/`WorkerMessage`).
//
// The constitutional contracts it enforces (DESIGN.md §5.2, §10):
//   * Correlation gate. EVERY inbound message passes `parseWorkerMessage` then
//     `isForJob(activeJobId)`; anything else is dropped (counted for debugging).
//     A late message from a cancelled or timed-out job carries an OLD `jobId`,
//     so it can never resolve a newer job — safety by construction, not timing.
//   * Real cancellation. `cancel()` of the active job TERMINATES the worker; the
//     next job transparently spawns a fresh worker and re-initialises. Engine
//     warm-state is a cache, never a correctness dependency.
//   * Serialized jobs. A single worker runs one compile at a time; extra
//     `typeset()` calls queue and dispatch in FIFO order as each settles.
//   * No DOM, no hidden persistence. Web globals (`Worker`, `fetch`) are reached
//     structurally through `globalThis` (the build pins `lib: ["ES2022"]`,
//     `types: []`), so nothing here depends on the DOM or Node lib; both are
//     injectable for tests and for custom-scheme embedding (§10).
//
// This module is browser-safe: no Node types, no DOM lib, no `queueMicrotask`
// (not in ES2022) — scheduling is done with promises.
// ---------------------------------------------------------------------------

import { parseDiagnostics } from './diagnostics';
import {
  PROTOCOL_VERSION,
  isForJob,
  newJobId,
  parseClientMessage,
  parseWorkerMessage,
} from './protocol';
import type {
  AssetEntry,
  AssetsConfig,
  AssetsInventory,
  AutoOff,
  BundleSelection,
  CompileMessage,
  CompileStats,
  Diagnostic,
  EngineName,
  FatalCode,
  InitMessage,
  JobId,
  PassPolicy,
  ProjectFiles,
  ResultMessage,
  WorkerMessage,
} from './protocol';

// ---------------------------------------------------------------------------
// Injectable environment surfaces (structural — no DOM/Node lib).
//
// The real browser/worker globals satisfy these shapes; tests inject fakes and
// an in-process adapter. Kept intentionally minimal — only the members the
// client actually touches — so a fake is a few lines.
// ---------------------------------------------------------------------------

/** The `Worker`-like handle the client drives. A classic `Worker` satisfies it. */
export interface WorkerLike {
  /** Post a client→worker message. The client never transfers (see {@link CreateTypesetterOptions}); `transfer` exists only for shape-compatibility with `Worker`. */
  postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  /** Stop the worker for good (frees its wasm instance). `cancel()`/`dispose()` call this. */
  terminate(): void;
  /** Set by the client to receive worker→client messages. */
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  /** Set by the client to observe an unexpected worker failure (→ {@link WorkerCrashedError}). */
  onerror: ((event: unknown) => void) | null;
}

/** Builds a fresh {@link WorkerLike}. Called once per (re)initialisation. */
export type WorkerFactory = () => WorkerLike;

/** The `new Worker(url)` constructor shape (classic worker; no `{ type: 'module' }`). */
type WorkerConstructorLike = new (scriptUrl: string) => WorkerLike;

/** The subset of a `fetch` `Response` the client reads (for `assets.json`). */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** A `fetch`-like function. Defaults to `globalThis.fetch`; injectable for custom schemes (§10) and tests. */
export type FetchLike = (input: string) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Public option / result / job types (DESIGN.md §5.1 — the spec)
// ---------------------------------------------------------------------------

/** A coarse asset-load progress event (DESIGN.md §5.1 `onAssetProgress`). See fidelity note on {@link CreateTypesetterOptions.onAssetProgress}. */
export interface AssetProgress {
  /** The asset's inventory path (its stable identifier). */
  readonly assetId: string;
  /** Bytes loaded: `0` at start, `totalBytes` at completion — never a fabricated intermediate (see fidelity note). */
  readonly loadedBytes: number;
  /** The asset's real declared size from the manifest, or `0` when the manifest omits it. */
  readonly totalBytes: number;
}

/**
 * Options for {@link createTypesetter} (DESIGN.md §5.1). The first four are the
 * §5.1 surface; the rest are injection seams (beyond §5.1) for tests and for the
 * embedding profile (§10 — custom scheme handlers, bundler-provided workers).
 */
export interface CreateTypesetterOptions {
  /** Same-origin base URL the worker loads assets from (DESIGN.md §5.1, §10). */
  readonly assetsBaseUrl: string;
  /** Which bundles to preload vs. leave on-demand. Defaults to none preloaded (a working typesetter needs at least one preload bundle). */
  readonly bundles?: BundleSelection;
  /**
   * Coarse asset-load progress callback (DESIGN.md §5.1).
   *
   * FIDELITY (M1): per-byte progress is NOT available. The engine wasm/js and the
   * preload bundles are fetched INSIDE the worker by Emscripten (`importScripts` +
   * its own runtime fetch), which exposes no byte callback to the main thread. So
   * the client emits, per init-loaded asset, exactly two events: `loadedBytes: 0`
   * when initialisation starts and `loadedBytes === totalBytes` when it completes.
   * `totalBytes` is the manifest's REAL size — no byte count is ever fabricated.
   * `assets.json` itself (a tiny bootstrap fetch) is not reported. True streaming
   * progress is deferred (would require the worker to fetch + post progress).
   */
  readonly onAssetProgress?: (progress: AssetProgress) => void;
  /**
   * Optional per-file URL override (DESIGN.md §5.1). Called with an asset's
   * inventory path (and `'assets.json'` for the bootstrap fetch); a returned
   * non-empty string is used verbatim by the worker (`importScripts`/`fetch`)
   * instead of `assetsBaseUrl` + path. Same-origin is the host's concern.
   */
  readonly locateAsset?: (name: string) => string | undefined;
  /** Skip the `assets.json` fetch by supplying the inventory directly (tests / hosts that already hold it). */
  readonly inventory?: AssetsInventory;
  /** `fetch` implementation for loading `assets.json`. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Build the worker. Defaults to `() => new Worker(workerUrl)` (classic). Node tests inject a fake or an in-process adapter. */
  readonly workerFactory?: WorkerFactory;
  /** The classic-worker script URL for the default factory. Defaults to `assetsBaseUrl` + `worker.js`. */
  /**
   * Note: `locateAsset` is consulted for inventory entries and `assets.json`,
   * but NOT for the default worker-script URL — custom-scheme hosts (§10)
   * that need to relocate the worker script use this option (or
   * `workerFactory`) instead.
   */
  readonly workerUrl?: string;
}

/**
 * One typeset request (DESIGN.md §5.1 `typeset(...)`). The key set is exactly
 * §5.1's — `engine`, `entry`, `files`, `passes`, `bibliography`, `index`,
 * `synctex`; the four knobs are optional here with the documented defaults.
 */
export interface TypesetJob {
  /** `'xetex'` (fully supported) | `'pdftex'` | `'luatex'` (reserved — rejected with a {@link FatalError}). */
  readonly engine: EngineName;
  /** The root file to compile, a safe project-relative path (e.g. `main.tex`). */
  readonly entry: string;
  /** Project inputs as a `path → contents` map (bytes or UTF-8 text). */
  readonly files: ProjectFiles;
  /** Rerun policy: `'auto'` (default) reruns until quiescent (cap 5), or an exact 1..5. */
  readonly passes?: PassPolicy;
  /** `'auto'` (default) runs bibtex8 when the `.aux` requests it; `'off'` never. */
  readonly bibliography?: AutoOff;
  /** `'auto'` (default) runs makeindex when a non-empty `.idx` exists; `'off'` never. */
  readonly index?: AutoOff;
  /** Request SyncTeX output (default `false`). Accepted but not yet produced in M1 (advisory logged). */
  readonly synctex?: boolean;
}

/** The terminal result of a compile (DESIGN.md §5.1 result shape). */
export interface TypesetResult {
  /** True iff the sequence finished and produced a PDF. */
  readonly ok: boolean;
  /** The last applet's process exit code (`0` on success). */
  readonly exitCode: number;
  /** The produced PDF bytes, when `ok`. */
  readonly pdf?: Uint8Array;
  /** The produced SyncTeX bytes, when requested and produced (absent in M1). */
  readonly synctex?: Uint8Array;
  /** The full engine transcript (all streamed log lines joined). */
  readonly log: string;
  /**
   * Parsed diagnostics (DESIGN.md §5.1): errors and warnings extracted from
   * the transcript by the pure log parser (`parseDiagnostics` over `log`),
   * with file/line attribution where TeX reports them. Empty for a clean
   * compile.
   */
  readonly diagnostics: readonly Diagnostic[];
  /** Compile statistics (passes run, wall time, bundles loaded). */
  readonly stats: CompileStats;
}

/** A single typeset job handle (DESIGN.md §5.1). */
export interface Job {
  /** Resolves with the {@link TypesetResult}; rejects with {@link CancelledError}, {@link WorkerCrashedError}, or {@link FatalError}. */
  readonly done: Promise<TypesetResult>;
  /** Register a line callback for the streaming transcript. A late registration replays lines already seen, preserving order. */
  onLog(callback: (line: string) => void): void;
  /** Cancel the job. If it is running, the worker is terminated and `done` rejects with {@link CancelledError}; the next job re-initialises. Idempotent. */
  cancel(): void;
}

/** The typesetter handle returned by {@link createTypesetter} (DESIGN.md §5.1). */
export interface Typesetter {
  /** Enqueue a compile and return its {@link Job}. Throws {@link TypesetInputError} synchronously on invalid input. */
  typeset(job: TypesetJob): Job;
  /** Terminate the worker and reject every in-flight and queued job. Idempotent. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error taxonomy (all exported, documented)
// ---------------------------------------------------------------------------

/**
 * The reason a {@link CancelledError} was raised: an explicit `job.cancel()`
 * (`'cancelled'`) or a `typesetter.dispose()` (`'disposed'`).
 */
export type CancelReason = 'cancelled' | 'disposed';

/**
 * A job's `done` was rejected because the job was deliberately cancelled — via
 * `job.cancel()` (which terminated the running worker, DESIGN.md §5.2) or via
 * `typesetter.dispose()`. Distinguished from a failure: nothing went wrong.
 */
export class CancelledError extends Error {
  /** Whether an individual `cancel()` or a whole-typesetter `dispose()` caused it. */
  readonly reason: CancelReason;
  constructor(reason: CancelReason, message: string) {
    super(message);
    this.name = 'CancelledError';
    this.reason = reason;
  }
}

/**
 * A job's `done` was rejected because the worker failed unexpectedly — an
 * `onerror` event or an abnormal termination that is NOT a structured `fatal`
 * (DESIGN.md §5.2). The next `typeset()` transparently re-initialises on a fresh
 * worker.
 */
export class WorkerCrashedError extends Error {
  /** A best-effort, non-sensitive detail recovered from the error event, if any. */
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'WorkerCrashedError';
    this.detail = detail;
  }
}

/**
 * A structured, engine-level failure surfaced by the worker (DESIGN.md §5.2
 * `fatal`). Carries the protocol {@link FatalCode} so a host can branch on it —
 * e.g. `'unsupported-engine'` (a reserved engine like `luatex`), `'init-failed'`
 * (asset load / instantiation), `'engine-aborted'` (a wasm `abort()`).
 */
export class FatalError extends Error {
  /** The closed protocol fatal category. */
  readonly code: FatalCode;
  /** A non-sensitive detail (e.g. a failing asset path), if the worker supplied one. */
  readonly detail: string | undefined;
  constructor(code: FatalCode, message: string, detail?: string) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Thrown SYNCHRONOUSLY by `createTypesetter` (bad options) or `typeset()` (a
 * malformed job) — a programmer error caught before anything is sent to the
 * worker. The validation authority is `parseClientMessage` (the same total
 * validator the worker trusts), so the client and worker cannot disagree.
 */
export class TypesetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypesetInputError';
  }
}

// ---------------------------------------------------------------------------
// Diagnostics accessor (debug-only; kept OFF the §5.1 Typesetter surface)
// ---------------------------------------------------------------------------

/** Debug counters for a {@link Typesetter} (read via {@link typesetterDiagnostics}). */
export interface TypesetterDiagnostics {
  /** Inbound messages dropped by the correlation gate (unparseable or foreign/stale `jobId`). */
  readonly droppedMessages: number;
  /** Workers spawned so far — increments on each (re)initialisation, so > 1 proves a cancel/crash reinit happened. */
  readonly workerSpawns: number;
}

// A WeakMap keeps the debug surface off the §5.1 `Typesetter` interface: the
// returned object is exactly `{ typeset, dispose }` to a type consumer, while
// this reader still gives tests/debuggers typed access to the internals.
const internalsRegistry = new WeakMap<Typesetter, TypesetterClient>();

/**
 * Read the debug counters of a {@link Typesetter} created by this module. Not
 * part of the §5.1 surface — for tests and diagnostics only. Throws if `t` is not
 * a wasmtex typesetter.
 */
export function typesetterDiagnostics(t: Typesetter): TypesetterDiagnostics {
  const client = internalsRegistry.get(t);
  if (client === undefined) {
    throw new TypesetInputError('typesetterDiagnostics: not a wasmtex Typesetter created by this module');
  }
  return { droppedMessages: client.droppedMessages, workerSpawns: client.workerSpawns };
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

/** A promise with externally callable settle handlers. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Reduce an unknown thrown value to a short, non-sensitive message string. */
function describeError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

/** Best-effort, non-sensitive detail from a worker `onerror` event. */
function describeErrorEvent(event: unknown): string | undefined {
  if (typeof event === 'string') return event.length > 0 ? event : undefined;
  if (event !== null && typeof event === 'object') {
    const e = event as { message?: unknown; error?: unknown };
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (e.error instanceof Error && e.error.message.length > 0) return e.error.message;
  }
  return undefined;
}

/** Join a base (URL or POSIX path) with a relative name using `/` (mirrors the host's joinLocation). */
function joinLocation(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

/** Last path segment of a `/`-separated path. */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Normalise the bundle selection (defensive copies; default none preloaded). */
function normalizeBundles(bundles: BundleSelection | undefined): BundleSelection {
  if (!bundles) return { preload: [], onDemand: [] };
  return { preload: [...bundles.preload], onDemand: [...bundles.onDemand] };
}

/** Inject `locateAsset` overrides as per-entry `url` fields (the override mechanism, DESIGN.md §5.1). */
function applyLocateAsset(
  inventory: AssetsInventory,
  locateAsset: ((name: string) => string | undefined) | undefined,
): AssetsInventory {
  if (!locateAsset) return inventory;
  const assets = inventory.assets.map((entry) => {
    const override = locateAsset(entry.path);
    return typeof override === 'string' && override.length > 0 ? { ...entry, url: override } : entry;
  });
  return { ...inventory, assets };
}

/**
 * The assets the worker loads during init — engine wasm + its JS loader, plus
 * each preload bundle's JS + data blob (matched by name, leniently). Used ONLY
 * to derive coarse {@link AssetProgress} events; best-effort, so an unmatched
 * bundle name is simply not reported here (init itself surfaces a real mismatch).
 */
function initLoadedAssets(config: AssetsConfig): readonly AssetEntry[] {
  const { inventory, bundles } = config;
  const out: AssetEntry[] = [];
  for (const a of inventory.assets) {
    if (a.role === 'engine-wasm' || a.role === 'engine-js') out.push(a);
  }
  for (const name of bundles.preload) {
    for (const a of inventory.assets) {
      if (a.role !== 'bundle-js' && a.role !== 'bundle-data') continue;
      const b = basename(a.path);
      if (b === name || b === `${name}.js` || b === `${name}.data` || b.replace(/\.(js|data)$/, '') === name) {
        out.push(a);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JobHandle — the private side of a public Job
// ---------------------------------------------------------------------------

/**
 * The internal record behind a {@link Job}. Owns the `done` promise, the log
 * buffer/callbacks, and a `settled` gate that makes resolve/reject idempotent and
 * unblocks the dispatch pump exactly once.
 */
class JobHandle {
  readonly jobId: JobId;
  readonly compile: CompileMessage;
  readonly job: Job;
  /** True once resolved or rejected. Guards double-settling and lets the pump skip a cancelled-while-queued job. */
  settled = false;

  readonly #done = deferred<TypesetResult>();
  readonly #settled = deferred<void>();
  readonly #logCallbacks: Array<(line: string) => void> = [];
  readonly #logLines: string[] = [];

  constructor(jobId: JobId, compile: CompileMessage, onCancel: (self: JobHandle) => void) {
    this.jobId = jobId;
    this.compile = compile;
    // Library safety: a cancelled/failed job the host chose not to await must not
    // surface as an unhandled rejection. A benign catch marks `done` handled while
    // the host's own `await`/`.catch` still receives the rejection independently.
    this.#done.promise.catch(() => {});
    this.job = {
      done: this.#done.promise,
      onLog: (callback) => this.#addLog(callback),
      cancel: () => onCancel(this),
    };
  }

  /** Resolves (once) when the job settles for ANY reason — the pump awaits this to serialize. */
  get settledPromise(): Promise<void> {
    return this.#settled.promise;
  }

  #addLog(callback: (line: string) => void): void {
    for (const line of this.#logLines) callback(line); // replay so a late registration keeps order
    this.#logCallbacks.push(callback);
  }

  /** Append one streamed transcript line: buffer it and fan out to every callback. */
  appendLog(line: string): void {
    this.#logLines.push(line);
    for (const callback of this.#logCallbacks) callback(line);
  }

  resolve(result: TypesetResult): void {
    if (this.settled) return;
    this.settled = true;
    this.#done.resolve(result);
    this.#settled.resolve();
  }

  reject(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.#done.reject(error);
    this.#settled.resolve();
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Runtime dependencies of {@link TypesetterClient} (resolved by {@link createTypesetter}). */
interface ClientDeps {
  readonly workerFactory: WorkerFactory;
  readonly onAssetProgress: ((progress: AssetProgress) => void) | undefined;
}

class TypesetterClient implements Typesetter {
  readonly #deps: ClientDeps;
  readonly #initConfig: AssetsConfig;
  readonly #initAssets: readonly AssetEntry[];

  #worker: WorkerLike | null = null;
  #workerReady = false;
  /** The id the correlation gate currently expects (init id while initialising, active compile id while compiling, else null). */
  #currentJobId: JobId | null = null;
  #pendingInit: { readonly jobId: JobId; readonly deferred: Deferred<void> } | null = null;

  #activeJob: JobHandle | null = null;
  readonly #queue: JobHandle[] = [];
  #pumping = false;
  #disposed = false;

  // Debug counters (exposed via typesetterDiagnostics; not on the §5.1 surface).
  droppedMessages = 0;
  workerSpawns = 0;

  constructor(deps: ClientDeps, initConfig: AssetsConfig) {
    this.#deps = deps;
    this.#initConfig = initConfig;
    this.#initAssets = initLoadedAssets(initConfig);
  }

  /** Spawn the first worker and complete the init handshake. Rejects on init `fatal`/crash. */
  async start(): Promise<void> {
    await this.#ready();
  }

  // -- public §5.1 surface --------------------------------------------------

  typeset(input: TypesetJob): Job {
    if (this.#disposed) {
      throw new TypesetInputError('typeset: the typesetter has been disposed');
    }
    const jobId = newJobId();
    const compile = this.#buildCompile(jobId, input); // throws TypesetInputError on bad input
    const handle = new JobHandle(jobId, compile, (h) => this.#cancelJob(h));
    this.#queue.push(handle);
    void this.#pump();
    return handle.job;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const err = new CancelledError('disposed', 'the typesetter was disposed');
    if (this.#pendingInit) {
      const pending = this.#pendingInit;
      this.#pendingInit = null;
      pending.deferred.reject(err);
    }
    if (this.#activeJob) {
      const job = this.#activeJob;
      this.#activeJob = null;
      job.reject(err);
    }
    const queued = this.#queue.splice(0, this.#queue.length);
    for (const job of queued) job.reject(err);
    this.#teardownWorker();
  }

  // -- validation -----------------------------------------------------------

  /** Build + validate a CompileMessage through the SAME validator the worker uses (single source of truth). */
  #buildCompile(jobId: JobId, input: TypesetJob): CompileMessage {
    const candidate = {
      type: 'compile',
      v: PROTOCOL_VERSION,
      jobId,
      files: input.files,
      entry: input.entry,
      engine: input.engine,
      passes: input.passes ?? 'auto',
      bibliography: input.bibliography ?? 'auto',
      index: input.index ?? 'auto',
      synctex: input.synctex ?? false,
    };
    const parsed = parseClientMessage(candidate);
    if (parsed === null || parsed.type !== 'compile') {
      throw new TypesetInputError(
        `typeset: invalid job (engine=${JSON.stringify(input.engine)}, ` +
          `entry=${JSON.stringify(input.entry)}, passes=${JSON.stringify(input.passes ?? 'auto')}). ` +
          "engine must be 'xetex' | 'pdftex' | 'luatex'; entry and every file path must be safe " +
          "project-relative paths (no '..', no leading/trailing slash, no empty segment); " +
          "passes must be 'auto' or an integer 1..5; bibliography/index must be 'auto' | 'off'; " +
          'synctex must be a boolean; files must be a non-empty map of path -> (string | Uint8Array).',
      );
    }
    return parsed;
  }

  // -- worker lifecycle -----------------------------------------------------

  /** Resolve once a ready worker exists; (re)initialise a fresh one if needed. */
  #ready(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new TypesetInputError('the typesetter has been disposed'));
    }
    if (this.#workerReady) return Promise.resolve();
    if (this.#pendingInit) return this.#pendingInit.deferred.promise;
    return this.#spawnAndInit();
  }

  #spawnAndInit(): Promise<void> {
    const worker = this.#deps.workerFactory();
    this.#worker = worker;
    this.#workerReady = false;
    this.workerSpawns += 1;
    worker.onmessage = (event) => this.#handleMessage(event.data);
    worker.onerror = (event) => this.#handleWorkerError(event);

    const jobId = newJobId();
    const d = deferred<void>();
    this.#pendingInit = { jobId, deferred: d };
    this.#currentJobId = jobId;
    this.#emitAssetProgress(false); // start: loadedBytes 0

    const init: InitMessage = { type: 'init', v: PROTOCOL_VERSION, jobId, assets: this.#initConfig };
    this.#post(init);
    return d.promise;
  }

  /** Terminate + forget the current worker. Leaves #pendingInit/#activeJob to the caller. */
  #teardownWorker(): void {
    const worker = this.#worker;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        /* a terminate() that throws still means the worker is gone to us */
      }
    }
    this.#worker = null;
    this.#workerReady = false;
    this.#currentJobId = null;
  }

  #post(message: InitMessage | CompileMessage): void {
    const worker = this.#worker;
    if (!worker) throw new Error('internal: #post with no worker');
    // Deliberately NO transfer list: transferring would DETACH the host's own
    // input Uint8Arrays (protocol `transferablesOf` HAZARD). Cloning the inputs
    // keeps the host's `files` intact — correctness over a copy. (The worker→client
    // result transfer is the worker's call, in entry.ts.)
    worker.postMessage(message);
  }

  // -- inbound message routing (the correlation gate) -----------------------

  #handleMessage(data: unknown): void {
    const msg = parseWorkerMessage(data);
    if (msg === null) {
      this.droppedMessages += 1; // unparseable / wrong version / hostile shape
      return;
    }
    const expected = this.#currentJobId;
    if (expected === null || !isForJob(msg, expected)) {
      this.droppedMessages += 1; // foreign or stale jobId — CANNOT resolve a newer job (§5.2)
      return;
    }
    if (this.#pendingInit && msg.jobId === this.#pendingInit.jobId) {
      this.#handleInitMessage(msg);
      return;
    }
    if (this.#activeJob && msg.jobId === this.#activeJob.jobId) {
      this.#handleCompileMessage(this.#activeJob, msg);
      return;
    }
    // Correlated to #currentJobId but no matching pending/active target — the two
    // are the only holders of #currentJobId, so this is unreachable; count it
    // rather than trust the invariant silently.
    this.droppedMessages += 1;
  }

  #handleInitMessage(msg: WorkerMessage): void {
    const pending = this.#pendingInit;
    if (!pending) return;
    switch (msg.type) {
      case 'initialized':
        this.#workerReady = true;
        this.#pendingInit = null;
        this.#currentJobId = null;
        this.#emitAssetProgress(true); // done: loadedBytes === totalBytes
        pending.deferred.resolve();
        return;
      case 'fatal':
        this.#pendingInit = null;
        this.#teardownWorker();
        pending.deferred.reject(new FatalError(msg.code, msg.message, msg.detail));
        return;
      default:
        // log/progress/result during init are not expected; ignore (correlated, harmless).
        return;
    }
  }

  #handleCompileMessage(job: JobHandle, msg: WorkerMessage): void {
    switch (msg.type) {
      case 'log':
        job.appendLog(msg.line);
        return;
      case 'progress':
        // Compile-phase progress (engine/bibtex8/makeindex/xdvipdfmx). Recognised and
        // correlated, but the §5.1 public Job has no compile-progress channel in M1;
        // a future onProgress hook would surface it. Intentionally a no-op (not a drop).
        return;
      case 'result':
        this.#activeJob = null;
        this.#currentJobId = null;
        job.resolve(assembleResult(msg));
        return;
      case 'fatal':
        this.#activeJob = null;
        this.#currentJobId = null;
        if (msg.code === 'engine-aborted' || msg.code === 'internal') {
          // The engine instance may be corrupt (a wasm abort() / unexpected host
          // throw), so drop the worker; the next job re-initialises fresh (§5.2).
          this.#teardownWorker();
        }
        job.reject(new FatalError(msg.code, msg.message, msg.detail));
        return;
      default:
        // 'initialized' correlated to a compile id is impossible (init uses its own id).
        return;
    }
  }

  #handleWorkerError(event: unknown): void {
    if (this.#disposed) return;
    const detail = describeErrorEvent(event);
    const makeError = (): WorkerCrashedError =>
      new WorkerCrashedError('the worker terminated unexpectedly', detail);
    // Tear the worker down FIRST so the pending/active rejection below unblocks the
    // pump onto a clean slate (a fresh worker on the next #ready()).
    this.#teardownWorker();
    if (this.#pendingInit) {
      const pending = this.#pendingInit;
      this.#pendingInit = null;
      pending.deferred.reject(makeError());
    } else if (this.#activeJob) {
      const job = this.#activeJob;
      this.#activeJob = null;
      job.reject(makeError());
    }
  }

  // -- cancellation ---------------------------------------------------------

  #cancelJob(handle: JobHandle): void {
    if (handle.settled) return; // idempotent; also covers already-resolved jobs
    if (handle === this.#activeJob) {
      // Cancelling the RUNNING job: terminate the worker (real cancellation, §5.2).
      // Its settledPromise resolves via reject() → the pump advances onto a fresh
      // worker for the next job.
      this.#activeJob = null;
      this.#teardownWorker();
      handle.reject(new CancelledError('cancelled', 'the job was cancelled'));
      return;
    }
    // Cancelling a QUEUED-but-not-running job: drop it; the worker (busy with
    // another job, or idle) is untouched.
    const index = this.#queue.indexOf(handle);
    if (index >= 0) this.#queue.splice(index, 1);
    handle.reject(new CancelledError('cancelled', 'the job was cancelled'));
  }

  // -- dispatch pump (serialization) ----------------------------------------

  /**
   * The single dispatch loop: runs one job at a time, awaiting each job's
   * settlement before dispatching the next (strict serialization, DESIGN.md §5.2).
   * Guarded by `#pumping` so concurrent triggers collapse into one loop.
   */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#disposed && this.#queue.length > 0 && this.#activeJob === null) {
        const job = this.#queue[0];
        if (job === undefined) break;
        if (job.settled) {
          this.#queue.shift(); // cancelled while queued
          continue;
        }
        if (!this.#workerReady) {
          try {
            await this.#ready();
          } catch (error) {
            // Init failed/crashed for this job. Fail just this job; the next one
            // retries init on a fresh worker (transparent reinit).
            if (!job.settled) {
              this.#queue.shift();
              job.reject(error);
            }
            continue;
          }
          if (this.#disposed) break;
          if (job.settled) {
            // Cancelled while awaiting init. #cancelJob already SPLICED the
            // handle out of the queue, so `job` is no longer queue[0] —
            // shift() here would silently drop the NEXT job (whose `done`
            // would then hang forever). Remove by identity, defensively.
            const i = this.#queue.indexOf(job);
            if (i >= 0) this.#queue.splice(i, 1);
            continue;
          }
        }
        // The worker is ready: dispatch SYNCHRONOUSLY — no await between the
        // readiness check and #post — so a same-tick `cancel()` targets the now
        // ACTIVE job (real worker termination, §5.2) instead of slipping into the
        // queued-drop path during an await micro-turn.
        this.#queue.shift();
        this.#activeJob = job;
        this.#currentJobId = job.jobId;
        this.#post(job.compile);
        await job.settledPromise; // result / fatal / cancel / crash clears #activeJob
      }
    } finally {
      this.#pumping = false;
    }
  }

  // -- progress -------------------------------------------------------------

  #emitAssetProgress(done: boolean): void {
    const cb = this.#deps.onAssetProgress;
    if (!cb) return;
    for (const entry of this.#initAssets) {
      const totalBytes = typeof entry.bytes === 'number' ? entry.bytes : 0;
      cb({ assetId: entry.path, loadedBytes: done ? totalBytes : 0, totalBytes });
    }
  }
}

/**
 * Assemble the public {@link TypesetResult} from a worker `result` envelope.
 *
 * The §5.1 `diagnostics` are derived HERE, client-side, from the raw `log` on
 * the wire (item 8): `parseDiagnostics` is a pure, total parser (`./diagnostics`)
 * — keeping it off the worker/protocol boundary means a TeX-Live rebase that
 * changes transcript wording touches only the parser + its fixtures, never the
 * worker bundle (M1 rebase-proofing rule 2).
 */
function assembleResult(message: ResultMessage): TypesetResult {
  const diagnostics: readonly Diagnostic[] = parseDiagnostics(message.log);
  return {
    ok: message.ok,
    exitCode: message.exitCode,
    ...(message.pdf !== undefined ? { pdf: message.pdf } : {}),
    ...(message.synctex !== undefined ? { synctex: message.synctex } : {}),
    log: message.log,
    diagnostics,
    stats: message.stats,
  };
}

// ---------------------------------------------------------------------------
// createTypesetter (DESIGN.md §5.1 entry point)
// ---------------------------------------------------------------------------

/** Resolve the inventory: use the supplied one, or fetch `assets.json` from the base URL. */
async function resolveInventory(options: CreateTypesetterOptions): Promise<AssetsInventory> {
  if (options.inventory) return options.inventory;
  const name = 'assets.json';
  const override = options.locateAsset?.(name);
  const url = typeof override === 'string' && override.length > 0 ? override : joinLocation(options.assetsBaseUrl, name);
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypesetInputError(
      'createTypesetter: no fetch is available to load assets.json; pass options.inventory or options.fetchImpl',
    );
  }
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new FatalError('init-failed', `failed to fetch ${url}: ${describeError(error)}`, url);
  }
  if (!response.ok) {
    throw new FatalError('init-failed', `failed to fetch ${url}: HTTP ${response.status}`, url);
  }
  try {
    return (await response.json()) as AssetsInventory;
  } catch (error) {
    throw new FatalError('init-failed', `assets.json at ${url} is not valid JSON: ${describeError(error)}`, url);
  }
}

/** Choose the worker factory: explicit, else the default `new Worker(workerUrl)` (classic). */
function resolveWorkerFactory(options: CreateTypesetterOptions): WorkerFactory {
  if (options.workerFactory) return options.workerFactory;
  const workerUrl = options.workerUrl ?? joinLocation(options.assetsBaseUrl, 'worker.js');
  const WorkerCtor = (globalThis as { Worker?: WorkerConstructorLike }).Worker;
  if (typeof WorkerCtor !== 'function') {
    throw new TypesetInputError(
      'createTypesetter: no Worker constructor in this environment; pass options.workerFactory ' +
        '(e.g. wrapping your bundler’s worker) or run where classic Workers exist',
    );
  }
  return () => new WorkerCtor(workerUrl); // classic worker — no { type: 'module' } (DESIGN.md §3)
}

/**
 * Boot a {@link Typesetter} (DESIGN.md §5.1): resolve the asset inventory (fetch
 * `assets.json` unless supplied), apply any `locateAsset` overrides, validate the
 * whole init config through the worker's own validator, spawn the correlated
 * worker, and await the first init handshake. Rejects (without leaking a worker)
 * on invalid options ({@link TypesetInputError}), a fatal init ({@link FatalError}),
 * or a worker crash ({@link WorkerCrashedError}).
 */
export async function createTypesetter(options: CreateTypesetterOptions): Promise<Typesetter> {
  const baseUrl = options.assetsBaseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypesetInputError('createTypesetter: assetsBaseUrl must be a non-empty string');
  }
  const bundles = normalizeBundles(options.bundles);
  const rawInventory = await resolveInventory(options);
  const inventory = applyLocateAsset(rawInventory, options.locateAsset);

  // Validate the init config through the SAME total validator the worker trusts.
  // This strips junk, rebuilds a fresh inventory carrying the injected `url`s, and
  // fails HERE (typed) if the resolved assets.json is malformed.
  const probe = parseClientMessage({
    type: 'init',
    v: PROTOCOL_VERSION,
    jobId: newJobId(),
    assets: { baseUrl, inventory, bundles },
  });
  if (probe === null || probe.type !== 'init') {
    throw new TypesetInputError(
      'createTypesetter: the resolved assets inventory is malformed ' +
        '(expected { assets: [{ path, ... }] } with a non-empty baseUrl and string[] bundles)',
    );
  }

  const client = new TypesetterClient(
    { workerFactory: resolveWorkerFactory(options), onAssetProgress: options.onAssetProgress },
    probe.assets,
  );
  internalsRegistry.set(client, client);
  await client.start(); // spawn + first init; throws on fatal/crash (no worker leaked — teardown ran)
  return client;
}
