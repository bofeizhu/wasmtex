#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (node:
//   builtins + the sibling tlpdb parser / tier resolver / exceptions table). The
//   INPUT it reads is TeX Live's own package database (`catalogue-license` fields)
//   plus LICENSE.TL — metadata/data, not third-party CODE, so parsing it copies no
//   third-party source. No GPL/AGPL sources and no other WASM-TeX wrapper were
//   consulted; the allowlist + audit model is original.
//
// =============================================================================
// SHIPPED-AGGREGATE LICENSE ENUMERATION + FAIL-CLOSED AUDIT (M5 item 2)
// -----------------------------------------------------------------------------
// This is the LEGALLY load-bearing check behind the DESIGN.md §1/§7 statement
// that the WasmTeX release artifacts are "an aggregate distribution of TeX Live
// programs ... each carried under its own FREE license". It answers two questions
// about exactly what `core` + `academic` actually ship:
//
//   1. ENUMERATE — for every SHIPPED package, its `catalogue-license` value, as a
//      machine-readable inventory (per-tier package→license, plus aggregate
//      license→packages). Emitted to `--json OUT` (the release carries it as
//      `dist/licenses.json`), and summarised for THIRD_PARTY_NOTICES.md.
//
//   2. AUDIT (fail-closed) — FAIL if any shipped package's license is missing,
//      empty, `noinfo`/`nosource`/`nonfree`, or contains any token NOT on the
//      explicit free ALLOWLIST. The audit never guesses: an unresolvable license
//      FAILS and NAMES the package(s) so a human resolves each before release
//      (M5 risks). Catalogue GAPS in TeX-Live-proper support packages are resolved
//      by the cited `license-exceptions.mjs` table (backed by LICENSE.TL); any
//      package neither catalogued nor excepted FAILS.
//
// WHAT COUNTS AS "SHIPPED" (the collections/schemes caveat, handled correctly)
//   A package is SHIPPED iff it OWNS >=1 runfile in its tier (i.e. contributes
//   >=1 real installed file to that bundle). This precisely excludes:
//     * Collections/Schemes — pure dependency nodes, no runfiles (already dropped
//       from `resolution.tiers[].packages` by the resolver);
//     * doc-only / binary-only packages (their docfiles/binfiles are dropped by
//       the WASM build, leaving 0 runfiles) — e.g. `luahbtex`, the `*-zh-cn`
//       manuals — which contribute nothing to the bundle and carry no
//       distribution obligation here.
//   So the audit judges exactly the packages whose files a user actually receives.
//
// LICENSE VALUES ARE SPACE-SEPARATED LISTS. A `catalogue-license` value may name
// several licenses (e.g. `ofl lppl`, `lppl1.3c agpl3`, `gpl3+ fdl`) — the TeX
// Catalogue convention for a package that AGGREGATES files under different licenses
// (font under OFL + macros under LPPL, code under AGPL + docs under LPPL, …). We
// split on whitespace and require EVERY token to be free: if any single token is
// non-free/unknown, the package contains a non-free file and the audit FAILS. This
// is the correct fail-closed reading (a space-separated list is an aggregate, not
// "your choice of").
//
// THE ALLOWLIST is an explicit Set of the TeX Catalogue's FREE license tokens
// (researched against the pinned TL 2026 tlpdb + the documented Catalogue license
// vocabulary), NOT a glob. "Free" here means the TeX Catalogue's classification
// AND, as a blanket backstop, LICENSE.TL's statement that everything in the
// distribution meets the FSF definition + the DFSG (which is why a handful of
// tokens contested under a strict FSF-only reading — artistic1, older CC-BY/BY-SA,
// fdl — are admitted: every shipped package is additionally covered by LICENSE.TL,
// cited in THIRD_PARTY_NOTICES.md). Fail-closed by construction: a token the Catalogue adds
// in a future pin that we have not vetted is unknown → FAILS until reviewed. The
// non-free markers (`noinfo`/`nosource`/`nonfree`/`shareware`/… and the
// NonCommercial/NoDerivatives CC variants) are deliberately absent, and `collection`
// (the meta-value on Collection stanzas) is absent too — a shipped package must
// never carry it.
//
// CLI
//   node licenses.mjs [--tlpdb PATH] [--json OUT] [--no-exceptions] [--quiet]
//     --tlpdb PATH     texlive.tlpdb to read (default: $WASMTEX_TLPDB, else the
//                      pinned ISO-staged copy — see resolve.mjs defaultTlpdbPath).
//     --json OUT       write the machine-readable inventory to OUT (deterministic).
//     --no-exceptions  ignore license-exceptions.mjs — exposes the RAW catalogue
//                      gaps (used to demonstrate/test the fail-closed behaviour).
//     --quiet          suppress the human report (still exits non-zero on failure).
//   Prints the per-tier license breakdown + any audit failures; exits non-zero if
//   the audit fails (a shipped package with an unresolved / non-free license).
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTlpdb } from './tlpdb.mjs';
import { TIERS } from './tiers.mjs';
import { defaultTlpdbPath, extractRelease, resolveTiers } from './resolve.mjs';
import { LICENSE_EXCEPTIONS } from './license-exceptions.mjs';

