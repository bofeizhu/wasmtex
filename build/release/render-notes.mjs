#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only node:
//   builtins). The INPUTS it reads are OUR OWN artifacts — the release-notes
//   template, the `pack.mjs --json` report, and dist/manifest.json — so it consults
//   no third-party code. No GPL/AGPL source and no other WASM-TeX wrapper was read.
//
// =============================================================================
// RELEASE-NOTES RENDERER (M5 item 8, DESIGN.md §7)
// -----------------------------------------------------------------------------
// Fills build/release/RELEASE_NOTES.template.md's {{PLACEHOLDERS}} from the facts
// the release workflow already has: the version/tag/repo/date it is releasing, the
// per-archive gzip size + sha256 from `node build/release/pack.mjs --json`, and the
// TeX Live snapshot id from dist/manifest.json. Emits the rendered notes (stdout or
// --out FILE) for the GitHub Release body.
//
// FAIL-CLOSED: it aborts if a required placeholder value is missing, if the pack
// report / manifest disagrees with --version (a third lockstep check, after the
// release workflow's tag↔package.json and gen-assets' manifest.version), or if ANY
// `{{...}}` token survives substitution (a template that grew a placeholder without
// a source must STOP the release, not ship notes with a literal `{{FOO}}` in them).
//
// Usage:
//   node render-notes.mjs --version <v> --pack-report FILE --manifest FILE \
//       --repo-url URL --date YYYY-MM-DD [--template FILE] [--out FILE]
//     --version      the release version (e.g. 0.1.0); {{TAG}} = assets-v<version>
//     --pack-report  the `pack.mjs --json` report (archive sizes + sha256)
//     --manifest     dist/manifest.json (TL release + tlpdb revision, lockstep version)
//     --repo-url     e.g. https://github.com/bofeizhu/wasmtex
//     --date         ISO release date, e.g. 2026-07-24
//     --template     the notes template (default: ./RELEASE_NOTES.template.md)
//     --out FILE     write here (default: stdout)
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = resolve(scriptDir, 'RELEASE_NOTES.template.md');

export function fail(msg) {
  console.error(`\n!! [render-notes] FAIL: ${msg}`);
  process.exit(1);
}

