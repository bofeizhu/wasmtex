// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   The message protocol is an ORIGINAL design per DESIGN.md §2.4 — it is
//   intentionally shaped differently from prior wrappers (correlated jobId
//   envelopes, discriminated unions, structured fatals). The vendored busytex
//   glue's postMessage contract (journaled in docs/plans/M0-item4-journal.md
//   "6N demo notes") was consulted as a BEHAVIOURAL reference only — what the
//   engine needs to run — never for message shapes; no field names, types, or
//   API shapes were copied from it (busytex is MIT, so this is posture, not
//   obligation). Not derived from any GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// The correlated worker protocol (DESIGN.md §5.1–§5.3).
//
// This module is the pure, zero-dependency, browser-safe core that makes
// cancellation and correlation CORRECTNESS features rather than best-effort
// scheduling. It defines the wire envelopes exchanged between the main-thread
// client (runtime/src) and the classic Worker (runtime/worker), plus the total
// validators that guard the worker→client trust boundary.
//
// Constitutional contract (DESIGN.md §5.2): EVERY message carries a protocol
// version `v` and a `jobId`. A late message from a cancelled or timed-out job
// can NEVER be attributed to a newer job, because the client correlates on the
// exact `jobId` (see `isForJob`) — safety by construction, not by timing.
//
// Cancellation has NO message. Per DESIGN.md §5.2, `cancel()` is worker
// TERMINATION: the client kills the Worker and transparently re-initialises on
// the next job. There is deliberately no `cancel` envelope to race with
// in-flight work — a terminated worker simply stops sending, and any message
// that was already in flight is dropped by the correlation gate once a newer
// job is active. Engine warm-state is a cache, never a correctness dependency.
//
// Browser-safe: no Node types, no DOM types, no imports. The build tsconfig
// pins `lib: ["ES2022"]` with `types: []`; anything referenced here must be a
// core ES global (hence the structural access to `crypto` in `newJobId`).
// ---------------------------------------------------------------------------

/**
 * Wire-format version. Bumped on any breaking change to an envelope shape so a
 * mismatched worker/client pair fails closed at `parseWorkerMessage` rather
 * than misinterpreting bytes. Integer, starts at 1.
 */
export const PROTOCOL_VERSION = 1;

/** The literal type of {@link PROTOCOL_VERSION} — every envelope's `v` field. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// JobId — a branded, session-unique correlation token
// ---------------------------------------------------------------------------

declare const jobIdBrand: unique symbol;

/**
 * A correlation token minted by the client for each request (init or compile)
 * and echoed by the worker in every response. Branded so a raw string cannot be
 * passed where a minted id is required; at runtime it is an ordinary string, so
 * it is structured-clone friendly and crosses the worker boundary unchanged.
 */
export type JobId = string & { readonly [jobIdBrand]: 'JobId' };

/** Monotonic per-realm sequence. Guarantees uniqueness within one client. */
let jobIdSequence = 0;

/**
 * Mint a fresh, session-unique {@link JobId}.
 *
 * Uniqueness within a session comes from the monotonic counter alone — there is
 * NO dependence on `Date.now` for uniqueness (two calls in the same millisecond
 * still differ). The random suffix is defence-in-depth: it distinguishes ids
 * across realms/reloads (where the counter restarts at 0), so a stale id minted
 * by a previous page load or a terminated worker's realm can never equal a
 * fresh id here. The result is a plain string (structured-clone friendly).
 */
export function newJobId(): JobId {
  const seq = (++jobIdSequence).toString(36);
  return `${seq}.${randomToken()}` as JobId;
}

/**
 * 32 bits of randomness as base36. Uses Web Crypto when present (browsers,
 * Workers, Node ≥ 19 all expose `globalThis.crypto`); falls back to `Math.random`
 * because the token only needs to distinguish realms — session uniqueness is
 * already guaranteed by the counter, so a non-cryptographic fallback is a safe
 * degradation. Accessed structurally so no DOM/WebWorker lib is required.
 */
function randomToken(): string {
  const g = globalThis as {
    crypto?: { getRandomValues?: <T extends ArrayBufferView>(array: T) => T };
  };
  const c = g.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return (buf[0] ?? 0).toString(36);
  }
  return Math.floor(Math.random() * 0x1_0000_0000).toString(36);
}

// ---------------------------------------------------------------------------
// Shared payload types (DESIGN.md §5.1)
// ---------------------------------------------------------------------------

