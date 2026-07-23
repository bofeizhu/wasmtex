// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM using the
//   built-in `node:test` runner.
//   Run: `node --test build/bundles/gen-profile.test.mjs`
//
// Unit tests for gen-profile.mjs — the install-tl profile collection emitter that
// makes tiers.mjs the single source of truth for the combined install (M4 item 3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TIERS } from './tiers.mjs';
import { profileBlock, profileCollections } from './gen-profile.mjs';

describe('gen-profile — synthetic tiers', () => {
  test('unions collections across tiers, sorted and deduplicated', () => {
    const tiers = [
      { name: 'core', collections: ['collection-basic', 'collection-latex'], extraPackages: [] },
      // collection-basic repeats (shared) → must appear once; order irrelevant in.
      { name: 'academic', collections: ['collection-mathscience', 'collection-basic'], extraPackages: [] },
    ];
    assert.deepEqual(profileCollections(tiers), [
      'collection-basic',
      'collection-latex',
      'collection-mathscience',
    ]);
  });

  test('profileBlock renders one `<collection>  1` line each, no trailing newline', () => {
    const tiers = [{ name: 'core', collections: ['collection-latex', 'collection-basic'], extraPackages: [] }];
    assert.equal(profileBlock(tiers), 'collection-basic  1\ncollection-latex  1');
  });

  test('extraPackages are NOT emitted (profiles select collections, not packages)', () => {
    const tiers = [{ name: 'academic', collections: ['collection-langchinese'], extraPackages: ['fandol'] }];
    assert.deepEqual(profileCollections(tiers), ['collection-langchinese']);
    assert.ok(!profileBlock(tiers).includes('fandol'));
  });

  test('empty tier list yields no collections / empty block', () => {
    assert.deepEqual(profileCollections([]), []);
    assert.equal(profileBlock([]), '');
  });
});

describe('gen-profile — the real shipped tier definition', () => {
  const cols = profileCollections();

  test('covers every collection of every shipped tier', () => {
    const want = new Set(TIERS.flatMap((t) => t.collections));
    assert.equal(cols.length, want.size, 'deduped union size matches distinct collections');
    for (const c of want) assert.ok(cols.includes(c), `missing ${c}`);
  });

  test('includes the core base + the academic journal/CJK collections', () => {
    for (const c of ['collection-basic', 'collection-latex', 'collection-xetex']) {
      assert.ok(cols.includes(c), `core collection ${c} present`);
    }
    for (const c of [
      'collection-latexrecommended',
      'collection-mathscience',
      'collection-latexextra',
      'collection-pictures',
      'collection-fontsrecommended',
      'collection-langchinese',
      'collection-langcjk',
    ]) {
      assert.ok(cols.includes(c), `academic collection ${c} present`);
    }
  });

  test('never emits collection-luatex (LuaTeX dropped, DESIGN.md §9)', () => {
    assert.ok(!cols.includes('collection-luatex'));
    assert.ok(!profileBlock().includes('collection-luatex'));
  });

  test('output is deterministic (sorted) and each line ends in "  1"', () => {
    const sorted = [...cols].sort();
    assert.deepEqual(cols, sorted);
    for (const line of profileBlock().split('\n')) {
      assert.match(line, /^collection-[a-z0-9-]+ {2}1$/);
    }
  });
});
