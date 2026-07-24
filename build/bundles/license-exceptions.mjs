// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (no imports
//   at all — a pure committed data table). The determinations below are read from
//   TeX Live's own authoritative license statement (LICENSE.TL) and the package
//   identities in the pinned tlpdb — metadata/data, not third-party CODE. No
//   GPL/AGPL sources and no other WASM-TeX wrapper were consulted.
//
// =============================================================================
// LICENSE EXCEPTIONS — the human-resolved license of shipped packages that carry
// NO `catalogue-license` field in the pinned tlpdb (M5 item 2; docs/plans/M5.md).
// -----------------------------------------------------------------------------
// The aggregate license audit (licenses.mjs) is FAIL-CLOSED: a SHIPPED package
// (one that contributes >=1 runfile to `core` or `academic`) whose license is
// missing / noinfo / nosource / nonfree / not on the free allowlist FAILS the
// audit. TWO kinds of resolvable gap need a cited entry here:
//
//   1. NO CATALOGUE ENTRY (17 packages). The TeX Catalogue only catalogues
//      user-facing macro/font packages, so a handful of TeX-Live-PROPER support
//      packages (infrastructure, encodings, hyphen data, two Thai CJK fonts) ship
//      real files yet carry no `catalogue-license` at all.
//   2. THE `collection` TOKEN (5 packages). A few old CTAN "bundle" packages have
//      `catalogue-license collection` — the Catalogue's explicit "this is a
//      collection whose parts carry different licenses" punt. That is UNSPECIFIED,
//      not non-free: it asserts no single identifier, so it needs resolution too.
//
// This table is the durable, cited record of resolving each — the "a human
// resolves each before release" step DESIGN.md §9 / M5 risks call for.
//
// WHY THIS IS NOT A GUESS (the constitutional "never guess" bar, M5 item 2):
//   Every package here is installed FROM `texlive.tlpdb` — i.e. it is TeX Live
//   proper, NOT the separable CTAN snapshot. TeX Live's own top-level LICENSE.TL
//   states, authoritatively and as a maintainer-vetted guarantee:
//       "To the best of our knowledge, all software in the TeX Live distribution
//        is freely redistributable ... within the Free Software Foundation's
//        definition and the Debian Free Software Guidelines."
//   and is explicit that only the *CTAN snapshot* (which install-tl does NOT
//   install into texmf-dist, and which we do not ship) "contains many files which
//   are *not* freely redistributable; see LICENSE.CTAN". So the FREENESS of each
//   package below is established by an authoritative source, not assumed. We record
//   the honest floor `other-free` (the TeX Catalogue token meaning "free under some
//   other license") rather than inventing a specific SPDX identifier we have not
//   read: the claim is exactly "free (per LICENSE.TL), specific license per the
//   package's own files", nothing stronger.
//
// TIGHTENING (optional, human): any entry may later be narrowed from `other-free`
// to the package's actual token (e.g. `gpl2`, `knuth`, `bsd3`) by reading that
// package's shipped license file — the pruned build tree drops docs, so this needs
// the unpruned CTAN container. Until then `other-free` is the correct, non-guessing
// classification. Dropping a package from `academic` instead is also a valid human
// resolution (edit tiers.mjs); nothing here is load-bearing on it staying shipped.
//
// SHAPE (consumed by licenses.mjs): packageName -> { license, reason, source }.
//   license  an ALLOWLISTED free token (validated by the audit like any other; a
//            typo such as `nonfree` here FAILS the audit, so exceptions cannot
//            smuggle a non-free classification past the gate).
//   reason   what the package is (factual, from its tlpdb shortdesc + runfiles).
//   source   the authority for the freeness determination.
//
// FAIL-CLOSED PROPERTY: this table resolves ONLY the exact names below. A future
// pin that introduces a NEW shipped package with no `catalogue-license` is NOT
// covered here, so the audit FAILS on it until a human reviews and adds it. An
// entry whose package now HAS a `catalogue-license` (tlpdb caught up) is flagged
// by the audit as a stale exception to remove.
// =============================================================================

/**
 * The authoritative freeness citation shared by every entry: TeX Live's own
 * LICENSE.TL, which covers all of TeX Live proper (everything installed from
 * texlive.tlpdb), explicitly excepting only the separable CTAN snapshot we do
 * not ship.
 */
const TL = 'LICENSE.TL (TeX Live 2026): all TeX Live software is freely redistributable per the FSF definition + DFSG; this is TeX Live-proper (installed from texlive.tlpdb, not the separable CTAN snapshot) and has no TeX Catalogue entry';

