// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner + a throwaway tmpdir fixture.
//   Run: `node --test build/release/tar.test.mjs`
//
// Unit tests for the deterministic tar+gzip core (tar.mjs, M5 item 7): the USTAR
// writer round-trips through the streaming reader, double-packing is byte-identical,
// the header knobs are fixed (mode/uid/gid/mtime), the gzip header is canonical,
// and a corrupt/truncated archive aborts the reader.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { BLOCK, packTarGz, readTarGzEntries, splitUstarPath, ustarHeader } from './tar.mjs';

const EPOCH = 1772323200; // TL 2026 freeze, 2026-03-01T00:00:00Z

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wasmtex-tar-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const parseOctal = (buf, start, len) =>
  parseInt(buf.toString('latin1', start, start + len).replace(/[\0 ].*$/s, '') || '0', 8);

/** Write `files` (name→Buffer/string) into root/src (nested dirs created) and
 *  return packTarGz entries carrying the source bytes for later assertions. */
function writeSrc(files) {
  const entries = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, 'src', ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    writeFileSync(abs, buf);
    entries.push({ archivePath: rel, sourcePath: abs, _content: buf });
  }
  return entries;
}

describe('tar — round-trip through the streaming reader', () => {
  test('reads back every entry with matching path, size, sha256 (sorted order)', async () => {
    const entries = writeSrc({
      'core.data': 'CORE-DATA-BLOB-01234567',
      'a.txt': 'hello world\n',
      'formats/x.fmt': Buffer.from(Array.from({ length: 3000 }, (_, i) => i & 0xff)),
    });
    const out = join(root, 'out.tar.gz');
    const packed = await packTarGz({ entries, outPath: out, mtime: EPOCH });
    // Packed order is C-locale sorted by archive path.
    assert.deepEqual(packed, ['a.txt', 'core.data', 'formats/x.fmt']);

    const read = await readTarGzEntries(out);
    assert.deepEqual(
      read.map((e) => e.path),
      ['a.txt', 'core.data', 'formats/x.fmt'],
    );
    const bySrc = new Map(entries.map((e) => [e.archivePath, e._content]));
    for (const e of read) {
      assert.equal(e.size, bySrc.get(e.path).length, `size of ${e.path}`);
      assert.equal(e.sha256, sha256(bySrc.get(e.path)), `sha256 of ${e.path}`);
    }
  });

  test('a zero-byte file round-trips (no data block, just header)', async () => {
    const entries = writeSrc({ empty: '' });
    const out = join(root, 'empty.tar.gz');
    await packTarGz({ entries, outPath: out, mtime: EPOCH });
    const read = await readTarGzEntries(out);
    assert.equal(read.length, 1);
    assert.equal(read[0].size, 0);
    assert.equal(read[0].sha256, sha256(Buffer.alloc(0)));
  });

  test('data larger than one gzip chunk round-trips (streaming boundary)', async () => {
    const big = Buffer.alloc(700 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) & 0xff;
    const entries = writeSrc({ 'big.bin': big });
    const out = join(root, 'big.tar.gz');
    await packTarGz({ entries, outPath: out, mtime: EPOCH });
    const [e] = await readTarGzEntries(out);
    assert.equal(e.size, big.length);
    assert.equal(e.sha256, sha256(big));
  });
});

