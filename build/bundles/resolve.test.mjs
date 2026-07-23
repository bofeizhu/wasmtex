// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner.
//   Run: `node --test build/bundles/tlpdb.test.mjs build/bundles/resolve.test.mjs`
//   (name the files explicitly — `node --test build/bundles/` errors on Node 24).
//
// TWO test groups:
//   1. Resolver INVARIANTS on crafted synthetic dbs — first-tier-wins
//      disjointness, cycle guard, provides index, unresolved detection.
//   2. Resolver invariants against the REAL pinned tlpdb (skipped cleanly when
//      the ISO-staged copy is absent, e.g. in CI without the native build):
//      disjointness, core⊇LaTeX-base, academic markers (siunitx/tikz/xeCJK/ctex/
//      fandol), core∩academic=∅, and STABLE counts recorded as the baseline so
//      any drift under the pinned tlpdb is caught.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseTlpdb } from './tlpdb.mjs';
import { TIERS } from './tiers.mjs';
import {
  defaultTlpdbPath,
  extractRevision,
  isNonPackageDepend,
  resolveTiers,
  toJson,
} from './resolve.mjs';

// ---------------------------------------------------------------------------
// Synthetic-db helpers.
// ---------------------------------------------------------------------------

/** Build a fake tlpdb Map from terse specs. */
function db(specs) {
  const m = new Map();
  for (const s of specs) {
    m.set(s.name, {
      name: s.name,
      category: s.category ?? 'Package',
      revision: s.revision ?? 1,
      shortdesc: s.shortdesc ?? '',
      depends: s.depends ?? [],
      runfiles: s.runfiles ?? [],
      runsizeBlocks: s.runsizeBlocks ?? (s.runfiles ? s.runfiles.length : 0),
      binaryArchs: s.binaryArchs ?? [],
      catalogue: s.catalogue ?? {},
    });
  }
  return m;
}

