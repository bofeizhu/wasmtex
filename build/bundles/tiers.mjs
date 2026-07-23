// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM. The
//   collection choices below are a PRODUCT decision recorded in DESIGN.md /
//   docs/plans/M4.md — reconstructed from TeX Live's public collection names,
//   copying no third-party code and consulting no other WASM-TeX wrapper.
//
// =============================================================================
// TIER DEFINITION — the committed data that says which TeX Live collections
// land in which bundle (M4 item 2; docs/plans/M4.md "Design decisions").
// -----------------------------------------------------------------------------
// This is CONFIG, not logic: adding a package or collection to a tier, or adding
// a whole new tier, is an edit here — never a change to the resolver. The plan
// is explicit that "adding to a tier later is config, not rework", so the
// machinery in resolve.mjs stays N-tier-general and reads this list verbatim.
//
// SHAPE: an ORDERED array of tiers, `core` FIRST. Order is load-significant and
// disjointness-significant: the resolver assigns every file/package to the FIRST
// tier (in this order) whose roots reach it, so a later tier carries only what
// earlier tiers did not. `core` is always preloaded; later tiers are on-demand.
//
//   { name, collections: string[], extraPackages: string[] }
//     name          bundle name (also the file_packager stem in item 3).
//     collections   tlpdb Collection/Scheme roots pulled into this tier; the
//                   resolver expands each transitively via `depend`.
//     extraPackages individual leaf packages to add beyond the collections
//                   (for one-off inclusions that no chosen collection carries).
//
// Every name here is verified to exist in the pinned TL 2026 tlpdb by
// resolve.test.mjs (an unknown root would otherwise silently contribute
// nothing). If TeX Live renames a collection in a future pin, this file — not
// the resolver — is where the rename is recorded.
// =============================================================================

/**
 * @typedef {Object} TierDef
 * @property {string} name                 bundle name / file_packager stem.
 * @property {string[]} collections        Collection/Scheme roots (expanded transitively).
 * @property {string[]} extraPackages      extra leaf packages beyond the collections.
 */

/** @type {ReadonlyArray<TierDef>} */
export const TIERS = [
  {
    // ── core ────────────────────────────────────────────────────────────────
    // Reproduces exactly what today's `texlive-basic` bundle installs:
    //   install-tl  scheme-basic  collection-xetex  collection-latex
    // `scheme-basic` is `collection-basic` + `collection-latex` (confirmed in the
    // pinned TL2026 tlpdb during item-2 review), so we enumerate the three
    // Collections directly here to keep `collections` homogeneous (Collections
    // only, no Schemes). The resolved package/file closure is identical to the
    // scheme-based invocation above. Always preloaded (DESIGN §5.4).
    name: 'core',
    collections: ['collection-basic', 'collection-latex', 'collection-xetex'],
    extraPackages: [],
  },
  {
    // ── academic ──────────────────────────────────────────────────────────────
    // The scientific-journal + CJK working set (user target, 2026-07-24). Strictly
    // ADDITIVE over core: its files are academic's package closure MINUS anything
    // core already carries. On-demand, not preloaded.
    //   collection-latexrecommended  babel, natbib, psnfss (journal citation base)
    //   collection-mathscience       mathtools, siunitx, physics, unicode-math (journal math)
    //   collection-latexextra        geometry, hyperref, booktabs, microtype, listings,
    //                                AND the journal classes (IEEEtran, elsarticle, revtex4, achemso…)
    //   collection-pictures          tikz/pgf/pgfplots (scientific figures)
    //   collection-fontsrecommended  Latin Modern, TeX Gyre
    //   collection-langchinese       ctex, xeCJK, zhnumber, ctexart/book (XeTeX Chinese path)
    //   collection-langcjk           general CJK (JP/KR in mixed docs)
    // Plus `fandol`: ctex's default free Chinese font, bundled as a deliberate
    // narrow exception to DESIGN §6.3 ("fonts are host-supplied") so a Chinese
    // doc COMPILES out of the box. NOTE: collection-langchinese already lists
    // `fandol` as a depend, so this extraPackages entry is belt-and-suspenders —
    // kept explicit so the intent survives any future collection reshuffle.
    // Heavier production CJK fonts (Noto CJK, Source Han) stay host-supplied.
    name: 'academic',
    collections: [
      'collection-latexrecommended',
      'collection-mathscience',
      'collection-latexextra',
      'collection-pictures',
      'collection-fontsrecommended',
      'collection-langchinese',
      'collection-langcjk',
    ],
    extraPackages: ['fandol'],
  },

  // ── full ────────────────────────────────────────────────────────────────────
  // DEFERRED / not shipped for v1 (docs/plans/M4.md: the journal+CJK target does
  // not need TeX Live's long tail). When a general-purpose audience emerges,
  // `full` is JUST ANOTHER ENTRY here — e.g.
  //   { name: 'full', collections: ['scheme-full'], extraPackages: [] }
  // — with no change to resolve.mjs. Left out (not commented-in) so the shipped
  // tier list is exactly what the build produces.
];

export default TIERS;
