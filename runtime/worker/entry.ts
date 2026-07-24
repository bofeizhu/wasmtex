// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   ORIGINAL §5 worker binding. The vendored busytex_worker.js (MIT) was a
//   BEHAVIOURAL reference only (a classic worker that importScripts the engine
//   and answers postMessage) — no code or message shapes copied. Not derived
//   from any GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// The classic-worker entry (M1 item 5). This is the ONLY file that touches the
// Worker message globals (`self.onmessage` / `self.postMessage`); it is
// deliberately thin. It bundles to a SINGLE self-contained classic script
// (`npm run build:worker` → runtime/dist/worker.js, IIFE, no imports), so the
// engine is loaded with `importScripts` — no ES-module worker (DESIGN.md §3).
//
// Responsibilities:
//   * Structurally validate every inbound client message (`parseClientMessage`)
//     — defence in depth: a hostile page in the same realm can post here too
//     (DESIGN.md §5.2 / §10). An unparseable message is answered with a `fatal`
//     iff a jobId can be recovered for correlation, else dropped.
//   * Hand parsed messages to the orchestration core, which streams correlated
//     responses back through `post`.
//   * Transfer (zero-copy) the byte payloads a message owns (result pdf/synctex)
//     via `transferablesOf` — always safe here because each output Uint8Array
//     owns its buffer (FS.readFile allocates fresh).
// No DOM, no network beyond the engine/asset load the host performs, no browser
// storage dependency.
// ---------------------------------------------------------------------------

import {
  fatalMessage,
  parseClientMessage,
  transferablesOf,
  type JobId,
  type WorkerMessage,
} from '../src/protocol.js';
import { createWorkerCore } from './core.js';
import { EmscriptenEngineHost, createWorkerModuleLoader } from './engine-host.js';

/** The subset of the (classic) Worker global scope this entry uses. */
interface WorkerScope {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

/** The single outward channel: post a correlated message, transferring owned buffers. */
function post(message: WorkerMessage): void {
  scope.postMessage(message, transferablesOf(message));
}

/** Best-effort jobId recovery from an unparseable message, for a correlated fatal. */
function recoverJobId(data: unknown): JobId | null {
  if (typeof data !== 'object' || data === null) return null;
  const jobId = (data as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? (jobId as JobId) : null;
}

const core = createWorkerCore({
  host: new EmscriptenEngineHost(createWorkerModuleLoader()),
  post,
});

// SERIALISE handling. `core.handle` is async (a `compile` may await an
// on-demand bundle mount, §5.4). Without a queue, a second `compile` arriving
// mid-job would interleave: job B's `openJob()` re-stages PROJECT_DIR while job
// A is mid-flight, and A's retry pass would run against B's files — wrong output
// posted under A's jobId, which jobId gating cannot catch. The shipped client
// already sends FIFO and one-at-a-time; this makes the worker robust to an
// out-of-contract same-realm sender too (the defense entry.ts posture assumes).
// Cancellation is a client-side `worker.terminate()`, so it is NOT queued here.
let chain: Promise<void> = Promise.resolve();

scope.onmessage = (event: { data: unknown }): void => {
  const message = parseClientMessage(event.data);
  if (message === null) {
    const jobId = recoverJobId(event.data);
    if (jobId !== null) {
      post(fatalMessage(jobId, 'protocol', 'unparseable or unsupported client message'));
    }
    return;
  }
  // The core streams its own correlated responses and surfaces failures as
  // `fatal` messages internally, so a rejection here has no correlation target —
  // isolate it (`.catch`) so one job's failure cannot poison the queue.
  chain = chain.then(() => core.handle(message)).catch(() => {});
};