/** Inventory schema version (`dist/licenses.json`). Bump on an incompatible shape change. */
export const LICENSES_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// The free ALLOWLIST — the TeX Catalogue's FREE license tokens (researched
// against the pinned TL 2026 tlpdb; forward-looking to sibling versions we have
// not yet seen shipped). Any token NOT here FAILS the audit.
// ---------------------------------------------------------------------------
export const LICENSE_ALLOWLIST = new Set([
  // LaTeX Project Public License (all versions).
  'lppl', 'lppl1', 'lppl1.2', 'lppl1.3', 'lppl1.3a', 'lppl1.3b', 'lppl1.3c',
  // GNU GPL / LGPL / AGPL / FDL (free copyleft — allowed in the AGGREGATE; the
  // §2 no-copyleft rule governs OUR runtime code, NOT the bundled TeX Live
  // programs, which are separate programs under their own free licenses).
  'gpl', 'gpl1', 'gpl2', 'gpl2+', 'gpl3', 'gpl3+',
  'lgpl', 'lgpl2', 'lgpl2.1', 'lgpl3',
  'agpl1', 'agpl3',
  'fdl',
  // Permissive.
  'mit', 'x11', 'bsd', 'bsd2', 'bsd3', 'bsd4', '0bsd',
  'apache2', 'artistic', 'artistic1', 'artistic2', 'isc', 'zlib',
  // Fonts / TeX-specific.
  'ofl', 'gfl', 'gfsl', 'knuth',
  // Public domain.
  'pd', 'cc0',
  // Creative Commons Attribution / Attribution-ShareAlike (free content licenses;
  // the NonCommercial / NoDerivatives variants are deliberately NOT here).
  'cc-by-1', 'cc-by-2', 'cc-by-3', 'cc-by-4',
  'cc-by-sa-1', 'cc-by-sa-2', 'cc-by-sa-3', 'cc-by-sa-4',
  // Other free (the Catalogue's catch-all "free under some other license"), plus
  // the Open Publication License and the EU Public License.
  'other-free', 'opl', 'eupl',
]);

// ---------------------------------------------------------------------------
// Known NEGATIVE markers — a real "this is not free / no source" assertion. NOT
// allowlisted (so they fail regardless), and NOT exception-overridable: a human
// must consciously drop such a package, not paper over it. Enumerated so the
// failure message can say "non-free" vs merely "unknown". Any other unlisted
// token also fails, as "unknown" (fail-closed).
// ---------------------------------------------------------------------------
export const KNOWN_NONFREE = new Set([
  'nonfree', 'nosource', 'shareware', 'digest',
  // Creative Commons NonCommercial / NoDerivatives (all versions) — non-free.
  'cc-by-nc-1', 'cc-by-nc-2', 'cc-by-nc-2.5', 'cc-by-nc-3', 'cc-by-nc-4',
  'cc-by-nd-1', 'cc-by-nd-2', 'cc-by-nd-2.5', 'cc-by-nd-3', 'cc-by-nd-4',
  'cc-by-nc-sa-1', 'cc-by-nc-sa-2', 'cc-by-nc-sa-3', 'cc-by-nc-sa-4',
  'cc-by-nc-nd-1', 'cc-by-nc-nd-2', 'cc-by-nc-nd-3', 'cc-by-nc-nd-4',
]);

