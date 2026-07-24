#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only node:
//   builtins — fs, zlib, crypto, stream). No GPL/AGPL source and no other WASM-TeX
//   wrapper was read; the USTAR encoder + the streaming reader are original,
//   written straight from the POSIX ustar interchange format (public spec).
//
// =============================================================================
// DETERMINISTIC tar + gzip — the byte-reproducible archive core for the release
// packer (M5 item 7, DESIGN.md §6.1: "SOURCE_DATE_EPOCH and stable file ordering
// in archives are mandatory").
// -----------------------------------------------------------------------------
// A pure-node writer + reader instead of shelling out to the host `tar`, on
// purpose: macOS ships bsdtar and Linux ships GNU tar, whose deterministic flag
// spellings and default block-padding differ — shelling out would make the
// archive bytes host-dependent. Owning the encoder removes every host variance so
// `packTarGz` on identical inputs is byte-identical run to run (and, for a fixed
// node/zlib version, across hosts too).
//
// WRITER (`packTarGz`) — a minimal POSIX USTAR stream, gzip-wrapped:
//   * Entries are packed in the caller's given order (the packer sorts by path,
//     C-locale, matching SHA256SUMS / gen-assets); duplicate paths abort.
//   * Every header is normalized: mode 0644, uid/gid 0, empty uname/gname,
//     typeflag '0' (regular file), mtime = the caller's fixed epoch
//     (SOURCE_DATE_EPOCH). No field carries wall-clock time or host identity.
//   * File data is STREAMED (createReadStream piped through a single gzip into the
//     output) so a 474 MB bundle never lands in memory whole — the packer runs in
//     CI on the full asset set.
//   * The archive ends with the two zero blocks POSIX requires; it is NOT padded
//     to a 20-block factor (a gzip'd tar needs no blocking-factor padding, and
//     the extra zero padding would only bloat the archive).
//   * The gzip header is CANONICALIZED after writing: node's zlib already emits
//     MTIME=0 with no FNAME (the `gzip -n` shape), but the OS byte is host-zlib
//     specific (0x13 on macOS, 0x03 on GNU/Linux). We force MTIME=0, XFL=0, and
//     OS=0xFF (unknown) so the wrapper encodes no host identity and two packs of
//     the same input are byte-identical. (These header bytes are informational —
//     gunzip ignores them — so the patch never affects decompression.)
//   Determinism caveat (honest): the DEFLATE payload is deterministic for a fixed
//   node/zlib version; different zlib versions may choose different matches for
//   identical input. Same-host double-pack is byte-identical (the packer's proof);
//   cross-version byte-identity is not promised (DESIGN §6.1 amendment descopes
//   cross-environment byte-repro for v1).
//
// READER (`readTarGzEntries`) — a streaming untar+gunzip that returns, per
// regular-file entry, `{ path, size, sha256 }` WITHOUT ever holding a full entry
// in memory (each entry's bytes flow straight into a running sha256). It verifies
// each header's checksum + ustar magic (a corrupt archive aborts) and requires the
// closing zero blocks (a truncated archive aborts). The packer uses it to re-read
// every archive it just wrote and confirm the bytes against manifest.json — so the
// integrity check exercises the REAL archive, not just the files it meant to pack.
// =============================================================================

import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const BLOCK = 512; // POSIX tar block size.
export const GZIP_LEVEL = 6; // Pinned: a fixed level is required for determinism.

// --- USTAR header encoding ---------------------------------------------------

// Write a zero-padded octal number into a numeric header field of width `len`
// as (len-1) octal digits followed by a NUL — the widely-read convention that
// both GNU tar and bsdtar accept.
function writeOctalField(buf, offset, len, value) {
  const digits = len - 1;
  const s = value.toString(8);
  if (s.length > digits) {
    throw new Error(`tar: value ${value} (0o${s}) overflows a ${len}-byte octal field`);
  }
  buf.write(s.padStart(digits, '0'), offset, 'ascii');
  buf[offset + digits] = 0; // NUL terminator
}

// Split a posix path into ustar { name (≤100 B), prefix (≤155 B) }. Short paths
// (all of ours: `academic.data`, `formats/xelatex.fmt`, …) use `name` alone.
// A path that cannot be represented aborts (fail loud, never silently truncate).
export function splitUstarPath(p) {
  if (Buffer.byteLength(p, 'utf8') <= 100) return { name: p, prefix: '' };
  // Find the LAST '/' such that the tail (name) is ≤100 B and the head (prefix)
  // is ≤155 B. Walk separators from the right.
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const name = p.slice(i + 1);
    const prefix = p.slice(0, i);
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
      return { name, prefix };
    }
  }
  throw new Error(`tar: path too long for ustar (no ≤100/≤155 split): "${p}"`);
}

