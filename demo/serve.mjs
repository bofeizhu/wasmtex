// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Minimal static file server for the M0 demo + its Playwright smoke. Serves the
// REPO ROOT on one origin so both /dist/... (vendored artifacts) and /demo/...
// (this demo) resolve under the same origin — the same-origin, no-network
// embedding profile from DESIGN.md §10.
//
// The one load-bearing detail is the MIME map: busytex.js compiles the engine
// (busytex_pipeline.js) with WebAssembly.compileStreaming(fetch(...)), which REQUIRES the
// wasm response to carry `application/wasm` or Chromium rejects the stream.
//
// Dev:   node demo/serve.mjs           (then open http://127.0.0.1:8099/demo/)
// Test:  launched automatically by playwright.config.mjs `webServer`.
// Env:   PORT (default 8099), HOST (default 127.0.0.1).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..'); // repo root (demo/ -> parent)
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', // <- required for compileStreaming
  '.data': 'application/octet-stream',
  '.fmt': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve within ROOT and refuse any path that escapes it (traversal).
    const filePath = normalize(join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    let body;
    try {
      body = await readFile(filePath);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('500 ' + (err && err.message ? err.message : 'error'));
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`wasmtex demo server: http://${HOST}:${PORT}/demo/  (root: ${ROOT})`);
});
