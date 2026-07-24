#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (node:
//   builtins + the sibling deterministic tar core, ./tar.mjs). The INPUTS it reads
//   are OUR OWN artifacts — a built dist/ and its gen-assets manifest.json — so it
//   consults no third-party code. No GPL/AGPL source and no other WASM-TeX wrapper
//   was read; the archive layout and the verify model are original.
//
// =============================================================================
// VERSIONED-ARCHIVE PACKER (M5 item 7, DESIGN.md §7)
// -----------------------------------------------------------------------------
// Turns a built dist/ into the DESIGN §7 release archives, deterministically, and
// verifies every archive's bytes back against dist/manifest.json (the gen-assets
// integrity manifest — the verification oracle) before it is trusted:
//
//   wasmtex-assets-<v>.tar.gz     the FULL asset set — everything a host needs to
//                                 run AND verify: the engine (busytex.js/.wasm),
//                                 every bundle (core + academic .js/.data), the
//                                 .fmt formats, manifest.json, assets.json,
//                                 licenses.json, and SHA256SUMS. (The full dist/.)
//   wasmtex-bundle-core-<v>.tar.gz      core.js + core.data (the preload tier).
//   wasmtex-bundle-academic-<v>.tar.gz  academic.js + academic.data (on-demand).
//
// One per-bundle archive is produced for each REAL (non-alias) bundle the manifest
// lists, so the set follows the manifest (core + academic today; a future `full`
// tier would pack for free). Bundle file lists come from `manifest.bundles[].files`
// — DATA, never hardcoded asset names (DESIGN rebase-proofing: "asset inventories
// are DATA, not code constants"), so a rebase that renames a bundle file is
// followed without editing this tool.
//
// VERSION-PARAMETERIZED: `--version <v>` supplies the filename version; the tool
// hardcodes no release number. The Makefile `pack` target and the release workflow
// (M5 item 8) pass the tag's version. If manifest.json ever carries a package
// `version` field (item 8 adds one for the npm↔assets lockstep) that disagrees
// with `--version`, the pack ABORTS — a mislabel guard. Until then, a manifest
// without `version` packs with just a note.
//
// DETERMINISM: archives are packed by ./tar.mjs (sorted entries, mtime =
// SOURCE_DATE_EPOCH, fixed uid/gid/mode, canonical gzip header) so `pack` twice on
// the same dist/ is byte-identical (proven by the packer's own double-pack test
// and `make pack` run twice + cmp). The mtime is SOURCE_DATE_EPOCH if set, else the
// build's own epoch recorded in `manifest.texliveSnapshot.sourceDateEpoch`, else 0.
//
// VERIFY (fail-closed, mirrors gen-assets' SHA256SUMS-exclusion rules):
//   * assets archive — every manifest asset MUST be present with a matching
//     size + sha256; and every archived file MUST be either a manifest asset or one
//     of the two gen-assets outputs (manifest.json / assets.json) that are
//     deliberately not self-listed. (SHA256SUMS IS a manifest asset — role
//     "checksums" — so it is verified by the forward direction, not exempted.)
//   * each bundle archive — contains EXACTLY that bundle's declared files, each
//     matching the manifest.
// Any mismatch, missing asset, or stray file FAILS the whole pack (non-zero exit).
//
// Usage:
//   node pack.mjs --version <v> [--dist DIR] [--out DIR] [--gzip-level N] [--json]
//     --version   REQUIRED release version for the archive filenames (e.g. 0.1.0)
//     --dist DIR  the built dist/ (default: <repo>/dist)
//     --out DIR   where to write the archives (default: <dist>/release)
//     --json      print the per-archive report as JSON (else a human table)
// =============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packTarGz, readTarGzEntries, sha256File } from './tar.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

// The two files gen-assets.mjs writes and excludes from its own payload inventory
// (its OUTPUT_NAMES). They ship in the assets archive but are NOT manifest assets,
// so the reverse verify direction allows them. Kept in lockstep with gen-assets.
const GENERATOR_OUTPUTS = new Set(['manifest.json', 'assets.json']);

const MANIFEST_NAME = 'manifest.json';

