#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only node:
//   builtins). The INPUTS it reads are OUR OWN artifacts — dist/manifest.json (the
//   gen-assets integrity manifest) and build/budgets.json — so it consults no
//   third-party code. No GPL/AGPL source and no other WASM-TeX wrapper was read;
//   the budget model is original.
//
// =============================================================================
// ASSET SIZE-BUDGET CHECKER (M5 item 5, DESIGN.md §8)
// -----------------------------------------------------------------------------
// DESIGN §8 requires the engine wasm and core-bundle sizes to be "tracked with an
// explicit budget file; CI flags growth". This is that check, made FAIL-CLOSED and
// wired into the dist stage of both build drivers (build/artifacts/*.sh), exactly
// where the shipped-aggregate license audit runs (M5 item 2) — so an over-budget
// build fails at assembly, in the container, with no CI-workflow edit.
//
// It reads the per-file `bytes` already recorded in dist/manifest.json (the single
// source of truth the runtime and hosts verify against — it is NOT re-stat'd here,
// so the budget is measured against exactly what ships) and compares each BUDGETED
// asset against build/budgets.json's byte ceiling. The PRELOAD path (engine wasm +
// core bundle) is budgeted strictly (cold-start cost); the on-demand academic tier
// loosely. See build/budgets.json's `_rationale` for the why.
//
// THREE OUTCOMES per manifest asset:
//   * BUDGETED + present  -> compared. `bytes` strictly greater than `maxBytes`
//     is a FAILURE (the build aborts, naming the asset, actual vs budget).
//   * BUDGETED + absent    -> a NOTE (a core-only dist, or a dropped tier/alias:
//     a budget for an absent asset is vacuously satisfied, never a size failure).
//   * UNBUDGETED           -> allowed. But an unbudgeted asset LARGER than
//     `unbudgetedWarnBytes` is WARNED (not failed) UNLESS it is byte-identical
//     (equal sha256) to a budgeted asset — i.e. a back-compat alias like
//     texlive-basic.* copying core.* — whose bytes are already budgeted. The
//     warning is the safety net: a NEW large artifact cannot ship unbudgeted
//     unnoticed. Warnings never change the exit code.
//
// The checker is a PURE function of (manifest, budgets); the CLI is a thin shell
// (readable table + a documented --json). Determinism: sorted throughout, no
// timestamps, so re-running on an unchanged manifest is byte-identical.
//
// CLI
//   node check-sizes.mjs [--manifest PATH] [--budgets PATH] [--json] [--quiet]
//     --manifest PATH  dist/manifest.json to read (default: <repo>/dist/manifest.json).
//     --budgets  PATH  the budget file       (default: <repo>/build/budgets.json).
//     --json           emit the machine-readable report to stdout (suppresses the
//                      table); the exit code still reflects pass/fail.
//     --quiet          suppress the human table (still exits non-zero on breach).
//   Exits 1 if any budgeted asset exceeds its ceiling (or on a missing/invalid
//   manifest or budget file); 0 otherwise. Warnings alone do not fail.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Decimal megabyte (matches the manifest/budgets convention: 1 MB = 1e6 bytes). */
export const MB = 1_000_000;
/** Default unbudgeted-large warn threshold when budgets.json omits one. */
export const DEFAULT_WARN_BYTES = 5_000_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

const compareStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Format a byte count as a decimal-MB string, e.g. `27.51 MB`. */
export function formatMB(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Budget-document parsing + validation. Kept separate from file I/O so tests can
// exercise the shape rules on in-memory objects.
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Budget
 * @property {number} maxBytes  exact byte ceiling (positive integer).
 * @property {string} tier      informational ("preload" | "on-demand" | ...).
 * @property {string} note      human rationale (may be empty).
 */

/**
 * Validate + normalise a parsed budgets.json document.
 * @param {any} doc  the JSON.parse of build/budgets.json.
 * @returns {{ budgets: Map<string, Budget>, warnBytes: number }}
 * @throws {Error} on any shape violation (fail-closed: a malformed budget file
 *   must abort, never silently degrade to "nothing budgeted").
 */
export function parseBudgets(doc) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('budgets: top level must be a JSON object');
  }
  if (typeof doc.budgets !== 'object' || doc.budgets === null || Array.isArray(doc.budgets)) {
    throw new Error('budgets: missing/invalid `budgets` object (map of asset path -> { maxBytes })');
  }

  let warnBytes = DEFAULT_WARN_BYTES;
  if (doc.unbudgetedWarnBytes !== undefined) {
    const w = doc.unbudgetedWarnBytes;
    if (!Number.isInteger(w) || w < 0) {
      throw new Error(`budgets: unbudgetedWarnBytes must be a non-negative integer (got ${JSON.stringify(w)})`);
    }
    warnBytes = w;
  }

  const budgets = new Map();
  for (const [path, raw] of Object.entries(doc.budgets)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`budgets["${path}"]: entry must be an object { maxBytes, tier?, note? }`);
    }
    const { maxBytes } = raw;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`budgets["${path}"]: maxBytes must be a positive integer (got ${JSON.stringify(maxBytes)})`);
    }
    budgets.set(path, {
      maxBytes,
      tier: typeof raw.tier === 'string' ? raw.tier : '',
      note: typeof raw.note === 'string' ? raw.note : '',
    });
  }
  return { budgets, warnBytes };
}

// ---------------------------------------------------------------------------
// The core check. Pure: (manifest, parsedBudgets) -> a structured result.
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} CheckedAsset
 * @property {string} path
 * @property {string} role
 * @property {number} bytes
 * @property {number} maxBytes
 * @property {string} tier
 * @property {string} note
 * @property {boolean} over          bytes > maxBytes.
 * @property {number} headroomBytes  maxBytes - bytes (negative when over).
 * @property {number} usedFraction   bytes / maxBytes.
 */

/**
 * Compare a manifest's assets against the parsed budgets.
 * @param {any} manifest  the parsed dist/manifest.json (needs an `assets` array).
 * @param {{ budgets: Map<string, Budget>, warnBytes: number }} parsed
 * @returns {{
 *   ok: boolean,
 *   checked: CheckedAsset[],
 *   failures: CheckedAsset[],
 *   absent: Array<{ path: string, maxBytes: number, tier: string }>,
 *   warnings: Array<{ path: string, role: string, bytes: number }>,
 *   unbudgeted: Array<{ path: string, role: string, bytes: number, duplicateOf: string|null }>,
 *   warnBytes: number,
 * }}
 */
export function checkSizes(manifest, parsed) {
  if (typeof manifest !== 'object' || manifest === null || !Array.isArray(manifest.assets)) {
    throw new Error('manifest: missing/invalid `assets` array (is this a gen-assets manifest.json?)');
  }
  const { budgets, warnBytes } = parsed;

  // Index the manifest assets by path; validate the fields we depend on.
  const assetByPath = new Map();
  for (const a of manifest.assets) {
    if (typeof a.path !== 'string' || !Number.isFinite(a.bytes)) {
      throw new Error(`manifest: asset entry missing path/bytes: ${JSON.stringify(a)}`);
    }
    assetByPath.set(a.path, a);
  }

  // sha256 of every BUDGETED asset that is present — used to recognise a
  // byte-identical duplicate (an alias) so it is not warned as "unbudgeted large".
  const budgetedSha = new Map(); // sha256 -> budgeted path
  for (const path of budgets.keys()) {
    const a = assetByPath.get(path);
    if (a && typeof a.sha256 === 'string' && a.sha256 !== '') budgetedSha.set(a.sha256, path);
  }

  const checked = [];
  const absent = [];
  for (const [path, b] of budgets) {
    const a = assetByPath.get(path);
    if (a === undefined) {
      absent.push({ path, maxBytes: b.maxBytes, tier: b.tier });
      continue;
    }
    const bytes = a.bytes;
    checked.push({
      path,
      role: typeof a.role === 'string' ? a.role : '',
      bytes,
      maxBytes: b.maxBytes,
      tier: b.tier,
      note: b.note,
      over: bytes > b.maxBytes,
      headroomBytes: b.maxBytes - bytes,
      usedFraction: bytes / b.maxBytes,
    });
  }
  checked.sort((x, y) => compareStr(x.path, y.path));
  absent.sort((x, y) => compareStr(x.path, y.path));

  const warnings = [];
  const unbudgeted = [];
  for (const a of manifest.assets) {
    if (budgets.has(a.path)) continue; // enforced above.
    const dupOf =
      typeof a.sha256 === 'string' && budgetedSha.has(a.sha256) ? budgetedSha.get(a.sha256) : null;
    unbudgeted.push({ path: a.path, role: typeof a.role === 'string' ? a.role : '', bytes: a.bytes, duplicateOf: dupOf });
    // Warn on a genuinely-new large artifact: over the threshold AND not merely a
    // byte-identical copy of something already budgeted.
    if (a.bytes > warnBytes && dupOf === null) {
      warnings.push({ path: a.path, role: typeof a.role === 'string' ? a.role : '', bytes: a.bytes });
    }
  }
  unbudgeted.sort((x, y) => compareStr(x.path, y.path));
  warnings.sort((x, y) => compareStr(x.path, y.path));

  const failures = checked.filter((c) => c.over);
  return { ok: failures.length === 0, checked, failures, absent, warnings, unbudgeted, warnBytes };
}