describe('tar — determinism', () => {
  test('double-pack of identical inputs is byte-identical', async () => {
    const entries = writeSrc({ 'b.bin': 'BBBB', 'a.bin': 'AAAA-longer' });
    const p1 = join(root, 'one.tar.gz');
    const p2 = join(root, 'two.tar.gz');
    await packTarGz({ entries, outPath: p1, mtime: EPOCH });
    await packTarGz({ entries, outPath: p2, mtime: EPOCH });
    assert.ok(readFileSync(p1).equals(readFileSync(p2)), 'two packs of the same input differ');
  });

  test('input order does not affect the archive (entries are sorted)', async () => {
    const entries = writeSrc({ 'a.bin': 'AAAA', 'b.bin': 'BBBB' });
    const p1 = join(root, 'fwd.tar.gz');
    const p2 = join(root, 'rev.tar.gz');
    await packTarGz({ entries, outPath: p1, mtime: EPOCH });
    await packTarGz({ entries: [...entries].reverse(), outPath: p2, mtime: EPOCH });
    assert.ok(readFileSync(p1).equals(readFileSync(p2)));
  });

  test('the gzip header is canonical: 1f 8b 08 00 | mtime=0 | xfl=0 | os=0xff', async () => {
    const entries = writeSrc({ 'a.bin': 'payload' });
    const out = join(root, 'hdr.tar.gz');
    await packTarGz({ entries, outPath: out, mtime: EPOCH });
    const head = readFileSync(out).subarray(0, 10);
    assert.deepEqual([...head], [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  });
});

describe('tar — USTAR header knobs are fixed for determinism', () => {
  test('first entry header: mode 0644, uid/gid 0, typeflag 0, mtime=epoch, ustar magic', async () => {
    const entries = writeSrc({ 'file.bin': 'xyz' });
    const out = join(root, 'k.tar.gz');
    await packTarGz({ entries, outPath: out, mtime: EPOCH });
    const tar = gunzipSync(readFileSync(out));
    const h = tar.subarray(0, BLOCK);
    assert.equal(h.toString('latin1', 0, 8), 'file.bin');
    assert.equal(parseOctal(h, 100, 8), 0o644, 'mode');
    assert.equal(parseOctal(h, 108, 8), 0, 'uid');
    assert.equal(parseOctal(h, 116, 8), 0, 'gid');
    assert.equal(parseOctal(h, 124, 12), 3, 'size');
    assert.equal(parseOctal(h, 136, 12), EPOCH, 'mtime');
    assert.equal(h[156], 0x30, "typeflag '0'");
    assert.equal(h.toString('latin1', 257, 263), 'ustar\0');
    assert.equal(h.toString('latin1', 263, 265), '00', 'version');
    // Archive ends with two zero blocks.
    const tail = tar.subarray(tar.length - 2 * BLOCK);
    assert.ok(tail.every((b) => b === 0), 'two trailing zero blocks');
  });

  test('duplicate archive paths abort', async () => {
    const [e] = writeSrc({ 'dup.bin': 'x' });
    await assert.rejects(
      packTarGz({ entries: [e, e], outPath: join(root, 'd.tar.gz'), mtime: EPOCH }),
      /duplicate archive path/,
    );
  });

  test('a negative / non-integer mtime aborts', async () => {
    const entries = writeSrc({ 'a.bin': 'x' });
    await assert.rejects(packTarGz({ entries, outPath: join(root, 'n.tar.gz'), mtime: -1 }), /non-negative integer/);
  });
});

describe('tar — splitUstarPath', () => {
  test('short paths use the name field alone', () => {
    assert.deepEqual(splitUstarPath('core.data'), { name: 'core.data', prefix: '' });
    assert.deepEqual(splitUstarPath('formats/xelatex.fmt'), { name: 'formats/xelatex.fmt', prefix: '' });
  });
  test('a long path splits into prefix + name on a separator', () => {
    const deep = `${'d'.repeat(120)}/${'n'.repeat(40)}`;
    const { name, prefix } = splitUstarPath(deep);
    assert.equal(name, 'n'.repeat(40));
    assert.equal(prefix, 'd'.repeat(120));
  });
  test('a single component over 100 bytes cannot be represented → throws', () => {
    assert.throws(() => splitUstarPath('z'.repeat(101)), /too long for ustar/);
  });
});

describe('tar — the reader aborts on a corrupt or truncated archive', () => {
  // Assemble a minimal raw tar (header + padded data + 2 zero blocks), gzip it,
  // optionally tampering, then read it back. `refixChecksum` recomputes the ustar
  // checksum after a header edit so a test can target a field OTHER than the sum.
  const refixChecksum = (h) => {
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    h[154] = 0;
    h[155] = 0x20;
  };
  const buildTarGz = (header, data, { dropEndBlocks = false } = {}) => {
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    const parts = [header, data, Buffer.alloc(pad)];
    if (!dropEndBlocks) parts.push(Buffer.alloc(BLOCK * 2));
    return gzipSync(Buffer.concat(parts));
  };

  test('a flipped header byte fails the checksum', async () => {
    const h = ustarHeader({ path: 'x.bin', size: 3, mtime: EPOCH });
    h[10] ^= 0xff; // corrupt a name byte without fixing the checksum
    const p = join(root, 'bad.tar.gz');
    writeFileSync(p, buildTarGz(h, Buffer.from('xyz')));
    await assert.rejects(readTarGzEntries(p), /checksum mismatch/);
  });

  test('a wrong ustar magic is rejected', async () => {
    const h = ustarHeader({ path: 'x.bin', size: 1, mtime: EPOCH });
    h.write('nope!\0', 257, 6, 'latin1');
    refixChecksum(h); // so it is the MAGIC, not the checksum, that fails
    const p = join(root, 'magic.tar.gz');
    writeFileSync(p, buildTarGz(h, Buffer.from('y')));
    await assert.rejects(readTarGzEntries(p), /not a ustar header/);
  });

  test('a truncated archive (no end marker) aborts', async () => {
    const h = ustarHeader({ path: 'x.bin', size: 3, mtime: EPOCH });
    const p = join(root, 'trunc.tar.gz');
    writeFileSync(p, buildTarGz(h, Buffer.from('xyz'), { dropEndBlocks: true }));
    await assert.rejects(readTarGzEntries(p), /truncated archive/);
  });

  test('a non-regular entry type (e.g. directory) is rejected', async () => {
    const h = ustarHeader({ path: 'adir', size: 0, mtime: EPOCH });
    h[156] = 0x35; // typeflag '5' → directory
    refixChecksum(h);
    const p = join(root, 'dir.tar.gz');
    writeFileSync(p, buildTarGz(h, Buffer.alloc(0)));
    await assert.rejects(readTarGzEntries(p), /unsupported entry type/);
  });

  // INDEPENDENT validation: our writer and reader share assumptions (checksum,
  // octal encoding, offsets), so a symmetric bug would pass every round-trip
  // test above. Cross-check against the SYSTEM tar — the real interop target —
  // so a header the OS tar can't read fails here. Skips cleanly where no tar.
  test('system tar reads our archive with byte-identical extraction', async () => {
    let tarBin = null;
    for (const cand of ['/usr/bin/tar', '/bin/tar', 'tar']) {
      const r = spawnSync(cand, ['--version'], { stdio: 'ignore' });
      if (r.status === 0 || r.status === 1) { tarBin = cand; break; }
    }
    if (tarBin === null) { console.log('  (skip) no system tar found'); return; }

    // Author a couple of files incl. a path that exercises the name/prefix split
    // and non-ASCII bytes, pack with OUR writer.
    const files = {
      'a.txt': Buffer.from('hello\n'),
      'deep/dir/here/b.bin': Buffer.from([0, 1, 2, 253, 254, 255]),
      'empty': Buffer.alloc(0),
    };
    for (const [rel, buf] of Object.entries(files)) {
      const abs = join(root, 'src', rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, buf);
    }
    const archive = join(root, 'x.tar.gz');
    await packTarGz({
      entries: Object.keys(files).map((rel) => ({ archivePath: rel, sourcePath: join(root, 'src', rel) })),
      outPath: archive,
      mtime: EPOCH,
    });

    const outDir = join(root, 'out');
    mkdirSync(outDir, { recursive: true });
    const ex = spawnSync(tarBin, ['-xzf', archive, '-C', outDir], { stdio: 'pipe' });
    assert.equal(ex.status, 0, `system tar failed to extract: ${ex.stderr}`);
    for (const [rel, buf] of Object.entries(files)) {
      assert.deepEqual(readFileSync(join(outDir, rel)), buf, `system-tar extracted ${rel} differs`);
    }
  });
});
