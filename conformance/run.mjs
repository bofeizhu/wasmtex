// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ---------------------------------------------------------------------------
// Conformance seed-corpus runner (DESIGN.md §8; §9 M2 seeds). Drives the PUBLIC
// `wasmtex` runtime — `createTypesetter` (§5.1) — against the built `dist/`
// engine artifacts for every entry under `corpus/`, asserting its
// `expectations.json`: exit code, PDF page count, extracted text snippets, and
// diagnostics shape. NO pixel comparisons (§8).
//
// How it reaches the runtime (the import mechanism — see docs/plans/M2-journal.md
// item 7): the compiled `runtime/dist/**` is bundler-targeted (extensionless
// imports) and NOT Node-native, so this runner cannot import it directly.
// Instead it imports the esbuild-bundled Node harness `runtime/dist/node-harness.mjs`
// — a single self-contained ESM file, the Node-delivery twin of the browser
// `dist/worker.js` — which re-exports the PUBLIC `createTypesetter` plus a Node
// `WorkerFactory` (in-process adapter + Node engine loader + real
// EmscriptenEngineHost). It is the SAME factory `runtime/test/typeset-integration.test.ts`
// drives from source: one definition, two consumers, zero duplication.
//
// Guarded like the runtime integration tests: if the `dist/` engine artifacts
// are absent (they are git-ignored, produced by `make artifacts`), the runner
// prints a message and exits 0 (green skip). `preconformance` builds the runtime
// first, so the harness bundle is present whenever the engine artifacts are.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countPages, recoverText, stripSpaces } from './pdf-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// `WASMTEX_DIST` lets CI or a tester point at a downloaded/relocated dist/;
// defaults to the repo's own dist/.
const DIST = process.env.WASMTEX_DIST ? resolve(process.env.WASMTEX_DIST) : join(REPO, 'dist');
const CORPUS = join(HERE, 'corpus');
const HARNESS = join(REPO, 'runtime', 'dist', 'node-harness.mjs');

// Engine artifacts the runtime needs to actually compile (mirrors the runtime
// integration test's REQUIRED list). Their absence is a clean skip, not a fail.
const REQUIRED = ['assets.json', 'busytex.js', 'busytex.wasm', 'texlive-basic.js', 'texlive-basic.data'];

// Extensions read as UTF-8 text; anything else (e.g. a future CJK seed's font)
// is passed to the runtime as raw bytes.
const TEXT_EXT = new Set(['.tex', '.bib', '.cls', '.sty', '.ist', '.bst', '.txt', '.ltx', '.def', '.cfg', '.clo']);

// ---------------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------------
const missing = REQUIRED.filter((f) => !existsSync(join(DIST, f)));
if (missing.length > 0) {
  console.log(
    `[conformance] dist/ engine artifacts absent (${missing.join(', ')}). ` +
      'Run `make artifacts STAGE=dist` to produce them. Skipping the corpus run ' +
      '(green skip — CI runs the corpus only when dist/ is present, like the demo smoke).',
  );
  process.exit(0);
}
if (!existsSync(HARNESS)) {
  console.error(
    `[conformance] the Node harness ${HARNESS} is missing but dist/ is present. ` +
      'Build the runtime first: `npm --prefix runtime run build` (the `conformance` ' +
      'npm script does this via `preconformance`).',
  );
  process.exit(1);
}