/**
 * Engines selectable via `typeset({ engine })` (DESIGN.md §5.1).
 *
 * - `xetex` — primary engine, fully supported end to end in v1 (engine pass →
 *   `xdvipdfmx` → PDF).
 * - `pdftex` — exposed in v1 only if it costs nothing beyond driver/format
 *   selection (DESIGN.md §9; `docs/plans/M1.md`).
 * - `luatex` — **reserved**. The member exists so the public surface is stable,
 *   but LuaTeX is unimplemented in v1: a job requesting it is rejected with a
 *   clear error (`fatal` code `unsupported-engine`). Its presence is not a
 *   claim of support.
 */
export type EngineName = 'xetex' | 'pdftex' | 'luatex';

/** A single project input: raw bytes or UTF-8 text. Structured-clone friendly. */
export type ProjectFile = Uint8Array | string;

/**
 * The project as a `path → contents` map (DESIGN.md §5.1 — a map, not an array).
 * Paths are project-relative (e.g. `main.tex`, `fonts/Foo.otf`).
 */
export type ProjectFiles = Readonly<Record<string, ProjectFile>>;

/** An exact engine-pass count, 1..5 (DESIGN.md §5.1 "an exact number 1..5"). */
export type PassCount = 1 | 2 | 3 | 4 | 5;

/** Pass policy: bounded automatic reruns, or an exact count (DESIGN.md §5.1). */
export type PassPolicy = 'auto' | PassCount;

/** A feature that is auto-detected or explicitly disabled (DESIGN.md §5.1). */
export type AutoOff = 'auto' | 'off';

/**
 * A role an asset plays in the pipeline. The four known roles are the ones item
 * 4's generator (`build/manifest/gen-assets.mjs`, per `docs/plans/M1.md`) emits;
 * the `(string & {})` arm keeps them as autocomplete hints while leaving the set
 * OPEN — item 4 owns the schema, this protocol only carries it.
 */
export type AssetRole = 'engine' | 'glue' | 'format' | 'bundle' | (string & {});

/**
 * One entry of the parsed `assets.json` inventory.
 *
 * Item 4 OWNS this schema; the protocol only carries the inventory from client
 * to worker, so it is typed loosely — `path` is the one field the worker truly
 * needs, and `bytes`/`sha256`/`role` are REFERENCED (the field names item 4 will
 * emit) but optional. The index signature keeps the shape forward-compatible so
 * tightening the schema in item 4, or the M4 integrity manifest, does not churn
 * the protocol.
 */
export interface AssetEntry {
  readonly path: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly role?: AssetRole;
  readonly [field: string]: unknown;
}

/**
 * The parsed `assets.json` inventory (DESIGN.md §5.1, §5.4). Loosely typed on
 * purpose — see {@link AssetEntry}. `version` is item 4's own schema stamp,
 * optional so a minimal M1 file validates.
 */
export interface AssetsInventory {
  readonly version?: number;
  readonly assets: readonly AssetEntry[];
}

/**
 * Which bundles to preload versus leave for on-demand loading (DESIGN.md §5.1
 * `bundles`). Bundle names are opaque strings resolved against the inventory;
 * on-demand resolution with log feedback is M4 (DESIGN.md §5.4).
 */
export interface BundleSelection {
  readonly preload: readonly string[];
  readonly onDemand: readonly string[];
}

/**
 * Everything the worker needs to load engine, format, and bundle assets: a
 * same-origin base URL (DESIGN.md §5.1 `assetsBaseUrl`, §10) plus the inventory
 * and bundle selection. Client-side-only concerns (`onAssetProgress`,
 * `locateAsset` — functions cannot cross the worker boundary) stay in the
 * client (item 7) and are deliberately absent here.
 */
export interface AssetsConfig {
  readonly baseUrl: string;
  readonly inventory: AssetsInventory;
  readonly bundles: BundleSelection;
}

// ---------------------------------------------------------------------------
// Client → worker envelopes
// ---------------------------------------------------------------------------

/**
 * Initialise the worker: load and instantiate the engine and preload bundles
 * per {@link AssetsConfig}. The worker replies with `initialized` (success) or
 * `fatal` (asset/instantiation failure), both echoing this `jobId`.
 */
export interface InitMessage {
  readonly type: 'init';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly assets: AssetsConfig;
}

/**
 * Compile one project (DESIGN.md §5.1 `typeset(...)`). Drives the §5.3 engine
 * sequence in the worker; responses (`log`, `progress`, `result`, `fatal`) all
 * echo this `jobId`.
 */
