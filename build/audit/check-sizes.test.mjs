// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner.
//   Run: `node --test build/audit/check-sizes.test.mjs`
//
// TWO test groups (mirrors build/bundles/licenses.test.mjs):
//   1. The pure budget logic on crafted synthetic manifests/budgets — under vs
//      over budget (strict >), the exactly-at-budget boundary, the absent-asset
//      note, the unbudgeted-large WARNING incl. the byte-identical-duplicate
//      suppression, budget-doc shape validation, missing-file handling, the
//      --json report shape + determinism.
//   2. The REAL shipped inventory (dist/manifest.json + build/budgets.json),
//      skipped cleanly when the native dist/ is absent (as in stock CI): the
//      current sizes must PASS, and every budgeted preload asset must be present.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  MB,
  DEFAULT_WARN_BYTES,
  parseBudgets,
  checkSizes,
  buildJsonReport,
  formatTable,
  formatMB,
  readBudgetsFile,
  readManifestFile,
} from './check-sizes.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Synthetic-input helpers.
// ---------------------------------------------------------------------------
/** Build a manifest with the given assets ({path, bytes, sha256?, role?}). */
function manifest(assets) {
  return {
    schemaVersion: 2,
    assets: assets.map((a) => ({
      path: a.path,
      bytes: a.bytes,
      sha256: a.sha256 ?? `sha-${a.path}`,
      role: a.role ?? 'bundle-data',
    })),
  };
}

/** Build a budgets doc; `entries` maps path -> maxBytes (or a full object). */
function budgetsDoc(entries, extra = {}) {
  const budgets = {};
  for (const [path, v] of Object.entries(entries)) {
    budgets[path] = typeof v === 'number' ? { maxBytes: v, tier: 'preload', note: '' } : v;
  }
  return { budgets, ...extra };
}

// ===========================================================================
describe('parseBudgets — shape validation (fail-closed)', () => {
  test('a valid doc parses into a Map + warn threshold', () => {
    const p = parseBudgets(budgetsDoc({ 'a.wasm': 30_000_000 }, { unbudgetedWarnBytes: 7_000_000 }));
    assert.equal(p.warnBytes, 7_000_000);
    assert.equal(p.budgets.get('a.wasm').maxBytes, 30_000_000);
    assert.equal(p.budgets.get('a.wasm').tier, 'preload');
  });

  test('warn threshold defaults when omitted', () => {
    const p = parseBudgets(budgetsDoc({ 'a.wasm': 10 }));
    assert.equal(p.warnBytes, DEFAULT_WARN_BYTES);
  });

  test('rejects a missing/!object `budgets` key', () => {
    assert.throws(() => parseBudgets({}), /missing\/invalid `budgets`/);
    assert.throws(() => parseBudgets({ budgets: [] }), /missing\/invalid `budgets`/);
    assert.throws(() => parseBudgets(null), /top level must be a JSON object/);
    assert.throws(() => parseBudgets([]), /top level must be a JSON object/);
  });

  test('rejects a non-positive-integer maxBytes', () => {
    assert.throws(() => parseBudgets(budgetsDoc({ x: { maxBytes: 0 } })), /maxBytes must be a positive integer/);
    assert.throws(() => parseBudgets(budgetsDoc({ x: { maxBytes: -5 } })), /maxBytes must be a positive integer/);
    assert.throws(() => parseBudgets(budgetsDoc({ x: { maxBytes: 1.5 } })), /maxBytes must be a positive integer/);
    assert.throws(() => parseBudgets(budgetsDoc({ x: { maxBytes: '30mb' } })), /maxBytes must be a positive integer/);
    assert.throws(() => parseBudgets({ budgets: { x: 30 } }), /must be an object/);
  });

  test('rejects a bad unbudgetedWarnBytes', () => {
    assert.throws(() => parseBudgets(budgetsDoc({ x: 10 }, { unbudgetedWarnBytes: -1 })), /unbudgetedWarnBytes/);
    assert.throws(() => parseBudgets(budgetsDoc({ x: 10 }, { unbudgetedWarnBytes: 1.2 })), /unbudgetedWarnBytes/);
  });
});

