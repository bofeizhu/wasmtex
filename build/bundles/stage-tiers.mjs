#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (node:
//   builtins + the sibling tlpdb parser / tier resolver). No GPL/AGPL sources and
//   no other WASM-TeX wrapper were consulted; the staging model is original.
//
// =============================================================================
// TIER STAGING — split one combined TeX Live install into DISJOINT per-tier
// trees (M4 item 3; docs/plans/M4.md item 3 + the "tiers are disjoint" decision).
// -----------------------------------------------------------------------------
// Item 3 does ONE install-tl run (scheme-basic + every tier's collections) into a
// single, pruned, ls-R-normalized tree, then this tool HARDLINKS that tree into N
// disjoint per-tier staging trees that file_packager turns into `core.{js,data}`,
// `academic.{js,data}`, … Each staged tree mounts at the SAME `/texlive` root; the
// trees are disjoint, so mounting several together never collides.
//
// ASSIGNMENT (drives directly off resolve.mjs' `fileToTier`)
//   For every regular file in the install tree, at install-relative POSIX path `p`:
//       tier = fileToTier.get(p) ?? BASE_TIER          (BASE_TIER = the first
//                                                        tier, `core`)
//   and the file is hardlinked into  <out>/<tier>/<p>.
//   * A file that a later tier's package OWNS (fileToTier == that tier) → that
//     tier's tree, and ONLY that tree.
//   * EVERYTHING ELSE → the base tier (`core`): core package files AND every
//     install-generated / non-tlpdb file — the full-tree `ls-R`, `texmf.cnf` /
//     `texmfcnf.lua`, the retained `.fmt`s and font maps under `texmf-var`,
//     `fonts.conf`, the root `tex/` ini/config files, licences. So `core` stays
//     self-sufficient for basic docs and carries the FULL-tree ls-R.
//   Disjoint by construction: each path maps to exactly one tier.
//
// DESIGN NOTE (recorded per docs/plans/M4.md item 3; the runtime consequence
//   items 5/7 implement, NOT here): `core`'s ls-R is built over the FULL combined
//   install, so it OVER-LISTS `academic` paths. When only `core` is mounted, an
//   academic file's kpathsea lookup finds the path in ls-R but the file is absent
//   in MEMFS → a "file not found" — which is exactly the DESIGN.md §5.4(b)
//   missing-file retry trigger. This tool only BUILDS the disjoint bundles; the
//   on-demand mount + retry that consume this property are M4 items 5 and 7.
//
// Hardlinks (not copies): the trees share inodes with the install tree, so
// splitting a multi-hundred-MB install costs only directory entries; file_packager
// reads a hardlink like any regular file. A cross-device fallback copies (EXDEV).
//
// CLI
//   node stage-tiers.mjs --install DIR --tlpdb PATH --out DIR [--json OUT]
//     --install DIR   the combined, pruned install tree (build/texlive-tiers).
//     --tlpdb PATH    the pinned texlive.tlpdb (source/texmfrepo/tlpkg/…).
//     --out DIR       staging root; <out>/<tier>/ trees are (re)created here.
//     --json OUT      also write a small deterministic staging summary as JSON.
//   Writes <out>/tiers.txt (one packaged tier name per line, tier order) — the
//   driver reads it to know which bundles to file_packager. Prints a summary;
//   exits non-zero on a resolver problem (non-disjoint / unresolved) or if a tier
//   the resolver says has files staged none (install ≠ tier definition).
// =============================================================================

import {
  existsSync,
  linkSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTlpdb } from './tlpdb.mjs';
import { resolveTiers } from './resolve.mjs';

function fail(msg) {
  console.error(`\n!! [stage-tiers] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [stage-tiers] ${msg}`);
}