export interface CompileMessage {
  readonly type: 'compile';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly files: ProjectFiles;
  readonly entry: string;
  readonly engine: EngineName;
  readonly passes: PassPolicy;
  readonly bibliography: AutoOff;
  readonly index: AutoOff;
  readonly synctex: boolean;
}

/**
 * The client→worker union. There is intentionally no `cancel` member:
 * cancellation is worker termination (DESIGN.md §5.2; see the module header).
 */
export type ClientMessage = InitMessage | CompileMessage;

// ---------------------------------------------------------------------------
// Worker → client envelopes
// ---------------------------------------------------------------------------

/** Which engine stream a `log` line came from. */
export type LogStream = 'stdout' | 'stderr';

/**
 * A coarse progress phase (DESIGN.md §5.3 sequence). Discriminated on `kind`;
 * only the engine phase carries a 1-based pass ordinal, so the pass number
 * cannot be misread on a tool phase.
 */
export type ProgressPhase =
  | { readonly kind: 'engine'; readonly pass: number }
  | { readonly kind: 'bibtex8' }
  | { readonly kind: 'makeindex' }
  | { readonly kind: 'xdvipdfmx' };

/**
 * A parsed diagnostic (DESIGN.md §5.1 result `diagnostics`). Typed HERE so the
 * client (item 7) and the diagnostics parser (item 8) share one shape, but it
 * is deliberately NOT carried in {@link ResultMessage}: the worker emits raw
 * `log`, and item 8's pure parser derives diagnostics client-side. Kept out of
 * the wire so a rebase that changes transcript wording touches only the parser
 * and its fixtures (M1 rebase-proofing rule 2).
 */
export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

/** Compile statistics (DESIGN.md §5.1 result `stats`). */
export interface CompileStats {
  readonly passes: number;
  readonly elapsedMs: number;
  readonly bundlesLoaded: readonly string[];
}

/**
 * Closed set of fatal categories. Derived-from-array so the runtime validator
 * ({@link parseWorkerMessage}) and the {@link FatalCode} type cannot drift.
 */
const FATAL_CODES = [
  'init-failed', // asset load or engine instantiation failed
  'engine-aborted', // the wasm engine called abort() mid-run
  'unsupported-engine', // requested engine not implemented in v1 (e.g. luatex)
  'protocol', // the worker received a message it could not parse/handle
  'internal', // unexpected worker-side failure
] as const;

/** A structured fatal-error category (see {@link FatalMessage}). */
export type FatalCode = (typeof FATAL_CODES)[number];

/** Worker is ready (engine instantiated, bundles preloaded). Answers `init`. */
export interface InitializedMessage {
  readonly type: 'initialized';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
}

/** One line-buffered transcript line (no trailing newline) with its stream. */
export interface LogMessage {
  readonly type: 'log';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly stream: LogStream;
  readonly line: string;
}

/** A coarse progress update (DESIGN.md §5.3). */
export interface ProgressMessage {
  readonly type: 'progress';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly phase: ProgressPhase;
}

/**
 * Terminal success/failure of a compile (DESIGN.md §5.1 result shape MINUS
 * `diagnostics` — see {@link Diagnostic}). `pdf`/`synctex` are raw bytes and are
 * present only when produced. The client parses `log` into diagnostics and
 * assembles the public result.
 */
export interface ResultMessage {
  readonly type: 'result';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly pdf?: Uint8Array;
  readonly synctex?: Uint8Array;
  readonly log: string;
  readonly stats: CompileStats;
}

/**
 * A structured fatal error. Never a thrown-across-boundary `Error`: only a
 * closed {@link FatalCode}, a human-readable `message`, and an optional
 * non-sensitive `detail` (e.g. a failing asset path) — so nothing relies on
 * structured-cloning an exception, and the client maps `code` to its own error.
 */
export interface FatalMessage {
  readonly type: 'fatal';
  readonly v: ProtocolVersion;
  readonly jobId: JobId;
  readonly code: FatalCode;
  readonly message: string;
  readonly detail?: string;
}

/** The worker→client union — the messages `parseWorkerMessage` validates. */
export type WorkerMessage =
  | InitializedMessage
  | LogMessage
  | ProgressMessage
  | ResultMessage
  | FatalMessage;

/** Either direction. Used by direction-agnostic helpers (`isForJob`, transfer). */
export type ProtocolMessage = ClientMessage | WorkerMessage;

// ---------------------------------------------------------------------------
// The correlation gate (DESIGN.md §5.2, constitutional)
// ---------------------------------------------------------------------------

