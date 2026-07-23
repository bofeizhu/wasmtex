// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// The schemaVersion-2 integrity manifest (M4 item 4). `build/manifest/gen-assets.mjs`
// OWNS `dist/manifest.json`'s schema (DESIGN.md §7); `runtime/src/protocol.ts`
// CARRIES it across the client→worker boundary and EXPOSES the per-bundle
// `provides` index (the data M4 items 6–7 consume for §5.4 resolution). This test
// pins the two together from both ends and exercises the `bundleProvidingPackage`
// lookup helper:
//
//   * Compile-time (dist-INDEPENDENT): `satisfies` witnesses + field-precision
//     pins for the new types (TexliveSnapshot, BundleManifestEntry, the v2
//     AssetsInventory superset).
//   * Trust boundary: a v2 manifest round-trips through `parseClientMessage`
//     (init) with `texliveSnapshot`/`engines`/`bundles` CARRIED, not dropped —
//     the schemaVersion-1 parser silently discarded unknown top-level keys, so
//     this guards the extension.
//   * Runtime (skips cleanly when dist/ is absent — CI has no dist/): the REAL
//     generated `dist/manifest.json` is asserted to match, so the witnesses can
//     never silently diverge from what the generator emits.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  bundleProvidingPackage,
  newJobId,
  parseClientMessage,
} from '../src/protocol';
import type {
  AssetsInventory,
  BundleManifestEntry,
  TexliveSnapshot,
} from '../src/protocol';

// ---------------------------------------------------------------------------
// Compile-time witnesses (dist-independent). `satisfies` runs excess-property
// checking, so these literals compile ONLY if the protocol types accept the
// generator's schemaVersion-2 shape verbatim. Values are illustrative.
// ---------------------------------------------------------------------------
const SNAPSHOT_WITNESS = {
  release: '2026',
  tlpdbRevision: 78233,
  sourceDateEpoch: 1772323200,
  freeze: '2026-03-01',
} satisfies TexliveSnapshot;

const REAL_BUNDLE_WITNESS = {
  name: 'academic',
  files: ['academic.data', 'academic.js'],
  bytes: 505887127,
  provides: ['siunitx', 'ctex', 'xecjk'],
} satisfies BundleManifestEntry;

const ALIAS_BUNDLE_WITNESS = {
  name: 'texlive-basic',
  aliasOf: 'core',
} satisfies BundleManifestEntry;

const MANIFEST_WITNESS = {
  schemaVersion: 2,
  generated: '2026-03-01T00:00:00.000Z',
  texliveSnapshot: SNAPSHOT_WITNESS,
  engines: ['bibtex8', 'kpsewhich', 'makeindex', 'pdftex', 'xdvipdfmx', 'xetex'],
  bundles: [REAL_BUNDLE_WITNESS, { name: 'core', files: ['core.data', 'core.js'], bytes: 1, provides: ['latex'] }, ALIAS_BUNDLE_WITNESS],
  assets: [
    { path: 'busytex.wasm', bytes: 27_508_145, sha256: '00'.repeat(32), role: 'engine-wasm' },
  ],
} satisfies AssetsInventory;

// Field-precision pins: reading these off the typed manifest must keep their
// DECLARED types (not collapse to the forward-compat index signature's unknown).
function pinSnapshotFields(
  s: TexliveSnapshot,
): [string | undefined, number | undefined, number | undefined, string | undefined] {
  return [s.release, s.tlpdbRevision, s.sourceDateEpoch, s.freeze];
}
function pinBundleFields(
  b: BundleManifestEntry,
): [string, readonly string[] | undefined, number | undefined, readonly string[] | undefined, string | undefined] {
  return [b.name, b.files, b.bytes, b.provides, b.aliasOf];
}
function pinManifestFields(
  m: AssetsInventory,
): [TexliveSnapshot | undefined, readonly string[] | undefined, readonly BundleManifestEntry[] | undefined] {
  return [m.texliveSnapshot, m.engines, m.bundles];
}