// ===========================================================================
describe('checkSizes — under vs over budget', () => {
  test('all assets under budget -> ok, correct headroom + usedFraction', () => {
    const m = manifest([
      { path: 'busytex.wasm', bytes: 27_500_000, role: 'engine-wasm' },
      { path: 'core.data', bytes: 53_000_000 },
    ]);
    const p = parseBudgets(budgetsDoc({ 'busytex.wasm': 30_000_000, 'core.data': 60_000_000 }));
    const r = checkSizes(m, p);
    assert.equal(r.ok, true);
    assert.equal(r.failures.length, 0);
    const wasm = r.checked.find((c) => c.path === 'busytex.wasm');
    assert.equal(wasm.over, false);
    assert.equal(wasm.headroomBytes, 2_500_000);
    assert.equal(wasm.usedFraction, 27_500_000 / 30_000_000);
    // checked is sorted by path.
    assert.deepEqual(r.checked.map((c) => c.path), ['busytex.wasm', 'core.data']);
  });

  test('an over-budget asset FAILS and is named in failures', () => {
    const m = manifest([
      { path: 'busytex.wasm', bytes: 31_000_000, role: 'engine-wasm' },
      { path: 'core.data', bytes: 10_000_000 },
    ]);
    const p = parseBudgets(budgetsDoc({ 'busytex.wasm': 30_000_000, 'core.data': 60_000_000 }));
    const r = checkSizes(m, p);
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].path, 'busytex.wasm');
    assert.equal(r.failures[0].over, true);
    assert.equal(r.failures[0].headroomBytes, -1_000_000);
  });

  test('the budget is STRICT: equal-to-budget passes, one byte over fails', () => {
    const p = parseBudgets(budgetsDoc({ 'x.data': 1000 }));
    assert.equal(checkSizes(manifest([{ path: 'x.data', bytes: 1000 }]), p).ok, true);
    assert.equal(checkSizes(manifest([{ path: 'x.data', bytes: 1001 }]), p).ok, false);
  });

  test('a budgeted-but-absent asset is a note, never a failure', () => {
    const m = manifest([{ path: 'core.data', bytes: 10 }]);
    const p = parseBudgets(budgetsDoc({ 'core.data': 60_000_000, 'academic.data': 550_000_000 }));
    const r = checkSizes(m, p);
    assert.equal(r.ok, true);
    assert.deepEqual(r.absent.map((a) => a.path), ['academic.data']);
    assert.equal(r.checked.length, 1);
  });
});

// ===========================================================================
describe('checkSizes — the unbudgeted-large warning + duplicate suppression', () => {
  test('a large unbudgeted asset WARNS but does not fail', () => {
    const m = manifest([
      { path: 'core.data', bytes: 10 },
      { path: 'surprise.data', bytes: 9_000_000 }, // > 5MB default, no budget entry
    ]);
    const p = parseBudgets(budgetsDoc({ 'core.data': 60_000_000 }));
    const r = checkSizes(m, p);
    assert.equal(r.ok, true, 'a warning is not a failure');
    assert.deepEqual(r.warnings.map((w) => w.path), ['surprise.data']);
  });

  test('a small unbudgeted asset does not warn', () => {
    const m = manifest([
      { path: 'core.data', bytes: 10 },
      { path: 'tiny.js', bytes: 100_000 }, // < 5MB
    ]);
    const r = checkSizes(m, parseBudgets(budgetsDoc({ 'core.data': 60_000_000 })));
    assert.equal(r.warnings.length, 0);
    assert.deepEqual(r.unbudgeted.map((u) => u.path), ['tiny.js']);
  });

  test('a byte-identical duplicate of a budgeted asset does NOT warn (alias case)', () => {
    // texlive-basic.data copies core.data byte-for-byte (same sha256) — its bytes
    // are already budgeted via core.data, so the large-unbudgeted warning is suppressed.
    const m = manifest([
      { path: 'core.data', bytes: 53_000_000, sha256: 'deadbeef' },
      { path: 'texlive-basic.data', bytes: 53_000_000, sha256: 'deadbeef' },
    ]);
    const r = checkSizes(m, parseBudgets(budgetsDoc({ 'core.data': 60_000_000 })));
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0, 'the alias must not warn');
    const dup = r.unbudgeted.find((u) => u.path === 'texlive-basic.data');
    assert.equal(dup.duplicateOf, 'core.data');
  });

  test('the warn threshold is configurable', () => {
    const m = manifest([{ path: 'core.data', bytes: 10 }, { path: 'mid.data', bytes: 3_000_000 }]);
    // With a 1MB threshold, the 3MB asset warns; with the 5MB default it would not.
    const r = checkSizes(m, parseBudgets(budgetsDoc({ 'core.data': 60_000_000 }, { unbudgetedWarnBytes: 1_000_000 })));
    assert.deepEqual(r.warnings.map((w) => w.path), ['mid.data']);
  });
});

// ===========================================================================
describe('checkSizes — malformed manifest', () => {
  test('a manifest with no assets array throws', () => {
    assert.throws(() => checkSizes({}, parseBudgets(budgetsDoc({ x: 10 }))), /missing\/invalid `assets`/);
  });
  test('an asset missing path/bytes throws', () => {
    assert.throws(
      () => checkSizes({ assets: [{ path: 'x' }] }, parseBudgets(budgetsDoc({ x: 10 }))),
      /missing path\/bytes/,
    );
  });
});

