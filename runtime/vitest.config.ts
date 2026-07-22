// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Vitest config for the wasmtex runtime. Tests run as pure node modules — the
// worker/wasm compile path is covered by the demo + integration suites (see
// runtime/README.md and docs/plans/M1.md), not here.
//
// Type-checking of the test sources is handled by `npm run typecheck` (tsc over
// tsconfig.test.json), NOT by vitest's `typecheck` mode: that mode is a
// type-assertion feature and does not fail on ordinary type errors in test
// bodies, so it would be a false green. `npm test` is behavioural only.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