// A v2 manifest fixture as it crosses the client→worker boundary (init.assets).
function v2Inventory(): unknown {
  return {
    schemaVersion: 2,
    generated: '2026-03-01T00:00:00.000Z',
    texliveSnapshot: { release: '2026', tlpdbRevision: 78233, sourceDateEpoch: 1772323200, freeze: '2026-03-01' },
    engines: ['bibtex8', 'kpsewhich', 'makeindex', 'pdftex', 'xdvipdfmx', 'xetex'],
    bundles: [
      { name: 'academic', files: ['academic.data', 'academic.js'], bytes: 505887127, provides: ['siunitx', 'xecjk'] },
      { name: 'core', files: ['core.data', 'core.js'], bytes: 55334848, provides: ['latex', 'amsmath'] },
      { name: 'texlive-basic', aliasOf: 'core' },
    ],
    assets: [
      { path: 'busytex.js', bytes: 10, sha256: 'ab', role: 'engine-js' },
      { path: 'busytex.wasm', bytes: 20, sha256: 'cd', role: 'engine-wasm' },
      { path: 'core.data', role: 'bundle-data' },
      { path: 'core.js', role: 'bundle-js' },
    ],
  };
}

function parsedInventoryFrom(inventory: unknown): AssetsInventory {
  const msg = parseClientMessage({
    type: 'init',
    v: PROTOCOL_VERSION,
    jobId: newJobId(),
    assets: { baseUrl: '/dist', inventory, bundles: { preload: ['core'], onDemand: ['academic'] } },
  });
  if (msg === null || msg.type !== 'init') throw new Error('init message unexpectedly rejected');
  return msg.assets.inventory;
}

