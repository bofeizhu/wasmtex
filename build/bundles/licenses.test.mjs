// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner.
//   Run: `node --test build/bundles/licenses.test.mjs`
//
// TWO test groups:
//   1. Allowlist + fail-closed AUDIT invariants on crafted synthetic dbs — the
//      three resolution cases (free catalogue / unresolved-placeholder+exception /
//      non-free negative), multi-token splitting, shipped-vs-not (collections and
//      0-runfile packages skipped), exception precedence, and the inventory shape.
//   2. The audit against the REAL pinned tlpdb (skipped cleanly when the ISO-staged
//      copy is absent): PASS with the cited exceptions, FAIL (22 named) without
//      them, the STABLE shipped-count + exception baseline, and "no shipped package
//      carries a non-allowlisted token".

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseTlpdb } from './tlpdb.mjs';
import { TIERS } from './tiers.mjs';
import { defaultTlpdbPath, resolveTiers } from './resolve.mjs';
import { LICENSE_EXCEPTIONS } from './license-exceptions.mjs';
import {
  LICENSE_ALLOWLIST,
  KNOWN_NONFREE,
  RESOLVABLE_PLACEHOLDERS,
  auditLicenses,
  buildInventory,
  classifyValue,
  licenseTokens,
  ownedFileCount,
} from './licenses.mjs';

// ---------------------------------------------------------------------------
// Synthetic-db helper (mirrors resolve.test.mjs).
// ---------------------------------------------------------------------------
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

/** Resolve a single-tier `t` over a synthetic db and audit it with `exceptions`. */
function auditSingleTier(specs, roots, exceptions = {}) {
  const m = db(specs);
  const resolution = resolveTiers(m, [{ name: 't', collections: roots.collections ?? [], extraPackages: roots.extraPackages ?? [] }]);
  return { m, resolution, audit: auditLicenses(m, resolution, { exceptions }) };
}

const shippedOf = (audit, tier = 't') => audit.tiers.find((x) => x.tier === tier).shipped;
const pkg = (audit, name, tier = 't') => shippedOf(audit, tier).find((p) => p.package === name);

// ===========================================================================
describe('licenseTokens + classifyValue — the allowlist core', () => {
  test('splits whitespace-separated multi-license values', () => {
    assert.deepEqual(licenseTokens('ofl lppl'), ['ofl', 'lppl']);
    assert.deepEqual(licenseTokens('  lppl1.3c   agpl3 '), ['lppl1.3c', 'agpl3']);
    assert.deepEqual(licenseTokens(''), []);
    assert.deepEqual(licenseTokens('   '), []);
  });

  test('a single free token passes', () => {
    for (const v of ['lppl1.3', 'gpl3+', 'mit', 'ofl', 'knuth', 'pd', 'cc0', 'other-free', 'bsd3', 'apache2']) {
      assert.equal(classifyValue(v).ok, true, `${v} should be free`);
    }
  });

  test('EVERY token in a multi-license value must be free (aggregate, not choice)', () => {
    assert.equal(classifyValue('ofl lppl').ok, true);
    assert.equal(classifyValue('lppl1.3c agpl3').ok, true, 'agpl3 is a free license (allowed in the aggregate)');
    assert.equal(classifyValue('gpl3+ fdl').ok, true);
    // One non-free token taints the whole value.
    const r = classifyValue('gpl3 nonfree');
    assert.equal(r.ok, false);
    assert.deepEqual(r.bad, ['nonfree']);
    assert.deepEqual(r.nonfree, ['nonfree']);
  });

  test('non-free / unknown / empty values are not ok', () => {
    assert.equal(classifyValue('nonfree').ok, false);
    assert.equal(classifyValue('cc-by-nc-4').ok, false);
    assert.equal(classifyValue('nosource').ok, false);
    assert.equal(classifyValue('made-up-token').ok, false);
    assert.equal(classifyValue('').ok, false);
    // A distinguishing message signal: known-nonfree vs merely-unknown.
    assert.deepEqual(classifyValue('made-up-token').unknown, ['made-up-token']);
    assert.deepEqual(classifyValue('made-up-token').nonfree, []);
  });

  test('token-set hygiene: allowlist ∩ nonfree = ∅; placeholders are on neither', () => {
    for (const t of KNOWN_NONFREE) assert.ok(!LICENSE_ALLOWLIST.has(t), `${t} must not be allowlisted`);
    for (const t of RESOLVABLE_PLACEHOLDERS) {
      assert.ok(!LICENSE_ALLOWLIST.has(t), `${t} placeholder must not be allowlisted`);
      assert.ok(!KNOWN_NONFREE.has(t), `${t} placeholder must not be marked non-free`);
    }
    // agpl3 IS free (the §2 copyleft rule governs OUR code, not the aggregate).
    assert.ok(LICENSE_ALLOWLIST.has('agpl3'));
  });
});

