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
  mountViaRunDependencies,
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

  readonly mountedPackageLocations: string[] = [];
  mountError: unknown = null;
  async mountDataPackage(_module: EngineModule, location: string): Promise<void> {
    this.mountedPackageLocations.push(location);
    if (this.mountError !== null) throw this.mountError;
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
      // A second (on-demand) tier present in the inventory but NOT preloaded, so
      // loadBundle('academic') has a bundle-js entry to resolve.
      { path: 'academic.js', role: 'bundle-js', ...u('wasmtex-assets://b/ac.js') },
      { path: 'academic.data', role: 'bundle-data', ...u('wasmtex-assets://b/ac.data') },
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

// ---------------------------------------------------------------------------
// loadBundle — post-init on-demand mount (M4 item 5), fake loader, no wasm
// ---------------------------------------------------------------------------

describe('EmscriptenEngineHost.loadBundle — on-demand mount', () => {
  it('resolves the on-demand tier bundle-js and mounts it via the loader (baseUrl + path)', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false)));

    // load() installed only the PRELOAD tier's data package (in preRun); nothing mounted yet.
    expect(loader.dataPackageLocations).toEqual(['/dist/texlive-basic.js']);
    expect(loader.mountedPackageLocations).toEqual([]);

    await host.loadBundle('academic');
    // The on-demand tier goes through mountDataPackage (the post-init path), NOT installDataPackage.
    expect(loader.mountedPackageLocations).toEqual(['/dist/academic.js']);
    expect(loader.dataPackageLocations).toEqual(['/dist/texlive-basic.js']); // unchanged
  });

  it('honors an entry.url override for the on-demand tier bundle-js', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(true)));

    await host.loadBundle('academic');
    expect(loader.mountedPackageLocations).toEqual(['wasmtex-assets://b/ac.js']);
  });

  it('is idempotent: mounting the same tier twice mounts once', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false)));

    await host.loadBundle('academic');
    await host.loadBundle('academic');
    expect(loader.mountedPackageLocations).toEqual(['/dist/academic.js']); // exactly one mount
  });

  it('treats an already-preloaded tier as a no-op (never re-mounts a preload tier)', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false))); // preload: ['texlive-basic']

    await host.loadBundle('texlive-basic');
    expect(loader.mountedPackageLocations).toEqual([]); // already mounted at load; not re-mounted
  });

  it('rejects loadBundle before load() has resolved', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await expect(host.loadBundle('academic')).rejects.toThrow(/before load\(\) resolved/);
  });

  it('rejects an unknown tier name (no matching bundle-js in the inventory)', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false)));
    await expect(host.loadBundle('nope')).rejects.toThrow(/bundle 'nope' has no matching bundle-js/);
    expect(loader.mountedPackageLocations).toEqual([]);
  });

  it('propagates a loader mount failure and does not record the tier as loaded (a retry re-mounts)', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    loader.mountError = new Error('academic.data fetch failed');
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false)));

    await expect(host.loadBundle('academic')).rejects.toThrow(/academic\.data fetch failed/);
    // A subsequent successful retry mounts again (the failed attempt was not cached as loaded).
    loader.mountError = null;
    await host.loadBundle('academic');
    expect(loader.mountedPackageLocations).toEqual(['/dist/academic.js', '/dist/academic.js']);
  });
});

// ---------------------------------------------------------------------------
// loadBundle hardening (M4 items 6–7 review nits): in-flight idempotency +
// alias canonicalization. A manifest-style inventory with `bundles` carrying an
// `aliasOf` back-compat tier.
// ---------------------------------------------------------------------------

function aliasedInventory(): AssetsInventory {
  return {
    schemaVersion: 2,
    assets: [
      { path: 'busytex.js', role: 'engine-js' },
      { path: 'busytex.wasm', role: 'engine-wasm' },
      { path: 'core.js', role: 'bundle-js' },
      { path: 'core.data', role: 'bundle-data' },
      { path: 'texlive-basic.js', role: 'bundle-js' },
      { path: 'texlive-basic.data', role: 'bundle-data' },
      { path: 'academic.js', role: 'bundle-js' },
      { path: 'academic.data', role: 'bundle-data' },
    ],
    bundles: [
      { name: 'core', files: ['core.js', 'core.data'], provides: ['latex'] },
      { name: 'academic', files: ['academic.js', 'academic.data'], provides: ['siunitx'] },
      { name: 'texlive-basic', aliasOf: 'core' },
    ],
  };
}

