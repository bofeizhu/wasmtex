// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   ORIGINAL implementation of the §5.4 automatic bundle-resolution helpers. The
//   \usepackage/\RequirePackage grammar scanned here is public LaTeX syntax;
//   nothing was read, copied, or adapted from busytex or any other TeX/WASM
//   wrapper (no GPL/AGPL source consulted). Not derived from any third-party
//   source.
//
// ---------------------------------------------------------------------------
// The §5.4 bundle-resolution helpers (M4 items 6–7) — PURE and total: no engine,
// no filesystem, no `self`/`postMessage`/`fetch`/DOM, only TYPES + the pure
// `bundleProvidingPackage` data accessor from the protocol. The worker
// (worker/core.ts) drives these to decide which on-demand tier to mount, then
// calls its host seam; all engine/FS side effects live in the caller.
//
// Two halves of one mechanism (DESIGN.md §5.4):
//   (a) scanRequiredPackages + selectBundlesForPackages — the static
//       \usepackage/\RequirePackage scan → provided-package index → preselect the
//       matching on-demand tier BEFORE the first pass (an OPTIMISATION to avoid a
//       failed probe pass).
//   (b) selectBundlesForMissingFiles — the missing-file retry's tier chooser: a
//       pass that failed naming not-found files → the un-handled on-demand tier(s)
//       to mount and retry (the CORRECTNESS net for anything the scan can't see).
//
// LOAD-BEARING POLICY (M4 item-4 review): the manifest `provides` is a
// package-NAME index, not a filename index. A scanned name that MATCHES an
// on-demand tier's provides preselects it; an UNMATCHED name is "unknown → do
// nothing" — it must NOT pull an on-demand tier. Many core packages ship a `.sty`
// whose name is not a provided-package name (longtable/graphicx/amssymb come from
// tools/graphics/amsfonts), so a "load academic on any unmatched name" rule would
// download the ~496 MB tier for a core-served document. Unmatched names fall
// through to the (b) retry, which — with ONE on-demand tier — needs no index.
// ---------------------------------------------------------------------------

import { bundleProvidingPackage } from '../src/protocol';
import type { AssetsInventory, ProjectFile, ProjectFiles } from '../src/protocol';

/**
 * File extensions the static scan reads as TeX SOURCE. Best-effort: a package
 * pulled from a file with a different extension (a `\input`'d `.cfg`, a generated
 * file) is deliberately NOT scanned and instead falls through to the §5.4(b)
 * missing-file retry — that split is what lets the retry be tested independently
 * of the scan.
 */
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set(['tex', 'ltx', 'sty', 'cls', 'def', 'clo']);

/** Cap on distinct scanned package names (bounds a hostile source of endless `\usepackage`). */
export const MAX_SCANNED_NAMES = 256;

const decoder = new TextDecoder();

/** A project file's text, decoding a `Uint8Array` as UTF-8; `null` for neither. */
function asText(value: ProjectFile | undefined): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return decoder.decode(value);
  return null;
}

/** Last `/`-segment of a path, lowercased (paths are project-relative). */
function basenameLower(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/** Lowercased extension (no dot) of a path, or `''` for a bare/dotfile name. */
function extensionOf(path: string): string {
  const base = basenameLower(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1);
}

/**
 * Cut a source line at its first UNESCAPED TeX comment (`%`), honouring `\%`. A
 * fully commented `%\usepackage{…}` line yields `''` (no match); an inline
 * `\usepackage{x} % note` keeps the declaration and drops the note.
 */
function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++; // skip the escaped char (covers `\%`, which is NOT a comment)
      continue;
    }
    if (c === '%') return line.slice(0, i);
  }
  return line;
}

// `\usepackage[opts]{a,b,c}` / `\RequirePackage[opts]{a,b,c}` — single-line,
// best-effort. The optional `[…]` (which never contains `]`) is skipped; the
// mandatory `{…}` (a comma list; package names never contain `}`) is captured.
// The trailing `\s*` lives INSIDE the optional group (not `(?:…)?\s*`): the
// `\s*(?:…)?\s*` form backtracks quadratically on a `\usepackage` + long-
// whitespace hostile input (host-supplied files reach this before pass 1); this
// form is linear and grammar-identical, including `[opt] {a,b}`.
const PACKAGE_DECL = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

/**
 * Scan project SOURCE for the package names it loads via `\usepackage` /
 * `\RequirePackage` (DESIGN.md §5.4(1)). Pure and total; deduplicated,
 * order-preserving (entry first, then other source files in `files` order),
 * {@link MAX_SCANNED_NAMES}-capped.
 *
 * Deliberately PARTIAL — an OPTIMISATION, not the correctness path. It is
 * single-line, strips comments, and reads only {@link SCAN_EXTENSIONS} files (plus
 * the entry, whatever its extension). Names hidden behind a macro, a multi-line
 * optional argument, or an `\input` of a non-source file fall through to the
 * §5.4(b) missing-file retry. It scans project-local `.sty`/`.cls` too (their own
 * `\RequirePackage` lines may pull an on-demand package); it is
 * {@link selectBundlesForPackages} that skips a name a project file PROVIDES.
 */