// ===========================================================================
describe('auditLicenses — the three resolution cases (synthetic)', () => {
  test('Case A: a free catalogue-license passes (source: catalogue)', () => {
    const { audit } = auditSingleTier(
      [
        { name: 'col', category: 'Collection', depends: ['p'] },
        { name: 'p', runfiles: ['texmf-dist/p.sty'], catalogue: { license: 'lppl1.3c' } },
      ],
      { collections: ['col'] },
    );
    assert.equal(audit.ok, true);
    const p = pkg(audit, 'p');
    assert.equal(p.ok, true);
    assert.equal(p.value, 'lppl1.3c');
    assert.equal(p.source, 'catalogue');
  });

  test('Case B: missing catalogue-license FAILS (missing); an exception RESOLVES it', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['infra'] },
      { name: 'infra', runfiles: ['tlpkg/infra.pl'], catalogue: {} }, // no license
    ];
    // Without exception -> fail 'missing'.
    const a1 = auditSingleTier(specs, { collections: ['col'] });
    assert.equal(a1.audit.ok, false);
    assert.equal(a1.audit.failures.length, 1);
    assert.equal(a1.audit.failures[0].kind, 'missing');
    assert.equal(a1.audit.failures[0].package, 'infra');
    // With a cited exception -> pass, source exception.
    const a2 = auditSingleTier(specs, { collections: ['col'] }, { infra: { license: 'other-free', reason: 'x', source: 'LICENSE.TL' } });
    assert.equal(a2.audit.ok, true);
    assert.equal(pkg(a2.audit, 'infra').source, 'exception');
    assert.equal(pkg(a2.audit, 'infra').value, 'other-free');
  });

  test('Case B: the `collection` placeholder FAILS as `unspecified`; an exception resolves it', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['bundle'] },
      { name: 'bundle', runfiles: ['texmf-dist/bundle.sty'], catalogue: { license: 'collection' } },
    ];
    const a1 = auditSingleTier(specs, { collections: ['col'] });
    assert.equal(a1.audit.ok, false);
    assert.equal(a1.audit.failures[0].kind, 'unspecified');
    const a2 = auditSingleTier(specs, { collections: ['col'] }, { bundle: { license: 'other-free' } });
    assert.equal(a2.audit.ok, true);
    assert.equal(pkg(a2.audit, 'bundle').source, 'exception');
  });

  test('Case C: a non-free catalogue token FAILS and is NOT exception-overridable', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['bad'] },
      { name: 'bad', runfiles: ['texmf-dist/bad.sty'], catalogue: { license: 'nonfree' } },
    ];
    // Even WITH an exception, a real non-free value still fails (exception ignored).
    const { audit } = auditSingleTier(specs, { collections: ['col'] }, { bad: { license: 'mit' } });
    assert.equal(audit.ok, false);
    assert.equal(audit.failures[0].kind, 'nonfree');
    assert.deepEqual(audit.failures[0].bad, ['nonfree']);
    assert.deepEqual(audit.ignoredExceptions, ['bad']);
  });

  test('a synthetic package with `noinfo` fails (unspecified) unless excepted', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['ni'] },
      { name: 'ni', runfiles: ['texmf-dist/ni.sty'], catalogue: { license: 'noinfo' } },
    ];
    assert.equal(auditSingleTier(specs, { collections: ['col'] }).audit.failures[0].kind, 'unspecified');
  });

  test('a bad exception (its own license not allowlisted) FAILS as bad-exception', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['g'] },
      { name: 'g', runfiles: ['texmf-dist/g.sty'], catalogue: {} },
    ];
    const { audit } = auditSingleTier(specs, { collections: ['col'] }, { g: { license: 'nonfree' } });
    assert.equal(audit.ok, false);
    assert.equal(audit.failures[0].kind, 'bad-exception');
  });

  test('a redundant exception (catalogue already free) is a note, not a failure', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['p'] },
      { name: 'p', runfiles: ['texmf-dist/p.sty'], catalogue: { license: 'mit' } },
    ];
    const { audit } = auditSingleTier(specs, { collections: ['col'] }, { p: { license: 'other-free' } });
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.redundantExceptions, ['p']);
    assert.equal(pkg(audit, 'p').source, 'catalogue'); // catalogue value stands.
  });

  test('an exception matching no shipped package is reported as unused', () => {
    const specs = [
      { name: 'col', category: 'Collection', depends: ['p'] },
      { name: 'p', runfiles: ['texmf-dist/p.sty'], catalogue: { license: 'mit' } },
    ];
    const { audit } = auditSingleTier(specs, { collections: ['col'] }, { ghost: { license: 'other-free' } });
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.unusedExceptions, ['ghost']);
  });
});