describe('resolveTiers — synthetic invariants', () => {
  test('first-tier-wins: a package reachable from both tiers lands in the earlier one', () => {
    const m = db([
      { name: 'col-core', category: 'Collection', depends: ['shared', 'coreonly'] },
      { name: 'col-ext', category: 'Collection', depends: ['shared', 'extonly'] },
      { name: 'shared', runfiles: ['texmf-dist/tex/shared.sty'] },
      { name: 'coreonly', runfiles: ['texmf-dist/tex/coreonly.sty'] },
      { name: 'extonly', runfiles: ['texmf-dist/tex/extonly.sty'] },
    ]);
    const tiers = [
      { name: 'core', collections: ['col-core'], extraPackages: [] },
      { name: 'ext', collections: ['col-ext'], extraPackages: [] },
    ];
    const r = resolveTiers(m, tiers);
    assert.equal(r.fileToTier.get('texmf-dist/tex/shared.sty'), 'core', 'shared file goes to core (first)');
    assert.equal(r.fileToTier.get('texmf-dist/tex/coreonly.sty'), 'core');
    assert.equal(r.fileToTier.get('texmf-dist/tex/extonly.sty'), 'ext');

    const core = r.tiers.find((t) => t.tier === 'core');
    const ext = r.tiers.find((t) => t.tier === 'ext');
    assert.deepEqual(core.packages, ['coreonly', 'shared']);
    assert.deepEqual(ext.packages, ['extonly'], 'ext does NOT re-claim the shared package');
    assert.equal(r.violations.length, 0, 'no cross-tier collision');
  });

  test('disjointness: no installed file is assigned to two tiers', () => {
    const m = db([
      { name: 'c1', category: 'Collection', depends: ['p1'] },
      { name: 'c2', category: 'Collection', depends: ['p2'] },
      { name: 'p1', runfiles: ['a.sty', 'b.sty'] },
      { name: 'p2', runfiles: ['c.sty'] },
    ]);
    const r = resolveTiers(m, [
      { name: 't1', collections: ['c1'], extraPackages: [] },
      { name: 't2', collections: ['c2'], extraPackages: [] },
    ]);
    const byTier = new Map();
    for (const [f, t] of r.fileToTier) {
      if (byTier.has(f)) assert.fail(`file ${f} assigned twice`);
      byTier.set(f, t);
    }
    assert.equal(r.fileToTier.size, 3);
  });

  test('cycle guard: mutually-dependent packages resolve without infinite loop', () => {
    const m = db([
      { name: 'col', category: 'Collection', depends: ['a'] },
      { name: 'a', depends: ['b'], runfiles: ['a.sty'] },
      { name: 'b', depends: ['a', 'col'], runfiles: ['b.sty'] }, // cycles back to a and col
    ]);
    const r = resolveTiers(m, [{ name: 'only', collections: ['col'], extraPackages: [] }]);
    assert.deepEqual(r.tiers[0].packages, ['a', 'b']);
    assert.equal(r.fileToTier.size, 2);
  });

  test('provides index: only .sty/.cls/.def basenames, per owning package', () => {
    const m = db([
      { name: 'col', category: 'Collection', depends: ['pkg'] },
      {
        name: 'pkg',
        runfiles: [
          'texmf-dist/tex/latex/pkg/pkg.sty',
          'texmf-dist/tex/latex/pkg/pkg.cls',
          'texmf-dist/tex/latex/pkg/pkg-extra.def',
          'texmf-dist/tex/latex/pkg/pkg.cfg', // NOT a provided ext
          'texmf-dist/fonts/pkg/pkg.otf', // NOT a provided ext
        ],
      },
    ]);
    const r = resolveTiers(m, [{ name: 't', collections: ['col'], extraPackages: [] }]);
    assert.deepEqual(r.tiers[0].provides.pkg, ['pkg-extra.def', 'pkg.cls', 'pkg.sty']);
  });

  test('extraPackages are pulled beyond the collections', () => {
    const m = db([
      { name: 'col', category: 'Collection', depends: [] },
      { name: 'loner', runfiles: ['loner.sty'] },
    ]);
    const r = resolveTiers(m, [{ name: 't', collections: ['col'], extraPackages: ['loner'] }]);
    assert.deepEqual(r.tiers[0].packages, ['loner']);
    assert.equal(r.fileToTier.get('loner.sty'), 't');
  });

  test('unresolved: a declared root absent from the db is surfaced, not thrown', () => {
    const r = resolveTiers(db([]), [{ name: 't', collections: ['missing-collection'], extraPackages: [] }]);
    assert.deepEqual(r.unresolved, ['missing-collection']);
  });

  test('config-directive and .ARCH depends are skipped (never unresolved)', () => {
    const m = db([
      { name: 'col', category: 'Collection', depends: ['bin'] },
      { name: 'bin', depends: ['release/2026', 'bin.ARCH'], runfiles: ['bin.sty'] },
    ]);
    const r = resolveTiers(m, [{ name: 't', collections: ['col'], extraPackages: [] }]);
    assert.deepEqual(r.unresolved, [], 'release/2026 and bin.ARCH are not real package edges');
    assert.deepEqual(r.tiers[0].packages, ['bin']);
  });

  test('isNonPackageDepend classifies edge kinds', () => {
    assert.equal(isNonPackageDepend('siunitx'), false);
    assert.equal(isNonPackageDepend('collection-latex'), false);
    assert.equal(isNonPackageDepend('kpathsea.ARCH'), true);
    assert.equal(isNonPackageDepend('release/2026'), true);
    assert.equal(isNonPackageDepend('container_format/xz'), true);
  });

  test('toJson is deterministic (stable key/path order)', () => {
    const m = db([
      { name: 'cB', category: 'Collection', depends: ['zeta', 'alpha'] },
      { name: 'zeta', runfiles: ['texmf-dist/z.sty'] },
      { name: 'alpha', runfiles: ['texmf-dist/a.sty'] },
    ]);
    const tiers = [{ name: 't', collections: ['cB'], extraPackages: [] }];
    assert.equal(toJson(resolveTiers(m, tiers)), toJson(resolveTiers(m, tiers)));
    const doc = JSON.parse(toJson(resolveTiers(m, tiers)));
    assert.deepEqual(Object.keys(doc.fileToTier), ['texmf-dist/a.sty', 'texmf-dist/z.sty']);
    assert.deepEqual(doc.tiers[0].packages, ['alpha', 'zeta']);
  });
});

