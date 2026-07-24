// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner.
//   Run: `node --test conformance/pdf-probe.test.mjs`
//
// Regression tests for pdf-probe.mjs stream extraction (DESIGN.md §8). These guard
// the bug that turned the conformance gate's `idx-makeindex` entry RED in CI (run
// 30050548281: "pages 0 (Pages=null, leaf=0)" on a VALID 2-page PDF): the page tree
// of a XeTeX/xdvipdfmx PDF lives ENTIRELY inside a FlateDecode object stream
// (/Type /ObjStm), and the pre-fix extractor bounded streams by TEXT-SEARCHING for
// `endstream` and trimming a trailing EOL. Both are unsafe against arbitrary
// compressed binary:
//   * a trailing 0x0d compressed byte was chopped as if it were the writer's EOL
//     delimiter (the ACTUAL intermittent CI trigger — ~1/256 of builds, re-rolled
//     each build because the timestamp is embedded in that very ObjStm), and
//   * a literal `endstream` byte sequence inside the compressed data truncated the
//     stream early.
// Either corrupted the deflate stream so inflateSync threw and the ObjStm was
// SILENTLY dropped, so countPages found no page objects → 0. The fix binds streams
// by their dict's direct-integer /Length. Each test below first shows the PRE-FIX
// logic reproduces the exact drop (0), then that the shipped countPages counts
// correctly — the §8 assertions are never weakened: a valid N-page PDF counts N.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync, deflateRawSync, inflateSync } from 'node:zlib';
import { countPages, inflateStreams } from './pdf-probe.mjs';

// ---------------------------------------------------------------------------
// Synthesis helpers — build PDFs whose page objects are reachable ONLY after
// inflation (never verbatim in the raw bytes), exactly like the real ObjStm.
// ---------------------------------------------------------------------------

/** Adler-32 (zlib's stream checksum). Standard algorithm — original implementation. */
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** An uncompressed ("stored") DEFLATE block (BFINAL=0), carrying `bytes` verbatim. */
function storedBlock(bytes) {
  const header = Buffer.alloc(5);
  header[0] = 0x00; // BFINAL=0, BTYPE=00 (stored)
  header.writeUInt16LE(bytes.length, 1);
  header.writeUInt16LE(~bytes.length & 0xffff, 3); // one's-complement of LEN
  return Buffer.concat([header, bytes]);
}

/**
 * A valid zlib stream that INFLATES to `poison + page`, but whose COMPRESSED bytes
 * contain `poison` verbatim (a stored block) while `page` is genuinely compressed
 * (a real DEFLATE block) — so `page`'s markers are recoverable ONLY via inflation,
 * mirroring the real /ObjStm. Put an `endstream`/`stream` sequence in `poison` to
 * reproduce the "in-binary boundary token" drop.
 */
function zlibWithPoison(poison, page) {
  const body = Buffer.concat([storedBlock(poison), deflateRawSync(page)]);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(Buffer.concat([poison, page])));
  return Buffer.concat([Buffer.from([0x78, 0x9c]), body, adler]);
}

/**
 * A zlib stream of `payload` whose LAST compressed byte is `lastByte`. deflateSync
 * appends the Adler-32 big-endian, so the final byte is `checksum & 0xff`; a
 * single appended filler byte walks that low byte through all 256 values, so a hit
 * is found within 256 tries (deterministic). Reproduces the trailing-EOL drop.
 */
function deflateEndingIn(lastByte, payload) {
  for (let f = 0; f < 256; f++) {
    const withFiller = Buffer.concat([payload, Buffer.from([f])]);
    if ((adler32(withFiller) & 0xff) === lastByte) {
      const z = deflateSync(withFiller);
      assert.equal(z[z.length - 1], lastByte, 'constructed compressed data ends in the target byte');
      return z;
    }
  }
  throw new Error(`unreachable: no filler yields last byte 0x${lastByte.toString(16)}`);
}

/**
 * Minimal PDF carrying one FlateDecode stream. No xref/trailer parsing is needed —
 * countPages scans the raw bytes plus every inflated stream. `dict` supplies the
 * stream's /Length (direct integer, or an indirect `N M R` to exercise the
 * fallback). The real `endstream` terminator follows the compressed bytes.
 */
