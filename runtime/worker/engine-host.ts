// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   ORIGINAL implementation of the §5 worker's engine host. The vendored busytex
//   glue (busytex_pipeline.js, MIT) was consulted ONLY as a BEHAVIOURAL
//   reference — which Emscripten Module options drive the multicall engine, the
//   TeX Live TDS paths/ENV the build expects, and the linear-memory reset that
//   makes repeated callMain sound — never for code or API shapes; nothing was
//   copied (busytex is MIT, so this is posture, not obligation). Not derived
//   from any GPL/AGPL source.
//
// ---------------------------------------------------------------------------
// The real {@link EngineHost} over the Emscripten multicall engine (M1 item 5).
//
// EXECUTION MODEL (chosen empirically — see core.ts's header and the M0 item-4
// journal "execution-model study"): ONE persistent MODULARIZE instance carries
// the ~79 MB texlive bundle; its LINEAR memory is snapshotted after load and
// rolled back after EVERY `callMain` (`fill(0)` then restore the low 64 MiB
// header). The reset is REQUIRED — without it a second same-applet run OOMs (the
// allocator brk never resets) — and it also clears TeX's global state so reruns
// are deterministic. The Emscripten MEMFS lives in the JS heap, so it SURVIVES
// the reset: that is what lets xdvipdfmx read xetex's `.xdv`, and lets the
// bundle stay mounted across jobs. Each new job remounts a clean MEMFS job dir.
//
// This module is ENVIRONMENT-AGNOSTIC: the environment-specific "how do I obtain
// the MODULARIZE factory and run the file_packager data-package script" is an
// injected {@link EngineModuleLoader}. The production (classic-worker) loader —
// `createWorkerModuleLoader`, importScripts + the worker's own fetch — lives
// here and is bundle-safe (only worker globals). The Node loader
// (createRequire + fs, mirroring build/artifacts/verify-engine.mjs) is a
// TEST-ONLY helper (runtime/test/support/) that is NEVER imported by the worker
// entry, so `node:*` built-ins never reach the shipped IIFE bundle — a
// deliberate split so the bundle stays self-contained (grep-clean of imports).
// ---------------------------------------------------------------------------

import {
  EngineAborted,
  describeError,
  type EngineHost,
  type EngineLogSink,
  type EngineRunResult,
  type EngineRunStep,
  type EngineStageInfo,
} from './core';
import type { AssetEntry, AssetsConfig, AssetsInventory, LogStream } from '../src/protocol';

// ---------------------------------------------------------------------------
// The Emscripten module surface we touch (structural — no @types/emscripten;
// tsconfig pins `lib: ["ES2022"]`, `types: []`). Only the members this host
// uses are declared; the index signature carries the file_packager carrier
// props (BusytexPipeline.*) and any other Emscripten-added fields.
// ---------------------------------------------------------------------------

/** The Emscripten MEMFS operations this host uses. */
export interface EngineFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  chdir(path: string): void;
  unmount(mountpoint: string): void;
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
  analyzePath(path: string): {
    exists: boolean;
    object?: { mount?: { mountpoint?: string } };
  };
  readonly filesystems: { readonly MEMFS: unknown };
}

/**
 * The MODULARIZE Module: the object passed to the factory and augmented in place
 * (so the same reference is both input options and initialised instance). Fields
 * we set are optional; Emscripten-provided fields (FS, callMain, HEAPU8, …) are
 * present only after the factory resolves — accessed via a controlled cast.
 */
