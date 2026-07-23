// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (no
//   imports at all — a pure string→data transform). The INPUT it parses is TeX
//   Live's own package database (`texlive.tlpdb`), which is metadata/data, not
//   third-party CODE — parsing it copies no third-party source. No GPL/AGPL
//   sources and no other WASM-TeX wrapper were consulted; the format handling
//   below is reconstructed from direct inspection of the pinned TL 2026 tlpdb.
//
// =============================================================================
// texlive.tlpdb PARSER (M4 item 2; docs/plans/M4.md)
// -----------------------------------------------------------------------------
// `texlive.tlpdb` is TeX Live's flat package database: blank-line-separated
// STANZAS, one per package/collection/scheme. Each stanza is a set of lines:
//
//   * FIELD lines  — `key value` (key is the first whitespace-delimited token).
//     Repeatable keys (`depend`, `longdesc`, `execute`, `catalogue-also`, …)
//     appear on multiple lines. Single-valued keys (`name`, `category`,
//     `revision`, `shortdesc`, `relocated`, `containersize`, …) appear once.
//   * FILE-LIST headers — `runfiles size=N`, `srcfiles size=N`,
//     `docfiles size=N`, `binfiles arch=A size=N`. Each is followed by its file
//     entries on lines that begin with a SINGLE SPACE. A file entry is
//     ` <path>[ key="value" …]` — only docfiles carry the `details="…"` /
//     `language="…"` annotations in practice, but we defensively take the first
//     whitespace-delimited token as the path regardless (TL paths never contain
//     spaces).
//
// RELOCATION: relocatable packages (`relocated 1`) list their files under a
// `RELOC/` prefix; TL installs those to `texmf-dist/`. We normalize
// `RELOC/<x>` → `texmf-dist/<x>` in `runfiles` so callers see real installed
// texmf paths. Non-relocated packages already list absolute `texmf-dist/…`,
// `texmf-dist/scripts/…`, `tlpkg/…`, etc.; those pass through unchanged.
//
// WHAT WE KEEP vs DROP (deliberate, documented — the resolver needs only the
// runtime file set and the dependency graph):
//   * KEEP: name, category, revision, shortdesc, depends[] (verbatim),
//     runfiles[] (normalized install paths), runsizeBlocks, binaryArchs[],
//     catalogue{} (catalogue-* with the prefix stripped).
//   * DROP the PATH LISTS of srcfiles/docfiles/binfiles (sources, docs, and
//     per-arch native binaries are irrelevant to a WASM engine that ships no
//     native binaries and needs no PDFs/dtx at typeset time). We still record
//     that binfiles EXIST, and for which arch, in `binaryArchs` ("arch-specific
//     binfiles noted, not carried" — M4 item 2). Their file lines are consumed
//     correctly so stanza boundaries are never mis-parsed.
//   * DROP longdesc/execute/postaction/depend-config and other fields not used
//     downstream (still consumed line-by-line; never mis-attributed to files).
//
// SIZE UNIT: `size=N` counts TeX Live blocks of 4096 bytes
// (`TeXLive::TLConfig::BlockSize`), each file rounded up (ceil) — so a sum is a
// conservative UPPER BOUND on real bytes, which is what a size budget wants.
// `BLOCK_SIZE` is exported for callers that turn blocks into an estimate.
//
// This module is pure: `parseTlpdb(text)` allocates no I/O and mutates nothing
// global, so it is trivially testable on crafted fixtures (see tlpdb.test.mjs).
// =============================================================================

/** TeX Live block size in bytes (`TeXLive::TLConfig::BlockSize`). */
export const BLOCK_SIZE = 4096;

/** The `RELOC/` prefix TL uses for relocatable-package file paths. */
export const RELOC_PREFIX = 'RELOC/';

/** The install root relocatable files map onto. */
export const RELOC_TARGET = 'texmf-dist/';

/**
 * One parsed tlpdb stanza.
 *
 * @typedef {Object} TlpdbPackage
 * @property {string} name              stanza `name` (e.g. "siunitx", "collection-latex", "kpathsea.x86_64-linux").
 * @property {string} category          `category` (Package | Collection | Scheme | TLCore | ConTeXt | …).
 * @property {number} revision          `revision` as an integer (0 if absent/unparseable).
 * @property {string} shortdesc         `shortdesc` (empty string if absent).
 * @property {string[]} depends         `depend` targets, VERBATIM (config directives like
 *                                       "revision/78233" and arch metas like "kpathsea.ARCH" are
 *                                       left as-is; the resolver decides what is a real package edge).
 * @property {string[]} runfiles        `runfiles` as installed texmf paths (RELOC/ → texmf-dist/).
 * @property {number} runsizeBlocks     `runfiles size=` in 4096-byte blocks (0 if no runfiles).
 * @property {string[]} binaryArchs     arch tags from each `binfiles arch=…` (paths intentionally dropped).
 * @property {Record<string,string>} catalogue  `catalogue-*` fields, prefix stripped (last value wins if repeated).
 */