const MiB = 1024 * 1024;
const fmtMiB = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`;

/** Deterministic recursive walk → install-relative POSIX paths of regular files. */
function walkFiles(root) {
  const out = [];
  const skipped = [];
  const rec = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const ent of entries) {
      const full = join(dir, ent.name);
      // Resolve type without following symlinks (lstat): a symlink is NOT a
      // regular file and must not be silently dereferenced into a tier tree.
      const st = ent.isSymbolicLink() ? null : lstatSync(full);
      if (ent.isDirectory()) {
        rec(full);
      } else if (st && st.isFile()) {
        out.push(full);
      } else {
        skipped.push(full);
      }
    }
  };
  rec(root);
  return { files: out, skipped };
}

/** mkdir -p (recursive; idempotent). */
function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

/** Hardlink src→dest (dest parent must exist); copy on a cross-device link. */
function linkOrCopy(src, dest) {
  if (existsSync(dest)) unlinkSync(dest);
  try {
    linkSync(src, dest);
  } catch (e) {
    if (e && e.code === 'EXDEV') copyFileSync(src, dest);
    else throw e;
  }
}

/**
 * Split the install tree at `installDir` into per-tier trees under `outDir`,
 * driven by `resolution.fileToTier`. Returns per-tier { files, bytes } totals in
 * tier order, plus the list of skipped non-regular entries.
 *
 * @param {string} installDir
 * @param {string} outDir
 * @param {import('./resolve.mjs').Resolution} resolution
 */
export function stageTree(installDir, outDir, resolution) {
  const baseTier = resolution.tiers[0].tier; // `core` — the catch-all base tier.
  const order = resolution.tiers.map((t) => t.tier);
  const totals = new Map(order.map((t) => [t, { files: 0, bytes: 0 }]));

  const { files, skipped } = walkFiles(installDir);
  for (const full of files) {
    const rel = relative(installDir, full).split(sep).join('/');
    const tier = resolution.fileToTier.get(rel) ?? baseTier;
    const dest = join(outDir, tier, ...rel.split('/'));
    mkdirp(dirname(dest));
    linkOrCopy(full, dest);
    const acc = totals.get(tier) ?? (totals.set(tier, { files: 0, bytes: 0 }), totals.get(tier));
    acc.files += 1;
    acc.bytes += statSync(full).size;
  }
  return { order, totals, skipped };
}

// --- CLI ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { install: null, tlpdb: null, out: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--install') opts.install = argv[++i];
    else if (a === '--tlpdb') opts.tlpdb = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node stage-tiers.mjs --install DIR --tlpdb PATH --out DIR [--json OUT]');
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  for (const k of ['install', 'tlpdb', 'out']) {
    if (!opts[k]) fail(`missing required --${k}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  for (const [label, p] of [['install tree', opts.install], ['tlpdb', opts.tlpdb]]) {
    if (!existsSync(p)) fail(`${label} not found: ${p}`);
  }
  note(`install: ${opts.install}`);
  note(`tlpdb:   ${opts.tlpdb}`);
  note(`out:     ${opts.out}`);

  const db = parseTlpdb(readFileSync(opts.tlpdb, 'utf8'));
  const resolution = resolveTiers(db);
  if (resolution.unresolved.length > 0) {
    fail(`tlpdb resolution has ${resolution.unresolved.length} unresolved root/dep(s): ${resolution.unresolved.join(', ')}`);
  }
  if (resolution.violations.length > 0) {
    fail(`tier assignment is NOT disjoint: ${resolution.violations.length} cross-tier file collision(s)`);
  }
  note(
    `tlpdb revision ${resolution.tlpdbRevision ?? '?'}, ${resolution.packageCount} packages; ` +
      `${resolution.fileToTier.size} files assigned across ${resolution.tiers.length} tier(s)`,
  );

  // Fresh staging root (the Makefile stamp rule also rm -rf's it; belt + braces).
  if (existsSync(opts.out)) rmSync(opts.out, { recursive: true, force: true });
  mkdirp(opts.out);

  const { order, totals, skipped } = stageTree(opts.install, opts.out, resolution);

  // Report + sanity: every tier the resolver says OWNS files must have staged
  // some (pruning removes docs/src/bin/scripts, so staged < resolver upper bound
  // is expected — but ZERO for a non-empty tier means the install profile did not
  // install that tier's collections, i.e. the install and tiers.mjs disagree).
  console.log('');
  console.log('   tier         files        size');
  console.log('   ----------  -------  -----------');
  const packaged = [];
  for (const tier of order) {
    const staged = totals.get(tier) ?? { files: 0, bytes: 0 };
    const expected = resolution.tiers.find((t) => t.tier === tier);
    console.log(
      `   ${tier.padEnd(10)}  ${String(staged.files).padStart(7)}  ${fmtMiB(staged.bytes).padStart(11)}`,
    );
    if (staged.files > 0) {
      packaged.push(tier);
    } else if (expected && expected.fileCount > 0) {
      fail(
        `tier '${tier}' resolves to ${expected.fileCount} tlpdb file(s) but staged 0 — the ` +
          `install (build/texlive-tiers.profile) did not install its collections. Check that ` +
          `gen-profile.mjs emitted this tier's collections and install-tl succeeded.`,
      );
    }
  }
  if (skipped.length > 0) {
    note(`skipped ${skipped.length} non-regular entr(y/ies) (symlinks/other): e.g. ${skipped.slice(0, 3).map((s) => relative(opts.install, s)).join(', ')}`);
  }

  // The packaged-tier list the driver consumes to know which bundles to build.
  writeFileSync(join(opts.out, 'tiers.txt'), `${packaged.join('\n')}\n`);
  note(`wrote ${join(opts.out, 'tiers.txt')} (${packaged.join(', ')})`);

  if (opts.json) {
    const doc = {
      tlpdbRevision: resolution.tlpdbRevision,
      tiers: order.map((tier) => {
        const s = totals.get(tier) ?? { files: 0, bytes: 0 };
        return { tier, files: s.files, bytes: s.bytes };
      }),
      skipped: skipped.length,
    };
    writeFileSync(opts.json, `${JSON.stringify(doc, null, 2)}\n`);
    note(`wrote ${opts.json}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