// ---------------------------------------------------------------------------
// Real pinned tlpdb — the acceptance invariants + STABLE-count baseline.
// Parsed ONCE; the whole group skips cleanly when the tlpdb is absent (CI).
// ---------------------------------------------------------------------------

const TLPDB_PATH = defaultTlpdbPath();
const HAVE_TLPDB = existsSync(TLPDB_PATH);
if (!HAVE_TLPDB) {
  console.warn(
    `[resolve.test] pinned tlpdb not found at ${TLPDB_PATH}; skipping the ` +
      'real-tlpdb invariant checks (expected in CI without the ISO-staged build). ' +
      'Set $WASMTEX_TLPDB to run them.',
  );
}

/** @type {import('./resolve.mjs').Resolution|null} */
let R = null;
let REAL_DB = null;
if (HAVE_TLPDB) {
  REAL_DB = parseTlpdb(readFileSync(TLPDB_PATH, 'utf8'));
  R = resolveTiers(REAL_DB, TIERS);
}
const tierOf = (name) => R.tiers.find((t) => t.tier === name);

// Recorded baseline (TL 2026, tlpdb revision 78233). These are DELIBERATELY
// exact: the tlpdb is a pinned build input, so any change to these numbers means
// the pin (or the resolver) moved — which the reviewer must see. Update in ONE
// place, with justification, when the pin is intentionally bumped.
const BASELINE = {
  packageCount: 8422,
  revision: 78233,
  core: { collections: 3, packages: 157, files: 6106, sizeBlocks: 25809 },
  academic: { collections: 7, packages: 2414, files: 31363, sizeBlocks: 190751 },
  totalFiles: 37469,
  totalSizeBlocks: 216560,
};