const SIZE_RE = /(?:^|\s)size=(\d+)/;
const ARCH_RE = /(?:^|\s)arch=(\S+)/;

/**
 * Parse a full `texlive.tlpdb` document into a name→package map.
 *
 * Robust to the real format: multi-line repeated fields, space-indented file
 * lists with trailing `key="value"` annotations, empty runfiles, per-arch
 * binfiles, relocation, and stanzas whose first line is not `name` (guarded).
 * Order of insertion follows the file; callers that need determinism sort keys.
 *
 * @param {string} text  the entire tlpdb file contents.
 * @returns {Map<string, TlpdbPackage>}  keyed by `name`; a stanza without a
 *   `name` field is skipped (there are none in a valid tlpdb, but we never throw
 *   on one). A duplicate `name` keeps the LAST stanza (matches "last wins").
 */
export function parseTlpdb(text) {
  const db = new Map();
  let stanza = [];

  const flush = () => {
    if (stanza.length > 0) {
      const pkg = parseStanza(stanza);
      if (pkg.name !== '') db.set(pkg.name, pkg);
      stanza = [];
    }
  };

  // Line-based scan: an EMPTY line ends a stanza. File-list entries begin with a
  // space (never empty), so they are never mistaken for a separator. Both `\n`
  // and `\r\n` inputs work: a trailing `\r` on an otherwise-empty line would
  // make it non-empty, so we treat a line that is empty after a trailing-\r trim
  // as a separator too.
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flush();
    } else {
      stanza.push(line);
    }
  }
  flush();

  return db;
}

/**
 * Parse the lines of a single stanza into a {@link TlpdbPackage}.
 * Exported so tests (and future callers) can exercise one stanza in isolation.
 *
 * @param {string[]} lines  stanza lines, no separators, in file order.
 * @returns {TlpdbPackage}
 */
export function parseStanza(lines) {
  /** @type {TlpdbPackage} */
  const pkg = {
    name: '',
    category: '',
    revision: 0,
    shortdesc: '',
    depends: [],
    runfiles: [],
    runsizeBlocks: 0,
    binaryArchs: [],
    catalogue: {},
  };

  // `currentList` is the array file-entry lines flow into (or null to discard,
  // for src/doc/bin whose paths we drop). Reset to null on every field line.
  /** @type {string[] | null} */
  let currentList = null;

  for (const line of lines) {
    if (line.charCodeAt(0) === 32 /* space */) {
      if (currentList !== null) currentList.push(fileEntryPath(line));
      continue;
    }

    currentList = null;
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);

    switch (key) {
      case 'name':
        pkg.name = value;
        break;
      case 'category':
        pkg.category = value;
        break;
      case 'revision': {
        const n = Number.parseInt(value, 10);
        pkg.revision = Number.isFinite(n) ? n : 0;
        break;
      }
      case 'shortdesc':
        pkg.shortdesc = value;
        break;
      case 'depend':
        pkg.depends.push(value);
        break;
      case 'runfiles':
        currentList = pkg.runfiles;
        pkg.runsizeBlocks = parseSizeBlocks(value);
        break;
      case 'srcfiles':
      case 'docfiles':
        // Consume the file list but discard the paths (not needed downstream).
        currentList = null;
        break;
      case 'binfiles': {
        // Note the arch; drop the native binary paths (a WASM engine ships none).
        const m = ARCH_RE.exec(value);
        if (m) pkg.binaryArchs.push(m[1]);
        currentList = null;
        break;
      }
      default:
        if (key.startsWith('catalogue-')) {
          pkg.catalogue[key.slice('catalogue-'.length)] = value;
        }
      // else: relocated / containersize / containerchecksum / longdesc /
      // execute / postaction / … — intentionally ignored (still consumed as a
      // field line, so the next file list is never mis-attributed).
    }
  }

  return pkg;
}

/**
 * Extract the installed path from a file-list entry line.
 * `" RELOC/tex/latex/x/x.sty"` → `"texmf-dist/tex/latex/x/x.sty"`;
 * `" texmf-dist/scripts/a2ping/a2ping.pl details=\"…\""` → the path token only.
 *
 * @param {string} line  a file-entry line (leading space already known present).
 * @returns {string}
 */
export function fileEntryPath(line) {
  // First whitespace-delimited token after the leading indent = the path
  // (TL paths never contain spaces; trailing key="value" annotations drop off).
  const path = line.trim().split(/\s+/, 1)[0];
  return path.startsWith(RELOC_PREFIX) ? RELOC_TARGET + path.slice(RELOC_PREFIX.length) : path;
}

/**
 * Parse the block count out of a `size=N` header value; 0 if absent.
 * @param {string} value  e.g. "size=163" or "arch=windows size=36".
 * @returns {number}
 */
export function parseSizeBlocks(value) {
  const m = SIZE_RE.exec(value);
  return m ? Number.parseInt(m[1], 10) : 0;
}
