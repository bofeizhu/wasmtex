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
// item 7): the compiled `runtime/dist/**` is now Node-loadable (its relative
// specifiers carry `.js`, 0.1.1), but the runner still needs a NODE `WorkerFactory`
// — the §5.1 client spawns a classic browser `Worker`, which Node lacks. So it
// imports the esbuild-bundled Node harness `runtime/dist/node-harness.mjs`
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
import { countPages, fontProbe, recoverText, stripSpaces } from './pdf-probe.mjs';
import { verifyManifest } from './verify-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// `WASMTEX_DIST` lets CI or a tester point at a downloaded/relocated dist/;
// defaults to the repo's own dist/.
const DIST = process.env.WASMTEX_DIST ? resolve(process.env.WASMTEX_DIST) : join(REPO, 'dist');
const CORPUS = join(HERE, 'corpus');
const HARNESS = join(REPO, 'runtime', 'dist', 'node-harness.mjs');

// Bundle tiers (M4 item 8). `core` is always preloaded; `academic` (the
// scientific-journal + CJK working set) is ON-DEMAND — the §5.4 static \usepackage
// scan and the missing-file retry mount it lazily at compile time. The basic
// entries never trigger it and stay entirely inside core.
const PRELOAD = ['core'];
const ONDEMAND = ['academic'];

// Engine artifacts the runtime needs to actually compile the CORE corpus (mirrors
// the runtime integration test's REQUIRED list). Their absence is a clean skip of
// the WHOLE run, not a fail. `manifest.json` (schemaVersion 2) is REQUIRED because
// the §5.4(a) scan resolves \usepackage names against its per-bundle `provides`
// index (the v1 `assets.json` alias lacks it), and the runner reads it as the
// inventory. The on-demand `academic.{js,data}` are NOT required here: an entry
// that needs academic is skipped PER-ENTRY when it is absent (below), so a
// core-only dist still runs the basic corpus. (Mirrors the integration test's
// two-tier guard: base REQUIRED gates the run; the academic tier gates its entries.)
const REQUIRED = ['manifest.json', 'busytex.js', 'busytex.wasm', 'core.js', 'core.data'];

/** Files an on-demand tier needs on disk to actually mount (its file_packager pair). */
const bundleFiles = (name) => [`${name}.js`, `${name}.data`];

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

// ---------------------------------------------------------------------------
// Preflight: SHIPPED-manifest integrity (M4 item 8). Before compiling anything,
// verify dist/manifest.json is internally consistent with the artifacts on disk —
// every PRESENT file matches its recorded bytes+sha256, and the per-bundle
// `provides` index is present + disjoint. A corrupt/truncated download (the real
// CI hazard) fails HERE, loud, instead of surfacing as a confusing compile error.
// ---------------------------------------------------------------------------
{
  const report = verifyManifest(DIST);
  const failed = report.checks.filter((c) => !c.pass);
  console.log(
    `[conformance] manifest integrity: ${report.checks.length} checks, ${report.present} files verified` +
      `${report.absent.length ? `, ${report.absent.length} listed-but-absent (partial dist): ${report.absent.join(', ')}` : ''}.`,
  );
  if (!report.ok) {
    for (const c of failed) console.error(`      FAIL: ${c.label} — ${c.detail}`);
    console.error(`\n[conformance] dist/manifest.json is INCONSISTENT (${failed.length} check(s)); aborting before the corpus.`);
    process.exit(1);
  }
  console.log('[conformance] manifest integrity OK.\n');
}

// The runner reads `manifest.json` (schemaVersion 2), NOT `assets.json`: the
// §5.4(a) static \usepackage scan resolves package names against the manifest's
// per-bundle `provides` index (absent from the v1 `assets.json` alias), so a
// scientific paper's \usepackage{siunitx} preselects the academic tier.
const inventory = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));

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
//
// Every entry gets a FRESH typesetter (create → typeset → dispose): the §8 cold,
// storage-less contract. No IndexedDB/localStorage, no warm state carried between
// entries — an on-demand tier is re-fetched + re-mounted per academic entry (the
// honest cold cost), and a basic entry can never be tainted by a prior mount.
// The tier config is uniform (preload core, academic on-demand); only an entry
// whose \usepackage scan or missing-file retry needs academic actually mounts it.
// ---------------------------------------------------------------------------
let failed = 0;
let skipped = 0;
const summary = [];

