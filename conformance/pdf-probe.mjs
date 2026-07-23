// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ---------------------------------------------------------------------------
// Shared PDF verification probe (DESIGN.md §8: "extracted text snippets via a
// small PDF text probe ... no pixel comparisons"). Two consumers import this
// ONE module, so the technique is not duplicated:
//   * conformance/run.mjs        — the seed-corpus runner.
//   * demo/test/smoke.spec.mjs   — the Playwright hello-world smoke.
//
// The text technique (the load-bearing part, documented once here):
//   XeTeX emits GLYPH-indexed content streams — the visible text is NOT ASCII in
//   the PDF — so a naive byte search cannot find it. We inflate every
//   FlateDecode stream (Node zlib) and, for a XeTeX PDF, parse the embedded
//   ToUnicode CMap (beginbfchar/beginbfrange: glyph -> Unicode) and decode the
//   content stream's hex glyph runs back to text in reading order. For a pdfTeX
//   PDF (CM fonts), the inflated content stream carries the text as literal
//   `(...)` string operators, which we extract and concatenate. Inter-word
//   spaces render as positioning (kerning), not glyphs, so both recovered
//   strings are space-free; callers strip spaces from the expected phrase and
//   assert substring presence (see {@link stripSpaces}).
// ---------------------------------------------------------------------------

import { inflateSync } from 'node:zlib';

/** Collapse every run of whitespace (incl. newlines) so kerning-only gaps do not defeat a substring match. */
export const stripSpaces = (s) => s.replace(/\s+/g, '');

/**
 * Inflate every FlateDecode stream in a PDF; non-flate streams are skipped.
 * Object streams (/Type /ObjStm, PDF 1.5+) are FlateDecode too, so page-tree
 * and page objects hidden inside them are exposed to the callers that scan the
 * inflated text (e.g. {@link countPages}).
 */
export function inflateStreams(pdf) {
  const buf = Buffer.from(pdf);
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    // `indexOf('stream')` also matches inside 'endstream'; skip those.
    if (buf.toString('latin1', Math.max(0, s - 3), s).endsWith('end')) {
      i = s + 6;
      continue;
    }
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start);
    if (e < 0) break;
    let end = e;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    try {
      out.push(inflateSync(buf.subarray(start, end)));
    } catch {
      /* not a flate stream (e.g. an uncompressed object) — ignore */
    }
    i = e + 9;
  }
  return out;
}

/** Decode a ToUnicode destination (a run of UTF-16BE code units) to a JS string.
 *  Ligatures map one glyph to several code units (e.g. `fi` -> U+0066 U+0069),
 *  so decode ALL of them, not just the first. */
export function decodeDest(hex) {
  let s = '';
  for (let k = 0; k + 4 <= hex.length; k += 4) s += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
  return s;
}

/** Parse a ToUnicode CMap body into a glyph-code -> string map (bfchar + bfrange). */
export function parseCMap(text, map) {
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), decodeDest(m[2]));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3].slice(0, 4), 16);
      for (let g = lo, u = dst; g <= hi; g++, u++) map.set(g, String.fromCodePoint(u));
    }
  }
}

/** Reconstruct XeTeX text: decode content-stream hex glyph runs through the ToUnicode CMap. */
export function reconstructXetexText(pdf) {
  const streams = inflateStreams(pdf).map((s) => s.toString('latin1'));
  const map = new Map();
  for (const t of streams) if (t.includes('beginbfchar') || t.includes('beginbfrange')) parseCMap(t, map);
  let text = '';
  for (const t of streams) {
    if (!/(TJ|Tj)/.test(t) || !/<[0-9A-Fa-f]{4,}>/.test(t)) continue; // a glyph content stream
    for (const hs of t.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const hex = hs[1];
      for (let k = 0; k + 4 <= hex.length; k += 4) text += map.get(parseInt(hex.slice(k, k + 4), 16)) ?? '';
    }
  }
  return text;
}

/** Extract pdfTeX text: concatenate the `(...)` string literals from the content stream. */
export function extractPdftexText(pdf) {
  const streams = inflateStreams(pdf).map((s) => s.toString('latin1'));
  let text = '';
  for (const t of streams) {
    if (!/(TJ|Tj)/.test(t) || !/\((?:\\.|[^\\()])*\)/.test(t)) continue;
    for (const m of t.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) text += m[1].replace(/\\([()\\])/g, '$1');
  }
  return text;
}

/**
 * Recover the visible text of a PDF by engine: XeTeX via the ToUnicode CMap,
 * pdfTeX via the `(...)` string literals. The returned string is space-free (see
 * the module header) — compare against a {@link stripSpaces}'d expected phrase.
 */
export function recoverText(pdf, engine) {
  return engine === 'pdftex' ? extractPdftexText(pdf) : reconstructXetexText(pdf);
}

/**
 * Count PDF pages honestly. The page tree is the authority: the root `/Type
 * /Pages` node's `/Count N` is the total. We first inflate all streams (so page
 * objects living in a PDF-1.5 object stream are visible), then take the largest
 * `/Count` that sits next to a `/Type /Pages` node (the root's count dominates
 * any intermediate node). As an independent cross-check we also count leaf
 * `/Type /Page` objects (not `/Pages`). Both are returned so a caller/report can
 * see them agree; `count` prefers the page-tree `/Count` and falls back to the
 * leaf tally when no `/Pages` node is exposed.
 *
 * Honesty caveat: this is a structural probe, not a full PDF parser. It does not
 * resolve `/Kids` references or object-stream indices; it relies on the counted
 * markers appearing in the raw bytes or the inflated stream text, which holds
 * for the xdvipdfmx / pdfTeX output the corpus exercises.
 */
export function countPages(pdf) {
  const hay = [Buffer.from(pdf).toString('latin1'), ...inflateStreams(pdf).map((s) => s.toString('latin1'))].join('\n');
  // Leaf page objects: `/Type /Page` NOT followed by another letter (excludes `/Pages`).
  const leafPageObjects = (hay.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  // The page-tree node counts: `/Count N` within a small window of a `/Type /Pages`.
  let viaPagesCount = null;
  for (const m of hay.matchAll(/\/Type\s*\/Pages\b/g)) {
    const i = m.index ?? 0;
    const window = hay.slice(Math.max(0, i - 160), i + 160);
    const cm = window.match(/\/Count\s+(\d+)/);
    if (cm) {
      const n = Number(cm[1]);
      if (viaPagesCount === null || n > viaPagesCount) viaPagesCount = n;
    }
  }
  const count = viaPagesCount ?? leafPageObjects;
  return { count, viaPagesCount, leafPageObjects };
}
