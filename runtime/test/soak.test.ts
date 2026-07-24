// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. The seeded PRNG below is a textbook
//   linear-congruential formula (public-domain math), inlined so the "random"
//   cancellations are deterministic — no Math.random flakiness. The tiny pdfTeX
//   literal-text extractor is a self-contained reduction of the technique
//   documented in conformance/pdf-probe.mjs (which cannot be imported into the
//   typechecked runtime test tree: it lives outside rootDir and is plain JS).
//
// ---------------------------------------------------------------------------
// SOAK TEST (M5 item 6.1). Drives the PUBLIC §5.1 API — createTypesetter /
// typeset() / job.done / cancel() / dispose() — over the REAL busytex wasm, in
// process under Node (the same in-process WorkerFactory the integration suite +
// conformance runner drive). It runs 50 SEQUENTIAL jobs on ONE typesetter (core
// preloaded), with seeded, interspersed cancellations. What it proves:
//
//   * No cross-job contamination. Every job compiles a DISTINCT document (a
//     unique per-job marker in both a \typeout — so it lands in result.log — and
//     the body — so it lands in the PDF). Each COMPLETED job's result must carry
//     ITS OWN marker under ITS OWN jobId and NONE of any other job's markers, in
//     both the transcript and the recovered PDF text. A cancelled job (whose
//     worker was terminated mid-flight) must never leak into a later job.
//
//   * dispose() frees the engine. Each cancel terminates the worker and the next
//     job transparently re-initialises a FRESH wasm instance (§5.2). We track
//     every spawned worker and its terminate(), and assert that after dispose()
//     ZERO engine instances remain live (all released for GC) — the deterministic,
//     non-flaky proxy for "dispose frees the ~80 MB engine". We ALSO measure
//     process memory (rss / external / arrayBuffers) at baseline / peak / post-
//     dispose and log the deltas — but, empirically, none of them return to
//     baseline in this Node in-process harness: V8 retains freed wasm linear
//     memory and collects the dropped Emscripten modules lazily. That is
//     un-collected garbage (our object graph releases every engine — proven by
//     live===0), not a leak, which is exactly the "RSS too noisy in Node" case the
//     task anticipates — so the lifecycle gate is the assertion and the numbers are
//     reported for visibility. A fresh typesetter then compiles cleanly, proving
//     the disposed one released without corrupting anything.
//
// Engine choice: pdfTeX (not XeTeX). The soak stresses the lifecycle
// (cancel/respawn/dispose/memory + isolation across 50 mixed ops), not engine
// coverage — the XeTeX → xdvipdfmx path is already soaked by typeset-integration
// + conformance + the demo. pdfTeX is faster (no driver pass) and its content
// stream carries literal `(...)` text, so the per-job content proof is a trivial,
// self-contained inflate + string-literal scan (no ToUnicode CMap).
//
// Skips cleanly when dist/ is absent (CI runs the runtime tests without built
// artifacts), exactly like typeset-integration.test.ts. Wall-time budget is
// generous: ~35 real pdfTeX compiles + ~15 cancel/reinit cycles ≈ under a minute
// locally, but the 5-min cap absorbs a slow/loaded host.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { AssetsInventory } from '../src/protocol';
import {
  createTypesetter,
  typesetterDiagnostics,
  CancelledError,
  type WorkerFactory,
  type WorkerLike,
} from '../src/index';
import { createNodeWorkerFactory } from '../node/harness';

// dist/ lives at the repo root; this file is runtime/test/, two levels down.
const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
// The soak preloads CORE only (a hello-world pdfTeX doc needs nothing else), so
// it requires only the engine + core tier — NOT the texlive-basic alias, NOT
// academic. This keeps it green after the M5 item-6 alias drop.
const REQUIRED = ['manifest.json', 'busytex.js', 'busytex.wasm', 'core.js', 'core.data'];
const present = REQUIRED.every((f) => existsSync(distDir + f));

if (!present) {
  console.warn(
    `[soak] dist/ artifacts not all present under ${distDir} ` +
      `(need ${REQUIRED.join(', ')}); skipping the real-wasm soak test. Run ` +
      '`make artifacts STAGE=dist` to produce them. CI runs the runtime tests ' +
      'without dist/, so this skip is expected there.',
  );
}