/**
 * The single correlation gate. Returns true iff `msg` belongs to the job
 * identified by `jobId`.
 *
 * This is the ONE place the runtime decides whether a worker message may act on
 * a job. A late message from a cancelled or timed-out job carries that job's
 * (older) `jobId`; once the client has moved on and gates on a newer id, the
 * stale message compares unequal and is dropped — it can NEVER be attributed to
 * the newer job. Safety is by construction (exact id equality), not by timing
 * or scheduling: even a terminated worker's already-in-flight message is
 * rejected here the instant a newer job is active. `JobId`s are collision-proof
 * within a session ({@link newJobId}), so equality is exact identity, never
 * accidental aliasing.
 */
export function isForJob(msg: ProtocolMessage, jobId: JobId): boolean {
  return msg.jobId === jobId;
}

// ---------------------------------------------------------------------------
// Total validators for the worker→client trust boundary
//
// `parseWorkerMessage` is total: it returns `null` for every non-conforming
// input and never throws. It reconstructs each accepted message's ENVELOPE
// and record structure from validated fields into a FRESH object literal, so
// no attacker-controlled extra key or `__proto__` entry flows through at any
// object level. `Uint8Array` byte payloads are referenced, not copied, by
// design (the parser never reads their bytes; over the real structuredClone
// transport subclass identity is stripped anyway).
// ---------------------------------------------------------------------------

/** A non-null, non-array object we can read string keys from. */
function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A non-empty string usable as a correlation token. Format is opaque here. */
function isJobIdString(x: unknown): x is JobId {
  return typeof x === 'string' && x.length > 0;
}

/** A finite integer (exit codes, pass counts). */
function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

/** A 1-based ordinal. */
function isPositiveInt(x: unknown): x is number {
  return isInt(x) && x >= 1;
}

/** A finite, non-negative number. */
function isNonNegativeNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** An array of strings (validated element-wise). */
function isStringArray(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((e) => typeof e === 'string');
}

type WorkerMessageParser = (
  fields: Record<string, unknown>,
  jobId: JobId,
) => WorkerMessage | null;

function parseInitialized(
  _fields: Record<string, unknown>,
  jobId: JobId,
): InitializedMessage | null {
  return { type: 'initialized', v: PROTOCOL_VERSION, jobId };
}

function parseLog(
  fields: Record<string, unknown>,
  jobId: JobId,
): LogMessage | null {
  const stream = fields['stream'];
  const line = fields['line'];
  if (stream !== 'stdout' && stream !== 'stderr') return null;
  if (typeof line !== 'string') return null;
  return { type: 'log', v: PROTOCOL_VERSION, jobId, stream, line };
}

function parseProgressPhase(x: unknown): ProgressPhase | null {
  if (!isPlainRecord(x)) return null;
  switch (x['kind']) {
    case 'engine': {
      const pass = x['pass'];
      return isPositiveInt(pass) ? { kind: 'engine', pass } : null;
    }
    case 'bibtex8':
      return { kind: 'bibtex8' };
    case 'makeindex':
      return { kind: 'makeindex' };
    case 'xdvipdfmx':
      return { kind: 'xdvipdfmx' };
    default:
      return null;
  }
}

function parseProgress(
  fields: Record<string, unknown>,
  jobId: JobId,
): ProgressMessage | null {
  const phase = parseProgressPhase(fields['phase']);
  if (phase === null) return null;
  return { type: 'progress', v: PROTOCOL_VERSION, jobId, phase };
}

function parseStats(x: unknown): CompileStats | null {
  if (!isPlainRecord(x)) return null;
  const passes = x['passes'];
  const elapsedMs = x['elapsedMs'];
  const bundlesLoaded = x['bundlesLoaded'];
  if (!isInt(passes) || passes < 0) return null;
  if (!isNonNegativeNumber(elapsedMs)) return null;
  if (!isStringArray(bundlesLoaded)) return null;
  return { passes, elapsedMs, bundlesLoaded: [...bundlesLoaded] };
}

function parseResult(
  fields: Record<string, unknown>,
  jobId: JobId,
): ResultMessage | null {
  const ok = fields['ok'];
  const exitCode = fields['exitCode'];
  const log = fields['log'];
  const pdf = fields['pdf'];
  const synctex = fields['synctex'];
  if (typeof ok !== 'boolean') return null;
  if (!isInt(exitCode)) return null;
  if (typeof log !== 'string') return null;
  if (pdf !== undefined && !(pdf instanceof Uint8Array)) return null;
  if (synctex !== undefined && !(synctex instanceof Uint8Array)) return null;
  const stats = parseStats(fields['stats']);
  if (stats === null) return null;
  return {
    type: 'result',
    v: PROTOCOL_VERSION,
    jobId,
    ok,
    exitCode,
    log,
    stats,
    ...(pdf !== undefined ? { pdf } : {}),
    ...(synctex !== undefined ? { synctex } : {}),
  };
}