describe('resolveTiers — real pinned tlpdb', { skip: !HAVE_TLPDB }, () => {
  test('tlpdb parsed and snapshot revision extracted', () => {
    assert.equal(R.packageCount, BASELINE.packageCount);
    assert.equal(R.tlpdbRevision, BASELINE.revision);
    assert.equal(extractRevision(REAL_DB), BASELINE.revision);
  });

  test('assignment is DISJOINT (no file in two tiers, no cross-tier collision)', () => {
    assert.equal(R.violations.length, 0, `unexpected collisions: ${JSON.stringify(R.violations.slice(0, 3))}`);

    // Independent cross-check: reconstruct each tier's file set; intersection ∅.
    const sets = new Map(R.tiers.map((t) => [t.tier, new Set()]));
    for (const [f, t] of R.fileToTier) sets.get(t).add(f);
    const core = sets.get('core');
    const academic = sets.get('academic');
    for (const f of academic) assert.ok(!core.has(f), `file in both tiers: ${f}`);
    assert.equal(core.size + academic.size, R.fileToTier.size, 'every file in exactly one tier');
  });

  test('no declared root or reached dependency is unresolved', () => {
    assert.deepEqual(R.unresolved, []);
  });

  test('STABLE counts — the drift baseline', () => {
    const core = tierOf('core');
    const academic = tierOf('academic');
    assert.equal(core.collections.length, BASELINE.core.collections);
    assert.equal(core.packages.length, BASELINE.core.packages);
    assert.equal(core.fileCount, BASELINE.core.files);
    assert.equal(core.sizeBlocks, BASELINE.core.sizeBlocks);

    assert.equal(academic.collections.length, BASELINE.academic.collections);
    assert.equal(academic.packages.length, BASELINE.academic.packages);
    assert.equal(academic.fileCount, BASELINE.academic.files);
    assert.equal(academic.sizeBlocks, BASELINE.academic.sizeBlocks);

    assert.equal(R.totals.files, BASELINE.totalFiles);
    assert.equal(R.totals.sizeBlocks, BASELINE.totalSizeBlocks);
  });

  test('core is non-empty and contains the LaTeX base (latex.ltx, article.cls)', () => {
    const core = tierOf('core');
    assert.ok(core.packages.length > 0);
    assert.ok(core.packages.includes('latex'), 'the `latex` package is in core');
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/base/latex.ltx'), 'core');
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/base/article.cls'), 'core');
  });

  test('academic contains the journal + CJK markers', () => {
    // Journal math / figures / classes.
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/siunitx/siunitx.sty'), 'academic');
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/pgf/frontendlayer/tikz.sty'), 'academic');
    // CJK path.
    assert.equal(R.fileToTier.get('texmf-dist/tex/xelatex/xecjk/xeCJK.sty'), 'academic');
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/ctex/ctex.sty'), 'academic');
    // ctex ships several files (classes, fontsets) — spot-check a class + a def.
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/ctex/ctexart.cls'), 'academic');
    assert.equal(R.fileToTier.get('texmf-dist/tex/latex/ctex/fontset/ctex-fontset-fandol.def'), 'academic');
    // fandol: the bundled default Chinese font — package + its .otf glyphs.
    assert.ok(tierOf('academic').packages.includes('fandol'), 'fandol package in academic');
    assert.equal(
      R.fileToTier.get('texmf-dist/fonts/opentype/public/fandol/FandolHei-Regular.otf'),
      'academic',
    );
  });

  test('markers are NOT in the wrong tier (academic ∩ core = ∅, concretely)', () => {
    assert.notEqual(R.fileToTier.get('texmf-dist/tex/latex/siunitx/siunitx.sty'), 'core');
    assert.notEqual(R.fileToTier.get('texmf-dist/tex/latex/base/latex.ltx'), 'academic');
    // The academic-only packages must not appear in core's package list.
    const core = tierOf('core');
    for (const p of ['siunitx', 'pgf', 'xecjk', 'ctex', 'fandol']) {
      assert.ok(!core.packages.includes(p), `${p} must not be in core`);
    }
  });

  test('provides index: package → provided .sty/.cls/.def basenames', () => {
    const academic = tierOf('academic');
    const core = tierOf('core');
    // siunitx → siunitx.sty
    assert.ok(academic.provides.siunitx.includes('siunitx.sty'));
    // ctex → ctex files (a .sty and a class among them)
    assert.ok(academic.provides.ctex.includes('ctex.sty'));
    assert.ok(academic.provides.ctex.includes('ctexart.cls'));
    // pgf → tikz.sty (\usepackage{tikz})
    assert.ok(academic.provides.pgf.includes('tikz.sty'));
    // xecjk → xeCJK.sty
    assert.ok(academic.provides.xecjk.includes('xeCJK.sty'));
    // core: latex → article.cls (\documentclass{article})
    assert.ok(core.provides.latex.includes('article.cls'));
    // Ownership is disjoint: an academic-owned package is not indexed under core.
    assert.equal(core.provides.siunitx, undefined, 'siunitx belongs to academic, not core');
    assert.equal(academic.provides.latex, undefined, 'latex belongs to core, not academic');
    // Every provides key is a package claimed by that tier.
    for (const t of R.tiers) {
      const pkgs = new Set(t.packages);
      for (const p of Object.keys(t.provides)) assert.ok(pkgs.has(p), `${p} indexed but not in ${t.tier}`);
    }
  });

  test('toJson round-trips the real resolution deterministically', () => {
    const a = toJson(R);
    const b = toJson(resolveTiers(REAL_DB, TIERS));
    assert.equal(a, b);
    const doc = JSON.parse(a);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.tlpdb.revision, BASELINE.revision);
    assert.equal(Object.keys(doc.fileToTier).length, BASELINE.totalFiles);
  });
});