// Bytes → the "NNN.N MB" form pack.mjs prints (MiB, labelled MB), so the notes'
// sizes match the pack report a maintainer sees. Kept in lockstep with pack.mjs.
export function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseArgs(argv) {
  const opts = {
    version: null,
    packReport: null,
    manifest: null,
    repoUrl: null,
    date: null,
    template: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') opts.version = argv[++i];
    else if (a === '--pack-report') opts.packReport = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--repo-url') opts.repoUrl = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--template') opts.template = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node render-notes.mjs --version <v> --pack-report FILE --manifest FILE --repo-url URL --date YYYY-MM-DD [--template FILE] [--out FILE]',
      );
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  return opts;
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${label} is not valid JSON (${path}): ${e && e.message ? e.message : e}`);
  }
}

/** Pick the single archive report of a given kind/bundle; fail if absent or ambiguous. */
function pickArchive(archives, predicate, label) {
  const matches = archives.filter(predicate);
  if (matches.length === 0) fail(`the pack report has no ${label} archive`);
  if (matches.length > 1) fail(`the pack report has ${matches.length} ${label} archives (expected exactly 1)`);
  return matches[0];
}

/**
 * Build the placeholder→value map from the release facts + the pack report +
 * the manifest. Pure (no I/O) so it is unit-testable. Fails closed on a
 * lockstep disagreement or a missing archive.
 */
export function buildValues({ version, packReport, manifest, repoUrl, date }) {
  if (typeof version !== 'string' || version === '') fail('--version <v> is required');
  if (typeof repoUrl !== 'string' || repoUrl === '') fail('--repo-url is required');
  if (typeof date !== 'string' || date === '') fail('--date is required');

  // Lockstep check #3 (after tag↔package.json and gen-assets' manifest.version):
  // the pack report and the manifest must both agree with the version we render.
  if (packReport.version !== version) {
    fail(`--version ${version} disagrees with the pack report version ${packReport.version}`);
  }
  if (typeof manifest.version === 'string' && manifest.version !== version) {
    fail(`--version ${version} disagrees with manifest.version ${manifest.version} (built dist mislabel)`);
  }

  const archives = Array.isArray(packReport.archives) ? packReport.archives : null;
  if (!archives) fail('the pack report has no archives[] array');

  const assets = pickArchive(archives, (a) => a.kind === 'assets', 'assets');
  const core = pickArchive(archives, (a) => a.kind === 'bundle' && a.bundle === 'core', 'core bundle');
  const academic = pickArchive(archives, (a) => a.kind === 'bundle' && a.bundle === 'academic', 'academic bundle');

  const snap = manifest.texliveSnapshot && typeof manifest.texliveSnapshot === 'object' ? manifest.texliveSnapshot : {};
  const tlRelease = snap.release;
  const tlpdbRevision = snap.tlpdbRevision;
  if (typeof tlRelease !== 'string' || tlRelease === '') {
    fail('manifest.texliveSnapshot.release is missing — cannot fill {{TL_RELEASE}}');
  }
  if (!Number.isInteger(tlpdbRevision)) {
    fail('manifest.texliveSnapshot.tlpdbRevision is missing — cannot fill {{TLPDB_REVISION}}');
  }

  return {
    VERSION: version,
    TAG: `assets-v${version}`,
    REPO_URL: repoUrl,
    RELEASE_DATE: date,
    TL_RELEASE: tlRelease,
    TLPDB_REVISION: String(tlpdbRevision),
    ASSETS_GZ: formatMB(assets.archiveBytes),
    ASSETS_SHA256: assets.sha256,
    BUNDLE_CORE_GZ: formatMB(core.archiveBytes),
    BUNDLE_CORE_SHA256: core.sha256,
    BUNDLE_ACADEMIC_GZ: formatMB(academic.archiveBytes),
    BUNDLE_ACADEMIC_SHA256: academic.sha256,
  };
}

/**
 * Strip the template's leading HTML authoring-comment (which itself documents the
 * `{{PLACEHOLDERS}}`), THEN substitute the real `{{KEY}}` tokens in the body. Order
 * matters: the comment names placeholders that have no value, so it must go first.
 * Fails closed if any `{{...}}` token survives — an unfilled placeholder must never
 * reach a release.
 */
export function renderTemplate(template, values) {
  // Drop the template's authoring-note comment (everything up to and including the
  // first `-->`), so the published notes start at the "# WasmTeX <v>" heading and
  // the comment's own `{{PLACEHOLDERS}}` documentation is not mistaken for a field.
  const body = template.replace(/^<!--[\s\S]*?-->\n*/, '');
  const out = body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    const v = values[key];
    if (v === undefined) fail(`template placeholder {{${key}}} has no value`);
    return v;
  });
  const leftover = out.match(/\{\{[^}]*\}\}/g);
  if (leftover) fail(`unfilled placeholder(s) survived rendering: ${[...new Set(leftover)].join(', ')}`);
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const templatePath = resolve(opts.template || DEFAULT_TEMPLATE);
  if (!existsSync(templatePath)) fail(`template not found: ${templatePath}`);
  if (!opts.packReport) fail('--pack-report FILE is required');
  if (!opts.manifest) fail('--manifest FILE is required');

  const template = readFileSync(templatePath, 'utf8');
  const packReport = readJson(resolve(opts.packReport), 'pack report');
  const manifest = readJson(resolve(opts.manifest), 'manifest');

  const values = buildValues({
    version: opts.version,
    packReport,
    manifest,
    repoUrl: opts.repoUrl,
    date: opts.date,
  });
  const rendered = renderTemplate(template, values);

  if (opts.out) {
    const outPath = resolve(opts.out);
    writeFileSync(outPath, rendered);
    console.error(`   [render-notes] wrote ${outPath} (${Buffer.byteLength(rendered)} bytes)`);
  } else {
    process.stdout.write(rendered);
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