// ---------------------------------------------------------------------------
// Deterministic machine-readable report (--json).
// ---------------------------------------------------------------------------
export function buildJsonReport(result) {
  return {
    ok: result.ok,
    warnBytes: result.warnBytes,
    checked: result.checked.map((c) => ({
      path: c.path,
      role: c.role,
      tier: c.tier,
      bytes: c.bytes,
      maxBytes: c.maxBytes,
      over: c.over,
      headroomBytes: c.headroomBytes,
      usedPercent: Math.round(c.usedFraction * 1000) / 10,
    })),
    failures: result.failures.map((c) => ({ path: c.path, bytes: c.bytes, maxBytes: c.maxBytes, overBy: c.bytes - c.maxBytes })),
    absent: result.absent.map((a) => ({ path: a.path, maxBytes: a.maxBytes })),
    warnings: result.warnings.map((w) => ({ path: w.path, bytes: w.bytes })),
    unbudgeted: result.unbudgeted.map((u) => ({ path: u.path, bytes: u.bytes, duplicateOf: u.duplicateOf })),
  };
}

// ---------------------------------------------------------------------------
// Human-readable size table. Deterministic; quotable into a build log.
// ---------------------------------------------------------------------------
export function formatTable(result) {
  const lines = [];
  const rows = result.checked.map((c) => ({
    asset: c.path,
    tier: c.tier || '-',
    size: formatMB(c.bytes),
    budget: formatMB(c.maxBytes),
    used: `${(c.usedFraction * 100).toFixed(1)}%`,
    headroom: `${c.headroomBytes >= 0 ? '' : '-'}${formatMB(Math.abs(c.headroomBytes))}`,
    status: c.over ? 'OVER' : 'OK',
  }));

  if (rows.length === 0) {
    lines.push('  (no budgeted asset is present in the manifest)');
  } else {
    const cols = ['asset', 'tier', 'size', 'budget', 'used', 'headroom', 'status'];
    const head = { asset: 'asset', tier: 'tier', size: 'size', budget: 'budget', used: 'used', headroom: 'headroom', status: 'status' };
    const width = {};
    for (const k of cols) width[k] = Math.max(head[k].length, ...rows.map((r) => r[k].length));
    // Left-align the label column, right-align the numeric/status columns.
    const rightAligned = new Set(['size', 'budget', 'used', 'headroom', 'status']);
    const fmtRow = (r) =>
      '  ' + cols.map((k) => (rightAligned.has(k) ? r[k].padStart(width[k]) : r[k].padEnd(width[k]))).join('  ');
    lines.push(fmtRow(head));
    lines.push('  ' + cols.map((k) => '-'.repeat(width[k])).join('  '));
    for (const r of rows) lines.push(fmtRow(r));
  }

  if (result.absent.length > 0) {
    lines.push('');
    lines.push(`  budgeted but ABSENT from this dist (not a failure — vacuously satisfied): ${result.absent.map((a) => a.path).join(', ')}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    for (const w of result.warnings) {
      lines.push(`  WARN: unbudgeted asset ${w.path} is ${formatMB(w.bytes)} (> ${formatMB(result.warnBytes)}); add a build/budgets.json entry.`);
    }
  }
  // Duplicates of budgeted assets are informational (their bytes are already budgeted).
  const dups = result.unbudgeted.filter((u) => u.duplicateOf !== null);
  if (dups.length > 0) {
    lines.push('');
    lines.push(`  note: ${dups.length} unbudgeted asset(s) are byte-identical to a budgeted asset (already covered): ${dups.map((u) => `${u.path}=${u.duplicateOf}`).join(', ')}`);
  }

  lines.push('');
  if (result.ok) {
    lines.push(`  BUDGET OK — ${result.checked.length} asset(s) within budget.`);
  } else {
    lines.push(`  BUDGET FAIL — ${result.failures.length} asset(s) over budget:`);
    for (const f of result.failures) {
      lines.push(`      ${f.path}: ${formatMB(f.bytes)} exceeds budget ${formatMB(f.maxBytes)} (over by ${formatMB(f.bytes - f.maxBytes)})`);
    }
  }
  return lines.join('\n');
}

// --- file I/O (thin; used by the CLI, not the pure core) ---------------------
function readJson(path, what) {
  if (!existsSync(path)) {
    throw new Error(`${what} not found: ${path}`);
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`${what} unreadable (${path}): ${e && e.message ? e.message : e}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${e && e.message ? e.message : e}`);
  }
}

/** Read + validate build/budgets.json from disk (throws on missing/invalid). */
export function readBudgetsFile(path) {
  return parseBudgets(readJson(path, 'budgets file'));
}
/** Read dist/manifest.json from disk (throws on missing/invalid JSON). */
export function readManifestFile(path) {
  return readJson(path, 'manifest');
}

// --- CLI ---------------------------------------------------------------------
function fail(msg) {
  console.error(`\n!! [check-sizes] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [check-sizes] ${msg}`);
}

function parseArgs(argv) {
  const opts = {
    manifest: join(repoRoot, 'dist', 'manifest.json'),
    budgets: join(repoRoot, 'build', 'budgets.json'),
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--budgets') opts.budgets = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node check-sizes.mjs [--manifest PATH] [--budgets PATH] [--json] [--quiet]');
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let parsedBudgets;
  let manifest;
  try {
    parsedBudgets = readBudgetsFile(opts.budgets);
  } catch (e) {
    fail(e.message);
  }
  try {
    manifest = readManifestFile(opts.manifest);
  } catch (e) {
    fail(
      `${e.message}\n` +
        '   The size check reads the dist inventory produced by gen-assets — run it after ' +
        '`make artifacts STAGE=dist` (or point --manifest at a built dist/manifest.json).',
    );
  }

  let result;
  try {
    result = checkSizes(manifest, parsedBudgets);
  } catch (e) {
    fail(e.message);
  }

  if (opts.json) {
    console.log(`${JSON.stringify(buildJsonReport(result), null, 2)}`);
  } else if (!opts.quiet) {
    note(`manifest: ${opts.manifest}`);
    note(`budgets:  ${opts.budgets} (warn threshold ${formatMB(result.warnBytes)})`);
    console.log('');
    console.log(formatTable(result));
    console.log('');
  }

  if (!result.ok) {
    fail(
      `${result.failures.length} asset(s) exceed their size budget: ` +
        `${result.failures.map((f) => f.path).join(', ')}. ` +
        'The budget is fail-closed: shrink the artifact, or raise the ceiling in build/budgets.json ' +
        'with a recorded justification (DESIGN.md §8).',
    );
  }
  if (result.warnings.length > 0 && !opts.json) {
    note(`${result.warnings.length} unbudgeted large asset(s) warned (see above) — not a failure.`);
  }
  if (!opts.json) note(`size budgets PASS — ${result.checked.length} asset(s) within budget.`);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