function isFatalCode(x: unknown): x is FatalCode {
  return typeof x === 'string' && (FATAL_CODES as readonly string[]).includes(x);
}

function parseFatal(
  fields: Record<string, unknown>,
  jobId: JobId,
): FatalMessage | null {
  const code = fields['code'];
  const message = fields['message'];
  const detail = fields['detail'];
  if (!isFatalCode(code)) return null;
  if (typeof message !== 'string') return null;
  if (detail !== undefined && typeof detail !== 'string') return null;
  return {
    type: 'fatal',
    v: PROTOCOL_VERSION,
    jobId,
    code,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Per-`type` parser table. `satisfies Record<WorkerMessage['type'], …>` locks it
 * to the union: adding a worker message variant without a parser here (or a
 * parser without a variant) fails to typecheck — the switch equivalent could
 * not enforce this because the incoming `type` is `unknown`.
 */
const WORKER_PARSERS = {
  initialized: parseInitialized,
  log: parseLog,
  progress: parseProgress,
  result: parseResult,
  fatal: parseFatal,
} satisfies Record<WorkerMessage['type'], WorkerMessageParser>;

/**
 * Validate and normalise a value received from the worker.
 *
 * Total: returns `null` for every non-conforming input and never throws. The
 * happy and reject paths use only non-throwing operations, and a top-level
 * backstop guarantees totality even against exotic inputs (e.g. a throwing
 * getter) that could never survive `structuredClone` on the real transport but
 * make the "never throws" contract unconditional. Rejects a wrong or missing
 * `v`, a missing/blank `jobId`, an unknown `type`, and any per-type shape
 * violation; accepted messages are rebuilt as fresh literals (no pass-through of
 * attacker keys or prototypes).
 */
export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  try {
    if (!isPlainRecord(data)) return null;
    if (data['v'] !== PROTOCOL_VERSION) return null;
    const jobId = data['jobId'];
    if (!isJobIdString(jobId)) return null;
    const type = data['type'];
    if (typeof type !== 'string') return null;
    // Own-key guard: a plain-object table lookup walks the prototype chain,
    // so a hostile `type` like "constructor" or "toString" would resolve to
    // Object.prototype members — `Object(data, jobId)` even returns the
    // attacker's object BY REFERENCE. Object.hasOwn (ES2022) closes it.
    const parser = Object.hasOwn(WORKER_PARSERS, type)
      ? (WORKER_PARSERS as Record<string, WorkerMessageParser>)[type]
      : undefined;
    return parser ? parser(data, jobId) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transferability
// ---------------------------------------------------------------------------

/**
 * The `ArrayBuffer`s a message may hand to `postMessage(msg, transfer)` to move
 * (zero-copy) instead of clone. Returns the buffers underlying any `Uint8Array`
 * payloads — compile inputs (`files`) and result outputs (`pdf`/`synctex`) —
 * de-duplicated (transferring one buffer twice throws) and excluding any
 * `SharedArrayBuffer` (not transferable; and DESIGN §10 rules SAB out anyway).
 *
 * Every payload is structured-clone safe, so transfer is always OPTIONAL — a
 * caller that omits the transfer list still gets a correct (copied) message.
 *
 * HAZARD a caller must know: transferring the buffer under a subarray view
 * detaches the ENTIRE backing buffer — bytes outside the view and every other
 * view sharing it (e.g. several `files` packed into one large buffer) become
 * unusable on the sending side, silently. Only pass the transfer list when
 * every payload owns its buffer; otherwise clone (omit the list).
 */
export function transferablesOf(msg: ProtocolMessage): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  switch (msg.type) {
    case 'compile':
      for (const file of Object.values(msg.files)) {
        if (file instanceof Uint8Array) collectBuffer(out, seen, file);
      }
      break;
    case 'result':
      if (msg.pdf) collectBuffer(out, seen, msg.pdf);
      if (msg.synctex) collectBuffer(out, seen, msg.synctex);
      break;
    default:
      break;
  }
  return out;
}

function collectBuffer(
  out: ArrayBuffer[],
  seen: Set<ArrayBuffer>,
  view: Uint8Array,
): void {
  const buffer = view.buffer;
  if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
    seen.add(buffer);
    out.push(buffer);
  }
}