// ---------------------------------------------------------------------------
// RESOLVABLE PLACEHOLDERS — catalogue values that are PRESENT but assert no
// license: `collection` (the TeX Catalogue's "this package is a bundle whose
// parts carry different licenses") and `noinfo` ("no license info found"). These
// carry no free/non-free claim, so — like an absent value — they are UNRESOLVED
// and FAIL unless a cited `license-exceptions.mjs` entry resolves them (the
// "a human resolves each" path). They are deliberately distinct from the NEGATIVE
// markers above, which assert non-freeness and are NOT exception-overridable.
// ---------------------------------------------------------------------------
export const RESOLVABLE_PLACEHOLDERS = new Set(['collection', 'noinfo']);

const compareStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rebuild an object with keys in sorted order (deterministic JSON). */
function sortObjKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort(compareStr)) out[k] = obj[k];
  return out;
}

/**
 * Split a `catalogue-license` value into its atomic tokens (whitespace-separated).
 * @param {string} value
 * @returns {string[]}
 */
export function licenseTokens(value) {
  return value.trim().split(/\s+/).filter((t) => t !== '');
}

/**
 * Classify a raw license value against the allowlist.
 * @param {string} value  a `catalogue-license` value (possibly multi-token).
 * @returns {{ ok: boolean, tokens: string[], bad: string[], nonfree: string[], unknown: string[] }}
 */
export function classifyValue(value) {
  const tokens = licenseTokens(value);
  const bad = tokens.filter((t) => !LICENSE_ALLOWLIST.has(t));
  const nonfree = bad.filter((t) => KNOWN_NONFREE.has(t));
  const unknown = bad.filter((t) => !KNOWN_NONFREE.has(t));
  return { ok: tokens.length > 0 && bad.length === 0, tokens, bad, nonfree, unknown };
}

/**
 * Does this package OWN >=1 runfile in `tierName` (i.e. is it SHIPPED there)?
 * @param {import('./tlpdb.mjs').TlpdbPackage} pkg
 * @param {string} tierName
 * @param {Map<string,string>} fileToTier
 * @returns {number}  count of runfiles the package owns in this tier.
 */
export function ownedFileCount(pkg, tierName, fileToTier) {
  let n = 0;
  for (const f of pkg.runfiles) if (fileToTier.get(f) === tierName) n += 1;
  return n;
}

/**
 * @typedef {Object} PackageLicense
 * @property {string} package
 * @property {string|null} value    effective license value (null if unresolved).
 * @property {'catalogue'|'exception'|'none'} source
 * @property {number} ownedFiles
 * @property {boolean} ok
 * @property {string[]} bad          non-allowlisted tokens (empty if ok).
 */

/**
 * @typedef {Object} AuditFailure
 * @property {string} tier
 * @property {string} package
 * @property {string} value          the offending value ('' when absent).
 * @property {'catalogue'|'exception'|'none'} source
 * @property {'missing'|'unspecified'|'nonfree'|'unknown'|'bad-exception'} kind
 *   missing = absent/empty catalogue-license, no exception; unspecified = a
 *   present-but-uninformative placeholder (collection/noinfo), no exception;
 *   nonfree/unknown = a real non-allowlisted token in the catalogue value;
 *   bad-exception = an exception whose OWN license value is not allowlisted.
 * @property {string[]} bad          non-allowlisted tokens (empty for missing/unspecified).
 */

/**
 * Is a catalogue value RESOLVING-FREE (present and every token allowlisted)?
 * @param {string[]} tokens
 */
function allFree(tokens) {
  return tokens.length > 0 && tokens.every((t) => LICENSE_ALLOWLIST.has(t));
}

/**
 * Is a catalogue value UNRESOLVED — absent/empty, or purely resolvable
 * placeholders (collection/noinfo)? Such a value asserts no license and needs a
 * cited exception. A value that mixes a placeholder with a real token is NOT
 * "purely placeholder", so it falls through to token classification (and fails
 * on the placeholder as an unknown token) — but that combination does not occur
 * in the pinned tlpdb.
 * @param {string[]} tokens
 */