export function scanRequiredPackages(files: ProjectFiles, entry: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const addFrom = (content: string): void => {
    for (const rawLine of content.split(/\r\n|\r|\n/)) {
      if (out.length >= MAX_SCANNED_NAMES) return;
      if (!rawLine.includes('\\')) continue; // no command on this line — cheap skip
      const line = stripTexComment(rawLine);
      PACKAGE_DECL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PACKAGE_DECL.exec(line)) !== null) {
        for (const raw of (m[1] ?? '').split(',')) {
          const name = raw.trim();
          if (name.length === 0 || seen.has(name)) continue;
          if (out.length >= MAX_SCANNED_NAMES) return;
          seen.add(name);
          out.push(name);
        }
      }
    }
  };

  // The entry is always scanned (any extension); other files only when a source
  // extension, so a large binary input (a font) is never decoded/scanned.
  const entryText = asText(files[entry]);
  if (entryText !== null) addFrom(entryText);
  for (const [path, content] of Object.entries(files)) {
    if (path === entry) continue;
    if (!SCAN_EXTENSIONS.has(extensionOf(path))) continue;
    const text = asText(content);
    if (text !== null) addFrom(text);
  }
  return out;
}

/** The lowercased basenames of the project's own `.sty`/`.cls` files (host-supplied packages). */
function projectLocalStyleBasenames(files: ProjectFiles): Set<string> {
  const set = new Set<string>();
  for (const path of Object.keys(files)) {
    const base = basenameLower(path);
    if (base.endsWith('.sty') || base.endsWith('.cls')) set.add(base);
  }
  return set;
}

/**
 * Resolve scanned package `names` to the on-demand tier(s) to PRESELECT
 * (DESIGN.md §5.4(1), item 6). Returns a deduplicated, order-preserving list of
 * on-demand bundle names — those that (1) are not provided by a project-local
 * `.sty`/`.cls`, (2) MATCH an on-demand tier's provided-package index, and (3) are
 * not already handled this session.
 *
 * The UNKNOWN-NAME POLICY is enforced structurally by
 * {@link bundleProvidingPackage} returning `undefined` for a name in no tier's
 * `provides`: such a name is skipped (do nothing), never mapped to a default tier.
 * Only bundles named in `onDemand` are eligible — a package a PRELOAD tier already
 * provides resolves to that tier and is skipped (it is not in `onDemand`).
 */
export function selectBundlesForPackages(
  names: readonly string[],
  inventory: AssetsInventory,
  files: ProjectFiles,
  onDemand: readonly string[],
  handled: ReadonlySet<string>,
): string[] {
  const onDemandSet = new Set(onDemand);
  const local = projectLocalStyleBasenames(files);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    // Host supplied this package as a project-local .sty/.cls — resolves locally,
    // so never pull a tier for it (guards a local file SHADOWING a tier package).
    if (local.has(`${lower}.sty`) || local.has(`${lower}.cls`)) continue;
    const bundle = bundleProvidingPackage(inventory, name);
    if (bundle === undefined) continue; // UNKNOWN → do nothing (item-4 policy)
    if (!onDemandSet.has(bundle)) continue; // not an opted-in on-demand tier (e.g. a preload tier)
    if (handled.has(bundle) || seen.has(bundle)) continue;
    seen.add(bundle);
    out.push(bundle);
  }
  return out;
}

/**
 * Choose the on-demand tier(s) to mount for a pass that FAILED naming missing
 * files (DESIGN.md §5.4(2), item 7). Returns the not-yet-handled on-demand
 * bundles, deduplicated in `onDemand` order.
 *
 * With ONE on-demand tier the mapping is trivial and needs no index: any genuine
 * miss could be in it, so load every un-handled on-demand tier and retry once.
 * This is a SOUND over-approximation — a missing file whose basename is NOT its
 * package name (a `.fd`, `.tfm`, a `-abbreviations.cfg`) still resolves once the
 * tier mounts, which a package-NAME shortcut on `missingFiles` would get wrong.
 *
 * GENERALISATION (≥2 on-demand tiers, a future `full`): replace the blanket load
 * with a filename→bundle index (resolve.mjs already computes package→`.sty`; carry
 * it into the manifest) that consults `missingFiles` to load ONLY the tier(s) that
 * could supply them. The signature already takes `missingFiles` for that.
 */
export function selectBundlesForMissingFiles(
  missingFiles: readonly string[],
  onDemand: readonly string[],
  handled: ReadonlySet<string>,
): string[] {
  if (missingFiles.length === 0) return []; // nothing missing ⇒ nothing to load
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of onDemand) {
    if (handled.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