// ===========================================================================
describe('readBudgetsFile / readManifestFile — file handling', () => {
  test('a missing budget file throws a clear "not found" error', () => {
    assert.throws(() => readBudgetsFile('/no/such/budgets.json'), /budgets file not found/);
  });
  test('a missing manifest throws a clear "not found" error', () => {
    assert.throws(() => readManifestFile('/no/such/manifest.json'), /manifest not found/);
  });
  test('invalid JSON throws (not a silent skip)', () => {
    // Point at a file that exists but is not JSON — this very test file.
    const self = fileURLToPath(import.meta.url);
    assert.throws(() => readBudgetsFile(self), /not valid JSON/);
  });
});

// ===========================================================================
describe('buildJsonReport + formatTable — shape, determinism, rendering', () => {
  const m = manifest([
    { path: 'busytex.wasm', bytes: 27_500_000, role: 'engine-wasm' },
    { path: 'core.data', bytes: 53_000_000 },
    { path: 'huge.blob', bytes: 8_000_000, role: 'bundle-data' },
  ]);
  const p = parseBudgets(budgetsDoc({ 'busytex.wasm': 30_000_000, 'core.data': 60_000_000 }));

  test('the --json report carries checked/failures/warnings/unbudgeted', () => {
    const rep = buildJsonReport(checkSizes(m, p));
    assert.equal(rep.ok, true);
    assert.equal(rep.checked.length, 2);
    assert.equal(rep.checked[0].path, 'busytex.wasm');
    assert.equal(rep.checked[0].usedPercent, 91.7); // 27.5/30 = 0.9166... -> 91.7
    assert.deepEqual(rep.warnings.map((w) => w.path), ['huge.blob']);
  });

  test('re-running buildJsonReport is byte-identical (deterministic)', () => {
    const mk = () => `${JSON.stringify(buildJsonReport(checkSizes(m, p)), null, 2)}\n`;
    assert.equal(mk(), mk());
  });

  test('formatTable renders OK on success and OVER on breach', () => {
    assert.match(formatTable(checkSizes(m, p)), /BUDGET OK/);
    const overM = manifest([{ path: 'busytex.wasm', bytes: 40_000_000, role: 'engine-wasm' }]);
    const t = formatTable(checkSizes(overM, parseBudgets(budgetsDoc({ 'busytex.wasm': 30_000_000 }))));
    assert.match(t, /BUDGET FAIL/);
    assert.match(t, /OVER/);
    assert.match(t, /busytex\.wasm/);
  });

  test('formatMB renders decimal MB', () => {
    assert.equal(formatMB(27_508_145), '27.51 MB');
    assert.equal(formatMB(MB), '1.00 MB');
  });
});

// ===========================================================================
// The REAL shipped inventory. Skipped cleanly when the native dist/ is absent
// (stock CI has no built dist/manifest.json). Mirrors licenses.test.mjs's
// real-tlpdb group: it asserts the CURRENT sizes pass the CHECKED-IN budgets.
// ===========================================================================
const MANIFEST_PATH = join(repoRoot, 'dist', 'manifest.json');
const BUDGETS_PATH = join(repoRoot, 'build', 'budgets.json');
const HAVE_DIST = existsSync(MANIFEST_PATH);
if (!HAVE_DIST) {
  console.warn(
    `[check-sizes.test] no built dist/ at ${MANIFEST_PATH}; skipping the real-inventory ` +
      'size check (expected in CI without a build). Build the native dist/ to run it.',
  );
}

describe('build/budgets.json — the checked-in budget file is well-formed', () => {
  test('parses and budgets the five expected preload+on-demand assets', () => {
    const p = readBudgetsFile(BUDGETS_PATH);
    for (const path of ['busytex.wasm', 'core.js', 'core.data', 'academic.js', 'academic.data']) {
      assert.ok(p.budgets.has(path), `budgets.json should budget ${path}`);
    }
    // Preload assets are tagged preload; academic on-demand.
    assert.equal(p.budgets.get('busytex.wasm').tier, 'preload');
    assert.equal(p.budgets.get('academic.data').tier, 'on-demand');
  });
});

describe('size budgets — real native dist/ manifest', { skip: !HAVE_DIST }, () => {
  test('the current shipped sizes are WITHIN the checked-in budgets', () => {
    const manifestDoc = readManifestFile(MANIFEST_PATH);
    const parsed = readBudgetsFile(BUDGETS_PATH);
    const r = checkSizes(manifestDoc, parsed);
    assert.equal(r.ok, true, `over budget: ${JSON.stringify(r.failures)}`);
    // Every budgeted preload asset is actually present (a real dist ships them).
    for (const path of ['busytex.wasm', 'core.js', 'core.data']) {
      assert.ok(r.checked.some((c) => c.path === path), `${path} present + checked`);
    }
    // The texlive-basic.* aliases must not trip the unbudgeted-large warning.
    assert.equal(r.warnings.length, 0, `unexpected size warnings: ${JSON.stringify(r.warnings)}`);
  });
});