// Build one 512-byte USTAR header block for a regular file. All identity/metadata
// fields are fixed for determinism; only name/prefix/size/mtime vary.
export function ustarHeader({ path, size, mtime, mode = 0o644, uid = 0, gid = 0 }) {
  const { name, prefix } = splitUstarPath(path);
  const h = Buffer.alloc(BLOCK); // zero-filled: linkname, uname, gname, dev* stay NUL
  h.write(name, 0, 100, 'utf8');
  writeOctalField(h, 100, 8, mode & 0o7777);
  writeOctalField(h, 108, 8, uid);
  writeOctalField(h, 116, 8, gid);
  writeOctalField(h, 124, 12, size);
  writeOctalField(h, 136, 12, mtime);
  // Checksum field (148..156): spaces while the sum is computed, then written.
  h.fill(0x20, 148, 156);
  h[156] = 0x30; // typeflag '0' → regular file
  h.write('ustar\0', 257, 6, 'latin1'); // magic
  h.write('00', 263, 2, 'latin1'); // version
  h.write(prefix, 345, 155, 'utf8');
  // Unsigned sum of all 512 bytes (checksum field counted as spaces, done above).
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i];
  // Checksum stored as 6 octal digits, NUL, space.
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  h[154] = 0; // NUL
  h[155] = 0x20; // space
  return h;
}

// --- gzip header canonicalization --------------------------------------------
// Force the variable header bytes to fixed values so the wrapper encodes no host
// identity: MTIME (4..8)=0, XFL (8)=0, OS (9)=0xFF. Asserts the header is the
// plain deflate/no-FLG shape node emits (else the fixed offsets would be wrong).
async function canonicalizeGzipHeader(path) {
  const fh = await open(path, 'r+');
  try {
    const head = Buffer.alloc(10);
    const { bytesRead } = await fh.read(head, 0, 10, 0);
    if (bytesRead < 10 || head[0] !== 0x1f || head[1] !== 0x8b) {
      throw new Error(`tar: ${path} is not a gzip stream (bad magic)`);
    }
    if (head[2] !== 0x08) throw new Error(`tar: unexpected gzip method ${head[2]} in ${path}`);
    if (head[3] !== 0x00) {
      // FLG!=0 means FNAME/FEXTRA/etc. are present and the header is longer than
      // 10 bytes — node never emits this, but assert rather than corrupt.
      throw new Error(`tar: unexpected gzip FLG ${head[3]} in ${path} (header not canonicalizable)`);
    }
    await fh.write(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff]), 0, 6, 4);
  } finally {
    await fh.close();
  }
}

// --- writer ------------------------------------------------------------------
/**
 * Pack `entries` into a deterministic gzip'd USTAR archive at `outPath`.
 * @param {object}   o
 * @param {Array<{archivePath:string, sourcePath:string, size?:number, mode?:number}>} o.entries
 * @param {string}   o.outPath   destination .tar.gz path (written atomically via a .tmp)
 * @param {number}   o.mtime     fixed entry mtime (SOURCE_DATE_EPOCH seconds)
 * @param {number}  [o.gzipLevel=GZIP_LEVEL]
 * @returns {Promise<string[]>}  the archive paths, in packed (sorted) order
 */
