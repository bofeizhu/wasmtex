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
import { inflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = process.env.WASMTEX_SCREENSHOT_DIR || resolve(HERE, '..', 'test-results');

// A sentence that is NOT in any test document — the negative control. Its
// space-stripped form must never appear in a recovered text (else the search is
// not discriminating and the whole content proof is worthless).
const WRONG_SENTENCE = 'Goodbye, cruel LibreOffice, farewell!';

const stripSpaces = (s) => s.replace(/\s+/g, '');

// ---------------------------------------------------------------------------
// PDF text extraction helpers (Node side; the page returns base64 PDF bytes).
// ---------------------------------------------------------------------------

/** Inflate every FlateDecode stream in a PDF; non-flate streams are skipped. */
function inflateStreams(pdf) {
  const buf = Buffer.from(pdf);
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    // `indexOf('stream')` also matches inside 'endstream'; skip those.
    if (buf.toString('latin1', Math.max(0, s - 3), s).endsWith('end')) {
      i = s + 6;
      continue;
    }
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e < 0) break;
    let end = e;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    try {
      out.push(inflateSync(buf.subarray(start, end)));
    } catch {
      /* not a flate stream (e.g. an uncompressed object) — ignore */
    }
    i = e + 9;
  }
  return out;
}

/** Decode a ToUnicode destination (a run of UTF-16BE code units) to a JS string.
 *  Ligatures map one glyph to several code units (e.g. `fi` -> U+0066 U+0069),
 *  so decode ALL of them, not just the first. */
function decodeDest(hex) {
  let s = '';
  for (let k = 0; k + 4 <= hex.length; k += 4) s += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
  return s;
}

/** Parse a ToUnicode CMap body into a glyph-code -> string map (bfchar + bfrange). */
function parseCMap(text, map) {
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), decodeDest(m[2]));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3].slice(0, 4), 16);
      for (let g = lo, u = dst; g <= hi; g++, u++) map.set(g, String.fromCodePoint(u));
    }
  }
}

/** Reconstruct XeTeX text: decode content-stream hex glyph runs through the ToUnicode CMap. */
function reconstructXetexText(pdf) {
  const streams = inflateStreams(pdf).map((s) => s.toString('latin1'));
  const map = new Map();
  for (const t of streams) if (t.includes('beginbfchar') || t.includes('beginbfrange')) parseCMap(t, map);
  let text = '';
  for (const t of streams) {
    if (!/(TJ|Tj)/.test(t) || !/<[0-9A-Fa-f]{4,}>/.test(t)) continue; // a glyph content stream
    for (const hs of t.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const hex = hs[1];
      for (let k = 0; k + 4 <= hex.length; k += 4) text += map.get(parseInt(hex.slice(k, k + 4), 16)) ?? '';
    }
  }
  return text;
}

/** Extract pdfTeX text: concatenate the `(...)` string literals from the content stream. */
function extractPdftexText(pdf) {
  const streams = inflateStreams(pdf).map((s) => s.toString('latin1'));
  let text = '';
  for (const t of streams) {
    if (!/(TJ|Tj)/.test(t) || !/\((?:\\.|[^\\()])*\)/.test(t)) continue;
    for (const m of t.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) text += m[1].replace(/\\([()\\])/g, '$1');
  }
  return text;
}

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
  expect(result.stats.bundlesLoaded).toContain('texlive-basic');
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