function assetsPreloading(inv: AssetsInventory, preload: string[]): AssetsConfig {
  return { baseUrl: '/dist', inventory: inv, bundles: { preload, onDemand: [] } };
}

describe('EmscriptenEngineHost.loadBundle — hardening (items 6–7)', () => {
  it('shares ONE mount for concurrent loadBundle calls (in-flight idempotency, no double LZ4)', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsWith(inventory(false))); // preload: ['texlive-basic']

    // Three concurrent mounts of the same tier before any resolves — they must
    // share one in-flight Promise (a second concurrent LZ4.loadPackage → EEXIST).
    await Promise.all([host.loadBundle('academic'), host.loadBundle('academic'), host.loadBundle('academic')]);
    expect(loader.mountedPackageLocations).toEqual(['/dist/academic.js']); // mounted exactly once
  });

  it('canonicalizes an alias tier: loadBundle(texlive-basic) no-ops against a preloaded core', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsPreloading(aliasedInventory(), ['core'])); // preload core

    await host.loadBundle('texlive-basic'); // aliasOf core → already mounted
    await host.loadBundle('core'); // the real name → already mounted
    expect(loader.mountedPackageLocations).toEqual([]); // neither mounted a duplicate copy
  });

  it('mounting an alias mounts its CANONICAL tier bundle-js (core.js), and core then no-ops', async () => {
    const { factory } = fakeFactory();
    const loader = new FakeLoader(factory);
    const host = new EmscriptenEngineHost(loader);
    await host.load(assetsPreloading(aliasedInventory(), [])); // nothing preloaded

    await host.loadBundle('texlive-basic'); // canonical core → mount core.js (not the alias copy)
    expect(loader.mountedPackageLocations).toEqual(['/dist/core.js']);
    await host.loadBundle('core'); // already mounted via the alias
    expect(loader.mountedPackageLocations).toEqual(['/dist/core.js']);
  });
});

// ---------------------------------------------------------------------------
// mountViaRunDependencies — the environment-agnostic completion protocol
//
// The real file_packager loader (post-init) adds one run dependency for its
// `.data` synchronously, then removes it once the LZ4 files are mounted;
// Emscripten calls `monitorRunDependencies(n)` on each transition. These tests
// drive that protocol with a fake Module, no wasm.
// ---------------------------------------------------------------------------

describe('mountViaRunDependencies — post-init mount completion', () => {
  it('resolves when the run-dependency count returns to 0 after an async removal', async () => {
    const module = {} as EngineModule;
    const promise = mountViaRunDependencies(module, () => {
      module.monitorRunDependencies?.(1); // addRunDependency (the .data), synchronous
      setTimeout(() => module.monitorRunDependencies?.(0), 0); // removed once mounted
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves for a fully synchronous mount (monitor 1 then 0 during execute)', async () => {
    const module = {} as EngineModule;
    await expect(
      mountViaRunDependencies(module, () => {
        module.monitorRunDependencies?.(1);
        module.monitorRunDependencies?.(0);
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects when the data-package script throws synchronously', async () => {
    const module = {} as EngineModule;
    await expect(
      mountViaRunDependencies(module, () => {
        throw new Error('importScripts 404');
      }),
    ).rejects.toThrow(/importScripts 404/);
  });

  it('restores (and chains) any previous monitorRunDependencies after settling', async () => {
    const previousCalls: number[] = [];
    const previous = (n: number): void => {
      previousCalls.push(n);
    };
    const module = { monitorRunDependencies: previous } as unknown as EngineModule;
    await mountViaRunDependencies(module, () => {
      module.monitorRunDependencies?.(1);
      module.monitorRunDependencies?.(0);
    });
    expect(module.monitorRunDependencies).toBe(previous); // hook restored, not left dangling
    expect(previousCalls).toEqual([1, 0]); // the pre-existing hook still saw every transition
  });
});
