// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ---------------------------------------------------------------------------
// SHIPPED-manifest integrity check (DESIGN.md §7; M4 item 8). Verifies that the
// on-disk `dist/manifest.json` (schemaVersion 2) is INTERNALLY CONSISTENT with the
// artifacts it describes:
//
//   1. Every asset's recorded `{ bytes, sha256 }` matches the ACTUAL dist file
//      (byte length + a recomputed SHA-256 of the file's bytes). A truncated or
//      swapped payload is caught here — this is the release-integrity bar, not a
//      parse/shape check (the runtime unit tests cover parsing).
//   2. The per-bundle `provides` index is PRESENT (every non-alias bundle carries a
//      non-empty package-name list) and the tiers are DISJOINT (no package name is
//      claimed by two tiers — the one-file-one-hash / disjoint-tier invariant the
//      §5.4 resolution and the integrity manifest both rely on).
//   3. Alias bundles (`texlive-basic` -> `core`) carry `aliasOf` pointing at a real
//      bundle and NO independent provides/files (they are a byte-copy, not a tier).
//
// Complements `runtime/test/manifest.test.ts` (which checks the TYPES + parse
// contract + a shape check of the real file): THIS checks the shipped BYTES.
//
// Guarded like the corpus runner: if `dist/manifest.json` is absent (git-ignored,
// produced by `make artifacts`), it prints a message and reports a green SKIP.
// A file the manifest lists but that is absent on disk is a SKIP (a partial dist —
// e.g. core-only, no academic — is legitimate for the basic corpus); a file that
// is PRESENT but whose bytes/sha256 disagree is a hard FAIL.
//
// Usage:
//   node conformance/verify-manifest.mjs            # standalone (exit 0/1)
//   import { verifyManifest } from './verify-manifest.mjs'   # preflight in run.mjs
// `WASMTEX_DIST=/path` points it at a relocated dist (mirrors run.mjs).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Verify a dist's `manifest.json` against the bytes on disk plus the internal
 * provides/alias invariants. Pure (no process exit); returns a structured report.
 *
 * @param {string} distDir absolute path to the dist directory.
 * @returns {{ skipped: boolean, ok: boolean, reason?: string, checks: Array<{label:string,pass:boolean,detail:string}>, present: number, absent: string[] }}
 */
export function verifyManifest(distDir) {
  const manifestPath = join(distDir, 'manifest.json');
  const checks = [];
  const add = (label, pass, detail = '') => checks.push({ label, pass, detail });

  if (!existsSync(manifestPath)) {
    return { skipped: true, ok: true, reason: `no ${manifestPath}`, checks, present: 0, absent: [] };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    add('manifest.json parses', false, String(err));
    return { skipped: false, ok: false, checks, present: 0, absent: [] };
  }

  // -- top-level shape -------------------------------------------------------
  add('schemaVersion === 2', manifest.schemaVersion === 2, `got ${JSON.stringify(manifest.schemaVersion)}`);
  const assets = Array.isArray(manifest.assets) ? manifest.assets : null;
  add('assets is a non-empty array', assets != null && assets.length > 0, `got ${assets == null ? 'non-array' : assets.length}`);
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : null;
  add('bundles is a non-empty array', bundles != null && bundles.length > 0, `got ${bundles == null ? 'non-array' : bundles.length}`);

  // -- per-file bytes + sha256 (the integrity bar) ---------------------------
  const absent = [];
  let present = 0;
  for (const a of assets ?? []) {
    if (typeof a?.path !== 'string') {
      add('asset has a string path', false, JSON.stringify(a));
      continue;
    }
    const filePath = join(distDir, a.path);
    if (!existsSync(filePath)) {
      absent.push(a.path); // a partial dist (e.g. no academic) is legitimate — skip, do not fail
      continue;
    }
    present += 1;
    const buf = readFileSync(filePath);
    if (typeof a.bytes === 'number') {
      add(`bytes: ${a.path}`, buf.length === a.bytes, `on-disk ${buf.length} vs manifest ${a.bytes}`);
    } else {
      add(`bytes recorded: ${a.path}`, false, 'manifest omits bytes');
    }
    if (typeof a.sha256 === 'string') {
      const actual = sha256(buf);
      add(`sha256: ${a.path}`, actual === a.sha256, `on-disk ${actual.slice(0, 12)}… vs manifest ${String(a.sha256).slice(0, 12)}…`);
    } else {
      add(`sha256 recorded: ${a.path}`, false, 'manifest omits sha256');
    }
  }

  // -- bundles / provides: present, alias-correct, disjoint ------------------
  const names = new Set((bundles ?? []).map((b) => b?.name));
  const provideSets = []; // { name, set }
  for (const b of bundles ?? []) {
    if (typeof b?.name !== 'string') {
      add('bundle has a string name', false, JSON.stringify(b));
      continue;
    }
    if (b.aliasOf !== undefined) {
      // Alias bundle: points at a real canonical, carries no independent tier data.
      add(`alias ${b.name} -> ${b.aliasOf} exists`, names.has(b.aliasOf) && b.aliasOf !== b.name, `aliasOf=${JSON.stringify(b.aliasOf)}`);
      add(`alias ${b.name} carries no provides`, b.provides === undefined, `provides=${b.provides ? b.provides.length : 'absent'}`);
      continue;
    }
    // Real tier: a non-empty provides package-name list.
    const provides = Array.isArray(b.provides) ? b.provides : null;
    add(`provides present: ${b.name}`, provides != null && provides.length > 0, `got ${provides == null ? 'non-array' : provides.length}`);
    if (provides) provideSets.push({ name: b.name, set: new Set(provides.map((p) => String(p).toLowerCase())) });
  }

  // Pairwise disjointness across real tiers (case-insensitive).
  for (let i = 0; i < provideSets.length; i++) {
    for (let j = i + 1; j < provideSets.length; j++) {
      const a = provideSets[i];
      const b = provideSets[j];
      const overlap = [...a.set].filter((p) => b.set.has(p));
      add(`provides disjoint: ${a.name} ∩ ${b.name}`, overlap.length === 0, overlap.length ? `overlap(${overlap.length}): ${overlap.slice(0, 5).join(', ')}…` : '∅');
    }
  }

  const ok = checks.every((c) => c.pass);
  return { skipped: false, ok, checks, present, absent };
}

// ---------------------------------------------------------------------------
// Standalone entry point.
// ---------------------------------------------------------------------------
function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO = resolve(HERE, '..');
  const DIST = process.env.WASMTEX_DIST ? resolve(process.env.WASMTEX_DIST) : join(REPO, 'dist');
  const report = verifyManifest(DIST);

  if (report.skipped) {
    console.log(`[verify-manifest] ${report.reason} — skipping (green skip, like the corpus runner).`);
    process.exit(0);
  }

  const failed = report.checks.filter((c) => !c.pass);
  console.log(`[verify-manifest] dist/manifest.json: ${report.checks.length} checks, ${report.present} files verified, ${report.absent.length} listed-but-absent.`);
  if (report.absent.length > 0) console.log(`[verify-manifest] absent (partial dist, skipped): ${report.absent.join(', ')}`);
  for (const c of failed) console.log(`  FAIL: ${c.label} — ${c.detail}`);
  if (report.ok) {
    console.log('[verify-manifest] OK — every present file matches its recorded bytes+sha256; provides present + disjoint.');
    process.exit(0);
  }
  console.error(`[verify-manifest] FAILED: ${failed.length} inconsistency(ies).`);
  process.exit(1);
}
