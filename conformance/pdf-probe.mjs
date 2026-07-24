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
 *
 * Stream bounding is /Length-AUTHORITATIVE, not text-search-based. A PDF stream
 * is `<<dict>> stream EOL <compressed-bytes> EOL endstream`, and the dict's
 * `/Length N` is the EXACT byte count of <compressed-bytes>. When N is a direct
 * integer we slice exactly those bytes — extraction never hunts for `endstream`
 * and never trims a "delimiter EOL" that is really a compressed byte.
 *
 * This is load-bearing. The compressed bytes are arbitrary binary that can:
 *   (a) contain the literal sequence `endstream` — a boundary search stops there
 *       and truncates the stream; or
 *   (b) simply END in 0x0d (or 0x0a) — a "strip the writer's trailing EOL" step
 *       then chops a real final byte.
 * Either corrupts the deflate stream so inflateSync throws and the stream is
 * silently dropped. When the dropped stream is the /ObjStm holding the page tree,
 * {@link countPages} reports 0 pages on a perfectly valid PDF. And because a PDF's
 * build timestamp is embedded IN that ObjStm (xdvipdfmx writes /CreationDate,
 * /ModDate there), its compressed bytes are re-rolled on every build — so case
 * (b) in particular (~1/256 of builds: the ObjStm's last compressed byte lands on
 * 0x0d) makes the drop INTERMITTENT and environment-correlated — it passes locally
 * yet reddens CI on a byte-shifted rebuild. Binding by /Length removes the guesswork.
 *
 * Fallback: when /Length is an indirect reference (`N M R`) — legal, though the
 * xdvipdfmx / pdfTeX output this probe targets always writes a direct integer — we
 * bound by `endstream`, but RETRY successive matches (and the plausible EOL-strip
 * candidates for each) until one inflates, so an `endstream` byte sequence inside
 * the compressed data can never abort the extraction. Non-flate streams
 * (uncompressed objects) fail inflate and are skipped in either path.
 */
export function inflateStreams(pdf) {
  const buf = Buffer.from(pdf);
  const out = [];
  let i = 0;
  for (;;) {
    const kw = nextStreamKeyword(buf, i);
    if (kw < 0) break;
    // Data begins after the `stream` keyword and its single EOL (CRLF or LF, per
    // the PDF spec). A zlib stream begins 0x78 — never 0x0a/0x0d — so skipping one
    // leading EOL here never eats a compressed byte.
    let start = kw + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;

    const len = directStreamLength(buf, kw);
    if (len != null) {
      // Authoritative: exactly /Length bytes. No EOL trimming, no `endstream` search.
      const inflated = tryInflate(buf, start, start + len);
      if (inflated) out.push(inflated);
      // Resume PAST this stream's real `endstream` (it follows the counted bytes),
      // so a `stream`/`endstream` sequence inside the compressed data can never be
      // mistaken for the next stream's boundary.
      const es = buf.indexOf('endstream', start + len);
      i = es < 0 ? start + len : es + 9;
    } else {
      // Indirect (or unparseable) /Length: bound by `endstream`, retrying past any
      // spurious in-binary matches until a candidate inflates.
      const { inflated, next } = inflateByEndstreamSearch(buf, start);
      if (inflated) out.push(inflated);
      i = next;
    }
  }
  return out;
}

/** Next `stream` keyword at/after `from` that is not the tail of `endstream`. */
function nextStreamKeyword(buf, from) {
  let s = from;
  for (;;) {
    s = buf.indexOf('stream', s);
    if (s < 0) return -1;
    // `indexOf('stream')` also matches inside `endstream`; skip those.
    if (buf.toString('latin1', Math.max(0, s - 3), s).endsWith('end')) {
      s += 6;
      continue;
    }
    return s;
  }
}

/**
 * The direct-integer `/Length` of the stream whose `stream` keyword is at `kw`,
 * or null when the dict cannot be parsed or /Length is an indirect ref (`N M R`,
 * which the caller then resolves via the `endstream` fallback). The stream dict is
 * the `<< … >>` immediately preceding the keyword; its extent is found by matching
 * `>>`/`<<` depth (so a nested dict such as /DecodeParms is handled correctly).
 */
