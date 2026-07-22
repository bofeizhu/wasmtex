// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ---------------------------------------------------------------------------
// TEST-ONLY in-process adapter: makes the worker orchestration core look like a
// {@link WorkerLike} so the client (`src/client.ts`) can drive it — plus a REAL
// {@link EngineHost} — end to end under Node, without a Web Worker. This is the
// full-stack cousin of the fake-worker unit suite: it exercises client →
// (parse) → core → sequencing → engine-host → wasm and back, through the PUBLIC
// §5.1 API. Never imported by production code (the shipped worker uses
// `runtime/worker/entry.ts`); lives under test/support like the node loader.
//
// It mirrors `entry.ts`: validate each inbound message at the boundary
// (`parseClientMessage`) then hand it to the core; deliver correlated responses
// back to `onmessage`. Both directions are scheduled on a microtask so the
// worker boundary is faithfully asynchronous (nothing observes a reply before
// the posting turn completes).
//
// terminate() semantics — see the class doc: in-process it is a permanent
// DETACH, not a preemption (a single thread cannot abort a synchronous
// callMain), which still satisfies the client's cancellation CONTRACT.
// ---------------------------------------------------------------------------

import { parseClientMessage, type WorkerMessage } from '../../src/protocol';
import { createWorkerCore, type EngineHost, type WorkerCore } from '../../worker/core';
import type { WorkerLike } from '../../src/client';

export class InProcessWorker implements WorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Observable count of terminate() calls (a real Worker has none; handy for assertions). */
  terminateCalls = 0;

  #core: WorkerCore | null;
  #terminated = false;

  constructor(host: EngineHost) {
    this.#core = createWorkerCore({ host, post: (message) => this.#deliver(message) });
  }

  postMessage(message: unknown): void {
    if (this.#terminated) return;
    // Microtask: mimic the async worker boundary. Mirror entry.ts — validate at
    // the boundary (defence in depth; the client already validated), then hand to
    // the core. A message that fails validation is dropped (the client never sends
    // one, so this only guards a hostile/buggy caller).
    void Promise.resolve().then(() => {
      if (this.#terminated) return;
      const core = this.#core;
      if (core === null) return;
      const parsed = parseClientMessage(message);
      if (parsed === null) return;
      void core.handle(parsed);
    });
  }

  #deliver(message: WorkerMessage): void {
    if (this.#terminated) return;
    void Promise.resolve().then(() => {
      if (this.#terminated) return;
      this.onmessage?.({ data: message });
    });
  }

  /**
   * In-process terminate == permanent DETACH (the documented mapping). There is
   * no thread to kill, and a synchronous `callMain` cannot be preempted on this
   * one thread — so terminate cannot abort work already executing. What it DOES:
   *   (a) stop all further input (`postMessage`) and output (`#deliver`) — anything
   *       the detached core still emits is discarded, and the client's correlation
   *       gate would drop it anyway (stale `jobId`); and
   *   (b) drop the core (with its EngineHost + wasm instance) for GC.
   * The client then builds a FRESH InProcessWorker (new core, new wasm) for the
   * next job, so the OBSERVABLE contract — the cancelled job rejects and the next
   * job compiles clean on a fresh instance — matches a real `Worker.terminate()`.
   * Only the underlying preemption differs; the client contract does not.
   */
  terminate(): void {
    this.terminateCalls += 1;
    this.#terminated = true;
    this.#core = null;
    this.onmessage = null;
    this.onerror = null;
  }
}
