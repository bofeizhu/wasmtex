// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner (the build tooling carries no test framework, so
//   the runtime's vitest is not used here).
//   Run: `node --test build/bundles/tlpdb.test.mjs build/bundles/resolve.test.mjs`
//   (name the files explicitly — `node --test build/bundles/` errors on Node 24).
//
// Parser correctness on CRAFTED stanza fixtures — every field form the real
// tlpdb uses (multi-line depends, space-indented file lists with size= headers
// and trailing annotations, RELOC relocation, empty runfiles, per-arch binfiles,
// catalogue-* fields, collection depends, CRLF, blank-line stanza separation).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BLOCK_SIZE,
  fileEntryPath,
  parseSizeBlocks,
  parseStanza,
  parseTlpdb,
} from './tlpdb.mjs';

describe('parseTlpdb — crafted fixtures', () => {
  test('a full Package stanza: fields, relocated runfiles, sizes, catalogue', () => {
    const text = [
      'name siunitx',
      'category Package',
      'revision 77682',
      'shortdesc A comprehensive (SI) units package',
      'relocated 1',
      'longdesc A package for typesetting quantities and units.',
      'longdesc Second longdesc line is joined-and-ignored.',
      'depend l3kernel',
      'depend l3packages',
      'docfiles size=240',
      ' RELOC/doc/latex/siunitx/README.md details="Readme"',
      ' RELOC/doc/latex/siunitx/siunitx-code.pdf details="Code documentation"',
      'srcfiles size=195',
      ' RELOC/source/latex/siunitx/siunitx-abbreviation.dtx',
      'runfiles size=163',
      ' RELOC/tex/latex/siunitx/siunitx-v2.sty',
      ' RELOC/tex/latex/siunitx/siunitx.sty',
      ' RELOC/tex/latex/siunitx/siunitx-abbreviations.cfg',
      'catalogue-license lppl1.3c',
      'catalogue-version 3.4.14',
      '',
    ].join('\n');

    const db = parseTlpdb(text);
    assert.equal(db.size, 1);
    const p = db.get('siunitx');
    assert.ok(p, 'siunitx stanza present');
    assert.equal(p.name, 'siunitx');
    assert.equal(p.category, 'Package');
    assert.equal(p.revision, 77682);
    assert.equal(p.shortdesc, 'A comprehensive (SI) units package');
    assert.deepEqual(p.depends, ['l3kernel', 'l3packages']);

    // runfiles: RELOC/ normalized to texmf-dist/, order preserved, annotations
    // never present on runfiles but the path token is taken regardless.
    assert.deepEqual(p.runfiles, [
      'texmf-dist/tex/latex/siunitx/siunitx-v2.sty',
      'texmf-dist/tex/latex/siunitx/siunitx.sty',
      'texmf-dist/tex/latex/siunitx/siunitx-abbreviations.cfg',
    ]);
    assert.equal(p.runsizeBlocks, 163);

    // src/doc PATH LISTS are dropped (not needed downstream); only runfiles kept.
    assert.equal(p.binaryArchs.length, 0);

    // catalogue-* captured with the prefix stripped.
    assert.equal(p.catalogue.license, 'lppl1.3c');
    assert.equal(p.catalogue.version, '3.4.14');
  });

  test('a Collection stanza: depend lines name member packages, no runfiles', () => {
    const text = [
      'name collection-latex',
      'category Collection',
      'revision 77034',
      'shortdesc LaTeX fundamental packages',
      'relocated 1',
      'depend latex',
      'depend latex-bin',
      'depend babel',
      'depend collection-basic',
      'containersize 632',
      '',
    ].join('\n');

    const p = parseTlpdb(text).get('collection-latex');
    assert.equal(p.category, 'Collection');
    assert.deepEqual(p.depends, ['latex', 'latex-bin', 'babel', 'collection-basic']);
    assert.deepEqual(p.runfiles, [], 'a collection carries no runfiles');
    assert.equal(p.runsizeBlocks, 0);
  });

  test('empty runfiles header (size=0, no entries) yields an empty file list', () => {
    const text = [
      'name emptyrun',
      'category Package',
      'runfiles size=0',
      'catalogue-license lppl',
      '',
    ].join('\n');
    const p = parseTlpdb(text).get('emptyrun');
    assert.deepEqual(p.runfiles, []);
    assert.equal(p.runsizeBlocks, 0);
    assert.equal(p.catalogue.license, 'lppl', 'field after an empty file list still parses');
  });

  test('per-arch binfiles: arch noted, native binary paths dropped', () => {
    const text = [
      'name kpathsea.x86_64-linux',
      'category TLCore',
      'revision 77900',
      'binfiles arch=x86_64-linux size=36',
      ' bin/x86_64-linux/kpseaccess',
      ' bin/x86_64-linux/kpsewhich',
      '',
    ].join('\n');
    const p = parseTlpdb(text).get('kpathsea.x86_64-linux');
    assert.deepEqual(p.binaryArchs, ['x86_64-linux'], 'arch tag recorded');
    assert.deepEqual(p.runfiles, [], 'binfiles are not runfiles');
  });

  test('a package mixing runfiles and multiple binfiles blocks keeps only runfiles', () => {
    const text = [
      'name mixed',
      'category Package',
      'runfiles size=2',
      ' RELOC/tex/latex/mixed/mixed.sty',
      'binfiles arch=windows size=1',
      ' bin/windows/mixed.exe',
      'binfiles arch=x86_64-linux size=1',
      ' bin/x86_64-linux/mixed',
      '',
    ].join('\n');
    const p = parseTlpdb(text).get('mixed');
    assert.deepEqual(p.runfiles, ['texmf-dist/tex/latex/mixed/mixed.sty']);
    assert.deepEqual(p.binaryArchs, ['windows', 'x86_64-linux']);
  });

  test('non-relocated absolute paths pass through unchanged', () => {
    const text = [
      'name a2ping',
      'category Package',
      'runfiles size=25',
      ' texmf-dist/scripts/a2ping/a2ping.pl',
      ' tlpkg/something/note.txt',
      '',
    ].join('\n');
    const p = parseTlpdb(text).get('a2ping');
    assert.deepEqual(p.runfiles, [
      'texmf-dist/scripts/a2ping/a2ping.pl',
      'tlpkg/something/note.txt',
    ]);
  });

  test('multiple stanzas separated by blank lines; duplicate name = last wins', () => {
    const text = [
      'name one',
      'category Package',
      '',
      'name two',
      'category Collection',
      'depend one',
      '',
      'name one',
      'category Package',
      'revision 2',
      '',
    ].join('\n');
    const db = parseTlpdb(text);
    assert.deepEqual([...db.keys()].sort(), ['one', 'two']);
    assert.equal(db.get('one').revision, 2, 'the second "one" stanza replaced the first');
    assert.deepEqual(db.get('two').depends, ['one']);
  });

  test('CRLF line endings and a trailing stanza with no final blank line', () => {
    const text = 'name crlf\r\ncategory Package\r\nrunfiles size=1\r\n RELOC/tex/x/x.sty\r\n\r\nname last\r\ncategory Package';
    const db = parseTlpdb(text);
    assert.equal(db.size, 2);
    assert.deepEqual(db.get('crlf').runfiles, ['texmf-dist/tex/x/x.sty']);
    assert.ok(db.get('last'), 'final stanza without a trailing blank line is flushed');
  });

  test('a stanza with no name field is skipped (never throws)', () => {
    const db = parseTlpdb('category Package\nrunfiles size=1\n RELOC/tex/x/x.sty\n');
    assert.equal(db.size, 0);
  });

  test('empty input yields an empty map', () => {
    assert.equal(parseTlpdb('').size, 0);
    assert.equal(parseTlpdb('\n\n\n').size, 0);
  });
});