function directStreamLength(buf, kw) {
  const dictEnd = buf.lastIndexOf('>>', kw);
  if (dictEnd < 0) return null;
  let depth = 0;
  let dictStart = -1;
  for (let j = dictEnd; j >= 0; j--) {
    if (buf[j] === 0x3e && buf[j + 1] === 0x3e) {
      depth++;
      j--;
    } else if (buf[j] === 0x3c && buf[j + 1] === 0x3c) {
      depth--;
      j--;
      if (depth === 0) {
        dictStart = j + 1;
        break;
      }
    }
  }
  if (dictStart < 0) return null;
  const dict = buf.toString('latin1', dictStart, dictEnd + 2);
  // `/Length 829` → direct integer; `/Length 12 0 R` → indirect (trailing group matches).
  const m = dict.match(/\/Length\s+(\d+)(\s+\d+\s+R\b)?/);
  if (!m || m[2]) return null;
  return Number(m[1]);
}

/** inflateSync over buf[start,end), or null on any failure (non-flate / truncated). */
function tryInflate(buf, start, end) {
  if (end <= start) return null;
  try {
    return inflateSync(buf.subarray(start, end));
  } catch {
    return null;
  }
}

/**
 * Bound a stream by `endstream` when its /Length is not a usable direct integer.
 * The first `endstream` can be a byte sequence inside the compressed data, so we
 * try successive matches; for each we try the plausible data ends (stripping a 1-
 * or 2-byte EOL delimiter, or none) and accept the first that inflates — so this
 * path is itself immune to both an in-binary `endstream` and a trailing-EOL byte.
 * Returns the inflated bytes (or null) and the offset at which to resume scanning.
 */
function inflateByEndstreamSearch(buf, start) {
  let from = start;
  let firstE = -1;
  for (;;) {
    const e = buf.indexOf('endstream', from);
    if (e < 0) {
      // Exhausted with nothing inflatable (e.g. a genuinely non-flate stream on
      // this indirect-/Length path). Resume just PAST THE FIRST `endstream`
      // (the pre-fix behavior) — NOT buf.length: aborting the whole scan here
      // would silently drop every later stream, incl. a page-bearing ObjStm,
      // reintroducing the 0-pages-on-a-valid-PDF class this module exists to fix.
      return { inflated: null, next: firstE >= 0 ? firstE + 9 : buf.length };
    }
    if (firstE < 0) firstE = e;
    for (const end of [e - 1, e - 2, e]) {
      const inflated = tryInflate(buf, start, end);
      if (inflated) return { inflated, next: e + 9 };
    }
    from = e + 9;
  }
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

/**
 * Structural font/glyph probe (M4 item 8, for the CJK corpus entry).
 *
 * WHY this exists alongside {@link recoverText}: a XeTeX-set CJK document embeds
 * the CJK font as a CID-keyed subset (CIDFontType0/2, `Identity-H`) that xdvipdfmx
 * often ships WITHOUT a ToUnicode CMap — so the glyphs render (they are visually
 * present and copy as glyph indices) but are NOT reverse-mappable to Unicode.
 * `recoverText` therefore recovers only the Latin runs (which get a ToUnicode
 * CMap), never the CJK. That is honest PDF reality, not a probe defect. To verify
 * "the Chinese is present" WITHOUT a pixel comparison (DESIGN.md §8), we assert the
 * STRUCTURE instead: the bundled CJK font is embedded (its subset `/BaseFont` name)
 * and a run of CID glyphs was emitted. When a document uses the CJK font for
 * nothing but its CJK text (the Latin runs use a separate Latin font), the CJK
 * font's presence is itself proof the CJK text was typeset with it.
 *
 * Returns:
 *   - `baseFonts`: the de-duplicated `/BaseFont` names (subset prefix included,
 *     e.g. `JRZBJV+FandolSong-Regular`).
 *   - `embeddedFontFile`: whether ANY font program is embedded (`/FontFile[123]`),
 *     i.e. the PDF is self-contained (no host font dependency).
 *   - `cidGlyphs`: total 2-byte glyph codes emitted in `TJ`/`Tj` content streams
 *     (Identity-H CID fonts index glyphs as 2 bytes each). A corroborating count —
 *     a CJK paragraph emits one per character.
 */
export function fontProbe(pdf) {
  const raw = Buffer.from(pdf).toString('latin1');
  const inflated = inflateStreams(pdf).map((s) => s.toString('latin1'));
  const hay = [raw, ...inflated].join('\n');
  const baseFonts = [...new Set([...hay.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_.]+)/g)].map((m) => m[1]))];
  const embeddedFontFile = /\/FontFile[0-9]?\b/.test(hay);
  let cidGlyphs = 0;
  for (const t of inflated) {
    if (!/(TJ|Tj)/.test(t)) continue;
    for (const hs of t.matchAll(/<([0-9A-Fa-f]{4,})>/g)) cidGlyphs += Math.floor(hs[1].length / 4);
  }
  return { baseFonts, embeddedFontFile, cidGlyphs };
}
