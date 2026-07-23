#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only
//   node: builtins). No GPL/AGPL sources and no other WASM-TeX wrapper were
//   consulted; the resolution model is original.
//
// =============================================================================
// TIER RESOLVER + CLI (M4 item 2; docs/plans/M4.md)
// -----------------------------------------------------------------------------
// Turns the pinned `texlive.tlpdb` (parsed by tlpdb.mjs) and the committed tier
// definition (tiers.mjs) into a DISJOINT `file → tier` assignment plus per-tier
// package / provided-file indexes — the data items 3–7 consume.
//
// RESOLUTION MODEL
//   For each tier IN ORDER (core first):
//     1. Expand its roots (collections + extraPackages) to a package set by
//        following `depend` edges transitively (Collection/Scheme deps are just
//        more edges), skipping packages ALREADY claimed by an earlier tier and
//        guarding against cycles with a visited set.
//     2. That tier CLAIMS the newly-reached packages; their `runfiles` become
//        the tier's files. A file/package therefore belongs to the FIRST tier
//        whose roots reach it — so `academic` = its closure MINUS `core`.
//   Skipping already-claimed packages during traversal is provably correct: if a
//   package X is reachable from a later tier ONLY through an earlier-claimed node
//   Y, then Y reaches X, so the earlier tier (which reached Y) already claimed X.
//   Thus a package lands in a later tier iff it has a claim-free depend path from
//   that tier's roots — exactly the disjoint "first tier wins" rule.
//
//   Non-package depend targets are skipped (isNonPackageDepend): tlpdb config
//   directives ("revision/78233", "container_format/xz") carry a slash, and
//   arch metapackages ("kpathsea.ARCH") end in ".ARCH" and expand only to native
//   binary subpackages a WASM engine never installs.
//
// OUTPUTS (see resolveTiers' return typedef)
//   * fileToTier   Map<installedPath, tierName>  — the disjoint assignment.
//   * per tier     { tier, collections[], packages[], provides{}, counts } where
//                  `provides` maps package name → the .sty/.cls/.def basenames it
//                  ships (the package→provided-file index DESIGN §5.4 resolves
//                  `\usepackage{…}` / `\documentclass{…}` against).
//   * a human summary (per-tier counts + est. size, totals, disjointness).
//
// CLI
//   node resolve.mjs [--tlpdb PATH] [--json OUT]
//     --tlpdb PATH   texlive.tlpdb to read (default: $WASMTEX_TLPDB, else the
//                    pinned ISO-staged copy under ~/.cache/wasmtex).
//     --json OUT     also write the full resolution (fileToTier + per-tier
//                    indexes) as deterministic JSON to OUT.
//   Prints the summary; exits non-zero if the assignment is not disjoint or a
//   declared root does not exist in the tlpdb.
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BLOCK_SIZE, parseTlpdb } from './tlpdb.mjs';
import { TIERS } from './tiers.mjs';

/** File extensions whose basenames form the §5.4 provided-file index. */
const PROVIDE_EXTS = new Set(['.sty', '.cls', '.def']);

/** Output schema version for the `--json` resolution file. */
const JSON_SCHEMA_VERSION = 1;

// --- tiny output helpers (mirror build/manifest/gen-assets.mjs style) --------
function fail(msg) {
  console.error(`\n!! [resolve] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [resolve] ${msg}`);
}

const compareStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSort = (arr) => [...new Set(arr)].sort(compareStr);

/** Rebuild an object with keys in sorted order (deterministic JSON). */
function sortObjKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort(compareStr)) out[k] = obj[k];
  return out;
}

/**
 * Is this `depend` target NOT a real package edge? tlpdb config directives carry
 * a slash ("release/2026", "container_format/xz"); ".ARCH" is the arch
 * metapackage marker (expands only to native-binary subpackages). Both are
 * skipped during traversal — neither contributes runtime files.
 * @param {string} target
 * @returns {boolean}
 */
