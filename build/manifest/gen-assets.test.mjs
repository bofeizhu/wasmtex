// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner + a throwaway tmpdir fixture.
//   Run: `node --test build/manifest/gen-assets.test.mjs`
//
// End-to-end tests for gen-assets.mjs (M4 item 4). The script runs top-level on
// import (a CLI, not a module), so it is exercised as a SUBPROCESS against a
// synthetic dist/ fixture + a stage-tiers side-channel — the real classify /
// cross-check / manifest-assembly path. Asserts the schemaVersion-2 manifest.json
// (texliveSnapshot + engines + per-bundle provides + alias), the schemaVersion-1
// assets.json alias, alias-by-sha256 detection, determinism, and the wiring guard.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const GEN_ASSETS = fileURLToPath(new URL('./gen-assets.mjs', import.meta.url));
const EPOCH = '1772323200'; // TL 2026 freeze, 2026-03-01T00:00:00Z

let root;
let distDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasmtex-genassets-'));
  distDir = join(root, 'dist');
  mkdirSync(join(distDir, 'formats'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Write a synthetic dist/ fixture. `texlive-basic.*` are byte-identical copies of
 * `core.*` (the real back-compat alias). Writes a matching SHA256SUMS (the exact
 * `find … | LC_ALL=C sort | shasum -a 256` text the build emits, minus the two
 * generator outputs). Returns the file→content map for hash assertions.
 */
function writeDist() {
  const files = {
    'busytex.wasm': 'WASM-ENGINE',
    'busytex.js': 'ENGINE-LOADER',
    'core.data': 'CORE-DATA-BLOB',
    'core.js': 'CORE-LOADER',
    'academic.data': 'ACADEMIC-DATA-BLOB',
    'academic.js': 'ACADEMIC-LOADER',
    'texlive-basic.data': 'CORE-DATA-BLOB', // byte-identical to core.data -> alias
    'texlive-basic.js': 'CORE-LOADER', // byte-identical to core.js
    'formats/xelatex.fmt': 'FMT-DUMP',
    'licenses.json': '{"schemaVersion":1}', // M5 item 2 shipped-license inventory (role license-inventory)
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(distDir, ...rel.split('/')), content);
  }
  // SHA256SUMS over every payload file (sorted, C-locale), "<hash>  ./<path>".
  const rows = Object.keys(files)
    .sort()
    .map((rel) => `${sha256(Buffer.from(files[rel]))}  ./${rel}`);
  writeFileSync(join(distDir, 'SHA256SUMS'), `${rows.join('\n')}\n`);
  return files;
}

/** Write the stage-tiers manifest side-channel and return its path. */
function writeSidecar(overrides = {}) {
  const doc = {
    schemaVersion: 1,
    texlive: { release: '2026', tlpdbRevision: 78233 },
    tiers: [
      { name: 'core', provides: ['amsmath', 'latex'] },
      { name: 'academic', provides: ['ctex', 'fandol', 'siunitx', 'xecjk'] },
    ],
    ...overrides,
  };
  const p = join(root, 'tiers.json');
  writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return p;
}

/** Run gen-assets.mjs (subprocess). Returns { status, stdout, stderr }. */
function runGen(args, { epoch = EPOCH } = {}) {
  try {
    const stdout = execFileSync('node', [GEN_ASSETS, distDir, ...args], {
      env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const readManifest = () => JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
const readAssets = () => JSON.parse(readFileSync(join(distDir, 'assets.json'), 'utf8'));
const bundle = (m, name) => m.bundles.find((b) => b.name === name);

describe('gen-assets — schemaVersion-2 manifest with side-channel', () => {
  test('emits manifest.json (v2) + assets.json (v1 alias) with the full shape', () => {
    writeDist();
    const r = runGen(['--tiers', writeSidecar()]);
    assert.equal(r.status, 0, r.stderr);

    const m = readManifest();
    assert.equal(m.schemaVersion, 2);
    assert.deepEqual(Object.keys(m), ['schemaVersion', 'generated', 'texliveSnapshot', 'engines', 'bundles', 'assets']);

    // texliveSnapshot: side-channel facts + epoch-derived freeze/day.
    assert.deepEqual(m.texliveSnapshot, {
      release: '2026',
      tlpdbRevision: 78233,
      sourceDateEpoch: 1772323200,
      freeze: '2026-03-01',
    });

    // engines: the static multicall set (DESIGN §3 minus luatex), sorted.
    assert.deepEqual(m.engines, ['bibtex8', 'kpsewhich', 'makeindex', 'pdftex', 'xdvipdfmx', 'xetex']);

    // bundles: sorted by name; real tiers carry files/bytes/provides.
    assert.deepEqual(m.bundles.map((b) => b.name), ['academic', 'core', 'texlive-basic']);
    assert.deepEqual(bundle(m, 'core').files, ['core.data', 'core.js']);
    assert.deepEqual(bundle(m, 'core').provides, ['amsmath', 'latex']);
    assert.deepEqual(bundle(m, 'academic').provides, ['ctex', 'fandol', 'siunitx', 'xecjk']);
    assert.equal(bundle(m, 'core').bytes, Buffer.byteLength('CORE-DATA-BLOB') + Buffer.byteLength('CORE-LOADER'));

    // assets: the full per-file inventory is retained.
    assert.ok(m.assets.some((a) => a.path === 'busytex.wasm' && a.role === 'engine-wasm'));
    assert.ok(m.assets.some((a) => a.path === 'licenses.json' && a.role === 'license-inventory'));
    assert.equal(m.assets.length, 11); // 10 payload files + SHA256SUMS

    // assets.json is the schemaVersion-1 SUBSET (no v2 keys), same inventory.
    const a = readAssets();
    assert.equal(a.schemaVersion, 1);
    assert.deepEqual(Object.keys(a), ['schemaVersion', 'generated', 'assets']);
    assert.equal(a.texliveSnapshot, undefined);
    assert.equal(a.bundles, undefined);
    assert.deepEqual(a.assets, m.assets);
  });

  test('detects the texlive-basic->core alias by equal .data sha256 (not a 3rd tier)', () => {
    writeDist();
    runGen(['--tiers', writeSidecar()]);
    const basic = bundle(readManifest(), 'texlive-basic');
    assert.deepEqual(basic, { name: 'texlive-basic', aliasOf: 'core' });
  });

  test('provides are disjoint across tiers (resolver guarantee, carried verbatim)', () => {
    writeDist();
    runGen(['--tiers', writeSidecar()]);
    const m = readManifest();
    const core = new Set(bundle(m, 'core').provides);
    const overlap = bundle(m, 'academic').provides.filter((p) => core.has(p));
    assert.deepEqual(overlap, []);
  });

  test('re-running on unchanged inputs is byte-identical (deterministic)', () => {
    writeDist();
    const sc = writeSidecar();
    runGen(['--tiers', sc]);
    const first = readFileSync(join(distDir, 'manifest.json'));
    const firstAssets = readFileSync(join(distDir, 'assets.json'));
    runGen(['--tiers', sc]);
    assert.deepEqual(readFileSync(join(distDir, 'manifest.json')), first);
    assert.deepEqual(readFileSync(join(distDir, 'assets.json')), firstAssets);
  });
});

describe('gen-assets — without a side-channel (standalone dist inventory)', () => {
  test('still emits a valid v2 manifest; alias detected by hash; provides omitted', () => {
    writeDist();
    const r = runGen([]); // no --tiers
    assert.equal(r.status, 0, r.stderr);
    const m = readManifest();
    assert.equal(m.schemaVersion, 2);
    // Snapshot keeps epoch-derived fields only (no release/revision without the tlpdb).
    assert.equal(m.texliveSnapshot.release, undefined);
    assert.equal(m.texliveSnapshot.tlpdbRevision, undefined);
    assert.equal(m.texliveSnapshot.freeze, '2026-03-01');
    // Alias still detected structurally (equal .data sha256).
    assert.deepEqual(bundle(m, 'texlive-basic'), { name: 'texlive-basic', aliasOf: 'core' });
    // Real bundles present with empty provides (no side-channel to fill them).
    assert.deepEqual(bundle(m, 'core').provides, []);
    assert.deepEqual(bundle(m, 'academic').provides, []);
  });
});

describe('gen-assets — lockstep manifest.version (--version, M5 item 8)', () => {
  test('--version stamps manifest.version (after schemaVersion); assets.json omits it', () => {
    writeDist();
    const r = runGen(['--tiers', writeSidecar(), '--version', '0.1.0']);
    assert.equal(r.status, 0, r.stderr);

    const m = readManifest();
    assert.equal(m.version, '0.1.0');
    // version sits right after schemaVersion in the fixed key order.
    assert.deepEqual(Object.keys(m), [
      'schemaVersion',
      'version',
      'generated',
      'texliveSnapshot',
      'engines',
      'bundles',
      'assets',
    ]);

    // assets.json stays the schemaVersion-1 inventory subset — no version leak.
    const a = readAssets();
    assert.equal(a.version, undefined);
    assert.deepEqual(Object.keys(a), ['schemaVersion', 'generated', 'assets']);
  });

  test('without --version the field is OMITTED (back-compat; runtime soft-verify tolerates absence)', () => {
    writeDist();
    runGen(['--tiers', writeSidecar()]);
    const m = readManifest();
    assert.equal('version' in m, false);
  });

  test('a re-run with the same --version is byte-identical (deterministic)', () => {
    writeDist();
    const sc = writeSidecar();
    runGen(['--tiers', sc, '--version', '2.3.4']);
    const first = readFileSync(join(distDir, 'manifest.json'));
    runGen(['--tiers', sc, '--version', '2.3.4']);
    assert.deepEqual(readFileSync(join(distDir, 'manifest.json')), first);
  });

  test('a version token that is not filename-safe aborts (mislabel guard, mirrors pack.mjs)', () => {
    writeDist();
    const r = runGen(['--tiers', writeSidecar(), '--version', '../evil']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /filename-safe version token/);
  });

  test('accepts a semver with pre-release / build metadata', () => {
    writeDist();
    const r = runGen(['--tiers', writeSidecar(), '--version', '1.0.0-rc.1+build.5']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readManifest().version, '1.0.0-rc.1+build.5');
  });

  // The literal a driver stamps when `node -p .version` reads a missing/nulled field.
  // These PASS the filename-safe regex, so a dedicated reject guards the manifest.
  for (const bad of ['undefined', 'null']) {
    test(`rejects the literal "${bad}" version (missing package.json field, not a real version)`, () => {
      writeDist();
      const r = runGen(['--tiers', writeSidecar(), '--version', bad]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /looks like a missing package\.json "version" field/);
    });
  }
});

describe('gen-assets — guards', () => {
  test('a given-but-missing --tiers path fails loud (wiring guard)', () => {
    writeDist();
    const r = runGen(['--tiers', join(root, 'does-not-exist.json')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /side-channel not found/);
  });

  test('a stale SHA256SUMS (missing a real file) still aborts (unchanged cross-check)', () => {
    const files = writeDist();
    // Drop one row from SHA256SUMS -> core.data now unchecksummed -> abort.
    const kept = Object.keys(files)
      .filter((rel) => rel !== 'core.data')
      .sort()
      .map((rel) => `${sha256(Buffer.from(files[rel]))}  ./${rel}`);
    writeFileSync(join(distDir, 'SHA256SUMS'), `${kept.join('\n')}\n`);
    const r = runGen(['--tiers', writeSidecar()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /absent from SHA256SUMS/);
  });
});
