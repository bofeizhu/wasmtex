// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source.
//
// ASSETS_VERSION + the boot-time asset-version soft-verify (M5 item 8, DESIGN.md
// §4 npm↔assets lockstep). Pure Node — no worker, no wasm: `createTypesetter` is
// driven with a supplied inventory + a FAKE auto-initialising WorkerLike, so the
// version gate is tested against the PUBLIC §5.1 surface. Cases: the constant is
// exported and in lockstep; a matching manifest version boots; a mismatch throws a
// typed AssetVersionMismatchError BEFORE any worker spawns; an absent version is
// tolerated (back-compat); and both overrides (a pinned string, and `false`).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASSETS_VERSION,
  AssetVersionMismatchError,
  createTypesetter,
  TypesetInputError,
  version,
  type CreateTypesetterOptions,
  type Typesetter,
  type WorkerFactory,
  type WorkerLike,
} from '../src/index';
import { initializedMessage, parseClientMessage, type AssetsInventory } from '../src/protocol';

// A minimal valid inventory; `version` is layered per-test (spread over this).
const BASE_INVENTORY = {
  schemaVersion: 2,
  assets: [
    { path: 'busytex.js', bytes: 100, role: 'engine-js' },
    { path: 'busytex.wasm', bytes: 30_000_000, role: 'engine-wasm' },
    { path: 'core.js', bytes: 1_700_000, role: 'bundle-js' },
    { path: 'core.data', bytes: 53_000_000, role: 'bundle-data' },
  ],
} as const;

const BUNDLES = { preload: ['core'], onDemand: [] };

/** A fake WorkerLike that auto-replies `initialized` so createTypesetter resolves. */
class AutoInitWorker implements WorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown): void {
    const parsed = parseClientMessage(message);
    if (parsed?.type === 'init') {
      const { jobId } = parsed;
      void Promise.resolve().then(() => this.onmessage?.({ data: initializedMessage(jobId) }));
    }
  }
  terminate(): void {
    this.onmessage = null;
    this.onerror = null;
  }
}

function boot(inventory: AssetsInventory, extra?: Partial<CreateTypesetterOptions>): {
  promise: Promise<Typesetter>;
  factoryState: { spawns: number };
} {
  const factoryState = { spawns: 0 };
  const factory: WorkerFactory = () => {
    factoryState.spawns += 1;
    return new AutoInitWorker();
  };
  const promise = createTypesetter({
    assetsBaseUrl: '/dist',
    bundles: BUNDLES,
    inventory,
    workerFactory: factory,
    ...extra,
  });
  return { promise, factoryState };
}