function isUnresolved(tokens) {
  return tokens.length === 0 || tokens.every((t) => RESOLVABLE_PLACEHOLDERS.has(t));
}

/**
 * Run the fail-closed license audit + enumeration over the resolved tiers.
 *
 * Per shipped package, THREE cases:
 *   A. catalogue value is resolving-free  -> PASS (source: catalogue). A matching
 *      exception is redundant (reported as a note, not a failure — the free
 *      catalogue value already stands).
 *   B. catalogue value is unresolved (absent/empty or a placeholder like
 *      `collection`/`noinfo`) -> a cited exception RESOLVES it (source:
 *      exception, its value re-classified — a non-free exception value fails as
 *      `bad-exception`); without one it FAILS (`missing`/`unspecified`).
 *   C. catalogue value contains a real non-allowlisted token -> FAILS
 *      (`nonfree`/`unknown`). An exception does NOT override a negative catalogue
 *      value (reported as an ignored-exception note); the human must drop it.
 *
 * @param {Map<string, import('./tlpdb.mjs').TlpdbPackage>} db
 * @param {import('./resolve.mjs').Resolution} resolution
 * @param {{ exceptions?: Record<string,{license:string,reason?:string,source?:string}> }} [opts]
 * @returns {{
 *   ok: boolean,
 *   tiers: Array<{ tier: string, shipped: PackageLicense[] }>,
 *   failures: AuditFailure[],
 *   redundantExceptions: string[],
 *   ignoredExceptions: string[],
 *   unusedExceptions: string[],
 *   shippedCount: number,
 * }}
 */
export function auditLicenses(db, resolution, opts = {}) {
  const exceptions = opts.exceptions ?? {};
  const usedException = new Set();
  const redundantExceptions = [];
  const ignoredExceptions = [];
  const failures = [];
  const tiers = [];
  let shippedCount = 0;

  for (const tierResult of resolution.tiers) {
    /** @type {PackageLicense[]} */
    const shipped = [];
    for (const name of tierResult.packages) {
      const pkg = db.get(name);
      if (pkg === undefined) continue; // resolver guarantees presence; defensive.
      const owned = ownedFileCount(pkg, tierResult.tier, resolution.fileToTier);
      if (owned === 0) continue; // not shipped (collections already excluded; also 0-runfile pkgs).
      shippedCount += 1;

      const rawVal = typeof pkg.catalogue.license === 'string' ? pkg.catalogue.license.trim() : '';
      const rawTokens = rawVal === '' ? [] : licenseTokens(rawVal);
      const exc = Object.prototype.hasOwnProperty.call(exceptions, name) ? exceptions[name] : undefined;

      const push = (value, source, ok, bad) => shipped.push({ package: name, value, source, ownedFiles: owned, ok, bad });
      const failNow = (value, source, kind, bad) => {
        failures.push({ tier: tierResult.tier, package: name, value, source, kind, bad });
      };

      if (allFree(rawTokens)) {
        // Case A — free from the catalogue. Any exception here is redundant.
        if (exc !== undefined) { usedException.add(name); redundantExceptions.push(name); }
        push(rawVal, 'catalogue', true, []);
      } else if (isUnresolved(rawTokens)) {
        // Case B — unresolved placeholder / absent. A cited exception resolves it.
        if (exc !== undefined) {
          usedException.add(name);
          const excVal = String(exc.license).trim();
          const cls = classifyValue(excVal);
          if (cls.ok) {
            push(excVal, 'exception', true, []);
          } else {
            failNow(excVal, 'exception', 'bad-exception', cls.bad);
            push(excVal, 'exception', false, cls.bad);
          }
        } else {
          const kind = rawTokens.length === 0 ? 'missing' : 'unspecified';
          failNow(rawVal, 'none', kind, []);
          push(rawVal === '' ? null : rawVal, 'none', false, []);
        }
      } else {
        // Case C — a real non-allowlisted token. Not exception-overridable.
        if (exc !== undefined) { usedException.add(name); ignoredExceptions.push(name); }
        const cls = classifyValue(rawVal);
        const kind = cls.nonfree.length > 0 ? 'nonfree' : 'unknown';
        failNow(rawVal, 'catalogue', kind, cls.bad);
        push(rawVal, 'catalogue', false, cls.bad);
      }
    }
    shipped.sort((a, b) => compareStr(a.package, b.package));
    tiers.push({ tier: tierResult.tier, shipped });
  }

  const unusedExceptions = Object.keys(exceptions)
    .filter((n) => !usedException.has(n))
    .sort(compareStr);

  return {
    ok: failures.length === 0,
    tiers,
    failures,
    redundantExceptions: redundantExceptions.sort(compareStr),
    ignoredExceptions: ignoredExceptions.sort(compareStr),
    unusedExceptions,
    shippedCount,
  };
}