export function isNonPackageDepend(target) {
  return target.includes('/') || target.endsWith('.ARCH');
}

/**
 * @typedef {Object} TierResolution
 * @property {string} tier
 * @property {string[]} collections        declared Collection roots (sorted).
 * @property {string[]} packages           content packages claimed by this tier (sorted).
 * @property {Record<string,string[]>} provides  package → sorted .sty/.cls/.def basenames it ships.
 * @property {number} fileCount            distinct installed files claimed by this tier.
 * @property {number} sizeBlocks           Σ runfiles block counts of this tier's packages.
 * @property {number} estBytes             sizeBlocks × 4096 (conservative upper bound).
 * @property {string[]} unresolved         declared/reached targets absent from the tlpdb (should be empty).
 */

/**
 * @typedef {Object} Resolution
 * @property {number|null} tlpdbRevision   TL snapshot revision (from 00texlive.config), or null.
 * @property {number} packageCount         total stanzas in the tlpdb.
 * @property {TierResolution[]} tiers       per-tier results, in tier order.
 * @property {Map<string,string>} fileToTier  installed path → tier name (disjoint).
 * @property {{files:number,sizeBlocks:number,estBytes:number}} totals
 * @property {Array<{file:string,firstTier:string,secondTier:string,pkg:string}>} violations
 *           cross-tier file collisions (empty ⇔ disjoint).
 * @property {string[]} unresolved          union of all tiers' unresolved targets.
 */

/**
 * Resolve a tier definition against a parsed tlpdb.
 * Pure: no I/O, no throw on data problems — violations/unresolved are RETURNED
 * so callers (CLI, tests) decide how loud to be.
 *
 * @param {Map<string, import('./tlpdb.mjs').TlpdbPackage>} db  parsed tlpdb.
 * @param {ReadonlyArray<import('./tiers.mjs').TierDef>} [tiers]  defaults to TIERS.
 * @returns {Resolution}
 */
export function resolveTiers(db, tiers = TIERS) {
  const claimed = new Set(); // package names claimed by ANY earlier-or-current tier
  const fileToTier = new Map(); // installed path -> tier name (first wins)
  const violations = [];
  const unresolvedAll = new Set();
  /** @type {TierResolution[]} */
  const tierResults = [];

  for (const tier of tiers) {
    const local = new Set(); // packages newly claimed by THIS tier
    const unresolved = new Set();

    // Iterative DFS with a cycle/dup guard (claimed = earlier tiers; local = this
    // tier's visited). tlpdb dependency graphs contain cycles (collections depend
    // on collection-basic which is reachable many ways), so the guard is required.
    const stack = [...tier.collections, ...tier.extraPackages];
    while (stack.length > 0) {
      const n = stack.pop();
      if (claimed.has(n) || local.has(n)) continue;
      const pkg = db.get(n);
      if (pkg === undefined) {
        // A real depend target we cannot resolve. Config directives / arch metas
        // are filtered before push, so anything landing here is genuinely absent.
        unresolved.add(n);
        continue;
      }
      local.add(n);
      for (const dep of pkg.depends) {
        if (!isNonPackageDepend(dep)) stack.push(dep);
      }
    }
    for (const n of local) claimed.add(n);

    // Collect this tier's content packages, files, sizes, and provided files.
    const packages = [];
    /** @type {Record<string,string[]>} */
    const provides = {};
    let sizeBlocks = 0;
    let fileCount = 0;

    for (const n of local) {
      const pkg = db.get(n);
      // Collections/Schemes are pure dependency nodes (no runfiles) — skip them
      // from `packages`; they are represented by the tier's `collections` field.
      if (pkg.category === 'Collection' || pkg.category === 'Scheme') continue;
      packages.push(n);
      sizeBlocks += pkg.runsizeBlocks;

      for (const file of pkg.runfiles) {
        const existing = fileToTier.get(file);
        let owner;
        if (existing === undefined) {
          fileToTier.set(file, tier.name);
          fileCount += 1;
          owner = tier.name;
        } else {
          owner = existing;
          if (existing !== tier.name) {
            // Two packages in DIFFERENT tiers ship the same installed path — a
            // real disjointness violation (breaks the one-file-one-hash manifest).
            violations.push({ file, firstTier: existing, secondTier: tier.name, pkg: n });
          }
          // Same-tier duplicate (two packages, one tier, same path): deduped by
          // the Map; not counted again.
        }
        // Only index a provided file under the tier that actually OWNS it.
        if (owner === tier.name) {
          const base = file.slice(file.lastIndexOf('/') + 1);
          const dot = base.lastIndexOf('.');
          if (dot > 0 && PROVIDE_EXTS.has(base.slice(dot))) {
            (provides[n] ??= []).push(base);
          }
        }
      }
    }

    for (const k of Object.keys(provides)) provides[k] = uniqSort(provides[k]);

    tierResults.push({
      tier: tier.name,
      collections: [...tier.collections].sort(compareStr),
      packages: packages.sort(compareStr),
      provides: sortObjKeys(provides),
      fileCount,
      sizeBlocks,
      estBytes: sizeBlocks * BLOCK_SIZE,
      unresolved: [...unresolved].sort(compareStr),
    });
    for (const u of unresolved) unresolvedAll.add(u);
  }

  const totalBlocks = tierResults.reduce((s, t) => s + t.sizeBlocks, 0);

  return {
    tlpdbRevision: extractRevision(db),
    packageCount: db.size,
    tiers: tierResults,
    fileToTier,
    totals: { files: fileToTier.size, sizeBlocks: totalBlocks, estBytes: totalBlocks * BLOCK_SIZE },
    violations,
    unresolved: [...unresolvedAll].sort(compareStr),
  };
}

