// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner + a throwaway tmpdir fixture.
//   Run: `node --test build/release/render-notes.test.mjs`
//
// Tests for render-notes.mjs (M5 item 8): the release-notes renderer that fills
// RELEASE_NOTES.template.md from the pack --json report + dist/manifest.json.
// Exercised as a SUBPROCESS (the CLI fail()s via process.exit, like pack.mjs's
// tests) for the fail-closed paths, plus a direct unit test of the pure
// renderTemplate/formatMB helpers on the happy path.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { formatMB, renderTemplate } from './render-notes.mjs';

const RENDER = fileURLToPath(new URL('./render-notes.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('./RELEASE_NOTES.template.md', import.meta.url));

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasmtex-rendernotes-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A representative pack --json report (three archives). */
function packReport(version = '0.1.0', overrides = {}) {
  return {
    version,
    epoch: 1772323200,
    epochSource: 'manifest.texliveSnapshot.sourceDateEpoch',
    archives: [
      {
        archive: `wasmtex-assets-${version}.tar.gz`,
        kind: 'assets',
        entryCount: 11,
        totalBytes: 596000000,
        archiveBytes: 435200000,
        sha256: 'a'.repeat(64),
        path: `/dist/release/wasmtex-assets-${version}.tar.gz`,
      },
      {
        archive: `wasmtex-bundle-academic-${version}.tar.gz`,
        kind: 'bundle',
        bundle: 'academic',
        entryCount: 2,
        totalBytes: 506000000,
        archiveBytes: 380900000,
        sha256: 'b'.repeat(64),
        path: `/dist/release/wasmtex-bundle-academic-${version}.tar.gz`,
      },
      {
        archive: `wasmtex-bundle-core-${version}.tar.gz`,
        kind: 'bundle',
        bundle: 'core',
        entryCount: 2,
        totalBytes: 55000000,
        archiveBytes: 37700000,
        sha256: 'c'.repeat(64),
        path: `/dist/release/wasmtex-bundle-core-${version}.tar.gz`,
      },
    ],
    ...overrides,
  };
}

/** A minimal manifest with the snapshot facts the notes need. */
function manifest(version = '0.1.0', overrides = {}) {
  return {
    schemaVersion: 2,
    version,
    texliveSnapshot: { release: '2026', tlpdbRevision: 78233, sourceDateEpoch: 1772323200, freeze: '2026-03-01' },
    engines: ['xetex'],
    bundles: [],
    assets: [],
    ...overrides,
  };
}

function write(name, obj) {
  const p = join(root, name);
  writeFileSync(p, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`);
  return p;
}

/** Run render-notes.mjs (subprocess). Returns { status, stdout, stderr }. */
function run(args) {
  try {
    const stdout = execFileSync('node', [RENDER, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function baseArgs({ version = '0.1.0', pr, mf } = {}) {
  return [
    '--version',
    version,
    '--pack-report',
    pr ?? write('pack.json', packReport(version)),
    '--manifest',
    mf ?? write('manifest.json', manifest(version)),
    '--repo-url',
    'https://github.com/bofeizhu/wasmtex',
    '--date',
    '2026-07-24',
    '--template',
    TEMPLATE,
  ];
}

describe('render-notes — happy path (real template)', () => {
  test('fills every placeholder; no {{...}} survives; comment stripped', () => {
    const r = run(baseArgs());
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;

    // No `{{...}}` token survives — this also proves the leading authoring-note
    // comment (which documents `{{PLACEHOLDERS}}`) was stripped before rendering.
    assert.equal(out.includes('{{'), false, `leftover double-brace token in:\n${out}`);
    // The authoring-note block is gone; notes start at the heading. (Inline
    // editorial `<!-- Per-release -->` comments in the body are intentionally kept —
    // GitHub hides HTML comments — so we do NOT assert the notes are comment-free.)
    assert.equal(out.startsWith('# WasmTeX 0.1.0'), true);
    assert.equal(out.includes('RELEASE-NOTES TEMPLATE'), false);

    // Spot-check the substituted facts.
    assert.match(out, /assets-v0\.1\.0/);
    assert.match(out, /\*\*TeX Live 2026\*\*/);
    assert.match(out, /`78233`/);
    assert.ok(out.includes('a'.repeat(64)), 'assets sha256 present');
    assert.ok(out.includes('b'.repeat(64)), 'academic sha256 present');
    assert.ok(out.includes('c'.repeat(64)), 'core sha256 present');
    // Sizes formatted like pack.mjs (MiB labelled MB).
    assert.ok(out.includes(formatMB(435200000)), 'assets gz size present');
    assert.ok(out.includes(formatMB(37700000)), 'core gz size present');
    assert.ok(out.includes('https://github.com/bofeizhu/wasmtex/blob/assets-v0.1.0/'), 'repo/tag links filled');
  });

  test('--out writes the rendered notes to a file', () => {
    const outPath = join(root, 'NOTES.md');
    const r = run([...baseArgs(), '--out', outPath]);
    assert.equal(r.status, 0, r.stderr);
    const written = readFileSync(outPath, 'utf8');
    assert.equal(written.startsWith('# WasmTeX 0.1.0'), true);
    assert.equal(/\{\{[^}]*\}\}/.test(written), false);
  });
});

describe('render-notes — fail-closed lockstep + input guards', () => {
  test('a pack-report version that disagrees with --version aborts', () => {
    const pr = write('pack.json', packReport('0.2.0')); // report says 0.2.0
    const r = run(baseArgs({ version: '0.1.0', pr }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /disagrees with the pack report version 0\.2\.0/);
  });

  test('a manifest.version that disagrees with --version aborts', () => {
    const mf = write('manifest.json', manifest('9.9.9'));
    const r = run(baseArgs({ version: '0.1.0', mf }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /disagrees with manifest\.version 9\.9\.9/);
  });

  test('a missing bundle archive in the pack report aborts', () => {
    const pr = write('pack.json', packReport('0.1.0', { archives: [{ kind: 'assets', archiveBytes: 1, sha256: 'x' }] }));
    const r = run(baseArgs({ version: '0.1.0', pr }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no core bundle archive/);
  });

  test('a missing TL snapshot in the manifest aborts', () => {
    const mf = write('manifest.json', manifest('0.1.0', { texliveSnapshot: { release: '', tlpdbRevision: 78233 } }));
    const r = run(baseArgs({ version: '0.1.0', mf }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TL_RELEASE/);
  });

  test('a template with an unknown placeholder aborts (drift guard)', () => {
    const tmpl = write('drift.md', '# WasmTeX {{VERSION}}\n\nSurprise: {{UNSOURCED_FIELD}}\n');
    const r = run([...baseArgs(), '--template', tmpl]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\{\{UNSOURCED_FIELD\}\}/);
  });
});

describe('render-notes — pure helpers', () => {
  test('renderTemplate substitutes and strips the comment; returns a string', () => {
    const out = renderTemplate('<!-- note -->\n# T {{VERSION}}\n', { VERSION: '1.2.3' });
    assert.equal(out, '# T 1.2.3\n');
  });

  test('formatMB matches the pack.mjs MiB-labelled-MB convention', () => {
    assert.equal(formatMB(1024 * 1024), '1.0 MB');
    assert.equal(formatMB(37700000), '36.0 MB');
  });
});
