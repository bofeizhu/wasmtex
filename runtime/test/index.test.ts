// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Scaffold smoke for the wasmtex public entry (M1 item 2): the two exports
// exist, are well-typed, and stay consistent with package.json. A pure node
// test — no worker, no wasm. Expanded/replaced by M1 items 3–8.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version, type EngineName } from '../src/index';

describe('wasmtex entry (scaffold)', () => {
  it('exports a semver version string that matches package.json', () => {
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);

    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(version).toBe(pkg.version);
  });

  it('admits exactly the three v1 engine names (luatex reserved)', () => {
    const engines: EngineName[] = ['xetex', 'pdftex', 'luatex'];
    expect(engines).toEqual(['xetex', 'pdftex', 'luatex']);

    // Type-level guard: EngineName must stay a closed union. If it were widened
    // (e.g. to `string`), the directive below would stop suppressing a real
    // error and tsc would flag it (TS2578) — that failure is the test.
    // @ts-expect-error 'latex' is not a member of EngineName
    const notAnEngine: EngineName = 'latex';
    void notAnEngine;
  });
});
