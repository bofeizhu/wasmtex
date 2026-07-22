// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// M0 item 6N acceptance smoke: load the faithful-baseline artifacts in headless
// Chromium via demo/index.html, compile a hello-world LaTeX document with the
// vendored busytex glue (XeTeX -> xdvipdfmx), and prove the output is a real
// PDF. This test defines "done" for the M0 compile-to-PDF proof (DESIGN.md §8).
//
// Assertions:
//   * page loads with no uncaught page errors and no main-thread console errors
//   * compilation settles within a generous timeout with exit code 0
//   * output is a valid PDF: %PDF- header, %%EOF trailer (trailing ws allowed),
//     and > 1 KB
//   * best-effort text probe for the literal body line (informational; see note)

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Screenshot lands in demo/test-results/ (git-ignored) unless overridden. The
// acceptance run points WASMTEX_SCREENSHOT_DIR at a scratchpad dir.
const SHOT_DIR = process.env.WASMTEX_SCREENSHOT_DIR || resolve(HERE, '..', 'test-results');

// Benign console noise to tolerate (kept empty on purpose — the demo page is
// engineered to produce none; add a pattern here only with justification).
const BENIGN_CONSOLE = [
  // e.g. /favicon/i,
];

test('hello-world compiles to a valid PDF in headless Chromium', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN_CONSOLE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

  await page.goto('/demo/', { waitUntil: 'domcontentloaded' });

  // The page auto-starts compilation on load and sets window.__wasmtexResult
  // exactly once when the pipeline settles (success or failure).
  await page.waitForFunction(() => window.__wasmtexResult !== null, null, {
    timeout: 150_000,
  });

  const result = await page.evaluate(() => window.__wasmtexResult);

  // Capture a real screenshot of the post-compile page state before asserting,
  // so it exists even when a later assertion fails.
  mkdirSync(SHOT_DIR, { recursive: true });
  const shotPath = join(SHOT_DIR, 'demo-post-compile.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  // Surfaced in the runner output so the human knows where it landed.
  console.log(`[smoke] screenshot: ${shotPath}`);
  console.log(`[smoke] exitCode=${result.exitCode} ok=${result.ok} size=${result.size}B elapsed=${result.elapsedMs}ms`);

  // --- compile succeeded ---
  const logTail = (result.log || '').slice(-2500);
  // Recognise the "hollow wasm" signature so a RED run reads as an ARTIFACT
  // defect, not a test bug: the item-5N wasm links with
  // --unresolved-symbols=ignore-all, so a missing dependency library becomes an
  // abort-stub (`missing function: …`; RuntimeError: Aborted(-1)) at runtime.
  const hollowArtifact = /Aborted\(-1\)|missing function:|_png_get_header_ver|unresolved-symbols/.test(result.log || '');
  const hollowHint = hollowArtifact
    ? '\n\n>>> DIAGNOSIS: the engine aborted on an UNRESOLVED LIBRARY SYMBOL. The'
      + ' dist/ wasm (built by M0 item 5N) is missing statically-linked dependency'
      + ' libraries — harfbuzz/libpng/zlib/graphite2/teckit/zziplib/libpaper were'
      + ' archived EMPTY and swallowed by the link. This is an ARTIFACT defect, not'
      + ' a demo/test defect. Root cause + fix owner: docs/plans/M0-item4-journal.md'
      + ' "6N demo notes". Rebuild dist/ via item 5N; this smoke then passes'
      + ' unchanged.'
    : '';
  expect(result.ok, `compile did not succeed (exitCode=${result.exitCode}).${hollowHint}\nlog tail:\n${logTail}`).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.pdfBase64, 'no PDF bytes were produced').toBeTruthy();

  // --- valid PDF ---
  const pdf = Buffer.from(result.pdfBase64, 'base64');
  expect(pdf.byteLength, 'PDF should exceed 1 KB').toBeGreaterThan(1024);

  const header = pdf.subarray(0, 5).toString('latin1');
  expect(header, 'PDF must start with %PDF-').toBe('%PDF-');

  // Trailer: allow trailing whitespace after the final %%EOF.
  const trailer = pdf.subarray(-96).toString('latin1').replace(/\s+$/, '');
  expect(trailer.endsWith('%%EOF'), `PDF must end with %%EOF; trailer was: ${JSON.stringify(pdf.subarray(-32).toString('latin1'))}`).toBe(true);

  // --- best-effort text probe (informational, non-fatal) ---
  // XeTeX output goes through xdvipdfmx, which (a) emits glyph-indexed text and
  // (b) compresses content streams by default, so the literal body line is not
  // expected to appear as contiguous ASCII. We report the probe but never gate
  // on it (see M0-item4-journal "6N demo notes").
  const raw = pdf.toString('latin1');
  const literalPresent = raw.includes(result.bodyMarker);
  const producedByXdv = raw.includes('xdvipdfmx');
  console.log(`[smoke] text probe: literal body "${result.bodyMarker}" present in raw PDF = ${literalPresent}`);
  console.log(`[smoke] provenance probe: "xdvipdfmx" present in raw PDF = ${producedByXdv}`);

  // --- clean load ---
  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});
