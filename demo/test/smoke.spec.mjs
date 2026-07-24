// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// M1 item 9 acceptance smoke: the demo page drives the ORIGINAL §5 `wasmtex`
// runtime (createTypesetter over a correlated worker) in headless Chromium —
// the vendored busytex glue is no longer loaded by the page. This suite is the
// real-browser cousin of runtime/test/typeset-integration.test.ts (which drives
// the same stack under Node): it proves, in a browser, the compile-to-PDF path,
// a CONTENT-level text proof (M0 gap #1), structured diagnostics (§8), and real
// Worker.terminate() cancellation (§5.2).
//
// Content-level PDF text proof (the mechanism, documented):
//   XeTeX emits GLYPH-indexed content streams (the visible text is not ASCII in
//   the PDF), so a naive byte search cannot find it. We inflate every
//   FlateDecode stream (Node zlib) and, for the XeTeX PDF, parse the embedded
//   ToUnicode CMap (beginbfchar/beginbfrange: glyph -> Unicode) and decode the
//   content stream's hex glyph runs back to text in reading order. For a second
//   document compiled with pdfTeX (CM fonts), the inflated content stream
//   carries the text as literal `(...)` string operators, which we extract and
//   concatenate. Inter-word spaces render as positioning (kerning), not glyphs,
//   so both recovered strings are space-free; we strip spaces from the expected
//   sentence and assert substring presence. A deliberately WRONG sentence is
//   asserted ABSENT (a negative control) — proving the check discriminates and
//   would FAIL on a PDF that lacked the text.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The PDF text-extraction technique documented above is factored into the shared
// conformance probe so this smoke and conformance/run.mjs use ONE implementation.
import { stripSpaces, reconstructXetexText, extractPdftexText } from '../../conformance/pdf-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = process.env.WASMTEX_SCREENSHOT_DIR || resolve(HERE, '..', 'test-results');

// A sentence that is NOT in any test document — the negative control. Its
// space-stripped form must never appear in a recovered text (else the search is
// not discriminating and the whole content proof is worthless).
const WRONG_SENTENCE = 'Goodbye, cruel LibreOffice, farewell!';

// The `stripSpaces` / `reconstructXetexText` / `extractPdftexText` helpers now
// live in ../../conformance/pdf-probe.mjs (imported above) — the single shared
// implementation of the technique the file header documents.

// ---------------------------------------------------------------------------
// Documents.
// ---------------------------------------------------------------------------

// The pdfTeX proof document (text-only → a single CM font → an unambiguous
// content stream). Same sentence as the demo's default doc so one marker fits.
const PDFTEX_DOC =
  '\\documentclass[11pt]{article}\n\\begin{document}\n' +
  'Hello, WasmTeX! This PDF was typeset in your browser.\n\\end{document}\n';

// A deliberately broken MULTI-FILE document: the bad macro is on line 4 of the
// \input'd subfile, so a correct diagnostic must attribute file+line to the
// SUBFILE, not the root (the case naive log scanners get wrong). Mirrors
// runtime/test/typeset-integration.test.ts.
const BROKEN_FILES = {
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\nIntro in the root file.\n' +
    '\\input{chapters/broken}\nAfter.\n\\end{document}\n',
  'chapters/broken.tex':
    'Some prose in the subfile.\n\nAnother paragraph, then a bad macro:\n' +
    '\\undefinedsubcmd\ntrailing text.\n',
};

// An academic-only document (§5.4): `siunitx` is served ONLY by the academic
// tier (absent from core), so compiling this with preload:['core'],
// onDemand:['academic'] mounts the academic tier ON DEMAND, IN THE BROWSER, at
// compile time — the M4-deferred real-browser proof of the JS-heap mount.
const SIUNITX_DOC =
  '\\documentclass{article}\n\\usepackage{siunitx}\n\\begin{document}\n' +
  'The speed of light is \\SI{299792458}{\\meter\\per\\second}.\n\\end{document}\n';

// ---------------------------------------------------------------------------
// Shared page-error/console-error capture.
// ---------------------------------------------------------------------------
function watchErrors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  return { consoleErrors, pageErrors };
}