/**
 * The TL snapshot revision, read from `00texlive.config`'s `depend revision/N`.
 * @param {Map<string, import('./tlpdb.mjs').TlpdbPackage>} db
 * @returns {number|null}
 */
export function extractRevision(db) {
  const cfg = db.get('00texlive.config');
  if (!cfg) return null;
  for (const dep of cfg.depends) {
    const m = /^revision\/(\d+)$/.exec(dep);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

/**
 * The TL RELEASE year, read from `00texlive.config`'s `depend release/YYYY` — the
 * release number "as used in the installer" (its own longdesc). This is the TL
 * snapshot's self-declared release (e.g. "2026"), the authoritative in-tlpdb
 * counterpart to the pinned `[texlive-*-2026]` id; the manifest carries it in
 * `texliveSnapshot`. Returned as a STRING (a release id, not an arithmetic
 * quantity — kept verbatim so a hypothetical non-numeric TL release survives).
 * @param {Map<string, import('./tlpdb.mjs').TlpdbPackage>} db
 * @returns {string|null}
 */
export function extractRelease(db) {
  const cfg = db.get('00texlive.config');
  if (!cfg) return null;
  for (const dep of cfg.depends) {
    const m = /^release\/(.+)$/.exec(dep);
    if (m) return m[1];
  }
  return null;
}

const MiB = 1024 * 1024;
const fmtMiB = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`;

/**
 * Render a {@link Resolution} as a human summary block (counts per tier, totals,
 * and the disjointness assertion).
 * @param {Resolution} r
 * @returns {string}
 */
export function formatSummary(r) {
  // Fixed column widths (tier left-aligned, numeric columns right-aligned).
  const W = { tier: 10, collections: 12, packages: 10, files: 9, size: 13 };
  const row = (a, b, c, d, e) =>
    `  ${String(a).padEnd(W.tier)}${String(b).padStart(W.collections)}` +
    `${String(c).padStart(W.packages)}${String(d).padStart(W.files)}${String(e).padStart(W.size)}`;

  const lines = [];
  lines.push(
    `tlpdb: ${r.packageCount} packages` +
      (r.tlpdbRevision !== null ? `, revision ${r.tlpdbRevision}` : ''),
  );
  lines.push('');
  lines.push(row('tier', 'collections', 'packages', 'files', 'est.size'));
  lines.push(row('-'.repeat(W.tier), '-'.repeat(W.collections - 2), '-'.repeat(W.packages - 2), '-'.repeat(W.files - 2), '-'.repeat(W.size - 2)));
  for (const t of r.tiers) {
    lines.push(row(t.tier, t.collections.length, t.packages.length, t.fileCount, `~${fmtMiB(t.estBytes)}`));
  }
  lines.push('');
  lines.push(`  total files: ${r.totals.files}    est. size: ~${fmtMiB(r.totals.estBytes)} (tlpdb blocks x 4096; upper bound)`);
  const disjoint = r.violations.length === 0;
  lines.push(`  disjoint: ${disjoint ? 'YES' : `NO -- ${r.violations.length} cross-tier collision(s)`} (assertion: no file in two tiers)`);
  lines.push(`  unresolved roots/deps: ${r.unresolved.length === 0 ? '(none)' : r.unresolved.join(', ')}`);
  return lines.join('\n');
}

/**
 * Serialize a {@link Resolution} to a deterministic JSON string (sorted keys /
 * file paths). This is the machine artifact items 3–4 consume.
 * @param {Resolution} r
 * @returns {string}
 */
export function toJson(r) {
  const fileToTier = {};
  for (const path of [...r.fileToTier.keys()].sort(compareStr)) {
    fileToTier[path] = r.fileToTier.get(path);
  }
  const doc = {
    schemaVersion: JSON_SCHEMA_VERSION,
    tlpdb: { revision: r.tlpdbRevision, packageCount: r.packageCount },
    totals: r.totals,
    tiers: r.tiers.map((t) => ({
      tier: t.tier,
      collections: t.collections,
      packages: t.packages,
      provides: t.provides,
      fileCount: t.fileCount,
      sizeBlocks: t.sizeBlocks,
      estBytes: t.estBytes,
    })),
    fileToTier,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// --- default tlpdb location --------------------------------------------------
/**
 * Where the pinned tlpdb lives: $WASMTEX_TLPDB wins; otherwise the ISO-staged
 * copy the native build unpacks under the user cache.
 * @returns {string}
 */
export function defaultTlpdbPath() {
  if (process.env.WASMTEX_TLPDB && process.env.WASMTEX_TLPDB.trim() !== '') {
    return process.env.WASMTEX_TLPDB.trim();
  }
  return `${homedir()}/.cache/wasmtex/build/native/busytex-2026/source/texmfrepo/tlpkg/texlive.tlpdb`;
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { tlpdb: defaultTlpdbPath(), json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tlpdb') opts.tlpdb = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node resolve.mjs [--tlpdb PATH] [--json OUT]');
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.tlpdb)) {
    fail(
      `tlpdb not found: ${opts.tlpdb}\n` +
        '   Set --tlpdb PATH or $WASMTEX_TLPDB. The pinned copy is ISO-staged by ' +
        'the native build under ~/.cache/wasmtex/build/native/…/tlpkg/texlive.tlpdb.',
    );
  }
  note(`tlpdb: ${opts.tlpdb}`);
  const db = parseTlpdb(readFileSync(opts.tlpdb, 'utf8'));
  const r = resolveTiers(db);

  console.log('');
  console.log(formatSummary(r));
  console.log('');

  if (r.unresolved.length > 0) {
    fail(`${r.unresolved.length} declared/reached target(s) absent from the tlpdb: ${r.unresolved.join(', ')}`);
  }
  if (r.violations.length > 0) {
    for (const v of r.violations.slice(0, 10)) {
      console.error(`   collision: ${v.file} in both ${v.firstTier} and ${v.secondTier} (via ${v.pkg})`);
    }
    fail(`assignment is NOT disjoint: ${r.violations.length} cross-tier file collision(s)`);
  }

  if (opts.json) {
    writeFileSync(opts.json, toJson(r));
    note(`wrote ${opts.json}`);
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
