// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Unit tests for the pure §5.4 bundle-resolution helpers (M4 items 6–7): the
// static \usepackage/\RequirePackage scan and the two tier-selection functions.
// No engine, no worker — pure string/data functions, so the scan grammar and the
// LOAD-BEARING unknown-name policy are pinned deterministically here, apart from
// the core's orchestration (worker-core.test.ts drives the whole loop).

import { describe, expect, it } from 'vitest';
import {
  scanRequiredPackages,
  selectBundlesForMissingFiles,
  selectBundlesForPackages,
} from '../worker/bundle-resolution';
import type { AssetsInventory, ProjectFiles } from '../src/protocol';

// A manifest inventory whose per-bundle `provides` index the scan resolves
// against. `longtable`/`graphicx` are DELIBERATELY absent from every list (they
// ship in core but their NAMES are not provided-package names — the unknown-name
// policy fixture, matching the real dist/manifest.json).
const INVENTORY: AssetsInventory = {
  schemaVersion: 2,
  assets: [{ path: 'core.js', role: 'bundle-js' }],
  bundles: [
    { name: 'core', provides: ['latex', 'amsmath', 'geometry', 'natbib'] },
    { name: 'academic', provides: ['siunitx', 'ctex', 'xeCJK', 'mathtools', 'fandol'] },
    { name: 'texlive-basic', aliasOf: 'core' },
  ],
};

const tex = (body: string): ProjectFiles => ({ 'main.tex': body });

// ---------------------------------------------------------------------------
// scanRequiredPackages
// ---------------------------------------------------------------------------