// ===========================================================================
describe('auditLicenses — "shipped" excludes collections and 0-runfile packages', () => {
  test('a Collection/Scheme is never a shipped package (no runfiles, resolver-excluded)', () => {
    const { audit } = auditSingleTier(
      [
        { name: 'col', category: 'Collection', depends: ['p'] }, // has NO license, but is a Collection
        { name: 'p', runfiles: ['texmf-dist/p.sty'], catalogue: { license: 'lppl1.3' } },
      ],
      { collections: ['col'] },
    );
    assert.equal(audit.ok, true);
    assert.equal(audit.shippedCount, 1, 'only the content package p is shipped');
    assert.equal(shippedOf(audit).some((x) => x.package === 'col'), false);
  });

  test('a package that OWNS 0 runfiles is not "shipped" — even with a non-free license', () => {
    // `docly` is category Package but ships nothing (docs/bins dropped) -> not audited.
    const { audit, m, resolution } = auditSingleTier(
      [
        { name: 'col', category: 'Collection', depends: ['docly', 'p'] },
        { name: 'docly', runfiles: [], catalogue: { license: 'nonfree' } }, // 0 runfiles
        { name: 'p', runfiles: ['texmf-dist/p.sty'], catalogue: { license: 'gpl2' } },
      ],
      { collections: ['col'] },
    );
    assert.equal(ownedFileCount(m.get('docly'), 't', resolution.fileToTier), 0);
    assert.equal(audit.ok, true, 'the 0-file non-free package is not shipped, so it cannot fail the audit');
    assert.equal(audit.shippedCount, 1);
  });
});