const JOB_COUNT = 50;
const CANCEL_SEED = 0x50a1c0de; // fixed → the cancel pattern is deterministic across runs.
const CANCEL_PROBABILITY = 0.3;

/** Read the real generated inventory (schemaVersion-2 manifest) once. */
function readInventory(): AssetsInventory {
  return JSON.parse(readFileSync(distDir + 'manifest.json', 'utf8')) as AssetsInventory;
}

/**
 * A deterministic 32-bit linear-congruential generator (Numerical-Recipes
 * constants — a public-domain formula, not copied code) returning a float in
 * [0, 1). Seeded so the "random" cancel pattern is fixed run to run.
 */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Wrap {@link createNodeWorkerFactory} so every spawned worker and its
 * `terminate()` is counted. `live = spawned - terminated` is the number of engine
 * instances still held (not yet released for GC); after `dispose()` it must be 0.
 */
function makeTrackedFactory(): {
  factory: WorkerFactory;
  stats: () => { spawned: number; terminated: number; live: number };
} {
  const base = createNodeWorkerFactory();
  let spawned = 0;
  let terminated = 0;
  const factory: WorkerFactory = () => {
    spawned += 1;
    const worker = base();
    const realTerminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminated += 1;
      realTerminate();
    };
    return worker satisfies WorkerLike;
  };
  return { factory, stats: () => ({ spawned, terminated, live: spawned - terminated }) };
}

/** A distinct, ASCII-only per-job marker that survives a pdfTeX round-trip. */
const markerFor = (i: number): string => `SOAKUID${String(i).padStart(4, '0')}MARK`;

/** Minimal per-job pdfLaTeX document embedding the marker in BOTH the log and the PDF. */
function docFor(i: number): string {
  const m = markerFor(i);
  // \typeout → transcript (result.log); the body line → the PDF content stream.
  return `\\documentclass{article}\n\\begin{document}\n\\typeout{${m}}\nBody ${m} soak line ${i}.\n\\end{document}\n`;
}

/**
 * Extract pdfTeX literal text from a PDF: inflate each FlateDecode stream and
 * concatenate its `(...)` string operators (kerning positions between them are
 * ignored, so adjacent glyphs stay adjacent), then strip whitespace. A minimal,
 * self-contained reduction of conformance/pdf-probe.mjs `extractPdftexText`
 * (endstream-bounded — these hello-world PDFs have no in-binary `endstream`
 * hazard). Sufficient to assert a unique marker's presence/absence.
 */
function pdftexText(pdf: Uint8Array): string {
  const buf = Buffer.from(pdf);
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    let s = buf.indexOf('stream', i);
    if (s < 0) break;
    // `indexOf('stream')` also matches the tail of `endstream`; skip those.
    if (buf.toString('latin1', Math.max(0, s - 3), s).endsWith('end')) {
      i = s + 6;
      continue;
    }
    let start = s + 6;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const end = buf.indexOf('endstream', start);
    if (end < 0) break;
    i = end + 9;
    let inflated: Buffer | null = null;
    for (const stop of [end - 2, end - 1, end]) {
      if (stop <= start) continue;
      try {
        inflated = inflateSync(buf.subarray(start, stop));
        break;
      } catch {
        /* not this boundary / non-flate — try the next candidate */
      }
    }
    if (!inflated) continue;
    const text = inflated.toString('latin1');
    if (!/(TJ|Tj)/.test(text)) continue;
    for (const m of text.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      parts.push((m[1] ?? '').replace(/\\([()\\])/g, '$1'));
    }
  }
  return parts.join('').replace(/\s+/g, '');
}