describe('scanRequiredPackages', () => {
  it('captures a single \\usepackage', () => {
    expect(scanRequiredPackages(tex('\\usepackage{siunitx}'), 'main.tex')).toEqual(['siunitx']);
  });

  it('splits a comma list and trims whitespace', () => {
    expect(scanRequiredPackages(tex('\\usepackage{amsmath, amssymb ,mathtools}'), 'main.tex')).toEqual([
      'amsmath',
      'amssymb',
      'mathtools',
    ]);
  });

  it('skips an optional argument and captures the mandatory list', () => {
    expect(scanRequiredPackages(tex('\\usepackage[a4paper,margin=1in]{geometry}'), 'main.tex')).toEqual([
      'geometry',
    ]);
  });

  it('captures \\RequirePackage as well', () => {
    expect(scanRequiredPackages(tex('\\RequirePackage{fix-cm}'), 'main.tex')).toEqual(['fix-cm']);
  });

  it('handles multiple declarations across lines, deduplicated in first-seen order', () => {
    const doc = '\\usepackage{siunitx}\n\\usepackage{tikz}\n\\usepackage{siunitx}\n';
    expect(scanRequiredPackages(tex(doc), 'main.tex')).toEqual(['siunitx', 'tikz']);
  });

  it('ignores a fully commented-out line', () => {
    expect(scanRequiredPackages(tex('% \\usepackage{siunitx}'), 'main.tex')).toEqual([]);
  });

  it('keeps a declaration before an inline comment', () => {
    expect(scanRequiredPackages(tex('\\usepackage{siunitx} % SI units'), 'main.tex')).toEqual(['siunitx']);
  });

  it('does not treat an escaped \\% as a comment', () => {
    // The `\%` is a literal percent, not a comment — the declaration still counts.
    expect(scanRequiredPackages(tex('\\usepackage{siunitx}\\% 50\\% done'), 'main.tex')).toEqual(['siunitx']);
  });

  it('scans a hostile long line in linear time (no ReDoS)', () => {
    // A `\usepackage` followed by a megabyte of whitespace with no `{` is the
    // quadratic-backtracking trap for the `\s*(?:[…])?\s*` regex form; the fixed
    // form is linear. Host-supplied files reach the scan before pass 1, so this
    // must not burn worker CPU. Linear is ~single-digit ms; the old form took
    // ~30 min at 1 MB — a 2 s bound cleanly separates them even on a slow runner.
    const hostile = `\\usepackage${' '.repeat(1_000_000)}`;
    const start = Date.now();
    expect(scanRequiredPackages(tex(hostile), 'main.tex')).toEqual([]);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('scans the entry plus other TeX-source files, in entry-first order', () => {
    const files: ProjectFiles = {
      'main.tex': '\\usepackage{siunitx}\n\\input{pre}',
      'pre.sty': '\\RequirePackage{mathtools}',
      'refs.bib': '@book{x, title={\\usepackage{fake}}}', // .bib is not scanned
    };
    expect(scanRequiredPackages(files, 'main.tex')).toEqual(['siunitx', 'mathtools']);
  });

  it('does not scan a non-source extension (an \\input .cfg falls to the retry)', () => {
    const files: ProjectFiles = {
      'main.tex': '\\input{setup.cfg}\n',
      'setup.cfg': '\\usepackage{siunitx}\n', // .cfg deliberately NOT scanned
    };
    expect(scanRequiredPackages(files, 'main.tex')).toEqual([]);
  });

  it('scans the entry regardless of its extension', () => {
    expect(scanRequiredPackages({ 'doc.ltx': '\\usepackage{siunitx}' }, 'doc.ltx')).toEqual(['siunitx']);
  });

  it('decodes a Uint8Array source (bytes, not string)', () => {
    const bytes = new TextEncoder().encode('\\usepackage{siunitx}');
    expect(scanRequiredPackages({ 'main.tex': bytes }, 'main.tex')).toEqual(['siunitx']);
  });

  it('returns [] for a document with no package declarations', () => {
    expect(scanRequiredPackages(tex('\\documentclass{article}\\begin{document}x\\end{document}'), 'main.tex')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// selectBundlesForPackages — the §5.4(a) resolver + unknown-name policy
// ---------------------------------------------------------------------------

const NONE: ReadonlySet<string> = new Set();
const CORE_HANDLED: ReadonlySet<string> = new Set(['core']);

describe('selectBundlesForPackages', () => {
  it('selects the on-demand tier that provides a scanned name', () => {
    expect(selectBundlesForPackages(['siunitx'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual(['academic']);
  });

  it('resolves case-insensitively (\\usepackage{xeCJK} → tlpdb `xeCJK`)', () => {
    expect(selectBundlesForPackages(['xecjk'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual(['academic']);
  });

  it('does NOTHING for an unmatched name (longtable ∉ provides) — the load-bearing policy', () => {
    // longtable is served by core but is not a provided-package NAME anywhere; a
    // "not in core ⇒ load academic" rule would download the whole tier.
    expect(selectBundlesForPackages(['longtable'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual([]);
    expect(selectBundlesForPackages(['graphicx'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual([]);
  });

  it('does not select a tier that is not in the on-demand set (a preload-provided package)', () => {
    // natbib is provided by core (a preload tier), so it is never an on-demand load.
    expect(selectBundlesForPackages(['natbib'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual([]);
  });

  it('skips a name the host supplied as a project-local .sty (local shadow of a tier package)', () => {
    const files: ProjectFiles = { 'siunitx.sty': '% local override' };
    expect(selectBundlesForPackages(['siunitx'], INVENTORY, files, ['academic'], CORE_HANDLED)).toEqual([]);
  });

  it('skips a name provided by a project-local .cls too', () => {
    const files: ProjectFiles = { 'ctex.cls': '% local' };
    expect(selectBundlesForPackages(['ctex'], INVENTORY, files, ['academic'], CORE_HANDLED)).toEqual([]);
  });

  it('skips an already-handled tier (idempotent within a session)', () => {
    const handled = new Set(['core', 'academic']);
    expect(selectBundlesForPackages(['siunitx'], INVENTORY, {}, ['academic'], handled)).toEqual([]);
  });

  it('deduplicates when several names map to the same tier', () => {
    expect(selectBundlesForPackages(['siunitx', 'mathtools', 'ctex'], INVENTORY, {}, ['academic'], CORE_HANDLED)).toEqual(
      ['academic'],
    );
  });

  it('returns [] when the manifest carries no bundles index (assets.json fallback)', () => {
    const bare: AssetsInventory = { assets: [] };
    expect(selectBundlesForPackages(['siunitx'], bare, {}, ['academic'], NONE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// selectBundlesForMissingFiles — the §5.4(b) tier chooser
// ---------------------------------------------------------------------------

describe('selectBundlesForMissingFiles', () => {
  it('returns the un-handled on-demand tiers when files are missing (one-tier: academic)', () => {
    expect(selectBundlesForMissingFiles(['siunitx.sty'], ['academic'], CORE_HANDLED)).toEqual(['academic']);
  });

  it('returns [] when nothing is missing (no needless download)', () => {
    expect(selectBundlesForMissingFiles([], ['academic'], CORE_HANDLED)).toEqual([]);
  });

  it('returns [] once every on-demand tier is handled (the retry BOUND)', () => {
    const handled = new Set(['core', 'academic']);
    expect(selectBundlesForMissingFiles(['nosuch.sty'], ['academic'], handled)).toEqual([]);
  });

  it('is sound for a missing file whose basename is not a package name (a .fd/.tfm)', () => {
    // The chooser ignores the specific names (no filename index yet) and loads the
    // tier anyway — a font-descriptor miss still resolves after academic mounts.
    expect(selectBundlesForMissingFiles([' t1lmr.fd', 'cmr10.tfm'], ['academic'], CORE_HANDLED)).toEqual(['academic']);
  });

  it('deduplicates a repeated on-demand name', () => {
    expect(selectBundlesForMissingFiles(['x.sty'], ['academic', 'academic'], CORE_HANDLED)).toEqual(['academic']);
  });
});
