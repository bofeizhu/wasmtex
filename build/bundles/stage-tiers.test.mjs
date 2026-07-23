// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner + a throwaway tmpdir fixture.
//   Run: `node --test build/bundles/stage-tiers.test.mjs`
//
// Unit tests for stage-tiers.mjs' pure-ish `stageTree` — the disjoint per-tier
// split that item 3's multi-bundle build hardlinks the combined install into.
// The tests build a tiny synthetic install tree + a stub resolution (no tlpdb),
// so they assert the ASSIGNMENT rule directly: fileToTier wins; everything else
// (unmapped / generated / root config) falls to the base tier `core`.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { manifestSidecar, stageTree } from './stage-tiers.mjs';

let root;
let installDir;
let outDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasmtex-stage-'));
  installDir = join(root, 'install');
  outDir = join(root, 'out');
  mkdirSync(installDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a file (creating parents) under the install tree. */
function put(rel, contents = 'x') {
  const full = join(installDir, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

/** A stub {@link Resolution} with the given fileToTier entries; tiers core→academic. */
function resolution(fileToTierObj) {
  return {
    tiers: [{ tier: 'core' }, { tier: 'academic' }],
    fileToTier: new Map(Object.entries(fileToTierObj)),
  };
}

const staged = (tier, rel) => join(outDir, tier, ...rel.split('/'));

describe('stageTree — disjoint assignment', () => {
  test('academic-owned files go to academic; everything else falls to core', () => {
    put('texmf-dist/tex/latex/base/article.cls');
    put('texmf-dist/tex/latex/siunitx/siunitx.sty');
    put('texmf-dist/ls-R'); // generated → not in the map
    put('texmf.cnf'); // root config → not in the map
    put('tex/latex/latexconfig/epstopdf-sys.cfg'); // pre-extracted root tex/ → not in the map

    const { totals } = stageTree(
      installDir,
      outDir,
      resolution({
        'texmf-dist/tex/latex/base/article.cls': 'core',
        'texmf-dist/tex/latex/siunitx/siunitx.sty': 'academic',
      }),
    );

    // academic: ONLY its one owned file.
    assert.ok(existsSync(staged('academic', 'texmf-dist/tex/latex/siunitx/siunitx.sty')));
    assert.ok(!existsSync(staged('academic', 'texmf-dist/tex/latex/base/article.cls')));
    assert.ok(!existsSync(staged('academic', 'texmf-dist/ls-R')));
    assert.ok(!existsSync(staged('academic', 'texmf.cnf')));

    // core: its owned file PLUS every unmapped / generated / root file (catch-all).
    assert.ok(existsSync(staged('core', 'texmf-dist/tex/latex/base/article.cls')));
    assert.ok(existsSync(staged('core', 'texmf-dist/ls-R')));
    assert.ok(existsSync(staged('core', 'texmf.cnf')));
    assert.ok(existsSync(staged('core', 'tex/latex/latexconfig/epstopdf-sys.cfg')));
    assert.ok(!existsSync(staged('core', 'texmf-dist/tex/latex/siunitx/siunitx.sty')));

    assert.equal(totals.get('core').files, 4);
    assert.equal(totals.get('academic').files, 1);
    assert.equal(totals.get('core').bytes, 4); // 4 files × 1 byte 'x'
    assert.equal(totals.get('academic').bytes, 1);
  });

  test('the split is disjoint — no path lands in two tiers', () => {
    put('texmf-dist/a.sty');
    put('texmf-dist/b.sty');
    stageTree(installDir, outDir, resolution({ 'texmf-dist/b.sty': 'academic' }));
    // a.sty → core only; b.sty → academic only.
    assert.ok(existsSync(staged('core', 'texmf-dist/a.sty')) && !existsSync(staged('academic', 'texmf-dist/a.sty')));
    assert.ok(existsSync(staged('academic', 'texmf-dist/b.sty')) && !existsSync(staged('core', 'texmf-dist/b.sty')));
  });

  test('staged files are HARDLINKS of the install tree (same inode, no copy)', () => {
    const src = put('texmf-dist/tex/latex/base/article.cls', 'hello');
    stageTree(installDir, outDir, resolution({}));
    const dst = staged('core', 'texmf-dist/tex/latex/base/article.cls');
    assert.equal(statSync(src).ino, statSync(dst).ino, 'hardlink shares the inode');
  });

  test('a later tier with no owned files simply stays empty (base catches all)', () => {
    put('texmf-dist/only-core.sty');
    const { totals } = stageTree(installDir, outDir, resolution({}));
    assert.equal(totals.get('core').files, 1);
    assert.equal(totals.get('academic').files, 0);
    assert.ok(!existsSync(join(outDir, 'academic')));
  });
});

describe('stageTree — non-regular entries', () => {
  test('symlinks are skipped (never dereferenced into a tier tree)', () => {
    put('texmf-dist/real.sty', 'r');
    // A symlink beside it; must be reported as skipped, not staged.
    symlinkSync('real.sty', join(installDir, 'texmf-dist', 'link.sty'));
    const { skipped, totals } = stageTree(installDir, outDir, resolution({}));
    assert.equal(totals.get('core').files, 1); // only real.sty
    assert.ok(!existsSync(staged('core', 'texmf-dist/link.sty')));
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /link\.sty$/);
  });
});

// ---------------------------------------------------------------------------
// manifestSidecar — the gen-assets side-channel builder (M4 item 4).
// ---------------------------------------------------------------------------

/** A stub {@link Resolution} with per-tier package lists + a tlpdb revision. */
function resolutionWith(revision, tierPackages) {
  return {
    tlpdbRevision: revision,
    tiers: Object.entries(tierPackages).map(([tier, packages]) => ({ tier, packages })),
  };
}

describe('manifestSidecar — provided-package index + snapshot facts', () => {
  test('emits per-tier provides (=packages) for only the named tiers, in order', () => {
    const r = resolutionWith(78233, {
      core: ['amsmath', 'latex'],
      academic: ['fandol', 'siunitx'],
    });
    const sc = manifestSidecar(r, '2026', ['core', 'academic']);
    assert.equal(sc.schemaVersion, 1);
    assert.deepEqual(sc.texlive, { release: '2026', tlpdbRevision: 78233 });
    assert.deepEqual(sc.tiers, [
      { name: 'core', provides: ['amsmath', 'latex'] },
      { name: 'academic', provides: ['fandol', 'siunitx'] },
    ]);
  });

  test('carries font-only packages (e.g. fandol) that ship no .sty — the full package list', () => {
    const r = resolutionWith(78233, { academic: ['ctex', 'fandol', 'xecjk'] });
    const sc = manifestSidecar(r, '2026', ['academic']);
    assert.ok(sc.tiers[0].provides.includes('fandol'));
  });

  test('skips a requested tier the resolution does not know, and null release becomes null', () => {
    const r = resolutionWith(78233, { core: ['latex'] });
    const sc = manifestSidecar(r, null, ['core', 'ghost']);
    assert.deepEqual(sc.tiers.map((t) => t.name), ['core']);
    assert.equal(sc.texlive.release, null);
  });
});
