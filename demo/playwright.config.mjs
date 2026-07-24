// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Playwright config for the demo smoke. BROWSER MATRIX (M5 item 6, DESIGN.md §8):
// Chromium (primary; Electron-equivalent) + Firefox + WebKit (the §8 advisory
// matrix, promoted from "deferred" to running at M5). The same smoke suite runs
// on all three; a genuine per-browser limitation is documented, never silently
// skipped. The `webServer` block boots demo/serve.mjs (repo root, correct
// application/wasm MIME) once for the whole matrix.

import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT || '8099';
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test',
  // Generous: a cold XeTeX + xdvipdfmx compile in wasm is the slow path.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node serve.mjs',
    url: `${BASE}/demo/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT },
  },
});