// ===========================================================================
describe('buildInventory — machine-readable shape + determinism', () => {
  const specs = [
    { name: 'col', category: 'Collection', depends: ['a', 'b', 'c'] },
    { name: 'a', runfiles: ['texmf-dist/a.sty'], catalogue: { license: 'lppl1.3' } },
    { name: 'b', runfiles: ['texmf-dist/b.sty'], catalogue: { license: 'lppl1.3' } },
    { name: 'c', runfiles: ['texmf-dist/c.sty'], catalogue: { license: 'ofl lppl' } },
  ];

  test('per-tier package→{license,source} + aggregate byLicense/byToken', () => {
    const m = db(specs);
    const resolution = resolveTiers(m, [{ name: 'core', collections: ['col'], extraPackages: [] }]);
    const audit = auditLicenses(m, resolution, {});
    audit.release = '2026';
    const inv = buildInventory(resolution, audit);

    assert.equal(inv.schemaVersion, 1);
    assert.deepEqual(inv.texlive, { release: '2026', tlpdbRevision: resolution.tlpdbRevision });
    assert.equal(inv.audit.ok, true);
    assert.equal(inv.audit.shippedPackageCount, 3);

    const core = inv.tiers.find((t) => t.tier === 'core');
    assert.deepEqual(core.packages.a, { license: 'lppl1.3', source: 'catalogue' });
    // byLicense keyed by the raw value; sorted package lists.
    assert.deepEqual(inv.aggregate.byLicense['lppl1.3'], { count: 2, packages: ['a', 'b'] });
    assert.deepEqual(inv.aggregate.byLicense['ofl lppl'], { count: 1, packages: ['c'] });
    // byToken splits the multi-license value: `lppl` appears in both lppl1.3? no —
    // token `lppl` only from 'ofl lppl'; `lppl1.3` from a+b; `ofl` from c.
    assert.equal(inv.aggregate.byToken['lppl1.3'].count, 2);
    assert.equal(inv.aggregate.byToken['ofl'].count, 1);
    assert.equal(inv.aggregate.byToken['lppl'].count, 1);
    // Keys are sorted (deterministic).
    assert.deepEqual(Object.keys(core.packages), ['a', 'b', 'c']);
  });

  test('re-running buildInventory on the same inputs is byte-identical', () => {
    const m = db(specs);
    const resolution = resolveTiers(m, [{ name: 'core', collections: ['col'], extraPackages: [] }]);
    const mk = () => {
      const a = auditLicenses(m, resolution, {});
      a.release = '2026';
      return `${JSON.stringify(buildInventory(resolution, a), null, 2)}\n`;
    };
    assert.equal(mk(), mk());
  });
});

// ===========================================================================
// Real pinned tlpdb — the acceptance invariants + STABLE baseline. Parsed ONCE;
// the whole group skips cleanly when the tlpdb is absent (CI without the ISO).
// ===========================================================================
const TLPDB_PATH = defaultTlpdbPath();
const HAVE_TLPDB = existsSync(TLPDB_PATH);
if (!HAVE_TLPDB) {
  console.warn(
    `[licenses.test] pinned tlpdb not found at ${TLPDB_PATH}; skipping the real-tlpdb ` +
      'license-audit checks (expected in CI without the ISO-staged build). Set $WASMTEX_TLPDB to run them.',
  );
}

// Recorded baseline (TL 2026, tlpdb revision 78233) — DELIBERATELY exact, like
// resolve.test.mjs: a change means the pin (or the audit logic) moved and a
// reviewer must see it. Update in ONE place, with justification, on an intended bump.
const BASELINE = {
  shippedTotal: 2545,
  core: 151,
  academic: 2394,
  exceptions: 22, // the cited catalogue-gap resolutions (build/bundles/license-exceptions.mjs).
};

let REAL_DB = null;
let R = null;
if (HAVE_TLPDB) {
  REAL_DB = parseTlpdb(readFileSync(TLPDB_PATH, 'utf8'));
  R = resolveTiers(REAL_DB, TIERS);
}

describe('license exceptions table — shape', () => {
  test('every exception carries an allowlisted license, a reason, and a source', () => {
    const names = Object.keys(LICENSE_EXCEPTIONS);
    assert.equal(names.length, BASELINE.exceptions, 'exception count baseline');
    for (const [name, e] of Object.entries(LICENSE_EXCEPTIONS)) {
      assert.equal(classifyValue(e.license).ok, true, `${name}: exception license "${e.license}" must be allowlisted`);
      assert.ok(typeof e.reason === 'string' && e.reason.length > 0, `${name}: reason`);
      assert.ok(typeof e.source === 'string' && /LICENSE\.TL/.test(e.source), `${name}: source cites LICENSE.TL`);
    }
  });
});

