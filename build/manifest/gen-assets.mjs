#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only
//   node: builtins). Reads a built dist/ and EMITS dist/assets.json — the
//   data-driven asset inventory the M1 runtime consumes INSTEAD of hardcoded
//   asset names (docs/plans/M1.md item 4; rebase-proofing rule 1: "asset
//   inventories are DATA, never code constants"). This is the forward-compatible
//   PRECURSOR of M4's top-level integrity manifest (DESIGN.md §4): M4 bumps
//   schemaVersion and adds the texlive snapshot id and per-bundle
//   provided-package indexes; schemaVersion 1 here carries only what M1 needs.
//
// =============================================================================
// SCHEMA (schemaVersion 1)
// -----------------------------------------------------------------------------
//   {
//     "schemaVersion": 1,
//     "generated": "<ISO 8601>",   // OMITTED unless SOURCE_DATE_EPOCH is set
//     "assets": [
//       { "path": "<posix rel path>", "bytes": <int>,
//         "sha256": "<64 hex>", "role": "<role>" },
//       ...
//     ]
//   }
//
// - `generated` is derived from SOURCE_DATE_EPOCH (seconds) when that env var is
//   set, and OMITTED otherwise — determinism: the field must never carry a
//   wall-clock time, or two builds of identical inputs would differ. The pinned
//   build (build/artifacts/build-native.sh) always exports SOURCE_DATE_EPOCH.
// - `assets` is sorted by `path` (byte/C-locale order — the same order the
//   build's `LC_ALL=C sort` gives SHA256SUMS), so output is deterministic.
// - Output is `JSON.stringify(_, null, 2)` + a trailing newline. Keys are
//   emitted in a fixed order (schemaVersion, generated, assets; then path,
//   bytes, sha256, role), so re-running on an unchanged dist/ is byte-identical.
//
// ROLE TABLE (data-driven, ORDERED, first match wins)
// -----------------------------------------------------------------------------
// Roles are assigned from filename/structure patterns, not a hardcoded name
// list, so the M2 TL-2026 rebase can rename or re-tier artifacts without editing
// classification logic. Structural (sibling-pairing) rules are preferred over
// exact names where a stable structural signal exists.
//
//   #  role            match (on the dist-relative posix path)
//   -  --------------  ---------------------------------------------------------
//   1  checksums       basename == "SHA256SUMS"
//   2  format          extension == ".fmt"        (engine .fmt format dumps)
//   3  engine-wasm     extension == ".wasm"       (the single multicall engine)
//   4  bundle-data     extension == ".data"       (Emscripten file_packager data)
//   5  engine-js       ".js" AND a sibling "<stem>.wasm" exists  (engine loader)
//   6  bundle-js       ".js" AND a sibling "<stem>.data" exists  (bundle loader)
//
// All six rules are STRUCTURAL (name/extension/sibling-pairing): the engine js
// loader always pairs with the engine wasm of the same stem, and a bundle js
// loader always pairs with its <stem>.data — so an engine/bundle rename at
// rebase reclassifies correctly with no code change, and M4's multi-bundle
// tiering (core.js/core.data, extended.js/extended.data, ...) classifies for
// free. (The former glue-pipeline / glue-worker rules were retired at M2 item 3
// when the vendored busytex worker/pipeline glue was dropped from dist/ — the
// runtime replaced their role at M1 and the config is ours now.) Any file
// matching NO rule is a hard error (see below).
//
// UNKNOWN FILES ARE A HARD ERROR
// -----------------------------------------------------------------------------
// A dist/ file that matches no rule aborts the build (exit 1). A new dist
// artifact must be classified DELIBERATELY — silently dropping or mis-bucketing
// it would let the runtime's data-driven loader miss (or mislabel) an asset.
//
// SHA256SUMS HANDLING (decision, documented per the item-4 spec)
// -----------------------------------------------------------------------------
// assets.json is NOT listed inside SHA256SUMS, and SHA256SUMS IS listed inside
// assets.json (role "checksums"). Rationale:
//   * The build generates SHA256SUMS FIRST (over every file except itself), then
//     runs this generator. So SHA256SUMS predates assets.json and cannot contain
//     it; and this generator can read SHA256SUMS to CROSS-CHECK every payload
//     file's hash (catches a stale dist/ — see consistency checks). Listing
//     assets.json in SHA256SUMS would be a self-reference fixpoint (its hash
//     depends on its own bytes) and would force checksums to be regenerated
//     after assets.json, inverting that useful ordering.
//   * assets.json aims to be a COMPLETE inventory of dist/ (the M4 manifest
//     direction), so the real, shipped SHA256SUMS artifact is itself listed
//     (role "checksums"). Only assets.json excludes itself.
// A checksums file never lists itself, so SHA256SUMS has no SHA256SUMS row; that
// one asset is exempt from the "every asset has a checksum row" direction below.
//
// CONSISTENCY CHECKS (fail loud — a mismatch means a stale or corrupt dist/)
// -----------------------------------------------------------------------------
//   * Every non-generated file in dist/ appears exactly once (assets.json — the
//     file this tool writes — is excluded; duplicate paths abort).
//   * When SHA256SUMS is present, cross-check BOTH directions:
//       - every SHA256SUMS row matches an on-disk asset with an equal hash
//         (a missing file or hash mismatch = stale/tampered dist -> abort);
//       - every asset except SHA256SUMS itself has a SHA256SUMS row
//         (an unchecksummed dist file = stale checksums -> abort).
//     When SHA256SUMS is absent (e.g. an un-checksummed dist), the cross-check
//     is skipped and no "checksums" asset is emitted.
//
// Usage:  node gen-assets.mjs [distDir]     (distDir defaults to <repo>/dist)
// =============================================================================

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, basename, extname, posix } from 'node:path';

