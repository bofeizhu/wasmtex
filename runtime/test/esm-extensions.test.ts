// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Native-ESM portability guard (0.1.1). The published `wasmtex` package is loaded
// as native ESM by consumers — bare Node (`import 'wasmtex'`) and native-browser
// ESM (the demo, with no importmap). Both REQUIRE explicit file extensions on
// relative specifiers; TypeScript's `moduleResolution: "bundler"` does NOT enforce
// them, so an extensionless `import './foo'` would typecheck, build, and pass every
// other unit test, then break those consumers at load time (this exact drift once
// surfaced as a 20-minute CI demo-smoke timeout — see docs/LOG.md). This test scans
// the SHIPPED sources (`src/` + `worker/`) and fails fast, naming any offender, so
// the regression cannot come back silently. `node/` is intentionally excluded: it
// is esbuild-bundled into the node-harness and never reaches the published files.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUNTIME_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Recursively collect every `.ts` file under a directory. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Relative specifiers in `from '…'`, `import('…')`, and side-effect `import '…'`.
const RELATIVE_SPECIFIER = /\b(?:from|import)\b\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

describe('published ESM uses explicit .js specifiers (native Node + browser portability)', () => {
  const dirs = ['src', 'worker'].map((d) => join(RUNTIME_ROOT, d));
  const files = dirs.flatMap(tsFiles);

  it('finds the shipped sources (guard is actually scanning something)', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('every relative import/export specifier in src/ and worker/ ends in .js (or .json)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
        const spec = match[1];
        if (!/\.(?:js|json)$/.test(spec)) {
          offenders.push(`${file.slice(RUNTIME_ROOT.length)}: '${spec}'`);
        }
      }
    }
    expect(
      offenders,
      'extensionless relative specifiers break native-ESM consumers (bare Node + importmap-less browser). ' +
        `Add a .js extension to each (bundler resolution maps .js -> .ts):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