const { createTypesetter, createNodeWorkerFactory } = await import(pathToFileURL(HARNESS).href);
const inventory = JSON.parse(readFileSync(join(DIST, 'assets.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Read every file under a corpus entry dir (recursively) into a `path -> contents` map, minus expectations.json. */
function readProjectFiles(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      readProjectFiles(p, base, out);
    } else if (name !== 'expectations.json') {
      const key = relative(base, p).split(sep).join('/'); // POSIX keys, regardless of host
      const buf = readFileSync(p);
      out[key] = TEXT_EXT.has(extname(name).toLowerCase()) ? buf.toString('utf8') : new Uint8Array(buf);
    }
  }
  return out;
}

// Transcript markers for the OBSERVABLE step phases. Each engine pass and the
// bibtex8/makeindex tools print a banner; xdvipdfmx does NOT (it is silent in
// the transcript), so the driver step is inferred separately (below).
const PHASE_MARKERS = [
  { re: /This is XeTeX/g, phase: 'engine' },
  { re: /This is pdfTeX/g, phase: 'engine' },
  { re: /This is makeindex/g, phase: 'makeindex' },
  { re: /The style file:/g, phase: 'bibtex8' }, // bibtex8 prints this once per run (with a style)
];

/**
 * Reconstruct the executed step sequence from the PUBLIC result. The engine /
 * bibtex8 / makeindex steps are read from the transcript in execution order (the
 * core streams each step's output sequentially). The xdvipdfmx DRIVER is silent
 * in the transcript, so it is INFERRED: a XeTeX job that produced a PDF must have
 * run xdvipdfmx, because XeTeX emits an `.xdv` (never a PDF) and the sequencing
 * machine finalizes XeTeX only through xdvipdfmx (and aborts if it fails). pdfTeX
 * writes the PDF directly — no driver step. This inference is the only honest way
 * to surface the driver via the public API, which exposes no progress phases.
 */
function derivePhases(log, engine, ok, hasPdf) {
  const hits = [];
  for (const { re, phase } of PHASE_MARKERS) {
    for (const m of log.matchAll(re)) hits.push({ i: m.index ?? 0, phase });
  }
  hits.sort((a, b) => a.i - b.i);
  const phases = hits.map((h) => h.phase);
  if (engine === 'xetex' && ok && hasPdf) phases.push('xdvipdfmx');
  return phases;
}

/** Canonicalize a diagnostic to a presence-normalized tuple so deep-equal ignores optional-key ordering. */
const canonDiag = (d) => [d.severity, d.message, d.file ?? null, d.line ?? null];
const diagsEqual = (a, b) => JSON.stringify(a.map(canonDiag)) === JSON.stringify(b.map(canonDiag));
const arrEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------------------
// Discover entries.
// ---------------------------------------------------------------------------
const entries = readdirSync(CORPUS)
  .filter((name) => {
    const d = join(CORPUS, name);
    return statSync(d).isDirectory() && existsSync(join(d, 'expectations.json'));
  })
  .sort();

if (entries.length === 0) {
  console.error(`[conformance] no corpus entries found under ${CORPUS}`);
  process.exit(1);
}

console.log(`[conformance] TL 2026 seed corpus: ${entries.length} entries against dist/\n`);

// ---------------------------------------------------------------------------
// Run each entry.
// ---------------------------------------------------------------------------
let failed = 0;
const summary = [];

for (const name of entries) {
  const dir = join(CORPUS, name);
  const spec = JSON.parse(readFileSync(join(dir, 'expectations.json'), 'utf8'));
  const files = readProjectFiles(dir);
  const want = spec.expect;

  const tex = await createTypesetter({
    assetsBaseUrl: DIST + '/',
    bundles: { preload: ['texlive-basic'], onDemand: [] },
    inventory,
    workerFactory: createNodeWorkerFactory(),
  });

  const t0 = Date.now();
  let result;
  try {
    const job = tex.typeset({
      engine: spec.engine,
      entry: spec.entry,
      files,
      ...(spec.passes ? { passes: spec.passes } : {}),
      ...(spec.bibliography ? { bibliography: spec.bibliography } : {}),
      ...(spec.index ? { index: spec.index } : {}),
    });
    result = await job.done;
  } finally {
    await tex.dispose();
  }
  const wallMs = Date.now() - t0;

  // --- assertions ---
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass, detail });

  check('ok', result.ok === want.ok, `got ${result.ok}, want ${want.ok}`);
  check('exitCode', result.exitCode === want.exitCode, `got ${result.exitCode}, want ${want.exitCode}`);

  const pdf = result.pdf;
  const hasPdf = pdf instanceof Uint8Array;
  let pages = null;
  if (want.minPages != null) {
    if (hasPdf) {
      pages = countPages(pdf);
      check('minPages', pages.count >= want.minPages, `pages ${pages.count} (via/Pages=${pages.viaPagesCount}, leaf=${pages.leafPageObjects}) >= ${want.minPages}`);
      // The two structural signals must agree when both are readable — an
      // overcounting /Count heuristic could otherwise mask a lost page.
      if (pages.viaPagesCount != null && pages.leafPageObjects != null) {
        check('pageProbeAgreement', pages.viaPagesCount === pages.leafPageObjects,
          `/Pages /Count (${pages.viaPagesCount}) == leaf page objects (${pages.leafPageObjects})`);
      }
    } else {
      check('minPages', false, 'no PDF produced');
    }
  }

  let recovered = '';
  if (hasPdf) recovered = stripSpaces(recoverText(pdf, spec.engine));
  for (const sn of want.textSnippets ?? []) {
    check(`text:${sn}`, hasPdf && recovered.includes(stripSpaces(sn)), hasPdf ? 'not found in recovered text' : 'no PDF');
  }
  for (const sn of want.absentSnippets ?? []) {
    check(`absent:${sn}`, !recovered.includes(stripSpaces(sn)), 'unexpectedly present (negative control failed)');
  }

  if (want.diagnostics != null) {
    check('diagnostics', diagsEqual(result.diagnostics, want.diagnostics), `got ${JSON.stringify(result.diagnostics)}`);
  }

  const phases = derivePhases(result.log, spec.engine, result.ok, hasPdf);
  if (spec.phases != null) {
    check('phases', arrEqual(phases, spec.phases), `got [${phases}], want [${spec.phases}]`);
  }

  const entryFailed = checks.some((c) => !c.pass);
  if (entryFailed) failed += 1;

  // --- per-entry report ---
  console.log(`${entryFailed ? 'FAIL' : 'ok  '}  ${name}  (${spec.engine})`);
  console.log(`      pages=${pages ? pages.count : 'n/a'}  passes=${result.stats?.passes}  phases=[${phases.join(' -> ')}]  diagnostics=${result.diagnostics.length}  wall=${wallMs}ms  pdf=${hasPdf ? pdf.length + 'B' : 'none'}`);
  for (const c of checks) {
    if (!c.pass) console.log(`      FAIL: ${c.label} — ${c.detail}`);
  }
  const foundSnips = (want.textSnippets ?? []).filter((s) => recovered.includes(stripSpaces(s)));
  console.log(`      snippets found: [${foundSnips.join(', ')}]${(want.absentSnippets ?? []).length ? `  (neg-control absent: [${(want.absentSnippets ?? []).join(', ')}])` : ''}`);

  summary.push({ name, engine: spec.engine, ok: !entryFailed, pages: pages ? pages.count : '-', passes: result.stats?.passes, phases: phases.join('>'), wallMs });
  console.log('');
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log('---------------------------------------------------------------------');
console.log('entry            engine  pages passes  wall   phases');
for (const s of summary) {
  console.log(
    `${(s.ok ? 'ok  ' : 'FAIL')} ${s.name.padEnd(15)} ${s.engine.padEnd(7)} ${String(s.pages).padEnd(5)} ${String(s.passes).padEnd(6)} ${String(s.wallMs + 'ms').padEnd(6)} ${s.phases}`,
  );
}
console.log('---------------------------------------------------------------------');

if (failed > 0) {
  console.error(`\n[conformance] FAILED: ${failed}/${entries.length} entries had failing assertions.`);
  process.exit(1);
}
console.log(`\n[conformance] all ${entries.length} corpus entries passed.`);
process.exit(0);
