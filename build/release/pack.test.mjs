// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner + a throwaway synthetic-dist fixture.
//   Run: `node --test build/release/pack.test.mjs`
//
// Tests for the versioned-archive packer (pack.mjs, M5 item 7). Builds a small
// synthetic dist/ + a matching gen-assets-shaped manifest.json (the same byte
// shape gen-assets emits: assets exclude manifest.json/assets.json; SHA256SUMS is
// role "checksums"), then exercises:
//   * the §7 archive set + version-parameterized filenames,
//   * verify-vs-manifest PASS on a clean dist,
//   * verify FAILS on a tampered file, a missing manifest asset, and a stray file,
//   * deterministic double-pack (byte-identical),
//   * epoch resolution + the item-8 manifest.version mislabel guard,
// via both the importable functions and the CLI subprocess.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { buildArchiveSpecs, resolveEpoch, verifyArchive } from './pack.mjs';
import { readTarGzEntries } from './tar.mjs';

const PACK = fileURLToPath(new URL('./pack.mjs', import.meta.url));
const EPOCH = 1772323200; // TL 2026 freeze
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let root;
let distDir;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasmtex-pack-'));
  distDir = join(root, 'dist');
  mkdirSync(join(distDir, 'formats'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Write a synthetic dist/ + a gen-assets-shaped manifest.json. Payload files get
 * a manifest asset row (SHA256SUMS included, role "checksums"); manifest.json and
 * assets.json are the two generator outputs, NOT listed in manifest.assets — the
 * exact exclusion gen-assets applies. Returns { files, manifest }.
 */
function writeDist(extra = {}) {
  const payload = {
    'busytex.wasm': 'WASM-ENGINE-BYTES',
    'busytex.js': 'ENGINE-LOADER',
    'core.data': 'CORE-DATA-BLOB-abc',
    'core.js': 'CORE-LOADER-xyz',
    'academic.data': 'ACADEMIC-DATA-BLOB-0123456789',
    'academic.js': 'ACADEMIC-LOADER',
    'formats/xelatex.fmt': 'FMT-DUMP-CONTENT',
    'licenses.json': '{"schemaVersion":1,"role":"license-inventory"}',
    ...extra,
  };
  // Roles mirror gen-assets' classifier (enough for the packer, which only reads
  // path/bytes/sha256 — role is carried for shape fidelity).
  const roleOf = (p) =>
    p === 'SHA256SUMS'
      ? 'checksums'
      : p === 'licenses.json'
        ? 'license-inventory'
        : p.endsWith('.fmt')
          ? 'format'
          : p.endsWith('.wasm')
            ? 'engine-wasm'
            : p.endsWith('.data')
              ? 'bundle-data'
              : p === 'busytex.js'
                ? 'engine-js'
                : 'bundle-js';

  for (const [rel, content] of Object.entries(payload)) {
    writeFileSync(join(distDir, ...rel.split('/')), content);
  }
  // SHA256SUMS over every payload file (sorted, C-locale, "<hash>  ./<path>").
  const sumsRows = Object.keys(payload)
    .sort()
    .map((rel) => `${sha256(Buffer.from(payload[rel]))}  ./${rel}`);
  const sumsText = `${sumsRows.join('\n')}\n`;
  writeFileSync(join(distDir, 'SHA256SUMS'), sumsText);

  // manifest.assets: every payload file + SHA256SUMS (role checksums), sorted;
  // manifest.json + assets.json are excluded (generator outputs).
  const withSums = { ...payload, SHA256SUMS: sumsText };
  const assets = Object.keys(withSums)
    .sort()
    .map((rel) => ({
      path: rel,
      bytes: Buffer.byteLength(withSums[rel]),
      sha256: sha256(Buffer.from(withSums[rel])),
      role: roleOf(rel),
    }));
  const manifest = {
    schemaVersion: 2,
    generated: '2026-03-01T00:00:00.000Z',
    texliveSnapshot: { release: '2026', tlpdbRevision: 78233, sourceDateEpoch: EPOCH, freeze: '2026-03-01' },
    engines: ['pdftex', 'xetex'],
    bundles: [
      { name: 'academic', files: ['academic.data', 'academic.js'], bytes: 0, provides: ['ctex'] },
      { name: 'core', files: ['core.data', 'core.js'], bytes: 0, provides: ['latex'] },
    ],
    assets,
  };
  writeFileSync(join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // assets.json: the v1 subset (a generator output; shipped but not self-listed).
  writeFileSync(
    join(distDir, 'assets.json'),
    `${JSON.stringify({ schemaVersion: 1, generated: manifest.generated, assets }, null, 2)}\n`,
  );
  return { files: withSums, manifest };
}

/** Run pack.mjs as a subprocess. */
function runPack(args, { epoch } = {}) {
  const env = { ...process.env };
  if (epoch !== undefined) env.SOURCE_DATE_EPOCH = String(epoch);
  else delete env.SOURCE_DATE_EPOCH;
  try {
    const stdout = execFileSync('node', [PACK, ...args], { env, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
const outDir = () => join(root, 'release');

describe('pack — the §7 archive set + verify PASS on a clean dist', () => {
  test('produces version-named assets + per-bundle archives, all verified', () => {
    writeDist();
    const r = runPack(['--version', '9.9.9', '--dist', distDir, '--out', outDir(), '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.version, '9.9.9');
    assert.deepEqual(
      rep.archives.map((a) => a.archive).sort(),
      ['wasmtex-assets-9.9.9.tar.gz', 'wasmtex-bundle-academic-9.9.9.tar.gz', 'wasmtex-bundle-core-9.9.9.tar.gz'],
    );
    const assets = rep.archives.find((a) => a.kind === 'assets');
    // 8 payload + SHA256SUMS + manifest.json + assets.json = 11 entries.
    assert.equal(assets.entryCount, 11);
    const core = rep.archives.find((a) => a.bundle === 'core');
    assert.equal(core.entryCount, 2);
    for (const a of rep.archives) assert.match(a.sha256, /^[0-9a-f]{64}$/);
  });

  test('the assets archive contains exactly the full dist tree', async () => {
    const { files } = writeDist();
    runPack(['--version', '0.1.0', '--dist', distDir, '--out', outDir(), '--json']);
    const entries = await readTarGzEntries(join(outDir(), 'wasmtex-assets-0.1.0.tar.gz'));
    const got = entries.map((e) => e.path).sort();
    const want = [...Object.keys(files), 'manifest.json', 'assets.json'].sort();
    assert.deepEqual(got, want);
    // Every payload entry's sha256 matches the source bytes.
    for (const e of entries) {
      if (e.path === 'manifest.json' || e.path === 'assets.json') continue;
      assert.equal(e.sha256, sha256(Buffer.from(files[e.path])), e.path);
    }
  });

  test('the core bundle archive contains exactly core.js + core.data', async () => {
    writeDist();
    runPack(['--version', '0.1.0', '--dist', distDir, '--out', outDir(), '--json']);
    const entries = await readTarGzEntries(join(outDir(), 'wasmtex-bundle-core-0.1.0.tar.gz'));
    assert.deepEqual(entries.map((e) => e.path).sort(), ['core.data', 'core.js']);
  });
});

describe('pack — verifyArchive fails closed', () => {
  const manifestByPath = (m) => new Map(m.assets.map((a) => [a.path, { bytes: a.bytes, sha256: a.sha256 }]));

  test('a tampered file (sha mismatch) is caught', () => {
    const { manifest } = writeDist();
    const spec = buildArchiveSpecs({ distDir, manifest, version: '0.1.0', outDir: outDir() }).find(
      (s) => s.kind === 'assets',
    );
    // Simulate an archive entry whose bytes disagree with the manifest.
    const archiveEntries = manifest.assets.map((a) => ({ path: a.path, size: a.bytes, sha256: a.sha256 }));
    archiveEntries.push({ path: 'manifest.json', size: 1, sha256: 'x' });
    archiveEntries.push({ path: 'assets.json', size: 1, sha256: 'y' });
    const tampered = archiveEntries.find((e) => e.path === 'core.data');
    tampered.sha256 = 'dead'.repeat(16);
    const errors = verifyArchive(archiveEntries, spec, manifestByPath(manifest));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /sha256 mismatch for core\.data/);
  });

  test('a manifest asset missing from the archive is caught', () => {
    const { manifest } = writeDist();
    const spec = buildArchiveSpecs({ distDir, manifest, version: '0.1.0', outDir: outDir() }).find(
      (s) => s.kind === 'assets',
    );
    const archiveEntries = manifest.assets
      .filter((a) => a.path !== 'busytex.wasm') // drop one asset
      .map((a) => ({ path: a.path, size: a.bytes, sha256: a.sha256 }));
    const errors = verifyArchive(archiveEntries, spec, manifestByPath(manifest));
    assert.ok(errors.some((e) => /missing from assets archive: busytex\.wasm/.test(e)));
  });

  test('a stray file (not a manifest asset, not a generator output) is caught', () => {
    const { manifest } = writeDist();
    const spec = buildArchiveSpecs({ distDir, manifest, version: '0.1.0', outDir: outDir() }).find(
      (s) => s.kind === 'assets',
    );
    const archiveEntries = manifest.assets.map((a) => ({ path: a.path, size: a.bytes, sha256: a.sha256 }));
    archiveEntries.push({ path: 'manifest.json', size: 1, sha256: 'a' });
    archiveEntries.push({ path: 'assets.json', size: 1, sha256: 'b' });
    archiveEntries.push({ path: 'STOWAWAY.txt', size: 3, sha256: 'c' });
    const errors = verifyArchive(archiveEntries, spec, manifestByPath(manifest));
    assert.ok(errors.some((e) => /stray file in assets archive.*STOWAWAY\.txt/.test(e)));
  });

  test('generator outputs (manifest.json/assets.json) are allowed unlisted; SHA256SUMS is verified', () => {
    const { manifest } = writeDist();
    const spec = buildArchiveSpecs({ distDir, manifest, version: '0.1.0', outDir: outDir() }).find(
      (s) => s.kind === 'assets',
    );
    const archiveEntries = manifest.assets.map((a) => ({ path: a.path, size: a.bytes, sha256: a.sha256 }));
    archiveEntries.push({ path: 'manifest.json', size: 10, sha256: 'whatever' });
    archiveEntries.push({ path: 'assets.json', size: 10, sha256: 'whatever' });
    const errors = verifyArchive(archiveEntries, spec, manifestByPath(manifest));
    assert.deepEqual(errors, []); // clean
    // SHA256SUMS IS a manifest asset, so a wrong SHA256SUMS row IS caught.
    const sums = archiveEntries.find((e) => e.path === 'SHA256SUMS');
    sums.sha256 = '0'.repeat(64);
    assert.ok(verifyArchive(archiveEntries, spec, manifestByPath(manifest)).some((e) => /SHA256SUMS/.test(e)));
  });

  test('an end-to-end tampered dist fails the CLI (non-zero exit)', () => {
    writeDist();
    // Corrupt core.data on disk AFTER the manifest recorded its hash.
    writeFileSync(join(distDir, 'core.data'), 'TAMPERED-DIFFERENT-LENGTH');
    const r = runPack(['--version', '0.1.0', '--dist', distDir, '--out', outDir()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAILED manifest verification|mismatch/);
  });
});

describe('pack — determinism', () => {
  test('double-pack into two dirs is byte-identical for all archives', () => {
    writeDist();
    const a = join(root, 'relA');
    const b = join(root, 'relB');
    assert.equal(runPack(['--version', '0.1.0', '--dist', distDir, '--out', a, '--json']).status, 0);
    assert.equal(runPack(['--version', '0.1.0', '--dist', distDir, '--out', b, '--json']).status, 0);
    for (const f of [
      'wasmtex-assets-0.1.0.tar.gz',
      'wasmtex-bundle-academic-0.1.0.tar.gz',
      'wasmtex-bundle-core-0.1.0.tar.gz',
    ]) {
      assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), `${f} differs across packs`);
    }
  });
});

describe('pack — epoch resolution + version guard', () => {
  test('SOURCE_DATE_EPOCH overrides the manifest epoch', () => {
    const { manifest } = writeDist();
    assert.deepEqual(resolveEpoch(manifest, { SOURCE_DATE_EPOCH: '42' }), { epoch: 42, source: 'SOURCE_DATE_EPOCH' });
  });
  test('falls back to the manifest epoch, then to 0', () => {
    const { manifest } = writeDist();
    assert.deepEqual(resolveEpoch(manifest, {}), {
      epoch: EPOCH,
      source: 'manifest.texliveSnapshot.sourceDateEpoch',
    });
    assert.deepEqual(resolveEpoch({ ...manifest, texliveSnapshot: {} }, {}), { epoch: 0, source: 'default(0)' });
  });

  test('a manifest.version that disagrees with --version aborts (item-8 mislabel guard)', () => {
    const { manifest } = writeDist();
    manifest.version = '0.2.0';
    writeFileSync(join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const r = runPack(['--version', '0.1.0', '--dist', distDir, '--out', outDir()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /disagrees with manifest\.version/);
  });
  test('a matching manifest.version packs cleanly', () => {
    const { manifest } = writeDist();
    manifest.version = '0.1.0';
    writeFileSync(join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const r = runPack(['--version', '0.1.0', '--dist', distDir, '--out', outDir(), '--json']);
    assert.equal(r.status, 0, r.stderr);
  });

  test('an invalid --version token is rejected', () => {
    writeDist();
    const r = runPack(['--version', '../evil', '--dist', distDir, '--out', outDir()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /filename-safe version token/);
  });
  test('a missing --version is rejected', () => {
    writeDist();
    const r = runPack(['--dist', distDir, '--out', outDir()]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--version <v> is required/);
  });
});
