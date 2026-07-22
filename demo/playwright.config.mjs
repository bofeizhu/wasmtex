// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Playwright config for the M0 demo smoke. Chromium ONLY: DESIGN.md §8 makes
// Chromium the primary target (Electron-equivalent); Firefox/WebKit are the
// advisory browser matrix deferred to M5. The `webServer` block boots
// demo/serve.mjs (repo root, correct application/wasm MIME) for the run.

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
  ],
  webServer: {
    command: 'node serve.mjs',
    url: `${BASE}/demo/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT },
  },
});