/** Await a promise expected to reject; return the thrown value (typed) or fail. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('ASSETS_VERSION (lockstep constant, M5 item 8)', () => {
  it('is exported, a semver string, and equal to version + package.json', () => {
    expect(typeof ASSETS_VERSION).toBe('string');
    expect(ASSETS_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
    // DESIGN §4 lockstep: the asset version equals the package version...
    expect(ASSETS_VERSION).toBe(version);
    // ...which is package.json (the single source of truth).
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(ASSETS_VERSION).toBe(pkg.version);
  });
});

describe('createTypesetter — asset-version soft-verify (DESIGN §4)', () => {
  it('boots when the manifest version matches ASSETS_VERSION', async () => {
    const { promise } = boot({ ...BASE_INVENTORY, version: ASSETS_VERSION });
    const tex = await promise;
    expect(tex).toBeDefined();
    await tex.dispose();
  });

  it('throws AssetVersionMismatchError (with expected/actual) on a mismatch, before spawning', async () => {
    const { promise, factoryState } = boot({ ...BASE_INVENTORY, version: '9.9.9' });
    const err = await rejection(promise);
    expect(err).toBeInstanceOf(AssetVersionMismatchError);
    // Prove nothing was spawned — the guard runs before the worker factory.
    expect(factoryState.spawns).toBe(0);

    const mismatch = err as AssetVersionMismatchError;
    expect(mismatch.expected).toBe(ASSETS_VERSION);
    expect(mismatch.actual).toBe('9.9.9');
    expect(mismatch.message).toContain('9.9.9');
    expect(mismatch.message).toContain(`wasmtex-assets-${ASSETS_VERSION}`);
    expect(mismatch.message).toContain(`assets-v${ASSETS_VERSION}`);
  });

  it('does NOT fail when the manifest omits version (back-compat with older assets)', async () => {
    // BASE_INVENTORY has no `version` field.
    const { promise } = boot(BASE_INVENTORY);
    const tex = await promise;
    expect(tex).toBeDefined();
    await tex.dispose();
  });

  it('treats a blank manifest version as absent (no throw)', async () => {
    const { promise } = boot({ ...BASE_INVENTORY, version: '' });
    const tex = await promise;
    expect(tex).toBeDefined();
    await tex.dispose();
  });

  describe('override', () => {
    it('expectAssetsVersion (string) requires THAT version instead of ASSETS_VERSION', async () => {
      // A deliberately different asset build the host pins; verification succeeds
      // against the pinned target...
      const ok = boot({ ...BASE_INVENTORY, version: '0.0.9' }, { expectAssetsVersion: '0.0.9' });
      const tex = await ok.promise;
      expect(tex).toBeDefined();
      await tex.dispose();

      // ...but still fails closed against a wrong/corrupt manifest.
      const bad = boot({ ...BASE_INVENTORY, version: '0.0.8' }, { expectAssetsVersion: '0.0.9' });
      const err = await rejection(bad.promise);
      expect(err).toBeInstanceOf(AssetVersionMismatchError);
      const mismatch = err as AssetVersionMismatchError;
      expect(mismatch.expected).toBe('0.0.9');
      expect(mismatch.actual).toBe('0.0.8');
    });

    it('expectAssetsVersion: false disables the check entirely', async () => {
      const { promise } = boot({ ...BASE_INVENTORY, version: 'totally-different' }, { expectAssetsVersion: false });
      const tex = await promise;
      expect(tex).toBeDefined();
      await tex.dispose();
    });

    it('a pinned string is FAIL-CLOSED: an absent manifest version throws (not back-compat)', async () => {
      // Unlike the default path, pinning a string treats a version-less manifest as
      // wrong/corrupt — the whole point of the pin is a hard guard.
      const { promise, factoryState } = boot(BASE_INVENTORY, { expectAssetsVersion: '0.0.9' });
      const err = await rejection(promise);
      expect(err).toBeInstanceOf(AssetVersionMismatchError);
      expect(factoryState.spawns).toBe(0);
      const mismatch = err as AssetVersionMismatchError;
      expect(mismatch.expected).toBe('0.0.9');
      expect(mismatch.actual).toBe(''); // '' signals "manifest declared no version"
      expect(mismatch.message).toContain('declares no version');
    });

    it('a pinned string still tolerates nothing but an exact match (blank manifest version fails)', async () => {
      const { promise } = boot({ ...BASE_INVENTORY, version: '' }, { expectAssetsVersion: '0.0.9' });
      const err = await rejection(promise);
      expect(err).toBeInstanceOf(AssetVersionMismatchError);
    });

    it.each([
      ['empty string', ''],
      ['a number', 123 as unknown as string],
      ['null', null as unknown as string],
      ['true', true as unknown as string],
    ])('rejects a malformed expectAssetsVersion (%s) with TypesetInputError, before spawning', async (_label, bad) => {
      const { promise, factoryState } = boot(
        { ...BASE_INVENTORY, version: ASSETS_VERSION },
        { expectAssetsVersion: bad as unknown as string | false },
      );
      const err = await rejection(promise);
      expect(err).toBeInstanceOf(TypesetInputError);
      expect(factoryState.spawns).toBe(0);
    });
  });
});
