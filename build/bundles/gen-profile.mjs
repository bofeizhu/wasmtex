#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (imports
//   only the sibling tier definition). No GPL/AGPL sources and no other WASM-TeX
//   wrapper were consulted.
//
// =============================================================================
// INSTALL-TL PROFILE COLLECTION EMITTER (M4 item 3; docs/plans/M4.md)
// -----------------------------------------------------------------------------
// Emits the `install-tl` profile COLLECTION-selection lines for the single
// combined install that item 3's multi-bundle build performs — one install-tl
// run covering EVERY shipped tier's collections, later split into disjoint
// per-tier bundles by stage-tiers.mjs.
//
// It prints one `<collection>  1` line per DISTINCT collection across all tiers
// in build/bundles/tiers.mjs (sorted, deduplicated). The Makefile's
// `build/texlive-tiers.profile` rule owns the rest of the profile (the
// `selected_scheme` + the TEXDIR/TEXMF* absolute paths, which depend on the work
// tree) and APPENDS this output. Consequence: adding a tier or a collection to a
// tier is a tiers.mjs edit — never a Makefile edit (the plan's "config, not
// rework" invariant). Regenerating the profile from a changed tiers.mjs triggers
// a reinstall via the Makefile's normal prerequisite tracking.
//
// SCOPE — collections only. `install-tl` profiles select SCHEMES and COLLECTIONS,
// not individual leaf packages, so a tier's `extraPackages` are NOT emitted here.
// Every current extraPackage is reachable through a selected collection's `depend`
// graph (e.g. `fandol` via `collection-langchinese`), so install-tl pulls it in
// regardless; the resolver still assigns its files to the owning tier. If a future
// extraPackage is NOT collection-reachable it would silently miss the install —
// stage-tiers.mjs' per-tier file counts (and the conformance corpus) are the
// backstop that would surface it.
//
// CLI
//   node gen-profile.mjs            print the `<collection>  1` lines to stdout.
//   node gen-profile.mjs --help
// =============================================================================

import { pathToFileURL } from 'node:url';
import { TIERS } from './tiers.mjs';

const compareStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The DISTINCT collection roots across every tier, sorted for determinism.
 * @param {ReadonlyArray<import('./tiers.mjs').TierDef>} [tiers]
 * @returns {string[]}
 */
export function profileCollections(tiers = TIERS) {
  return [...new Set(tiers.flatMap((t) => t.collections))].sort(compareStr);
}

/**
 * Render the install-tl profile collection block: one `<collection>  1` per
 * collection. No trailing blank line; the caller appends to an existing profile.
 * @param {ReadonlyArray<import('./tiers.mjs').TierDef>} [tiers]
 * @returns {string}
 */
export function profileBlock(tiers = TIERS) {
  return profileCollections(tiers)
    .map((c) => `${c}  1`)
    .join('\n');
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === '-h' || arg === '--help') {
    console.log('Usage: node gen-profile.mjs   # print install-tl collection lines from tiers.mjs');
    process.exit(0);
  }
  process.stdout.write(`${profileBlock()}\n`);
}