describe('aggregate license audit — real pinned tlpdb', { skip: !HAVE_TLPDB }, () => {
  test('PASSES with the cited exceptions — every shipped package is free', () => {
    const audit = auditLicenses(REAL_DB, R, { exceptions: LICENSE_EXCEPTIONS });
    assert.equal(audit.ok, true, `unexpected failures: ${JSON.stringify(audit.failures.slice(0, 5))}`);
    assert.equal(audit.failures.length, 0);
    assert.equal(audit.shippedCount, BASELINE.shippedTotal);
    // All 22 exceptions are USED and none redundant/ignored/unused (they resolve
    // real gaps, exactly).
    assert.deepEqual(audit.redundantExceptions, []);
    assert.deepEqual(audit.ignoredExceptions, []);
    assert.deepEqual(audit.unusedExceptions, []);
  });

  test('FAILS closed WITHOUT the exceptions — exactly the 22 gap packages are named', () => {
    const audit = auditLicenses(REAL_DB, R, { exceptions: {} });
    assert.equal(audit.ok, false);
    assert.equal(audit.failures.length, BASELINE.exceptions);
    const failed = audit.failures.map((f) => f.package).sort();
    assert.deepEqual(failed, Object.keys(LICENSE_EXCEPTIONS).sort(), 'the gap set == the exceptions table');
    // Kinds: the `collection`-token bundles are `unspecified`; the rest `missing`.
    const kinds = new Set(audit.failures.map((f) => f.kind));
    assert.deepEqual([...kinds].sort(), ['missing', 'unspecified']);
  });

  test('per-tier shipped counts baseline (drift tripwire)', () => {
    const audit = auditLicenses(REAL_DB, R, { exceptions: LICENSE_EXCEPTIONS });
    const core = audit.tiers.find((t) => t.tier === 'core');
    const academic = audit.tiers.find((t) => t.tier === 'academic');
    assert.equal(core.shipped.length, BASELINE.core);
    assert.equal(academic.shipped.length, BASELINE.academic);
  });

  test('NO shipped package carries a non-allowlisted token (the legal invariant)', () => {
    const audit = auditLicenses(REAL_DB, R, { exceptions: LICENSE_EXCEPTIONS });
    for (const t of audit.tiers) {
      for (const p of t.shipped) {
        assert.notEqual(p.value, null, `${p.package} has a resolved license`);
        for (const tok of licenseTokens(p.value)) {
          assert.ok(LICENSE_ALLOWLIST.has(tok), `${t.tier}/${p.package}: token "${tok}" must be allowlisted`);
        }
      }
    }
  });

  test('inventory: byToken includes free copyleft (agpl3) and fonts (ofl); no nonfree token key', () => {
    const audit = auditLicenses(REAL_DB, R, { exceptions: LICENSE_EXCEPTIONS });
    audit.release = '2026';
    const inv = buildInventory(R, audit);
    assert.ok(inv.aggregate.byToken['agpl3'].count > 0, 'agpl3 is present and free');
    assert.ok(inv.aggregate.byToken['ofl'].count > 0);
    assert.ok(inv.aggregate.byToken['other-free'].count >= BASELINE.exceptions);
    for (const tok of Object.keys(inv.aggregate.byToken)) {
      assert.ok(LICENSE_ALLOWLIST.has(tok), `aggregate token "${tok}" must be free`);
      assert.ok(!KNOWN_NONFREE.has(tok) && !RESOLVABLE_PLACEHOLDERS.has(tok), `"${tok}" must not be nonfree/placeholder`);
    }
  });
});
