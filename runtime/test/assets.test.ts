// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Schema ↔ type contract for the data-driven asset inventory (M1 item 4). The
// generator `build/manifest/gen-assets.mjs` (schemaVersion 1) OWNS the
// `dist/assets.json` schema; `runtime/src/protocol.ts` only CARRIES it in the
// init message. This test pins the two together from both ends:
//
//   * Compile-time (runs under `npm run typecheck`, dist-INDEPENDENT): a
//     `satisfies` witness plus the field-precision pins below. Because the
//     protocol types carry index signatures, the witness alone would silently
//     absorb a dropped field (no excess-property checking through an index
//     signature) — it still catches a narrowed `AssetRole` (named property
//     beats index signature). The DROPPED-field guarantee comes from
//     `pinInventoryFields`/`pinEntryFields`, which fail to compile if
//     `schemaVersion`/`generated`/entry fields leave the protocol types.
//   * Runtime (skips cleanly when dist/ is absent — CI has no dist/): the REAL
//     generated file is read and asserted to match that shape, so the witness
//     can never silently diverge from what the generator actually emits.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AssetEntry, AssetRole, AssetsInventory } from '../src/protocol';

// ---------------------------------------------------------------------------
// Compile-time witnesses (dist-independent). `satisfies` runs excess-property
// checking on these literals, so they compile ONLY if the protocol types accept
// the generator's schemaVersion-1 shape verbatim. Values are illustrative — a
// type pin, not a snapshot of dist/ (the runtime block below checks real data).
// ---------------------------------------------------------------------------
const SCHEMA_WITNESS = {
  schemaVersion: 1,
  generated: '2026-06-16T14:06:37.000Z',
  assets: [
    {
      path: 'SHA256SUMS',
      bytes: 1213,
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      role: 'checksums',
    },
    {
      path: 'busytex.wasm',
      bytes: 30366631,
      sha256: '1111111111111111111111111111111111111111111111111111111111111111',
      role: 'engine-wasm',
    },
  ],
} satisfies AssetsInventory;

const ENTRY_WITNESS = {
  path: 'texlive-basic.data',
  bytes: 79503467,
  sha256: '2222222222222222222222222222222222222222222222222222222222222222',
  role: 'bundle-data',
} satisfies AssetEntry;

// Field-precision pins: reading these fields off an AssetsInventory / AssetEntry
// must keep their DECLARED types (not collapse to the forward-compat index
// signature's `unknown`). Removing an explicit field from the protocol would
// break these return-type annotations.
function pinInventoryFields(
  inv: AssetsInventory,
): [number | undefined, string | undefined, number] {
  return [inv.schemaVersion, inv.generated, inv.assets.length];
}
function pinEntryFields(
  e: AssetEntry,
): [string, number | undefined, string | undefined, AssetRole | undefined] {
  return [e.path, e.bytes, e.sha256, e.role];
}

// ---------------------------------------------------------------------------
// Runtime contract against the real generated file.
// ---------------------------------------------------------------------------

// The six roles the generator emits (build/manifest/gen-assets.mjs ROLE TABLE).
// (glue-pipeline / glue-worker were retired at M2 item 3 when the vendored
// busytex glue was dropped from dist/.)
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'engine-wasm',
  'engine-js',
  'format',
  'bundle-js',
  'bundle-data',
  'checksums',
]);

// dist/ lives at the repo root; this file is runtime/test/, i.e. two levels down.
const assetsJsonPath = fileURLToPath(new URL('../../dist/assets.json', import.meta.url));
const present = existsSync(assetsJsonPath);
if (!present) {
  console.warn(
    `[assets.test] dist/assets.json not found at ${assetsJsonPath}; skipping the ` +
      'real-file inventory checks. Run `make artifacts STAGE=dist` to produce it. ' +
      'CI runs the runtime tests without dist/, so this skip is expected there — ' +
      'the compile-time schema witness above still runs under `npm run typecheck`.',
  );
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

describe('assets.json <-> protocol schema (M1 item 4)', () => {
  it('pins the generator schema against the protocol types (compile-time)', () => {
    // Touch the witnesses so `noUnusedLocals` is satisfied and they are part of
    // the build. Their real force is the `satisfies` checks above — this body
    // just proves the field-precision pins read the declared types back.
    const [schemaVersion, generated, count] = pinInventoryFields(SCHEMA_WITNESS);
    expect(schemaVersion).toBe(1);
    expect(typeof generated).toBe('string');
    expect(count).toBe(SCHEMA_WITNESS.assets.length);

    const [path, bytes] = pinEntryFields(ENTRY_WITNESS);
    expect(path).toBe('texlive-basic.data');
    expect(bytes).toBe(79503467);
  });

  it.runIf(present)(
    'the real generated dist/assets.json is a valid AssetsInventory',
    () => {
      const parsed: unknown = JSON.parse(readFileSync(assetsJsonPath, 'utf8'));
      expect(isPlainObject(parsed)).toBe(true);

      // The narrowing this cast asserts is exactly what the compile-time witness
      // pins; the assertions below prove the real bytes honor it.
      const inv = parsed as AssetsInventory;

      expect(inv.schemaVersion).toBe(1);

      if (inv.generated !== undefined) {
        expect(typeof inv.generated).toBe('string');
        // A well-formed, canonical ISO 8601 stamp (round-trips through Date).
        expect(new Date(inv.generated).toISOString()).toBe(inv.generated);
      }

      expect(Array.isArray(inv.assets)).toBe(true);
      expect(inv.assets.length).toBeGreaterThan(0);

      const paths = inv.assets.map((a) => a.path);
      // Deterministic output: sorted ascending (byte order) and unique.
      const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(paths).toEqual(sorted);
      expect(new Set(paths).size).toBe(paths.length);

      for (const a of inv.assets) {
        expect(typeof a.path).toBe('string');
        expect(a.path.length).toBeGreaterThan(0);
        expect(Number.isInteger(a.bytes)).toBe(true);
        expect(a.bytes ?? -1).toBeGreaterThanOrEqual(0);
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(KNOWN_ROLES.has(String(a.role))).toBe(true);
        pinEntryFields(a); // exercise the precision pins on real data
      }

      // Structural sanity that must hold for any built dist/: exactly one
      // multicall engine (wasm + its js loader) and at least one format dump.
      const countRole = (r: AssetRole) =>
        inv.assets.filter((a) => a.role === r).length;
      expect(countRole('engine-wasm')).toBe(1);
      expect(countRole('engine-js')).toBe(1);
      expect(countRole('format')).toBeGreaterThanOrEqual(1);

      pinInventoryFields(inv);
    },
  );
});