const SCHEMA_VERSION = 1;
const OUTPUT_NAME = 'assets.json';
const SUMS_NAME = 'SHA256SUMS';

// --- tiny output helpers (mirror build/artifacts/verify-engine.mjs style) ----
function fail(msg) {
  console.error(`\n!! [gen-assets] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [gen-assets] ${msg}`);
}

// --- resolve the dist directory ----------------------------------------------
// Explicit arg wins (the build passes an absolute path); otherwise default to
// <repo>/dist resolved from this script's location (build/manifest/ -> repo).
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distDir = resolve(process.argv[2] || join(repoRoot, 'dist'));

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail(`dist directory not found: ${distDir} (run \`make artifacts STAGE=dist\` first)`);
}
note(`dist: ${distDir}`);

// --- deterministic recursive walk -> dist-relative posix paths ---------------
function walk(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...walk(full));
    } else if (dirent.isFile()) {
      out.push(full);
    } else {
      // Symlinks / sockets / fifos have no place in a reproducible dist/.
      fail(`unexpected non-regular file in dist/: ${full}`);
    }
  }
  return out;
}

const toRel = (full) => relative(distDir, full).split(/[\\/]/).join(posix.sep);

// Collect every file except the output we are about to (re)write. Excluding
// assets.json by name makes re-runs idempotent even when it already exists.
const relPaths = walk(distDir)
  .map(toRel)
  .filter((rel) => rel !== OUTPUT_NAME);

// "appears exactly once": the fs walk yields each file once; assert defensively.
const seen = new Set();
for (const rel of relPaths) {
  if (seen.has(rel)) fail(`duplicate path encountered during walk: ${rel}`);
  seen.add(rel);
}

// --- role classification (ordered; first match wins) -------------------------
// Each rule is { role, test } where test(ctx) -> boolean. ctx carries the parsed
// path plus a sibling-existence probe over the full file set.
const allRel = seen; // Set<string> of every classified candidate path
function siblingWithExt(rel, ext) {
  const d = posix.dirname(rel);
  const stem = basename(rel, extname(rel));
  const sib = d === '.' ? `${stem}${ext}` : posix.join(d, `${stem}${ext}`);
  return allRel.has(sib);
}

const ROLE_RULES = [
  { role: 'checksums', test: (c) => c.base === SUMS_NAME },
  { role: 'format', test: (c) => c.ext === '.fmt' },
  { role: 'engine-wasm', test: (c) => c.ext === '.wasm' },
  { role: 'bundle-data', test: (c) => c.ext === '.data' },
  { role: 'engine-js', test: (c) => c.ext === '.js' && siblingWithExt(c.rel, '.wasm') },
  { role: 'bundle-js', test: (c) => c.ext === '.js' && siblingWithExt(c.rel, '.data') },
];