describe('parseStanza / helpers — units', () => {
  test('parseStanza handles a single stanza array directly', () => {
    const p = parseStanza(['name x', 'category Package', 'depend y']);
    assert.equal(p.name, 'x');
    assert.deepEqual(p.depends, ['y']);
  });

  test('fileEntryPath: RELOC normalization + annotation stripping', () => {
    assert.equal(fileEntryPath(' RELOC/tex/latex/x/x.sty'), 'texmf-dist/tex/latex/x/x.sty');
    assert.equal(
      fileEntryPath(' RELOC/doc/x/readme details="Readme"'),
      'texmf-dist/doc/x/readme',
    );
    assert.equal(fileEntryPath(' texmf-dist/scripts/x/x.pl'), 'texmf-dist/scripts/x/x.pl');
    assert.equal(fileEntryPath(' bin/windows/x.exe'), 'bin/windows/x.exe');
  });

  test('parseSizeBlocks: reads size= from either header form', () => {
    assert.equal(parseSizeBlocks('size=163'), 163);
    assert.equal(parseSizeBlocks('arch=windows size=36'), 36);
    assert.equal(parseSizeBlocks('nothing'), 0);
    assert.equal(parseSizeBlocks(''), 0);
  });

  test('BLOCK_SIZE is the TeX Live 4096-byte block', () => {
    assert.equal(BLOCK_SIZE, 4096);
  });
});