/** A snapshot of process memory (bytes). arrayBuffers ⊇ wasm linear memory + the MEMFS blob. */
function mem(): { rss: number; external: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  return { rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}
const MB = (n: number): string => (n / 1e6).toFixed(1);

/** Best-effort GC (when the runner exposes --expose-gc) + a tick for the OS to catch up. */
const maybeGc = (globalThis as { gc?: () => void }).gc;
async function quiesce(): Promise<void> {
  if (maybeGc) {
    maybeGc();
    maybeGc();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('soak: 50 sequential jobs with seeded cancellations (real wasm, node)', () => {
  it.runIf(present)(
    'no cross-job contamination across 50 jobs; dispose() releases every engine instance',
    async () => {
      const startedAt = Date.now();
      const inventory = readInventory();
      const tracked = makeTrackedFactory();

      const baseline = mem();
      const tex = await createTypesetter({
        assetsBaseUrl: distDir,
        bundles: { preload: ['core'], onDemand: [] },
        inventory,
        workerFactory: tracked.factory,
      });

      const rng = makeLcg(CANCEL_SEED);
      const completed: number[] = [];
      const cancelled: number[] = [];
      // Let the dispatch pump fully drain (a macrotask) before each job. The pump
      // runs on microtasks, and `await job.done` resolves BEFORE the pump's own
      // continuation drains it — so without this flush a synchronous cancel would
      // usually race in while the job is still QUEUED (a queued-drop, no worker
      // termination). Draining first means the next typeset() dispatches against an
      // IDLE pump + a ready worker, so the job is ACTIVE (posted) the instant
      // typeset() returns — and a synchronous cancel is then a REAL
      // Worker.terminate() mid-flight (§5.2), respawning a fresh engine for the
      // next job. This is what makes the cancels genuinely exercise the respawn.
      const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

      for (let i = 0; i < JOB_COUNT; i += 1) {
        await drain();
        // Job 0 always completes so the worker is warm; thereafter the seeded PRNG
        // decides. Cancelling a job dispatched against a warm, idle-pump worker is
        // a REAL Worker.terminate() (the client posts synchronously inside
        // typeset()), so the next job re-initialises a fresh instance.
        const doCancel = i > 0 && rng() < CANCEL_PROBABILITY;
        const job = tex.typeset({ engine: 'pdftex', entry: 'main.tex', files: { 'main.tex': docFor(i) } });

        if (doCancel) {
          job.cancel();
          const err: unknown = await job.done.catch((e: unknown) => e);
          expect(err, `cancelled job ${i} must reject with CancelledError`).toBeInstanceOf(CancelledError);
          expect((err as CancelledError).reason).toBe('cancelled');
          cancelled.push(i);
          continue;
        }

        const result = await job.done;
        // Valid, self-contained PDF.
        expect(result.ok, `job ${i} should compile; log tail:\n${result.log.slice(-800)}`).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stats.bundlesLoaded).toEqual(['core']);
        const pdf = result.pdf;
        expect(pdf, `job ${i} produced no PDF`).toBeInstanceOf(Uint8Array);
        if (!(pdf instanceof Uint8Array)) throw new Error(`job ${i}: no pdf`);
        expect(pdf.length).toBeGreaterThan(1000);
        expect(Array.from(pdf.slice(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);

        // --- NO CONTAMINATION: this job's marker, and no other job's, in BOTH
        //     the transcript and the recovered PDF text. ---
        const mine = markerFor(i);
        expect(result.log, `job ${i} transcript missing its own marker`).toContain(mine);
        const recovered = pdftexText(pdf);
        expect(recovered, `job ${i} PDF missing its own body marker`).toContain(mine);

        // Check EVERY other job index's marker is absent from this job's result —
        // O(n) per job, cheap, and catches a stale-worker / spliced-log leak from
        // any prior (completed OR cancelled) job or any future one.
        for (let j = 0; j < JOB_COUNT; j += 1) {
          if (j === i) continue;
          const other = markerFor(j);
          expect(result.log.includes(other), `job ${i} transcript leaked job ${j}'s marker`).toBe(false);
          expect(recovered.includes(other), `job ${i} PDF leaked job ${j}'s marker`).toBe(false);
        }
        completed.push(i);
      }

      // The seed must exercise BOTH paths meaningfully (guards against a pattern
      // that degenerates to all-complete or all-cancel).
      expect(completed.length, 'expected some completed jobs').toBeGreaterThan(20);
      expect(cancelled.length, 'expected some cancelled jobs').toBeGreaterThan(5);
      expect(completed.length + cancelled.length).toBe(JOB_COUNT);

      // Real cancellation happened and respawned: > 1 worker was spawned (a run
      // with zero cancels would spawn exactly one persistent worker).
      const diag = typesetterDiagnostics(tex);
      // A REAL floor, not > 1: the pre-fix "queued-drop" bug (cancels landing
      // before the job went active) produced workerSpawns=3, which > 1 would
      // pass — silently degrading this test back to no real terminations. With
      // the fixed pump + seeded cancels this is deterministically 12; require a
      // respawn for the clear majority of the (deterministic) cancelled jobs.
      expect(diag.workerSpawns).toBeGreaterThan(cancelled.length / 2);

      const peak = mem();
      const beforeDispose = tracked.stats();
      // Before dispose there is at most ONE live engine (the persistent worker, or
      // none if the last op was a cancel that just terminated it).
      expect(beforeDispose.live).toBeLessThanOrEqual(1);

      await tex.dispose();
      await quiesce();
      const afterDispose = tracked.stats();
      const post = mem();

      // DETERMINISTIC memory gate: every engine instance ever spawned was
      // terminated → released for GC. Zero live after dispose is the meaningful,
      // non-flaky "dispose frees the engine" proof (object lifecycle, not RSS).
      expect(afterDispose.terminated).toBe(afterDispose.spawned);
      expect(afterDispose.live).toBe(0);

      // A fresh typesetter boots + compiles cleanly AFTER dispose — the disposed
      // one released without corrupting the shared module/loader state.
      const tex2 = await createTypesetter({
        assetsBaseUrl: distDir,
        bundles: { preload: ['core'], onDemand: [] },
        inventory,
        workerFactory: createNodeWorkerFactory(),
      });
      const fresh = await tex2.typeset({
        engine: 'pdftex',
        entry: 'main.tex',
        files: { 'main.tex': docFor(9999) },
      }).done;
      expect(fresh.ok, 'a fresh typesetter must compile after the soak dispose').toBe(true);
      expect(fresh.pdf).toBeInstanceOf(Uint8Array);
      await tex2.dispose();

      // Measured memory (logged). EMPIRICAL FINDING (documented, not gated):
      // `arrayBuffers` PLATEAUS mid-run (~243 MB ≈ ≤2 live engines, not 12× ~150
      // MB) — so the JS-reachable wasm linear memory + MEMFS of dropped engines
      // ARE collected; no reference leak (confirmed by review). What does NOT
      // return to baseline in this Node in-process harness is rss/external (V8
      // page retention + per-spawn wasm-compilation/accounting residue the OS
      // reclaims lazily, no memory-pressure trigger even after an explicit gc()).
      // Our code holds ≤1 engine at any instant (`live` oscillates 0↔1) and 0
      // after dispose (asserted above). The real embedding target (Electron/
      // browser, DESIGN §10) uses Worker.terminate(), which reclaims the whole
      // isolate regardless. The lifecycle gate (live===0, terminated===spawned,
      // fresh reinit) is therefore the meaningful, non-flaky "dispose frees the
      // engine" proof; rss is intentionally not gated (page retention is noisy).
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[soak] ${completed.length} completed / ${cancelled.length} cancelled, ` +
          `workerSpawns=${diag.workerSpawns}, dropped=${diag.droppedMessages}, wall ${elapsedMs} ms`,
      );
      console.log(
        `[soak] engine instances: spawned=${afterDispose.spawned} terminated=${afterDispose.terminated} ` +
          `live-after-dispose=${afterDispose.live} (gc ${maybeGc ? 'on' : 'off — run vitest with --expose-gc for a tighter arrayBuffers delta'})`,
      );
      console.log(
        `[soak] memory MB  rss: base ${MB(baseline.rss)} → peak ${MB(peak.rss)} → post ${MB(post.rss)}  |  ` +
          `arrayBuffers: base ${MB(baseline.arrayBuffers)} → peak ${MB(peak.arrayBuffers)} → post ${MB(post.arrayBuffers)}  |  ` +
          `external: base ${MB(baseline.external)} → peak ${MB(peak.external)} → post ${MB(post.external)}`,
      );
      // Loose, non-flaky sanity: memory did not RUN AWAY after dispose. Post-dispose
      // arrayBuffers must be below peak + a generous slack (one engine's worth).
      expect(post.arrayBuffers).toBeLessThan(peak.arrayBuffers + 160_000_000);

      expect(elapsedMs).toBeLessThan(300_000);
    },
    300_000,
  );
});