function classify(rel) {
  const ctx = { rel, base: basename(rel), ext: extname(rel) };
  for (const rule of ROLE_RULES) {
    if (rule.test(ctx)) return rule.role;
  }
  fail(
    `unclassified dist artifact: "${rel}". No role rule matched. A new dist ` +
      `artifact must be classified deliberately — add a rule to ROLE_RULES ` +
      `(see the header ROLE TABLE) in ${relative(repoRoot, fileURLToPath(import.meta.url))}.`,
  );
}

// --- sha256 (hex) of a dist file ---------------------------------------------
function sha256OfRel(rel) {
  return createHash('sha256').update(readFileSync(join(distDir, rel))).digest('hex');
}

// --- build the asset entries -------------------------------------------------
const assets = relPaths
  .map((rel) => ({
    path: rel,
    bytes: statSync(join(distDir, rel)).size,
    sha256: sha256OfRel(rel),
    role: classify(rel),
  }))
  // Byte/C-locale order over ASCII paths (matches the build's LC_ALL=C sort).
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// --- cross-check against SHA256SUMS when present -----------------------------
const sumsPath = join(distDir, SUMS_NAME);
if (existsSync(sumsPath)) {
  // Parse "<64hex>  <path>" rows (shasum text mode; a leading "./" is stripped).
  const sums = new Map();
  const text = readFileSync(sumsPath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!m) fail(`unparseable SHA256SUMS line: "${raw}"`);
    const hash = m[1];
    const p = m[2].replace(/^\.\//, '');
    if (sums.has(p)) fail(`SHA256SUMS lists "${p}" more than once`);
    sums.set(p, hash);
  }

  const matched = new Set();
  for (const a of assets) {
    const want = sums.get(a.path);
    if (want !== undefined) {
      if (want !== a.sha256) {
        fail(
          `sha256 mismatch for ${a.path}: SHA256SUMS=${want} disk=${a.sha256} ` +
            `(stale or corrupt dist/ — regenerate with \`make artifacts STAGE=dist\`)`,
        );
      }
      matched.add(a.path);
    } else if (a.path !== SUMS_NAME) {
      // A checksums file never lists itself; every OTHER asset must have a row.
      fail(`${a.path} is present in dist/ but absent from SHA256SUMS (stale checksums?)`);
    }
  }
  for (const p of sums.keys()) {
    if (!matched.has(p)) {
      fail(`SHA256SUMS lists "${p}" but it is absent from dist/ (stale dist?)`);
    }
  }
  note(`SHA256SUMS: cross-checked ${matched.size} payload file(s); all hashes match`);
} else {
  note(`${SUMS_NAME} not present; skipping hash cross-check (no "checksums" asset)`);
}

// --- generated timestamp (deterministic; from SOURCE_DATE_EPOCH only) --------
let generated; // undefined => field omitted
const epochRaw = process.env.SOURCE_DATE_EPOCH;
if (epochRaw !== undefined && epochRaw.trim() !== '') {
  const epoch = epochRaw.trim();
  if (!/^\d+$/.test(epoch)) {
    fail(`SOURCE_DATE_EPOCH is set but is not a non-negative integer: "${epochRaw}"`);
  }
  const secs = Number(epoch);
  if (!Number.isSafeInteger(secs)) {
    fail(`SOURCE_DATE_EPOCH out of safe integer range: "${epochRaw}"`);
  }
  generated = new Date(secs * 1000).toISOString();
}

// --- assemble + write (fixed key order, 2-space, trailing newline) -----------
const inventory = {
  schemaVersion: SCHEMA_VERSION,
  ...(generated !== undefined ? { generated } : {}),
  assets: assets.map((a) => ({
    path: a.path,
    bytes: a.bytes,
    sha256: a.sha256,
    role: a.role,
  })),
};

const json = `${JSON.stringify(inventory, null, 2)}\n`;
const outPath = join(distDir, OUTPUT_NAME);
writeFileSync(outPath, json);

// --- summary -----------------------------------------------------------------
const roleCounts = {};
for (const a of assets) roleCounts[a.role] = (roleCounts[a.role] ?? 0) + 1;
const roleSummary = Object.keys(roleCounts)
  .sort()
  .map((r) => `${r}=${roleCounts[r]}`)
  .join(' ');
note(`classified ${assets.length} asset(s): ${roleSummary}`);
note(
  `wrote ${relative(repoRoot, outPath)} (${Buffer.byteLength(json)} bytes)` +
    (generated !== undefined ? `, generated=${generated}` : ', generated omitted (no SOURCE_DATE_EPOCH)'),
);