export interface EngineModule {
  thisProgram?: string;
  noInitialRun?: boolean;
  locateFile?: (name: string, scriptDirectory?: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  preRun?: Array<() => void>;
  ENV: Record<string, string>;
  FS: EngineFS;
  callMain(args: string[]): number | undefined;
  /** Flush libc stdio buffers to print/printErr — surfaces the run's final partial line. */
  _flush_streams?: () => void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  LZ4?: unknown;
  [key: string]: unknown;
}

/** The MODULARIZE factory (`-sEXPORT_NAME=busytex`): options in, ready Module out. */
export type BusytexFactory = (options: EngineModule) => Promise<EngineModule>;

/**
 * The environment-specific loader. `loadFactory` obtains the MODULARIZE factory
 * from an engine-JS location; `installDataPackage` executes a file_packager
 * data-package script so it registers its `runWithFS` into `module.preRun`
 * (worker: set the global carrier + importScripts; node: a scoped eval). Both
 * receive fully-resolved locations (URL in a worker, path under node) — the host
 * does the base-URL + inventory resolution so the loader stays environment-only.
 */
export interface EngineModuleLoader {
  loadFactory(engineJsLocation: string): Promise<BusytexFactory>;
  installDataPackage(module: EngineModule, dataPackageLocation: string): void;
}

// ---------------------------------------------------------------------------
// Engine build layout (the busytex/TeX Live TDS contract this artifact expects).
// Behavioural config learned from the vendored pipeline + verified by the study;
// rebase-stable TDS conventions, re-validated by the conformance corpus, not
// asserted as version strings in code (M1 rebase-proofing).
// ---------------------------------------------------------------------------

const BIN_BUSYTEX = '/bin/busytex'; // argv[0] / Emscripten thisProgram
const PROJECT_DIR = '/home/web_user/project_dir'; // clean-per-job working root
const MEM_HEADER_SIZE = 2 ** 26; // 64 MiB static/bss+allocator header (see study)

/** TeX search + config environment (mirrors the pipeline's proven values). */
const ENGINE_ENV: Readonly<Record<string, string>> = {
  TEXMFDIST: '/texlive/texmf-dist:/texmf/texmf-dist',
  TEXMFVAR: '/texlive/texmf-dist/texmf-var',
  TEXMFCNF: '/texlive/texmf-dist/web2c',
  TEXMFLOG: '/tmp/texmf.log',
  FONTCONFIG_PATH: '/texlive',
};

// ---------------------------------------------------------------------------
// Small pure path + inventory helpers
// ---------------------------------------------------------------------------

/** Join a base (URL or POSIX path) with a relative asset path using `/`. */
function joinLocation(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '' : path.slice(0, slash);
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;
}

/**
 * Resolve one inventory entry to the absolute location the worker loads it from.
 *
 * Honors the client's `locateAsset(name)` override (DESIGN.md §5.1) — carried as
 * `entry.url` — OVER the default `baseUrl` + `path`. The url is used verbatim
 * (`importScripts`/`fetch`); same-origin is the host's concern (§10 permits
 * custom schemes), so it is not enforced here — it is only ever a load location,
 * never a filesystem key. Pure and total; exported for unit testing.
 */
export function resolveAssetLocation(base: string, entry: AssetEntry): string {
  const url = entry.url;
  if (typeof url === 'string' && url.length > 0) return url;
  return joinLocation(base, entry.path);
}

/** The single inventory entry with `role`, resolved to a load location (honors entry.url), or throw. */
function entryLocationByRole(base: string, inventory: AssetsInventory, role: string): string {
  const matches = inventory.assets.filter((a) => a.role === role);
  if (matches.length === 0) throw new Error(`assets.json has no entry with role '${role}'`);
  const entry = matches[0];
  if (entry === undefined || typeof entry.path !== 'string' || entry.path.length === 0) {
    throw new Error(`assets.json role '${role}' entry has no usable path`);
  }
  return resolveAssetLocation(base, entry);
}

/** Resolve a name Emscripten/the data package requests to its load location (data-driven, honors entry.url). */
function locateNameLocation(base: string, inventory: AssetsInventory, requestedName: string): string {
  const match = inventory.assets.find(
    (a) => a.path === requestedName || basenameOf(a.path) === requestedName,
  );
  return match ? resolveAssetLocation(base, match) : joinLocation(base, requestedName);
}

/** Resolve each preload bundle NAME to its `bundle-js` load location (honors entry.url). */
function preloadBundleLocations(base: string, assets: AssetsConfig): string[] {
  const bundleJs = assets.inventory.assets.filter((a) => a.role === 'bundle-js');
  return assets.bundles.preload.map((name) => {
    const match = bundleJs.find((a) => {
      const b = basenameOf(a.path);
      return b === name || b === `${name}.js` || b.replace(/\.js$/, '') === name;
    });
    if (!match) {
      throw new Error(`preload bundle '${name}' has no matching bundle-js asset in the inventory`);
    }
    return resolveAssetLocation(base, match);
  });
}

/** Recursively create `dir` in the MEMFS (idempotent). */
function mkdirp(fs: EngineFS, dir: string): void {
  if (dir === '' || dir === '/') return;
  let current = '';
  for (const part of dir.split('/')) {
    if (part === '') continue;
    current += `/${part}`;
    try {
      fs.mkdir(current);
    } catch {
      /* already exists */
    }
  }
}

/** True for an Emscripten `ExitStatus` (a clean process exit, not a wasm abort). */
function isExitStatus(error: unknown): error is { status?: number; name?: string } {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { status?: unknown; name?: unknown };
  return e.name === 'ExitStatus' || typeof e.status === 'number';
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

const NOOP_SINK: EngineLogSink = () => {};

/**
 * The real engine host. Construct with an {@link EngineModuleLoader} for the
 * environment; call {@link load} once, then {@link run} per applet.
 */
export class EmscriptenEngineHost implements EngineHost {
  private module: EngineModule | null = null;
  private memHeader: Uint8Array | null = null;

  // Per-run transcript wiring. `print`/`printErr` are installed once on the
  // Module and route here; `sink`/`capture` are swapped in around each callMain
  // so the SAME closures serve every run (and drop load-time engine chatter).
  private sink: EngineLogSink = NOOP_SINK;
  private capture: { stdout: string[]; stderr: string[] } | null = null;

  constructor(private readonly loader: EngineModuleLoader) {}

  async load(assets: AssetsConfig): Promise<void> {
    const base = assets.baseUrl;
    const inventory = assets.inventory;
    const engineJsLocation = entryLocationByRole(base, inventory, 'engine-js');
    const bundleJsLocations = preloadBundleLocations(base, assets);

    const factory = await this.loader.loadFactory(engineJsLocation);

    // The options object Emscripten augments in place (options === instance).
    // Cast: FS/callMain/HEAPU8/HEAP32 are filled by the factory before preRun.
    const module = {
      thisProgram: BIN_BUSYTEX,
      noInitialRun: true,
      locateFile: (name: string) => locateNameLocation(base, inventory, name),
      print: (text: string) => this.emit('stdout', text),
      printErr: (text: string) => this.emit('stderr', text),
      preRun: [
        () => {
          Object.assign(module.ENV, ENGINE_ENV);
          try {
            module.FS.mkdir(PROJECT_DIR);
          } catch {
            /* already exists */
          }
        },
      ],
    } as EngineModule;

    // Register each preloaded bundle's runWithFS into module.preRun BEFORE the
    // factory runs; the factory then awaits the .data load as a run dependency.
    for (const location of bundleJsLocations) {
      this.loader.installDataPackage(module, location);
    }

    const instance = await factory(module);

    // The header-only reset is valid ONLY if memory past the 64 MiB header is
    // zero at rest — i.e. the engine's static/bss + initial allocator state fit
    // under MEM_HEADER_SIZE. Assert it ONCE per session against the real wasm:
    // a rebase whose static segment outgrows the header would otherwise get its
    // live state silently zeroed on the first post-callMain reset. One scan of
    // the ~112M-word tail (~100 ms, once at load); loud on violation.
    const heap = instance.HEAPU8;
    if (heap.length < MEM_HEADER_SIZE || MEM_HEADER_SIZE % 4 !== 0) {
      throw new Error('engine linear memory smaller than the reset header, or misaligned');
    }
    const tail = instance.HEAP32.subarray(MEM_HEADER_SIZE / 4);
    let firstNonZero = -1;
    for (let i = 0; i < tail.length; i++) {
      // Plain indexed loop, not findIndex: ~112 ms vs ~736 ms for a 112M-word
      // callback scan (measured) — a one-time cost, but no reason to pay 6×.
      if (tail[i] !== 0) {
        firstNonZero = i;
        break;
      }
    }
    if (firstNonZero !== -1) {
      throw new Error(
        `engine static memory extends past the ${MEM_HEADER_SIZE}-byte reset header ` +
          `(non-zero at word ${firstNonZero} beyond it): MEM_HEADER_SIZE in engine-host.ts ` +
          'must grow to cover the new static segment, or the post-callMain reset will zero live state',
      );
    }
    this.memHeader = heap.slice(0, MEM_HEADER_SIZE);
    this.module = instance;
  }

  run(step: EngineRunStep, onLine: EngineLogSink): EngineRunResult {
    const module = this.requireModule();
    this.sink = onLine;

    if (step.stage) this.openJob(module, step.stage);

    const stdout: string[] = [];
    const stderr: string[] = [];
    this.capture = { stdout, stderr };

    let exitCode: number;
    try {
      const rc = module.callMain([step.applet, ...step.argv]);
      exitCode = typeof rc === 'number' ? rc : 0;
    } catch (error) {
      if (isExitStatus(error)) {
        exitCode = typeof error.status === 'number' ? error.status : 0;
      } else {
        // A wasm abort() (RuntimeError) — the instance is now unusable; the
        // client re-initialises on a fresh worker (DESIGN.md §5.2).
        throw new EngineAborted(`applet '${step.applet}' aborted: ${describeError(error)}`);
      }
    } finally {
      // Flush the run's final partial (no-newline) line to the CURRENT sink —
      // BEFORE the memory reset (which zeros libc's stdio buffers) and BEFORE
      // swapping to NOOP. Without this the last line is lost, and a dangling
      // buffered line would surface inside the NEXT job's stream under the wrong
      // jobId (a content-level §5.2 break). Upstream flushes after every call.
      this.flushStreams(module);
      // ALWAYS roll linear memory back to the clean header — even on abort — so
      // the next run starts from a known state and the allocator does not grow
      // unbounded across runs.
      this.resetMemory(module);
      this.sink = NOOP_SINK;
      this.capture = null;
    }

    const outputs = this.collect(module, step);
    return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), outputs };
  }