/**
 * Build the deterministic machine-readable inventory (`dist/licenses.json`).
 * Pure function of (db, resolution, audit) — no timestamps, sorted throughout,
 * so re-running on the pinned tlpdb is byte-identical.
 *
 * @param {import('./resolve.mjs').Resolution} resolution
 * @param {ReturnType<typeof auditLicenses>} audit
 * @returns {object}
 */
export function buildInventory(resolution, audit) {
  /** @type {Record<string,{count:number,packages:string[]}>} */
  const byLicense = {};
  /** @type {Record<string,{count:number,examples:string[]}>} */
  const byToken = {};

  const tiers = audit.tiers.map((t) => {
    /** @type {Record<string,{license:string|null,source:string}>} */
    const packages = {};
    for (const p of t.shipped) {
      packages[p.package] = { license: p.value, source: p.source };
      if (p.value !== null) {
        (byLicense[p.value] ??= { count: 0, packages: [] }).count += 1;
        byLicense[p.value].packages.push(p.package);
        for (const tok of licenseTokens(p.value)) {
          const b = (byToken[tok] ??= { count: 0, examples: [] });
          b.count += 1;
          if (b.examples.length < 4) b.examples.push(p.package);
        }
      }
    }
    return { tier: t.tier, shippedPackageCount: t.shipped.length, packages: sortObjKeys(packages) };
  });

  for (const k of Object.keys(byLicense)) byLicense[k].packages.sort(compareStr);

  return {
    schemaVersion: LICENSES_SCHEMA_VERSION,
    texlive: { release: audit.release ?? null, tlpdbRevision: resolution.tlpdbRevision },
    audit: {
      ok: audit.ok,
      shippedPackageCount: audit.shippedCount,
      failureCount: audit.failures.length,
      failures: audit.failures.map((f) => ({ tier: f.tier, package: f.package, license: f.value, source: f.source, kind: f.kind, badTokens: f.bad })),
    },
    allowlist: [...LICENSE_ALLOWLIST].sort(compareStr),
    tiers,
    aggregate: {
      byLicense: sortObjKeys(byLicense),
      byToken: sortObjKeys(byToken),
    },
  };
}

/**
 * Render a human-readable report of the audit (per-tier token breakdown + any
 * failures). Deterministic; used by the CLI and quotable into notices.
 * @param {import('./resolve.mjs').Resolution} resolution
 * @param {ReturnType<typeof auditLicenses>} audit
 * @returns {string}
 */