export async function packTarGz({ entries, outPath, mtime, gzipLevel = GZIP_LEVEL }) {
  if (!Number.isInteger(mtime) || mtime < 0) {
    throw new Error(`tar: mtime must be a non-negative integer epoch, got ${mtime}`);
  }
  const sorted = [...entries].sort((a, b) =>
    a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0,
  );
  const seen = new Set();
  for (const e of sorted) {
    if (seen.has(e.archivePath)) throw new Error(`tar: duplicate archive path: ${e.archivePath}`);
    seen.add(e.archivePath);
  }

  const tmpPath = `${outPath}.tmp`;
  const gz = createGzip({ level: gzipLevel });
  const out = createWriteStream(tmpPath);

  async function* source() {
    for (const e of sorted) {
      const size = e.size ?? statSync(e.sourcePath).size;
      yield ustarHeader({ path: e.archivePath, size, mtime, mode: e.mode ?? 0o644 });
      let streamed = 0;
      for await (const chunk of createReadStream(e.sourcePath)) {
        streamed += chunk.length;
        yield chunk;
      }
      if (streamed !== size) {
        throw new Error(`tar: ${e.sourcePath} changed size while packing (header ${size}, read ${streamed})`);
      }
      const rem = size % BLOCK;
      if (rem !== 0) yield Buffer.alloc(BLOCK - rem); // pad the data to a block
    }
    yield Buffer.alloc(BLOCK * 2); // two zero blocks → end of archive
  }

  try {
    await pipeline(source(), gz, out);
    await canonicalizeGzipHeader(tmpPath);
    await rename(tmpPath, outPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  return sorted.map((e) => e.archivePath);
}

// --- reader ------------------------------------------------------------------

const isZeroBlock = (b) => {
  for (let i = 0; i < BLOCK; i += 1) if (b[i] !== 0) return false;
  return true;
};

const cstr = (buf, start, len) => {
  let end = start;
  const limit = start + len;
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.toString('utf8', start, end);
};

const parseOctal = (buf, start, len) => {
  const s = buf.toString('latin1', start, start + len).replace(/[\0 ]+.*$/s, '').replace(/[\0 ]/g, '');
  if (s === '') return 0;
  const n = parseInt(s, 8);
  if (!Number.isFinite(n)) throw new Error(`tar: bad octal field "${s}"`);
  return n;
};

function parseHeader(block) {
  // ustar magic at 257 ("ustar\0" or the "ustar " GNU spelling).
  const magic = block.toString('latin1', 257, 263);
  if (magic !== 'ustar\0' && magic !== 'ustar ') {
    throw new Error(`tar: not a ustar header (magic ${JSON.stringify(magic)})`);
  }
  // Checksum: recompute with the checksum field (148..156) taken as spaces.
  const stored = parseOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== stored) throw new Error(`tar: header checksum mismatch (stored ${stored}, computed ${sum})`);
  const name = cstr(block, 0, 100);
  const prefix = cstr(block, 345, 155);
  const typeflag = block[156];
  return {
    path: prefix ? `${prefix}/${name}` : name,
    size: parseOctal(block, 124, 12),
    typeflag, // 0x30 '0' or 0x00 → regular file
  };
}

// A streaming USTAR parse state machine. Fed byte chunks via push(); accumulates
// only header-sized fragments, and streams each entry's data straight into a
// sha256 (never buffering a whole entry). Collects { path, size, sha256 }.
class TarParser {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.state = 'header'; // 'header' | 'data'
    this.entries = [];
    this.zeroRun = 0;
    this.done = false;
    this.cur = null; // { path, size, hash }
    this.remaining = 0;
    this.pad = 0;
  }

  push(chunk) {
    if (this.done) return; // ignore trailing padding after the end marker
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this._process();
  }

  _process() {
    for (;;) {
      if (this.state === 'header') {
        if (this.pending.length < BLOCK) return;
        const block = this.pending.subarray(0, BLOCK);
        this.pending = this.pending.subarray(BLOCK);
        if (isZeroBlock(block)) {
          this.zeroRun += 1;
          if (this.zeroRun >= 2) {
            this.done = true;
            return;
          }
          continue;
        }
        this.zeroRun = 0;
        const hdr = parseHeader(block);
        if (hdr.typeflag !== 0x30 && hdr.typeflag !== 0x00) {
          throw new Error(`tar: unsupported entry type ${hdr.typeflag} for ${hdr.path} (regular files only)`);
        }
        this.cur = { path: hdr.path, size: hdr.size, hash: createHash('sha256') };
        this.remaining = hdr.size;
        this.pad = (BLOCK - (hdr.size % BLOCK)) % BLOCK;
        this.state = 'data';
        continue;
      }
      // state === 'data'
      if (this.remaining > 0) {
        if (this.pending.length === 0) return;
        const take = Math.min(this.remaining, this.pending.length);
        this.cur.hash.update(this.pending.subarray(0, take));
        this.pending = this.pending.subarray(take);
        this.remaining -= take;
        if (this.remaining > 0) return;
      }
      if (this.pad > 0) {
        if (this.pending.length === 0) return;
        const skip = Math.min(this.pad, this.pending.length);
        this.pending = this.pending.subarray(skip);
        this.pad -= skip;
        if (this.pad > 0) return;
      }
      this.entries.push({ path: this.cur.path, size: this.cur.size, sha256: this.cur.hash.digest('hex') });
      this.cur = null;
      this.state = 'header';
    }
  }

  end() {
    if (!this.done) {
      throw new Error('tar: stream ended before the archive end marker (truncated archive)');
    }
  }
}

/**
 * Stream a .tar.gz and return `{ path, size, sha256 }` for every regular-file
 * entry, in archive order. Never holds a full entry in memory.
 * @param {string} path
 * @returns {Promise<Array<{path:string, size:number, sha256:string}>>}
 */
export async function readTarGzEntries(path) {
  const parser = new TarParser();
  const gunzip = createGunzip();
  const src = createReadStream(path);
  // `src.pipe(gunzip)` does NOT forward a SOURCE error (e.g. ENOENT / a mid-read
  // I/O failure) to `gunzip`, so the `for await` below would never see it and the
  // process would crash with an uncaught error instead of this function REJECTING.
  // Forward it so callers (pack()'s verify, tests' assert.rejects) can trap it.
  src.on('error', (e) => gunzip.destroy(e));
  src.pipe(gunzip);
  for await (const chunk of gunzip) parser.push(chunk);
  parser.end();
  return parser.entries;
}

/** Streaming sha256 (hex) of a file — used for an archive's own digest. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
