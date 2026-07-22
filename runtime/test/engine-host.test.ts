// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// Engine-host asset-resolution tests (M1 item 7). The client's `locateAsset(name)`
// override (DESIGN.md §5.1) travels to the worker as a per-entry `url` on the
// init inventory; the host must load that entry from `url` INSTEAD OF
// `baseUrl` + `path`. These tests pin that support both in isolation (the pure
// `resolveAssetLocation`) and through `EmscriptenEngineHost.load()` with a fake
// module loader — no real wasm — so they run in CI without dist/.

import { describe, expect, it } from 'vitest';
import {
  EmscriptenEngineHost,
  resolveAssetLocation,
  type BusytexFactory,
  type EngineModule,
  type EngineModuleLoader,
} from '../worker/engine-host';
import type { AssetsConfig, AssetsInventory } from '../src/protocol';

// ---------------------------------------------------------------------------
// resolveAssetLocation (pure)
// ---------------------------------------------------------------------------

describe('resolveAssetLocation', () => {
  it('honors a non-empty url over baseUrl + path', () => {
    expect(resolveAssetLocation('/dist', { path: 'busytex.wasm', url: 'https://cdn.example/x.wasm' })).toBe(
      'https://cdn.example/x.wasm',
    );
  });

  it('joins baseUrl + path when url is absent or empty (default, unchanged behavior)', () => {
    expect(resolveAssetLocation('/dist', { path: 'busytex.wasm' })).toBe('/dist/busytex.wasm');
    expect(resolveAssetLocation('/dist/', { path: '/busytex.wasm' })).toBe('/dist/busytex.wasm');
    expect(resolveAssetLocation('/dist', { path: 'busytex.wasm', url: '' })).toBe('/dist/busytex.wasm');
  });

  it('uses the url verbatim regardless of scheme (custom schemes are legitimate, §10)', () => {
    expect(resolveAssetLocation('/dist', { path: 'tl.data', url: 'wasmtex-assets://custom/tl.data' })).toBe(
      'wasmtex-assets://custom/tl.data',
    );
  });
});

// ---------------------------------------------------------------------------
// load() honors entry.url at every resolution site (fake loader, no wasm)
// ---------------------------------------------------------------------------

/** A loader that records the locations it is handed, returning a scripted fake factory. */
class FakeLoader implements EngineModuleLoader {
  engineJsLocation: string | null = null;
  readonly dataPackageLocations: string[] = [];
  #factory: BusytexFactory;

  constructor(factory: BusytexFactory) {
    this.#factory = factory;
  }

  async loadFactory(location: string): Promise<BusytexFactory> {
    this.engineJsLocation = location;
    return this.#factory;
  }

  installDataPackage(_module: EngineModule, location: string): void {
    this.dataPackageLocations.push(location);
  }
}

/**
 * A fake MODULARIZE factory: captures the options module the host built, gives it
 * a 64 MiB all-zero heap (so the host's post-load zero-past-header memory scan
 * passes — its tail is empty), and returns it. Runs no preRun and no real wasm.
 */
function fakeFactory(): { factory: BusytexFactory; captured: () => EngineModule } {
  let module: EngineModule | null = null;
  const factory: BusytexFactory = async (options) => {
    module = options;
    const heap = new Uint8Array(2 ** 26); // 64 MiB, matches MEM_HEADER_SIZE → scan tail empty
    options.HEAPU8 = heap;
    options.HEAP32 = new Int32Array(heap.buffer);
    options.callMain = () => 0;
    options.FS = {} as EngineModule['FS'];
    return options;
  };
  return {
    factory,
    captured: () => {
      if (module === null) throw new Error('factory was not invoked');
      return module;
    },
  };
}

function inventory(withUrls: boolean): AssetsInventory {
  const u = (url: string) => (withUrls ? { url } : {});
  return {
    schemaVersion: 1,
    assets: [
      { path: 'busytex.js', role: 'engine-js', ...u('https://cdn.example/e.js') },
      { path: 'busytex.wasm', role: 'engine-wasm', ...u('https://cdn.example/e.wasm') },
      { path: 'texlive-basic.js', role: 'bundle-js', ...u('wasmtex-assets://b/tl.js') },
      { path: 'texlive-basic.data', role: 'bundle-data', ...u('wasmtex-assets://b/tl.data') },
    ],
  };
}

function assetsWith(inv: AssetsInventory): AssetsConfig {
  return { baseUrl: '/dist', inventory: inv, bundles: { preload: ['texlive-basic'], onDemand: [] } };
}

describe('EmscriptenEngineHost.load — entry.url honoring', () => {
  it('loads engine-js, bundle-js, and locateFile targets from url when present', async () => {
    const { factory, captured } = fakeFactory();
    const loader = new FakeLoader(factory);
    await new EmscriptenEngineHost(loader).load(assetsWith(inventory(true)));

    // engine-js factory location came from the url, not /dist/busytex.js.
    expect(loader.engineJsLocation).toBe('https://cdn.example/e.js');
    // bundle-js data-package location came from the url.
    expect(loader.dataPackageLocations).toEqual(['wasmtex-assets://b/tl.js']);
    // locateFile (Emscripten uses it for the .wasm and .data) honors url.
    const locateFile = captured().locateFile!;
    expect(locateFile('busytex.wasm')).toBe('https://cdn.example/e.wasm');
    expect(locateFile('texlive-basic.data')).toBe('wasmtex-assets://b/tl.data');
    // A name with no matching inventory entry still falls back to base + name.
    expect(locateFile('unknown.dat')).toBe('/dist/unknown.dat');
  });

  it('falls back to baseUrl + path at every site when no url override is present', async () => {
    const { factory, captured } = fakeFactory();
    const loader = new FakeLoader(factory);
    await new EmscriptenEngineHost(loader).load(assetsWith(inventory(false)));

    expect(loader.engineJsLocation).toBe('/dist/busytex.js');
    expect(loader.dataPackageLocations).toEqual(['/dist/texlive-basic.js']);
    const locateFile = captured().locateFile!;
    expect(locateFile('busytex.wasm')).toBe('/dist/busytex.wasm');
    expect(locateFile('texlive-basic.data')).toBe('/dist/texlive-basic.data');
  });
});