export function formatReport(resolution, audit) {
  const lines = [];
  lines.push(`shipped-aggregate license audit — tlpdb revision ${resolution.tlpdbRevision ?? '?'}`);
  lines.push('');

  for (const t of audit.tiers) {
    // Per-tier atomic-token breakdown.
    const tokCount = new Map();
    let missing = 0;
    for (const p of t.shipped) {
      if (p.value === null) { missing += 1; continue; }
      for (const tok of licenseTokens(p.value)) tokCount.set(tok, (tokCount.get(tok) ?? 0) + 1);
    }
    lines.push(`  ${t.tier}: ${t.shipped.length} shipped package(s)`);
    const rows = [...tokCount.entries()].sort((a, b) => b[1] - a[1] || compareStr(a[0], b[0]));
    for (const [tok, n] of rows) {
      const flag = LICENSE_ALLOWLIST.has(tok)
        ? ''
        : RESOLVABLE_PLACEHOLDERS.has(tok) ? '  <<< UNSPECIFIED (needs exception)'
        : KNOWN_NONFREE.has(tok) ? '  <<< NON-FREE'
        : '  <<< UNKNOWN';
      lines.push(`      ${String(n).padStart(5)}  ${tok}${flag}`);
    }
    if (missing > 0) lines.push(`      ${String(missing).padStart(5)}  (missing / unresolved license)  <<<`);
    lines.push('');
  }

  if (audit.failures.length === 0) {
    lines.push(`  AUDIT PASS — all ${audit.shippedCount} shipped package(s) carry a free, allowlisted license.`);
  } else {
    lines.push(`  AUDIT FAIL — ${audit.failures.length} shipped package(s) need human resolution:`);
    for (const f of audit.failures) {
      const detail =
        f.kind === 'missing' ? 'no catalogue-license and no exception'
        : f.kind === 'unspecified' ? `catalogue-license "${f.value}" asserts no specific license (bundle/no-info) and no exception`
        : f.kind === 'bad-exception' ? `exception license "${f.value}" is itself not allowlisted: ${f.bad.join(', ')}`
        : `${f.kind} token(s): ${f.bad.join(', ')} (in "${f.value}")`;
      lines.push(`      [${f.tier}] ${f.package}: ${detail}`);
    }
  }
  const notes = [
    audit.redundantExceptions.length > 0 && `${audit.redundantExceptions.length} redundant exception(s) (catalogue already free): ${audit.redundantExceptions.join(', ')}`,
    audit.ignoredExceptions.length > 0 && `${audit.ignoredExceptions.length} ignored exception(s) (cannot override a non-free catalogue value): ${audit.ignoredExceptions.join(', ')}`,
    audit.unusedExceptions.length > 0 && `${audit.unusedExceptions.length} unused exception(s) (matched no shipped package; pin moved?): ${audit.unusedExceptions.join(', ')}`,
  ].filter(Boolean);
  if (notes.length > 0) {
    lines.push('');
    for (const n of notes) lines.push(`  note: ${n}`);
  }
  return lines.join('\n');
}

// --- CLI ---------------------------------------------------------------------
function fail(msg) {
  console.error(`\n!! [licenses] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [licenses] ${msg}`);
}

function parseArgs(argv) {
  const opts = { tlpdb: defaultTlpdbPath(), json: null, exceptions: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tlpdb') opts.tlpdb = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--no-exceptions') opts.exceptions = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node licenses.mjs [--tlpdb PATH] [--json OUT] [--no-exceptions] [--quiet]');
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
  const resolution = resolveTiers(db, TIERS);
  if (resolution.unresolved.length > 0) {
    fail(`tlpdb resolution has ${resolution.unresolved.length} unresolved root/dep(s): ${resolution.unresolved.join(', ')}`);
  }
  if (resolution.violations.length > 0) {
    fail(`tier assignment is NOT disjoint: ${resolution.violations.length} cross-tier file collision(s)`);
  }

  const audit = auditLicenses(db, resolution, { exceptions: opts.exceptions ? LICENSE_EXCEPTIONS : {} });
  audit.release = extractRelease(db); // stamp the inventory's TL release id.

  if (!opts.quiet) {
    console.log('');
    console.log(formatReport(resolution, audit));
    console.log('');
  }

  if (opts.json !== null) {
    writeFileSync(opts.json, `${JSON.stringify(buildInventory(resolution, audit), null, 2)}\n`);
    note(`wrote ${opts.json} (${audit.shippedCount} shipped packages)`);
  }

  if (!audit.ok) {
    fail(
      `${audit.failures.length} shipped package(s) have an unresolved / non-free license (see above). ` +
        'The aggregate license audit is fail-closed: each must be resolved (add a cited entry to ' +
        'build/bundles/license-exceptions.mjs) or dropped from its tier before release.',
    );
  }
  note(`aggregate license audit PASS — ${audit.shippedCount} shipped packages, all free.`);
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