function pdfWithFlateStream(dict, compressed) {
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj\n${dict}\nstream\n`, 'latin1'),
    compressed,
    Buffer.from('\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1'),
  ]);
}

/** A two-page page tree + its two leaf page objects — the markers countPages seeks. */
const PAGE_OBJECTS = Buffer.from(
  '1 0 obj<</Type /Pages /Count 2 /Kids [2 0 R 3 0 R]>>endobj\n' +
    '2 0 obj<</Type /Page /Parent 1 0 R /MediaBox [0 0 612 792]>>endobj\n' +
    '3 0 obj<</Type /Page /Parent 1 0 R /MediaBox [0 0 612 792]>>endobj\n',
  'latin1',
);

/** Assert the page markers are NOT present in the raw PDF (only reachable via inflation). */
function assertMarkersOnlyInflated(pdf) {
  const raw = Buffer.from(pdf).toString('latin1');
  assert.ok(!/\/Type\s*\/Page/.test(raw), 'page markers must not appear in the raw bytes (test would be vacuous)');
}

// ---------------------------------------------------------------------------
// The PRE-FIX extractor + counter, reproduced verbatim so each test proves it
// exhibits the exact drop the fix removes — and nothing weaker.
// ---------------------------------------------------------------------------
function preFixInflateStreams(pdf) {
  const buf = Buffer.from(pdf);
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
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
      /* dropped */
    }
    i = e + 9;
  }
  return out;
}
function preFixCountPages(pdf) {
  const hay = [Buffer.from(pdf).toString('latin1'), ...preFixInflateStreams(pdf).map((s) => s.toString('latin1'))].join('\n');
  const leafPageObjects = (hay.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  let viaPagesCount = null;
  for (const m of hay.matchAll(/\/Type\s*\/Pages\b/g)) {
    const idx = m.index ?? 0;
    const window = hay.slice(Math.max(0, idx - 160), idx + 160);
    const cm = window.match(/\/Count\s+(\d+)/);
    if (cm) {
      const n = Number(cm[1]);
      if (viaPagesCount === null || n > viaPagesCount) viaPagesCount = n;
    }
  }
  return { count: viaPagesCount ?? leafPageObjects, viaPagesCount, leafPageObjects };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------
describe('countPages — stream-boundary robustness (idx-makeindex CI regression)', () => {
  test('trailing 0x0d compressed byte: pre-fix drops the page-bearing stream (0), fix counts 2', () => {
    // The ACTUAL intermittent CI trigger: the page-bearing stream's last compressed
    // byte is 0x0d, which the pre-fix EOL-trim chops → 1-byte truncation → inflate
    // throws → stream dropped → 0 pages.
    const compressed = deflateEndingIn(0x0d, PAGE_OBJECTS);
    const pdf = pdfWithFlateStream(`<</Type/ObjStm/Filter/FlateDecode/Length ${compressed.length}>>`, compressed);
    assertMarkersOnlyInflated(pdf);

    assert.deepEqual(preFixCountPages(pdf), { count: 0, viaPagesCount: null, leafPageObjects: 0 }, 'pre-fix reproduces the CI drop');
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 }, 'fix counts the valid 2-page PDF');
  });

  test('literal `endstream` inside compressed data: pre-fix truncates+drops (0), fix counts 2', () => {
    // The boundary-token variant named in the diagnosis: an `endstream` byte
    // sequence in the compressed data makes the pre-fix text search stop early.
    const compressed = zlibWithPoison(Buffer.from('  endstream  ', 'latin1'), PAGE_OBJECTS);
    assert.ok(compressed.includes(Buffer.from('endstream')), 'poison present in compressed bytes');
    const pdf = pdfWithFlateStream(`<</Type/ObjStm/Filter/FlateDecode/Length ${compressed.length}>>`, compressed);
    assertMarkersOnlyInflated(pdf);

    assert.equal(preFixCountPages(pdf).count, 0, 'pre-fix drops the truncated stream');
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 }, 'fix counts through the in-binary token');
  });

  test('literal `stream` + `endstream` together: pre-fix drops (0), fix counts 2', () => {
    const compressed = zlibWithPoison(Buffer.from(' stream .. endstream ', 'latin1'), PAGE_OBJECTS);
    assert.ok(compressed.includes(Buffer.from('stream')) && compressed.includes(Buffer.from('endstream')));
    const pdf = pdfWithFlateStream(`<</Filter/FlateDecode/Length ${compressed.length}>>`, compressed);

    assert.equal(preFixCountPages(pdf).count, 0);
    assert.equal(countPages(pdf).count, 2);
  });

  test('indirect /Length `N 0 R` with in-binary `endstream`: fix falls back and still counts 2', () => {
    // With no direct-integer /Length the extractor uses the endstream fallback,
    // which must RETRY past the spurious in-binary match to the real terminator.
    const compressed = zlibWithPoison(Buffer.from('  endstream  ', 'latin1'), PAGE_OBJECTS);
    const pdf = pdfWithFlateStream('<</Filter/FlateDecode/Length 9 0 R>>', compressed);
    assertMarkersOnlyInflated(pdf);

    assert.equal(preFixCountPages(pdf).count, 0, 'pre-fix drops it here too');
    assert.equal(countPages(pdf).count, 2, 'fallback retry recovers the stream');
  });

  test('clean FlateDecode stream: no regression (counts 2, both signals agree)', () => {
    const compressed = deflateSync(PAGE_OBJECTS, { level: 9 });
    const pdf = pdfWithFlateStream(`<</Type/ObjStm/Filter/FlateDecode/Length ${compressed.length}>>`, compressed);
    assertMarkersOnlyInflated(pdf);
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 });
  });

  test('multiple streams incl. a poisoned page-bearing one: only the valid page stream is counted', () => {
    // A decoy flate stream (no page objects) precedes the poisoned page stream, so a
    // desynchronized walk would miscount. The fix bounds each stream independently.
    const decoy = deflateSync(Buffer.from('q 1 0 0 1 0 0 cm BT /F1 12 Tf (hi) Tj ET Q\n', 'latin1'), { level: 9 });
    const pageComp = deflateEndingIn(0x0d, PAGE_OBJECTS);
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.5\n1 0 obj\n<</Filter/FlateDecode/Length ${decoy.length}>>\nstream\n`, 'latin1'),
      decoy,
      Buffer.from(`\nendstream\nendobj\n2 0 obj\n<</Type/ObjStm/Filter/FlateDecode/Length ${pageComp.length}>>\nstream\n`, 'latin1'),
      pageComp,
      Buffer.from('\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1'),
    ]);
    assertMarkersOnlyInflated(pdf);
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 });
  });

  test('non-flate stream with indirect /Length before the page stream: fallback resumes, does not abort', () => {
    // A NON-flate stream with an indirect `/Length N M R` (→ the endstream-search
    // fallback) precedes the page-bearing ObjStm. Every fallback candidate fails to
    // inflate (it is not deflate data), exhausting the search. A fallback that then
    // returns `next: buf.length` would ABORT the whole walk and drop the later page
    // stream — 0 pages on a valid PDF, the exact class this module fixes. The fix
    // resumes just past the first `endstream`, so the page ObjStm is still counted.
    const pageComp = deflateSync(PAGE_OBJECTS, { level: 6 });
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.5\n1 0 obj\n<</Length 3 0 R>>\nstream\n', 'latin1'),
      Buffer.from('raw bytes — not a deflate stream at all', 'latin1'),
      Buffer.from(`\nendstream\nendobj\n2 0 obj\n<</Type/ObjStm/Filter/FlateDecode/Length ${pageComp.length}>>\nstream\n`, 'latin1'),
      pageComp,
      Buffer.from('\nendstream\nendobj\ntrailer<</Root 2 0 R>>\n%%EOF', 'latin1'),
    ]);
    assertMarkersOnlyInflated(pdf);
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 });
  });

  test('uncompressed page objects in raw bytes are still counted (non-flate path unaffected)', () => {
    // countPages also scans the raw bytes, so a PDF with page objects outside any
    // stream must still count — the fix must not regress this.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), PAGE_OBJECTS, Buffer.from('\n%%EOF', 'latin1')]);
    assert.deepEqual(countPages(pdf), { count: 2, viaPagesCount: 2, leafPageObjects: 2 });
  });

  test('return shape is exactly { count, viaPagesCount, leafPageObjects }', () => {
    const compressed = deflateSync(PAGE_OBJECTS, { level: 6 });
    const pdf = pdfWithFlateStream(`<</Filter/FlateDecode/Length ${compressed.length}>>`, compressed);
    assert.deepEqual(Object.keys(countPages(pdf)).sort(), ['count', 'leafPageObjects', 'viaPagesCount']);
  });

  test('inflateStreams recovers the page-bearing stream that the pre-fix extractor dropped', () => {
    const compressed = deflateEndingIn(0x0d, PAGE_OBJECTS);
    const pdf = pdfWithFlateStream(`<</Type/ObjStm/Filter/FlateDecode/Length ${compressed.length}>>`, compressed);
    const preFix = preFixInflateStreams(pdf);
    const fixed = inflateStreams(pdf);
    assert.equal(preFix.length, 0, 'pre-fix recovered no streams (the sole stream was dropped)');
    assert.equal(fixed.length, 1, 'fix recovered the stream');
    assert.ok(fixed[0].toString('latin1').includes('/Type /Pages'), 'and it holds the page tree');
  });
});