for (const name of entries) {
  const dir = join(CORPUS, name);
  const spec = JSON.parse(readFileSync(join(dir, 'expectations.json'), 'utf8'));
  const files = readProjectFiles(dir);
  const want = spec.expect;

  // Per-entry academic-tier guard: an entry that expects an on-demand tier to load
  // (bundlesLoaded includes it) needs that tier's file_packager pair on disk. If a
  // partial dist lacks it (core-only build), GREEN-SKIP just this entry — the basic
  // corpus still runs. (Whole-run engine/core absence was already gated above.)
  const neededOnDemand = (want.bundlesLoaded ?? []).filter((b) => ONDEMAND.includes(b));
  const missingTierFiles = neededOnDemand.flatMap(bundleFiles).filter((f) => !existsSync(join(DIST, f)));
  if (missingTierFiles.length > 0) {
    skipped += 1;
    console.log(`skip  ${name}  (${spec.engine})`);
    console.log(`      needs on-demand tier(s) [${neededOnDemand.join(', ')}] but dist/ lacks ${missingTierFiles.join(', ')} — green skip (partial dist).`);
    console.log('');
    summary.push({ name, engine: spec.engine, skip: true });
    continue;
  }

  const tex = await createTypesetter({
    assetsBaseUrl: DIST + '/',
    bundles: { preload: PRELOAD, onDemand: ONDEMAND },
    inventory,
    workerFactory: createNodeWorkerFactory(),
  });

  const t0 = Date.now();
  // Capture the LIVE log stream (via the public Job.onLog) SEPARATELY from the
  // final result.log. The two differ by design when the §5.4(b) retry fires: a
  // failed probe pass streams "File `x' not found" LIVE, but the worker SPLICES
  // that probe out of the authoritative result.log. So liveLog-has-"not found" vs
  // result.log-clean is exactly what distinguishes the retry path from the scan
  // path at the public-API level (see the resolution check below).
  const liveLines = [];
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
    job.onLog((line) => liveLines.push(line));
    result = await job.done;
  } finally {
    await tex.dispose();
  }
  const wallMs = Date.now() - t0;
  const liveLog = liveLines.join('\n');

  // --- assertions ---
  const checks = [];
  const check = (label, pass, detail = '') => checks.push({ label, pass, detail });

  check('ok', result.ok === want.ok, `got ${result.ok}, want ${want.ok}`);
  check('exitCode', result.exitCode === want.exitCode, `got ${result.exitCode}, want ${want.exitCode}`);

  const pdf = result.pdf;
  const hasPdf = pdf instanceof Uint8Array;
  // Error-path contract (M5 item 4, the known-bad entry): assert NO PDF was
  // produced. A fatal compile (e.g. a genuinely-missing package that aborts with
  // "no output PDF file produced") must fail CLEANLY — result.pdf absent — never
  // ship a broken/partial PDF. The counterpart to minPages for the failure path.
  if (want.noPdf === true) {
    check('noPdf', !hasPdf, hasPdf ? `unexpected PDF produced (${pdf.length}B)` : '');
  }
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

  // --- which bundles actually mounted (M4 item 8) ---
  const bundlesLoaded = [...(result.stats?.bundlesLoaded ?? [])];
  if (want.bundlesLoaded != null) {
    check('bundlesLoaded', arrEqual(bundlesLoaded, want.bundlesLoaded), `got [${bundlesLoaded}], want [${want.bundlesLoaded}]`);
  }

  // --- §5.4 resolution PATH (scan vs retry vs none) ---
  // Distinguished by the live-vs-final log signature (see the liveLog note above):
  //   scan  → academic preselected before pass 1: NO failed probe, so liveLog has
  //           no "not found", and an on-demand tier IS in bundlesLoaded.
  //   retry → a pass failed "File `x' not found" (streamed LIVE) then the tier
  //           mounted + re-ran: liveLog HAS "not found" but result.log is SPLICED
  //           clean, and an on-demand tier IS in bundlesLoaded.
  //   none  → no on-demand tier mounted (core served everything) and no probe:
  //           liveLog has no "not found", bundlesLoaded == preload only.
  const liveNotFound = /not found/i.test(liveLog);
  const finalNotFound = /not found/i.test(result.log);
  const mountedOnDemand = bundlesLoaded.some((b) => ONDEMAND.includes(b));
  if (spec.resolution === 'scan') {
    check('resolution:scan', mountedOnDemand && !liveNotFound,
      `mountedOnDemand=${mountedOnDemand}, liveLog "not found"=${liveNotFound} (scan preselects → no failed probe pass)`);
  } else if (spec.resolution === 'retry') {
    check('resolution:retry', mountedOnDemand && liveNotFound && !finalNotFound,
      `mountedOnDemand=${mountedOnDemand}, liveLog "not found"=${liveNotFound} (expect true — probe streamed), result.log "not found"=${finalNotFound} (expect false — spliced)`);
  } else if (spec.resolution === 'none') {
    check('resolution:none', !mountedOnDemand && !liveNotFound,
      `mountedOnDemand=${mountedOnDemand} (expect false), liveLog "not found"=${liveNotFound} (expect false)`);
  }

  // --- embedded fonts / CJK glyph run (M4 item 8, the CJK entry) ---
  // A XeTeX-set CJK PDF embeds the CJK font as a CID subset WITHOUT a ToUnicode
  // CMap, so recoverText cannot reconstruct the Chinese as Unicode (only the Latin
  // runs). We verify the Chinese STRUCTURALLY instead (no pixel comparison, §8):
  // the bundled font is embedded and a run of CID glyphs was emitted.
  let fonts = null;
  if (want.embeddedFonts != null || want.absentFonts != null || want.minCidGlyphs != null || want.requireEmbeddedFontFile != null) {
    fonts = hasPdf ? fontProbe(pdf) : { baseFonts: [], embeddedFontFile: false, cidGlyphs: 0 };
    for (const wantFont of want.embeddedFonts ?? []) {
      const hit = fonts.baseFonts.some((bf) => bf.toLowerCase().includes(wantFont.toLowerCase()));
      check(`font:${wantFont}`, hit, `embedded /BaseFont names: [${fonts.baseFonts.join(', ')}]`);
    }
    // Negative font control (M5 item 4, the host-supplied-font CJK entry): a font
    // that must NOT be embedded. Proves the HOST font — not the bundled fandol —
    // is the one used for the CJK (§6.3). The exact counterpart to embeddedFonts.
    for (const absentFont of want.absentFonts ?? []) {
      const hit = fonts.baseFonts.some((bf) => bf.toLowerCase().includes(absentFont.toLowerCase()));
      check(`absentFont:${absentFont}`, !hit, `/BaseFont unexpectedly matches "${absentFont}": [${fonts.baseFonts.join(', ')}]`);
    }
    if (want.requireEmbeddedFontFile) {
      check('embeddedFontFile', fonts.embeddedFontFile, 'no /FontFile* — font not embedded (PDF not self-contained)');
    }
    if (want.minCidGlyphs != null) {
      // Total 2-byte CID glyphs emitted (Identity-H). For the CJK entry this is
      // dominated by the Chinese; a threshold above the Latin-only glyph count
      // proves real CJK glyphs were set (not just the doc's few Latin words).
      check('minCidGlyphs', fonts.cidGlyphs >= want.minCidGlyphs, `cidGlyphs ${fonts.cidGlyphs} >= ${want.minCidGlyphs}`);
    }
  }

  const entryFailed = checks.some((c) => !c.pass);
  if (entryFailed) failed += 1;

  // --- per-entry report ---
  const resLabel = spec.resolution ? `  resolution=${spec.resolution}` : '';
  console.log(`${entryFailed ? 'FAIL' : 'ok  '}  ${name}  (${spec.engine})`);
  console.log(`      pages=${pages ? pages.count : 'n/a'}  passes=${result.stats?.passes}  bundlesLoaded=[${bundlesLoaded.join(', ')}]${resLabel}  phases=[${phases.join(' -> ')}]  diagnostics=${result.diagnostics.length}  wall=${wallMs}ms  pdf=${hasPdf ? pdf.length + 'B' : 'none'}`);
  if (fonts) console.log(`      fonts=[${fonts.baseFonts.join(', ')}]  embeddedFontFile=${fonts.embeddedFontFile}  cidGlyphs=${fonts.cidGlyphs}`);
  for (const c of checks) {
    if (!c.pass) console.log(`      FAIL: ${c.label} — ${c.detail}`);
  }
  const foundSnips = (want.textSnippets ?? []).filter((s) => recovered.includes(stripSpaces(s)));
  console.log(`      snippets found: [${foundSnips.join(', ')}]${(want.absentSnippets ?? []).length ? `  (neg-control absent: [${(want.absentSnippets ?? []).join(', ')}])` : ''}`);

  summary.push({ name, engine: spec.engine, ok: !entryFailed, pages: pages ? pages.count : '-', passes: result.stats?.passes, bundles: bundlesLoaded.join('+'), resolution: spec.resolution ?? '-', phases: phases.join('>'), wallMs });
  console.log('');
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log('-------------------------------------------------------------------------------------');
console.log('entry            engine  pages passes bundles       reso   wall    phases');
for (const s of summary) {
  if (s.skip) {
    console.log(`skip ${s.name.padEnd(15)} ${s.engine.padEnd(7)} (on-demand tier absent from dist/)`);
    continue;
  }
  console.log(
    `${(s.ok ? 'ok  ' : 'FAIL')} ${s.name.padEnd(15)} ${s.engine.padEnd(7)} ${String(s.pages).padEnd(5)} ${String(s.passes).padEnd(6)} ${String(s.bundles).padEnd(13)} ${String(s.resolution).padEnd(6)} ${String(s.wallMs + 'ms').padEnd(7)} ${s.phases}`,
  );
}
console.log('-------------------------------------------------------------------------------------');

const ran = entries.length - skipped;
if (failed > 0) {
  console.error(`\n[conformance] FAILED: ${failed}/${ran} run entries had failing assertions${skipped ? ` (${skipped} green-skipped)` : ''}.`);
  process.exit(1);
}
console.log(`\n[conformance] all ${ran} run corpus entries passed${skipped ? ` (${skipped} green-skipped — on-demand tier absent)` : ''}.`);
process.exit(0);