// --- tiny output helpers (mirror gen-assets / check-sizes house style) --------
export function fail(msg) {
  console.error(`\n!! [pack] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [pack] ${msg}`);
}
const formatMB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// --- arg parsing --------------------------------------------------------------
export function parseArgs(argv) {
  const opts = { version: null, dist: null, out: null, gzipLevel: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') opts.version = argv[++i];
    else if (a === '--dist') opts.dist = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--gzip-level') opts.gzipLevel = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node pack.mjs --version <v> [--dist DIR] [--out DIR] [--gzip-level N] [--json]');
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return opts;
}

// A version token must be filename-safe (it becomes part of the archive names).
export function validateVersion(v) {
  if (typeof v !== 'string' || v === '') fail('--version <v> is required (e.g. 0.1.0)');
  // Reject the literal a driver stamps when `node -p .version` reads a missing field;
  // these pass the filename-safe regex but are never a real version (mirror gen-assets).
  if (v === 'undefined' || v === 'null') {
    fail(`--version "${v}" looks like a missing package.json "version" field, not a real version`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(v)) {
    fail(`--version "${v}" is not a filename-safe version token (allowed: [0-9A-Za-z.+-], no leading punctuation)`);
  }
  return v;
}

// --- manifest + epoch ---------------------------------------------------------
export function loadManifest(distDir) {
  const p = join(distDir, MANIFEST_NAME);
  if (!existsSync(p)) {
    fail(`${MANIFEST_NAME} not found in ${distDir} — run \`make artifacts STAGE=dist\` first (gen-assets writes it)`);
  }
  let m;
  try {
    m = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${p} is not valid JSON: ${e && e.message ? e.message : e}`);
  }
  if (typeof m !== 'object' || m === null || !Array.isArray(m.assets) || !Array.isArray(m.bundles)) {
    fail(`${p} is not a gen-assets manifest (expected { assets:[], bundles:[] })`);
  }
  return m;
}

// mtime source precedence: SOURCE_DATE_EPOCH env → the build's recorded epoch in
// the manifest → 0. Every path is deterministic (no wall-clock).
export function resolveEpoch(manifest, env = process.env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw !== undefined && String(raw).trim() !== '') {
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) fail(`SOURCE_DATE_EPOCH is set but not a non-negative integer: "${raw}"`);
    const n = Number(s);
    if (!Number.isSafeInteger(n)) fail(`SOURCE_DATE_EPOCH out of safe integer range: "${raw}"`);
    return { epoch: n, source: 'SOURCE_DATE_EPOCH' };
  }
  const snap = manifest.texliveSnapshot && manifest.texliveSnapshot.sourceDateEpoch;
  if (Number.isInteger(snap) && snap >= 0) {
    return { epoch: snap, source: 'manifest.texliveSnapshot.sourceDateEpoch' };
  }
  return { epoch: 0, source: 'default(0)' };
}

// --- dist walk (deterministic, excludes the output dir) -----------------------
function walkFiles(dir, excludeDir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, dirent.name);
    if (excludeDir && (full === excludeDir || full.startsWith(excludeDir + sep))) continue;
    if (dirent.isDirectory()) out.push(...walkFiles(full, excludeDir));
    else if (dirent.isFile()) out.push(full);
    else fail(`unexpected non-regular file in dist/: ${full}`);
  }
  return out;
}
const toPosixRel = (from, full) => relative(from, full).split(sep).join(posix.sep);

// --- archive specs (what goes in each archive) --------------------------------
/**
 * @returns {Array<{ kind:'assets'|'bundle', name:string, archiveName:string,
 *                    bundleFiles?:string[], entries:Array<{archivePath,sourcePath}> }>}
 */
export function buildArchiveSpecs({ distDir, manifest, version, outDir }) {
  const specs = [];

  // 1. assets archive = the full dist/ tree (excluding the output dir).
  const assetEntries = walkFiles(distDir, outDir).map((full) => ({
    archivePath: toPosixRel(distDir, full),
    sourcePath: full,
  }));
  specs.push({
    kind: 'assets',
    name: 'assets',
    archiveName: `wasmtex-assets-${version}.tar.gz`,
    entries: assetEntries,
  });

  // 2. one archive per REAL (non-alias) bundle, from manifest.bundles[].files.
  const realBundles = manifest.bundles
    .filter((b) => !b.aliasOf && Array.isArray(b.files))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const b of realBundles) {
    specs.push({
      kind: 'bundle',
      name: b.name,
      archiveName: `wasmtex-bundle-${b.name}-${version}.tar.gz`,
      bundleFiles: [...b.files],
      entries: b.files.map((f) => ({ archivePath: f, sourcePath: join(distDir, ...f.split(posix.sep)) })),
    });
  }
  return specs;
}

// --- verify an archive's entries against the manifest -------------------------
/**
 * @param {Array<{path,size,sha256}>} archiveEntries  read back from the archive
 * @param {object} spec  a buildArchiveSpecs() entry
 * @param {Map<string,{bytes,sha256}>} manifestByPath
 * @returns {string[]} errors (empty ⇒ verified)
 */
export function verifyArchive(archiveEntries, spec, manifestByPath) {
  const errors = [];
  const archiveByPath = new Map();
  for (const e of archiveEntries) {
    if (archiveByPath.has(e.path)) errors.push(`duplicate entry in archive: ${e.path}`);
    archiveByPath.set(e.path, e);
  }

  const checkAgainstManifest = (p, e) => {
    const rec = manifestByPath.get(p);
    if (!rec) return `archive file not listed in manifest: ${p}`;
    if (e.size !== rec.bytes) return `size mismatch for ${p}: archive=${e.size} manifest=${rec.bytes}`;
    if (e.sha256 !== rec.sha256) return `sha256 mismatch for ${p}: archive=${e.sha256} manifest=${rec.sha256}`;
    return null;
  };

  if (spec.kind === 'assets') {
    // Forward: every manifest asset must be present + match.
    for (const [p, rec] of manifestByPath) {
      const e = archiveByPath.get(p);
      if (!e) {
        errors.push(`manifest asset missing from assets archive: ${p}`);
        continue;
      }
      if (e.size !== rec.bytes) errors.push(`size mismatch for ${p}: archive=${e.size} manifest=${rec.bytes}`);
      if (e.sha256 !== rec.sha256) errors.push(`sha256 mismatch for ${p}: archive=${e.sha256} manifest=${rec.sha256}`);
    }
    // Reverse: every archived file is a manifest asset OR a gen-assets output.
    for (const p of archiveByPath.keys()) {
      if (manifestByPath.has(p)) continue;
      if (GENERATOR_OUTPUTS.has(p)) continue;
      errors.push(`stray file in assets archive (not a manifest asset, not a generator output): ${p}`);
    }
  } else {
    // Bundle archive: exactly the declared files, each matching the manifest.
    const want = new Set(spec.bundleFiles);
    for (const f of spec.bundleFiles) {
      const e = archiveByPath.get(f);
      if (!e) {
        errors.push(`bundle file missing from ${spec.name} archive: ${f}`);
        continue;
      }
      const err = checkAgainstManifest(f, e);
      if (err) errors.push(err);
    }
    for (const p of archiveByPath.keys()) {
      if (!want.has(p)) errors.push(`unexpected file in ${spec.name} bundle archive: ${p}`);
    }
  }
  return errors;
}

// --- the pack orchestration (importable; the CLI wraps this) ------------------
/**
 * Pack + verify every §7 archive from `distDir` into `outDir`.
 * Returns { archives:[report...], epoch, epochSource }. Throws on a verify failure
 * (so tests can assert); the CLI `main()` turns a throw into a fail() exit.
 */
export async function pack({ distDir, outDir, version, manifest, epoch, gzipLevel, onNote }) {
  const say = onNote || (() => {});
  mkdirSync(outDir, { recursive: true });

  const manifestByPath = new Map(manifest.assets.map((a) => [a.path, { bytes: a.bytes, sha256: a.sha256 }]));
  const specs = buildArchiveSpecs({ distDir, manifest, version, outDir });

  const archives = [];
  for (const spec of specs) {
    const outPath = join(outDir, spec.archiveName);
    await packTarGz({ entries: spec.entries, outPath, mtime: epoch, ...(gzipLevel != null ? { gzipLevel } : {}) });

    // Re-read the archive we just wrote and verify its bytes against the manifest.
    const archiveEntries = await readTarGzEntries(outPath);
    const errors = verifyArchive(archiveEntries, spec, manifestByPath);
    if (errors.length > 0) {
      throw new Error(
        `archive ${spec.archiveName} FAILED manifest verification:\n` + errors.map((e) => `    - ${e}`).join('\n'),
      );
    }

    const totalBytes = archiveEntries.reduce((s, e) => s + e.size, 0);
    const archiveBytes = statSync(outPath).size;
    const digest = await sha256File(outPath);
    const report = {
      archive: spec.archiveName,
      kind: spec.kind,
      bundle: spec.kind === 'bundle' ? spec.name : undefined,
      entryCount: archiveEntries.length,
      totalBytes,
      archiveBytes,
      sha256: digest,
      path: outPath,
    };
    archives.push(report);
    say(
      `verified ${spec.archiveName}: ${report.entryCount} entr${report.entryCount === 1 ? 'y' : 'ies'}, ` +
        `${formatMB(totalBytes)} raw → ${formatMB(archiveBytes)} gz  sha256=${digest.slice(0, 16)}…`,
    );
  }
  return { archives };
}

// --- report formatting --------------------------------------------------------
function formatReport(archives) {
  const rows = archives.map((a) => ({
    Archive: a.archive,
    Entries: String(a.entryCount),
    Raw: formatMB(a.totalBytes),
    Gz: formatMB(a.archiveBytes),
    sha256: a.sha256,
  }));
  const cols = ['Archive', 'Entries', 'Raw', 'Gz', 'sha256'];
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => r[c].length));
  const line = (r) => cols.map((c) => (c === 'Entries' ? r[c].padStart(width[c]) : r[c].padEnd(width[c]))).join('  ');
  const head = line(Object.fromEntries(cols.map((c) => [c, c])));
  const sepLine = cols.map((c) => '-'.repeat(width[c])).join('  ');
  return [head, sepLine, ...rows.map(line)].join('\n');
}

// --- CLI ----------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const version = validateVersion(opts.version);
  const distDir = resolve(opts.dist || join(repoRoot, 'dist'));
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    fail(`dist directory not found: ${distDir}`);
  }
  const outDir = resolve(opts.out || join(distDir, 'release'));
  const manifest = loadManifest(distDir);

  // Mislabel guard for the item-8 lockstep `version` field (soft until it exists).
  if (typeof manifest.version === 'string' && manifest.version !== '') {
    if (manifest.version !== version) {
      fail(
        `--version ${version} disagrees with manifest.version ${manifest.version} — the archive filenames would ` +
          `mislabel the built assets. Pass the version that matches the built dist/, or rebuild.`,
      );
    }
  } else if (!opts.json) {
    note('manifest has no `version` field yet (item 8 adds it); packing with --version unchecked against the manifest.');
  }

  const { epoch, source } = resolveEpoch(manifest, process.env);

  if (!opts.json) {
    note(`version:  ${version}`);
    note(`dist:     ${distDir}`);
    note(`out:      ${outDir}`);
    note(`mtime:    ${epoch} (${new Date(epoch * 1000).toISOString()}) from ${source}`);
  }

  let result;
  try {
    result = await pack({
      distDir,
      outDir,
      version,
      manifest,
      epoch,
      gzipLevel: opts.gzipLevel ?? undefined,
      onNote: opts.json ? undefined : note,
    });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
    return; // unreachable (fail exits) — keeps the type checker happy
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ version, epoch, epochSource: source, archives: result.archives }, null, 2)}\n`);
  } else {
    console.log('');
    console.log(formatReport(result.archives));
    console.log('');
    note(`packed + verified ${result.archives.length} archive(s) into ${relative(repoRoot, outDir)}/ — all match manifest.json.`);
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