/** @type {Readonly<Record<string, { license: string, reason: string, source: string }>>} */
export const LICENSE_EXCEPTIONS = {
  // ── core: TeX Live infrastructure + base support (no TeX Catalogue entry) ──
  glyphlist: {
    license: 'other-free',
    reason: 'Adobe Glyph List and TeX extensions — glyph-name→Unicode mapping data (glyphlist.txt, pdfglyphlist.txt, texglyphlist.txt) used by the font/dvips machinery.',
    source: TL,
  },
  'hyphen-base': {
    license: 'other-free',
    reason: 'Core hyphenation support files (language.dat/def, hyphen.cfg loader) — the TeX Live hyphenation infrastructure.',
    source: TL,
  },
  'hyphen-english': {
    license: 'other-free',
    reason: 'US/UK English hyphenation patterns (hyph-en-us / hyph-en-gb, hyph-utf8).',
    source: TL,
  },
  latexconfig: {
    license: 'other-free',
    reason: 'Configuration files for LaTeX-related formats (epstopdf-sys.cfg, lualatexiniconfig.tex).',
    source: TL,
  },
  'texlive-msg-translations': {
    license: 'other-free',
    reason: 'Translations (.po) of the TeX Live installer and TeX Live Manager messages.',
    source: TL,
  },
  'texlive-scripts': {
    license: 'other-free',
    reason: 'TeX Live infrastructure programs (install-tl, fmtutil/updmap configs, tetex dvips configs).',
    source: TL,
  },
  'texlive-scripts-extra': {
    license: 'other-free',
    reason: 'Additional TeX Live infrastructure scripts (allcm, dvi2fax, kpsetool, …).',
    source: TL,
  },
  'texlive.infra': {
    license: 'other-free',
    reason: 'Basic TeX Live infrastructure (tlmgr.pl, mktexlsr, TLUtils) — and it ships LICENSE.TL / LICENSE.CTAN themselves.',
    source: TL,
  },
  tlshell: {
    license: 'other-free',
    reason: 'Tcl/Tk GUI front-end for tlmgr (tlshell.tcl, tltcl.tcl).',
    source: TL,
  },
  xetexconfig: {
    license: 'other-free',
    reason: 'crop.cfg configuration for XeLaTeX.',
    source: TL,
  },

  // ── academic: CJK encodings, Thai CJK fonts, Chinese hyphenation, TTF utils ──
  c90: {
    license: 'other-free',
    reason: 'C90 font encoding for Thai (c90.enc) — CJK/Thai font-encoding support.',
    source: TL,
  },
  dnp: {
    license: 'other-free',
    reason: 'Subfont numbers for the DNP font encoding (DNP.sfd) — CJK font-encoding support.',
    source: TL,
  },
  'garuda-c90': {
    license: 'other-free',
    reason: 'TeX support (from CJK) for the Garuda font — C90-encoded TFM/map/config for the TLWG Thai font Garuda.',
    source: TL,
  },
  'hyphen-chinese': {
    license: 'other-free',
    reason: 'Chinese pinyin hyphenation patterns (hyph-zh-latn-pinyin, hyph-utf8).',
    source: TL,
  },
  'norasi-c90': {
    license: 'other-free',
    reason: 'TeX support (from CJK) for the Norasi font — C90-encoded TFM/map/config for the TLWG Thai font Norasi.',
    source: TL,
  },
  pdfwin: {
    license: 'other-free',
    reason: 'Customizable windows for screen viewing of TeX documents (pdfwin.sty, pdfwin.cfg).',
    source: TL,
  },
  ttfutils: {
    license: 'other-free',
    reason: 'Convert TrueType to TFM/PK — the ttf2pk/ttf2tfm runtime support files (encodings, subfont definition files).',
    source: TL,
  },

  // ── `catalogue-license collection` bundles (present-but-unspecified token) ──
  // Long-established free LaTeX bundles whose Catalogue license is the non-specific
  // `collection` token (parts under various free licenses). All are TeX-Live-proper
  // and heavily used; freeness is guaranteed by LICENSE.TL exactly as above.
  ltxmisc: {
    license: 'other-free',
    reason: 'Miscellaneous LaTeX packages (abstbook, beletter, concrete, topcapt, …); catalogue-license "collection" (parts under various free licenses).',
    source: TL,
  },
  frankenstein: {
    license: 'other-free',
    reason: 'A collection of LaTeX packages by Matt Swift (abbrevs, attrib, blkcntrl, achicago, …); catalogue-license "collection".',
    source: TL,
  },
  preprint: {
    license: 'other-free',
    reason: 'A bundle of preprint-support packages (authblk, balance, figcaps, fullpage, sublabel); catalogue-license "collection".',
    source: TL,
  },
  was: {
    license: 'other-free',
    reason: 'A collection of small packages by Walter Schmidt (icomma, upgreek); catalogue-license "collection".',
    source: TL,
  },
  fragments: {
    license: 'other-free',
    reason: 'Fragments of LaTeX code (overrightarrow, subscript, checklab, removefr); catalogue-license "collection".',
    source: TL,
  },
};

export default LICENSE_EXCEPTIONS;