  private requireModule(): EngineModule {
    if (this.module === null) throw new Error('engine host used before load() resolved');
    return this.module;
  }

  /** Open a fresh job: remount a clean MEMFS at the job dir, stage files, chdir. */
  private openJob(module: EngineModule, stage: EngineStageInfo): void {
    // Belt-and-suspenders: guarantee clean linear memory even if a prior run
    // threw before its finally reset.
    this.resetMemory(module);

    const fs = module.FS;
    const info = fs.analyzePath(PROJECT_DIR);
    if (info.exists && info.object?.mount?.mountpoint === PROJECT_DIR) {
      fs.unmount(PROJECT_DIR);
    } else if (!info.exists) {
      mkdirp(fs, PROJECT_DIR);
    }
    fs.mount(fs.filesystems.MEMFS, {}, PROJECT_DIR);

    for (const [path, contents] of Object.entries(stage.files)) {
      const absolute = joinPath(PROJECT_DIR, path);
      mkdirp(fs, dirnameOf(absolute));
      fs.writeFile(absolute, contents);
    }

    const cwd = stage.cwd === '.' || stage.cwd === '' ? PROJECT_DIR : joinPath(PROJECT_DIR, stage.cwd);
    fs.chdir(cwd);
  }

  /** Read back the step's `collect` outputs (relative to the current cwd). */
  private collect(module: EngineModule, step: EngineRunStep): Map<string, Uint8Array> {
    const outputs = new Map<string, Uint8Array>();
    for (const rel of step.collect ?? []) {
      if (module.FS.analyzePath(rel).exists) {
        outputs.set(rel, module.FS.readFile(rel));
      }
    }
    return outputs;
  }