// ===========================================================================

test('hello-world (XeTeX) compiles to a valid, text-bearing PDF with clean diagnostics', async ({ page }) => {
  const { consoleErrors, pageErrors } = watchErrors(page);

  // Record every network request URL so we can PROVE the vendored glue is not
  // loaded and the runtime worker IS (the migration is real, not cosmetic).
  const requestUrls = [];
  page.on('request', (req) => requestUrls.push(req.url()));

  await page.goto('/demo/', { waitUntil: 'domcontentloaded' });

  // The page auto-compiles the default doc and sets window.__wasmtexResult once
  // it settles (extended contract: + diagnostics, + stats).
  await page.waitForFunction(() => window.__wasmtexResult !== null, null, { timeout: 150_000 });
  const result = await page.evaluate(() => window.__wasmtexResult);
  // If the page module never evaluated (import-map canary, syntax error), the
  // global is undefined and the wait above resolves instantly — fail with a
  // clear message instead of a TypeError on the next line.
  expect(result, 'page module failed to evaluate — window.__wasmtexResult was never defined').toBeTruthy();

  mkdirSync(SHOT_DIR, { recursive: true });
  const shotPath = join(SHOT_DIR, 'demo-post-compile.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log(`[smoke] screenshot: ${shotPath}`);
  console.log(`[smoke] xetex: ok=${result.ok} exit=${result.exitCode} size=${result.size}B ` +
    `passes=${result.stats?.passes} bundles=[${result.stats?.bundlesLoaded}] elapsed=${result.elapsedMs}ms`);

  // --- compile succeeded, valid PDF ---
  const logTail = (result.log || '').slice(-2000);
  expect(result.ok, `compile did not succeed (exit=${result.exitCode}).\nlog tail:\n${logTail}`).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.pdfBase64, 'no PDF bytes were produced').toBeTruthy();

  const pdf = Buffer.from(result.pdfBase64, 'base64');
  expect(pdf.byteLength, 'PDF should exceed 1 KB').toBeGreaterThan(1024);
  expect(pdf.subarray(0, 5).toString('latin1'), 'PDF must start with %PDF-').toBe('%PDF-');
  expect(pdf.subarray(-96).toString('latin1').replace(/\s+$/, '').endsWith('%%EOF'), 'PDF must end with %%EOF').toBe(true);

  // --- CONTENT-LEVEL TEXT PROOF (M0 gap #1): reconstruct the visible text ---
  const recovered = reconstructXetexText(pdf);
  const wantSentence = stripSpaces(result.bodyMarker);      // the demo's body line
  console.log(`[smoke] xetex recovered text: ${JSON.stringify(recovered.slice(0, 120))}`);
  expect(recovered, 'XeTeX PDF must carry the document body text (reconstructed via ToUnicode)').toContain(wantSentence);
  expect(recovered).toContain('WasmTeX');
  // Negative control: a wrong sentence must NOT be found (the search discriminates).
  expect(recovered, 'negative control: a wrong sentence must be absent').not.toContain(stripSpaces(WRONG_SENTENCE));

  // --- diagnostics are part of the result and clean for a good doc (§5.1) ---
  expect(result.diagnostics, 'a clean document parses to zero diagnostics').toEqual([]);

  // --- stats surfaced (DESIGN.md §5.1 result.stats) ---
  expect(result.stats).toBeTruthy();
  expect(result.stats.passes).toBeGreaterThanOrEqual(1);
  // The default doc is core-only (preload:['core']); academic is NOT pulled.
  expect(result.stats.bundlesLoaded).toContain('core');
  expect(result.stats.bundlesLoaded, 'the core-only default doc must not pull academic').not.toContain('academic');
  expect(typeof result.stats.elapsedMs).toBe('number');

  // --- the migration is real: no vendored glue loaded; the runtime worker is ---
  const glue = requestUrls.filter((u) => /busytex_worker|busytex_pipeline/.test(u));
  expect(glue, `the page must not load the vendored glue; saw: ${glue.join(', ')}`).toEqual([]);
  expect(requestUrls.some((u) => u.endsWith('/runtime/dist/worker.js')), 'the runtime worker must be loaded').toBe(true);
  expect(requestUrls.some((u) => u.endsWith('/runtime/dist/src/index.js')), 'the runtime ESM must be loaded').toBe(true);

  // --- clean load ---
  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});