describe('manifest.json (schemaVersion 2) <-> protocol types (M4 item 4)', () => {
  it('pins the generator schema against the protocol types (compile-time)', () => {
    const [release, rev] = pinSnapshotFields(SNAPSHOT_WITNESS);
    expect(release).toBe('2026');
    expect(rev).toBe(78233);
    const [name, files, , provides, aliasOf] = pinBundleFields(REAL_BUNDLE_WITNESS);
    expect(name).toBe('academic');
    expect(files).toEqual(['academic.data', 'academic.js']);
    expect(provides).toContain('siunitx');
    expect(aliasOf).toBeUndefined();
    expect(pinBundleFields(ALIAS_BUNDLE_WITNESS)[4]).toBe('core');
    const [snap, engines, bundles] = pinManifestFields(MANIFEST_WITNESS);
    expect(snap?.tlpdbRevision).toBe(78233);
    expect(engines).toContain('xetex');
    expect(bundles?.length).toBe(3);
  });

  it('carries texliveSnapshot / engines / bundles across the client→worker boundary', () => {
    const inv = parsedInventoryFrom(v2Inventory());
    // schemaVersion-1 additions the OLD parser dropped are now preserved.
    expect(inv.schemaVersion).toBe(2);
    expect(inv.texliveSnapshot?.tlpdbRevision).toBe(78233);
    expect(inv.texliveSnapshot?.release).toBe('2026');
    expect(inv.engines).toEqual(['bibtex8', 'kpsewhich', 'makeindex', 'pdftex', 'xdvipdfmx', 'xetex']);
    expect(inv.bundles?.map((b) => b.name)).toEqual(['academic', 'core', 'texlive-basic']);
    const core = inv.bundles?.find((b) => b.name === 'core');
    expect(core?.provides).toContain('latex');
    expect(inv.bundles?.find((b) => b.name === 'texlive-basic')?.aliasOf).toBe('core');
    // The full inventory still validated (assets carried), so init did not reject.
    expect(inv.assets.map((a) => a.path)).toContain('busytex.wasm');
  });

  it('drops a malformed bundle entry without failing the whole inventory (lenient, non-load-critical)', () => {
    const inv = parsedInventoryFrom({
      schemaVersion: 2,
      bundles: [
        { name: 'core', provides: ['latex'] },
        { notName: 'oops' }, // no `name` -> dropped
        'garbage', // not a record -> dropped
      ],
      assets: [{ path: 'busytex.wasm', role: 'engine-wasm' }],
    });
    expect(inv.bundles?.map((b) => b.name)).toEqual(['core']);
  });

  describe('bundleProvidingPackage (the §5.4 provides lookup helper)', () => {
    const inv = parsedInventoryFrom(v2Inventory());

    it('maps a package name to the bundle that provides it', () => {
      expect(bundleProvidingPackage(inv, 'siunitx')).toBe('academic');
      expect(bundleProvidingPackage(inv, 'latex')).toBe('core');
    });

    it('is case-insensitive (\\usepackage{xeCJK} -> tlpdb package xecjk)', () => {
      expect(bundleProvidingPackage(inv, 'xeCJK')).toBe('academic');
      expect(bundleProvidingPackage(inv, 'AMSMath')).toBe('core');
    });

    it('skips alias bundles (resolves to the canonical tier, never a back-compat copy)', () => {
      // texlive-basic aliases core and carries no provides; a core package still
      // resolves to `core`, and nothing resolves to `texlive-basic`.
      const names = new Set((inv.bundles ?? []).map((b) => b.name));
      expect(names.has('texlive-basic')).toBe(true);
      expect(bundleProvidingPackage(inv, 'latex')).toBe('core');
    });

    it('returns undefined for an unknown package, an empty name, or a manifest with no bundles', () => {
      expect(bundleProvidingPackage(inv, 'no-such-package')).toBeUndefined();
      expect(bundleProvidingPackage(inv, '')).toBeUndefined();
      expect(bundleProvidingPackage({ assets: [] }, 'latex')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Runtime contract against the real generated dist/manifest.json.
// ---------------------------------------------------------------------------
const manifestJsonPath = fileURLToPath(new URL('../../dist/manifest.json', import.meta.url));
const present = existsSync(manifestJsonPath);
if (!present) {
  console.warn(
    `[manifest.test] dist/manifest.json not found at ${manifestJsonPath}; skipping the ` +
      'real-file manifest checks. Run `make artifacts STAGE=dist` (or gen-assets.mjs) to ' +
      'produce it. CI runs the runtime tests without dist/, so this skip is expected there.',
  );
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

describe('real dist/manifest.json (M4 item 4)', () => {
  it.runIf(present)('is a valid schemaVersion-2 integrity manifest', () => {
    const parsed: unknown = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    expect(isPlainObject(parsed)).toBe(true);
    const m = parsed as AssetsInventory;

    expect(m.schemaVersion).toBe(2);

    // texliveSnapshot: a real TL snapshot identity.
    expect(isPlainObject(m.texliveSnapshot)).toBe(true);
    expect(typeof m.texliveSnapshot?.release).toBe('string');
    expect(Number.isInteger(m.texliveSnapshot?.tlpdbRevision)).toBe(true);
    if (m.texliveSnapshot?.freeze !== undefined) {
      expect(m.texliveSnapshot.freeze).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // engines: the multicall program set, incl. the v1 engines.
    expect(Array.isArray(m.engines)).toBe(true);
    expect(m.engines).toContain('xetex');
    expect(m.engines).toContain('pdftex');
    expect(m.engines).toContain('bibtex8');

    // bundles: core + academic real tiers, texlive-basic alias, disjoint provides.
    expect(Array.isArray(m.bundles)).toBe(true);
    const byName = new Map((m.bundles ?? []).map((b) => [b.name, b]));
    const core = byName.get('core');
    const academic = byName.get('academic');
    const basic = byName.get('texlive-basic');
    expect(core).toBeDefined();
    expect(academic).toBeDefined();

    // core provides the LaTeX base; academic the journal + CJK working set.
    expect(core?.provides).toContain('latex');
    for (const pkg of ['siunitx', 'ctex', 'xecjk', 'pgf', 'fandol']) {
      expect(academic?.provides).toContain(pkg);
    }

    // Disjoint: no package appears in both tiers.
    const coreSet = new Set(core?.provides ?? []);
    const overlap = (academic?.provides ?? []).filter((p) => coreSet.has(p));
    expect(overlap).toEqual([]);

    // The alias is honestly marked, not a duplicate third tier.
    expect(basic?.aliasOf).toBe('core');
    expect(basic?.provides).toBeUndefined();

    // Real bundles carry files + bytes; the helper resolves against them.
    expect(core?.files).toContain('core.data');
    expect(typeof core?.bytes).toBe('number');
    expect(bundleProvidingPackage(m, 'siunitx')).toBe('academic');
    expect(bundleProvidingPackage(m, 'latex')).toBe('core');

    // The per-file inventory is still present and non-empty (unchanged from v1).
    expect(Array.isArray(m.assets)).toBe(true);
    expect(m.assets.length).toBeGreaterThan(0);
    pinManifestFields(m);
  });
});