  /** Flush libc stdio to print/printErr so the run's final partial line surfaces. */
  private flushStreams(module: EngineModule): void {
    const flush = module._flush_streams;
    if (typeof flush !== 'function') return;
    try {
      flush();
    } catch {
      // A wasm abort() leaves the runtime unusable; this flush is best-effort
      // and the job has already failed.
    }
  }

  /** Restore the clean low-memory header and zero the rest (the reset trick). */
  private resetMemory(module: EngineModule): void {
    if (this.memHeader === null) return;
    const heap = module.HEAPU8; // re-read: never cache (defends against any resize)
    heap.fill(0);
    heap.set(this.memHeader);
  }

  /** Route one Emscripten print/printErr call to the active sink + capture, per line. */
  private emit(stream: LogStream, text: string): void {
    const value = String(text);
    const lines = value.includes('\n') ? value.split('\n') : [value];
    for (const line of lines) {
      this.sink(stream, line);
      if (this.capture) this.capture[stream].push(line);
    }
  }
}

// ---------------------------------------------------------------------------
// The production (classic-worker) module loader — bundle-safe (worker globals
// only; no node built-ins). Used by the worker entry.
// ---------------------------------------------------------------------------

interface WorkerGlobalScope {
  importScripts?: (...urls: string[]) => void;
  busytex?: BusytexFactory;
  BusytexPipeline?: unknown;
}

/**
 * The classic-worker loader: `importScripts` the engine JS (which defines the
 * global MODULARIZE factory `busytex`) and the file_packager data-package JS
 * (which reads the global carrier `BusytexPipeline`). Emscripten's own worker
 * code loads the `.wasm` and `.data` via the Module's `locateFile` + the worker
 * `fetch` — no DOM, classic worker, no SharedArrayBuffer (DESIGN.md §3, §10).
 */
export function createWorkerModuleLoader(): EngineModuleLoader {
  const scope = globalThis as unknown as WorkerGlobalScope;
  if (typeof scope.importScripts !== 'function') {
    throw new Error('createWorkerModuleLoader requires a classic Worker (importScripts unavailable)');
  }
  const importScripts = scope.importScripts.bind(scope);

  return {
    async loadFactory(engineJsLocation: string): Promise<BusytexFactory> {
      importScripts(engineJsLocation);
      const factory = scope.busytex;
      if (typeof factory !== 'function') {
        throw new Error(`engine JS at ${engineJsLocation} did not define the 'busytex' factory`);
      }
      return factory;
    },
    installDataPackage(module: EngineModule, dataPackageLocation: string): void {
      // The file_packager script reads the global `BusytexPipeline` as its
      // Module carrier; point it at our Module so runWithFS registers on
      // module.preRun and mounts the bundle during the factory's preRun.
      scope.BusytexPipeline = module;
      importScripts(dataPackageLocation);
    },
  };
}