test('pdfTeX path: the inflated content stream carries the document text (+ negative control)', async ({ page }) => {
  const { consoleErrors, pageErrors } = watchErrors(page);
  // `?manual=1`: boot the typesetter without the default auto-compile — this
  // test drives its own pdfTeX job.
  await page.goto('/demo/?manual=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wasmtex && window.__wasmtex.ready !== null, null, { timeout: 150_000 });
  await page.evaluate(() => window.__wasmtex.ready);

  const out = await page.evaluate(
    (doc) => window.__wasmtex.run({ engine: 'pdftex', entry: 'p.tex', files: { 'p.tex': doc } }),
    PDFTEX_DOC,
  );
  console.log(`[smoke] pdftex: ok=${out.ok} exit=${out.exitCode} size=${out.size}B passes=${out.stats?.passes}`);
  expect(out.ok, `pdftex compile failed (exit=${out.exitCode}); log tail:\n${(out.log || '').slice(-1500)}`).toBe(true);
  expect(out.pdfBase64).toBeTruthy();
  expect(out.diagnostics).toEqual([]);

  const pdf = Buffer.from(out.pdfBase64, 'base64');
  const recovered = extractPdftexText(pdf);
  console.log(`[smoke] pdftex recovered text: ${JSON.stringify(recovered.slice(0, 120))}`);
  const wantSentence = stripSpaces('Hello, WasmTeX! This PDF was typeset in your browser.');
  expect(recovered, 'pdfTeX content stream must carry the document text').toContain(wantSentence);
  // Negative control.
  expect(recovered, 'negative control: a wrong sentence must be absent').not.toContain(stripSpaces(WRONG_SENTENCE));

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('a deliberately broken document surfaces structured diagnostics with file + line (§8)', async ({ page }) => {
  const { consoleErrors, pageErrors } = watchErrors(page);
  // `?manual=1`: boot without the default auto-compile — this test drives its
  // own (broken) job.
  await page.goto('/demo/?manual=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wasmtex && window.__wasmtex.ready !== null, null, { timeout: 150_000 });
  await page.evaluate(() => window.__wasmtex.ready);

  const out = await page.evaluate(
    (files) => window.__wasmtex.run({ engine: 'xetex', entry: 'main.tex', files }),
    BROKEN_FILES,
  );
  console.log(`[smoke] broken-doc diagnostics: ${JSON.stringify(out.diagnostics)}`);

  // The compile failed (no PDF) and the transcript is present...
  expect(out.ok).toBe(false);
  expect(out.pdfBase64).toBeFalsy();
  expect(out.log).toContain('Undefined control sequence');

  // ...and the structured diagnostic attributes the error to the SUBFILE, line 4.
  expect(out.diagnostics).toEqual([
    { severity: 'error', message: 'Undefined control sequence.', file: 'chapters/broken.tex', line: 4 },
  ]);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('cancel() surfaces CancelledError and the next compile succeeds on a fresh worker (§5.2)', async ({ page }) => {
  const { consoleErrors, pageErrors } = watchErrors(page);
  // `?manual=1`: boot the typesetter but DON'T auto-compile, so cancelProbe's
  // job is dispatched as the ACTIVE job against an idle-but-live worker — the
  // real Worker.terminate() path (not a queued-job drop).
  await page.goto('/demo/?manual=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wasmtex && window.__wasmtex.ready !== null, null, { timeout: 150_000 });
  await page.evaluate(() => window.__wasmtex.ready);

  const doc = { engine: 'xetex', entry: 'hello.tex', files: { 'hello.tex': '\\documentclass{article}\n\\begin{document}\nCancel me.\n\\end{document}\n' } };

  // Start a compile and immediately cancel it: the worker is terminated in-flight.
  const cancel = await page.evaluate((d) => window.__wasmtex.cancelProbe(d), doc);
  console.log(`[smoke] cancel: ${JSON.stringify(cancel)}`);
  expect(cancel.rejected, 'cancel() must reject the job').toBe(true);
  expect(cancel.errorName, 'the rejection must be a CancelledError').toBe('CancelledError');
  expect(cancel.reason).toBe('cancelled');

  // The next compile transparently re-initialises on a fresh worker and succeeds.
  const followUp = await page.evaluate((d) => window.__wasmtex.run(d), doc);
  console.log(`[smoke] follow-up after cancel: ok=${followUp.ok} size=${followUp.size}B`);
  expect(followUp.ok, `the compile after a cancel must succeed; log tail:\n${(followUp.log || '').slice(-1500)}`).toBe(true);
  expect(followUp.pdfBase64).toBeTruthy();
  expect(Buffer.from(followUp.pdfBase64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('on-demand academic tier mounts IN THE BROWSER: a siunitx doc compiles via preload:[core]+onDemand:[academic] (§5.4, M4 deferral)', async ({ page }) => {
  const { consoleErrors, pageErrors } = watchErrors(page);
  // `?manual=1`: boot the typesetter (preload core only) WITHOUT the default
  // auto-compile — this test drives its own academic-requiring job.
  await page.goto('/demo/?manual=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__wasmtex && window.__wasmtex.ready !== null, null, { timeout: 150_000 });
  await page.evaluate(() => window.__wasmtex.ready);

  // Skip gracefully if the served dist/ is core-only (a partial build): the
  // academic tier (~496 MB) is not always present in CI. Presence is read from
  // the shipped manifest's bundle list — no multi-hundred-MB probe download.
  const hasAcademic = await page.evaluate(async () => {
    try {
      const m = await (await fetch('/dist/manifest.json')).json();
      return (m.bundles || []).some((b) => b.name === 'academic' && (b.files || []).length > 0);
    } catch {
      return false;
    }
  });
  test.skip(!hasAcademic, 'served dist/ has no academic tier (core-only build) — skipping the on-demand browser mount');

  // Compile the siunitx doc: the §5.4 static \usepackage scan resolves `siunitx`
  // against the manifest `provides` index → preselects `academic` → the tier is
  // fetched + mounted into the LIVE engine's JS heap in-browser, then the compile
  // runs. Generous wall time: mounting the academic .data is the slow path.
  const out = await page.evaluate(
    (doc) => window.__wasmtex.run({ engine: 'xetex', entry: 'main.tex', files: { 'main.tex': doc } }),
    SIUNITX_DOC,
  );
  console.log(
    `[smoke] on-demand siunitx: ok=${out.ok} exit=${out.exitCode} size=${out.size}B ` +
      `bundles=[${out.stats?.bundlesLoaded}] passes=${out.stats?.passes} elapsed=${out.elapsedMs}ms`,
  );

  expect(out.ok, `siunitx compile failed (exit=${out.exitCode}); log tail:\n${(out.log || '').slice(-1800)}`).toBe(true);
  expect(out.pdfBase64, 'no PDF bytes were produced').toBeTruthy();
  expect(out.diagnostics, 'a clean siunitx doc parses to zero diagnostics').toEqual([]);

  // The academic tier mounted ON DEMAND in-browser (it was NOT preloaded at
  // init): bundlesLoaded is exactly [core, academic] — core from preload, academic
  // from the compile-time §5.4 scan. This is the JS-heap mount proven in a real
  // browser, not just Node.
  expect(out.stats.bundlesLoaded).toContain('core');
  expect(out.stats.bundlesLoaded, 'academic must have mounted on demand in-browser').toContain('academic');

  const pdf = Buffer.from(out.pdfBase64, 'base64');
  expect(pdf.byteLength, 'PDF should exceed 1 KB').toBeGreaterThan(1024);
  expect(pdf.subarray(0, 5).toString('latin1'), 'PDF must start with %PDF-').toBe('%PDF-');
  expect(pdf.subarray(-96).toString('latin1').replace(/\s+$/, '').endsWith('%%EOF'), 'PDF must end with %%EOF').toBe(true);

  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});
