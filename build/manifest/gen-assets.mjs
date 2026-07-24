#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 WasmTeX contributors
//
// Provenance: original work authored in the WasmTeX repository (see LICENSE).
//   Not derived from any third-party source. Zero-dependency node ESM (only
//   node: builtins + the sibling tier side-channel it READS, never the tlpdb).
//   Reads a built dist/ and EMITS the top-level integrity manifest the runtime
//   consumes INSTEAD of hardcoded asset names (rebase-proofing rule 1: "asset
//   inventories are DATA, never code constants").
//
// This is the DESIGN.md §7 integrity manifest (M4 item 4). It EVOLVED from the
// M1 `assets.json` inventory (schemaVersion 1) into a SUPERSET, schemaVersion 2:
// the full per-file inventory is kept verbatim, and three fields are added — the
// TeX Live snapshot id, the engine list, and a per-bundle provided-package index.
// Two files are written from ONE serialization pass:
//   * dist/manifest.json — the schemaVersion-2 manifest (the DESIGN §7 name; the
//     runtime PREFERS it, hosts verify installs against it).
//   * dist/assets.json  — the schemaVersion-1 inventory SUBSET, byte-shape
//     identical to what M1 shipped, RETAINED for one release as a back-compat
//     alias so 0.0.1 consumers keep working (dropped at M5; docs/plans/M4.md
//     item 4 + risks). It is NOT a byte-copy of manifest.json — it deliberately
//     stays v1 (inventory only), so its schemaVersion===1 contract is unbroken.
//
// gen-assets stays a pure DIST-INVENTORY tool: it walks dist/, classifies files,
// and cross-checks SHA256SUMS. The tlpdb-derived facts it cannot see from dist/
// alone — each bundle's provided-package names and the tlpdb revision/release —
// arrive via a SIDE-CHANNEL written by build/bundles/stage-tiers.mjs during
// staging (`--manifest`, MANIFEST_SIDECAR_VERSION), passed here as `--tiers`. So
// this tool never re-parses the tlpdb; the resolver remains the single owner of
// the package→tier truth.
//
// =============================================================================
// SCHEMA (schemaVersion 2 — manifest.json; assets.json is the v1 subset)
// -----------------------------------------------------------------------------
//   {
//     "schemaVersion": 2,
//     "version": "<pkg version>",       // OMITTED unless --version is passed (M5 item 8)
//     "generated": "<ISO 8601>",        // OMITTED unless SOURCE_DATE_EPOCH is set
//     "texliveSnapshot": {              // OMITTED if no snapshot facts are known
//       "release": "<TL release id>",   // from the tlpdb (side-channel), e.g. "2026"
//       "tlpdbRevision": <int>,         // from the tlpdb (side-channel)
//       "sourceDateEpoch": <int>,       // from SOURCE_DATE_EPOCH
//       "freeze": "<YYYY-MM-DD>"         // the snapshot day, derived from the epoch
//     },
//     "engines": ["bibtex8", "kpsewhich", ...],   // the multicall program set (static)
//     "bundles": [                      // per-tier provided-package index
//       { "name": "academic", "files": ["academic.data","academic.js"],
//         "bytes": <int>, "provides": ["siunitx", ...] },
//       { "name": "core", "files": ["core.data","core.js"],
//         "bytes": <int>, "provides": ["latex", ...] },
//       { "name": "texlive-basic", "aliasOf": "core" }   // honest alias, not a 3rd tier
//     ],
//     "assets": [
//       { "path": "<posix rel path>", "bytes": <int>,
//         "sha256": "<64 hex>", "role": "<role>" },
//       ...
//     ]
//   }
//
// - `version` is the npm↔assets LOCKSTEP package version (DESIGN §4, M5 item 8):
//   the single source of truth is `runtime/package.json`, read by the build DRIVER
//   and handed here via `--version <v>` (this tool never reads package.json — it
//   stays a pure dist-inventory tool, so the version is an EXPLICIT input, like the
//   `--tiers` side-channel). It is OMITTED when `--version` is absent (a standalone
//   dist inventory, or an asset tree that predates the lockstep field — the runtime
//   soft-verify tolerates its absence for back-compat). The runtime exports a
//   matching `ASSETS_VERSION` and boot-checks the fetched manifest's `version`
//   against it; `build/release/pack.mjs` fails closed if `--version` disagrees with
//   this field (the mislabel guard). Only `manifest.json` carries it — `assets.json`
//   stays the schemaVersion-1 inventory subset.
// - `generated` is derived from SOURCE_DATE_EPOCH (seconds) when that env var is
//   set, and OMITTED otherwise — determinism: the field must never carry a
//   wall-clock time, or two builds of identical inputs would differ. The pinned
//   build (build/artifacts/build-native.sh) always exports SOURCE_DATE_EPOCH.
// - `assets` is sorted by `path` (byte/C-locale order — the same order the
//   build's `LC_ALL=C sort` gives SHA256SUMS), so output is deterministic.
// - `engines` is a STATIC, sorted list (see ENGINES): the busytex multicall
//   dispatches these programs by argv[0], but the shipped `.wasm` is ONE opaque
//   binary, so the set cannot be read from the dist inventory — it is a property
//   of the engine build config (DESIGN §3, minus luatex), asserted here.
// - `bundles` is sorted by `name`. A bundle's `files`/`bytes` come from the DIST
//   inventory (the tier's `<name>.js`+`<name>.data`); its `provides` comes from
//   the side-channel. A dist bundle whose `.data` is BYTE-IDENTICAL to a real
//   tier's is emitted as `{ name, aliasOf }` (detected by equal sha256), so the
//   `texlive-basic`→`core` back-compat alias is represented honestly, not as a
//   duplicate third tier. Without `--tiers`, `provides`/snapshot facts are
//   omitted (a dist-only inventory still emits a valid schemaVersion-2 manifest).
// - Output is `JSON.stringify(_, null, 2)` + a trailing newline, keys in a fixed
//   order, so re-running on an unchanged dist/ + side-channel is byte-identical.
//
// ROLE TABLE (data-driven, ORDERED, first match wins)
// -----------------------------------------------------------------------------
// Roles are assigned from filename/structure patterns, not a hardcoded name
// list, so the M2 TL-2026 rebase can rename or re-tier artifacts without editing
// classification logic. Structural (sibling-pairing) rules are preferred over
// exact names where a stable structural signal exists.
//
//   #  role              match (on the dist-relative posix path)
//   -  ----------------  -------------------------------------------------------
//   1  checksums         basename == "SHA256SUMS"
//   2  license-inventory basename == "licenses.json"  (the M5-item-2 shipped-
//                        aggregate license inventory, emitted by
//                        build/bundles/licenses.mjs BEFORE SHA256SUMS so it is
//                        hashed + cross-checked like any payload file)
//   3  format            extension == ".fmt"        (engine .fmt format dumps)
//   4  engine-wasm       extension == ".wasm"       (the single multicall engine)
//   5  bundle-data       extension == ".data"       (Emscripten file_packager data)
//   6  engine-js         ".js" AND a sibling "<stem>.wasm" exists  (engine loader)
//   7  bundle-js         ".js" AND a sibling "<stem>.data" exists  (bundle loader)
//
// All seven rules are STRUCTURAL (name/extension/sibling-pairing): the engine js
// loader always pairs with the engine wasm of the same stem, and a bundle js
// loader always pairs with its <stem>.data — so an engine/bundle rename at
// rebase reclassifies correctly with no code change, and M4's multi-bundle
// tiering (core.js/core.data, extended.js/extended.data, ...) classifies for
// free. (The former glue-pipeline / glue-worker rules were retired at M2 item 3
// when the vendored busytex worker/pipeline glue was dropped from dist/ — the
// runtime replaced their role at M1 and the config is ours now.) Any file
// matching NO rule is a hard error (see below).
//
// UNKNOWN FILES ARE A HARD ERROR
// -----------------------------------------------------------------------------
// A dist/ file that matches no rule aborts the build (exit 1). A new dist
// artifact must be classified DELIBERATELY — silently dropping or mis-bucketing
// it would let the runtime's data-driven loader miss (or mislabel) an asset.
//
// SHA256SUMS HANDLING (decision, documented per the item-4 spec)
// -----------------------------------------------------------------------------
// Neither generator output (manifest.json, assets.json) is listed inside
// SHA256SUMS, and SHA256SUMS IS listed inside the manifest (role "checksums").
// Rationale:
//   * The build generates SHA256SUMS FIRST (over every file except itself and the
//     two generator outputs), then runs this generator. So SHA256SUMS predates
//     the manifest and cannot contain it; and this generator reads SHA256SUMS to
//     CROSS-CHECK every payload file's hash (catches a stale dist/ — see
//     consistency checks). Listing manifest.json/assets.json in SHA256SUMS would
//     be a self-reference fixpoint (a file's hash depending on its own bytes) and
//     would invert that useful ordering.
//   * The manifest is a COMPLETE inventory of the shipped PAYLOAD, so the real,
//     shipped SHA256SUMS artifact is itself listed (role "checksums"). Only the
//     two generator outputs exclude themselves.
// A checksums file never lists itself, so SHA256SUMS has no SHA256SUMS row; that
// one asset is exempt from the "every asset has a checksum row" direction below.
//
// CONSISTENCY CHECKS (fail loud — a mismatch means a stale or corrupt dist/)
// -----------------------------------------------------------------------------
//   * Every non-generated file in dist/ appears exactly once (the tool's own two
//     outputs, manifest.json + assets.json, are excluded; duplicate paths abort).
//   * When SHA256SUMS is present, cross-check BOTH directions:
//       - every SHA256SUMS row matches an on-disk asset with an equal hash
//         (a missing file or hash mismatch = stale/tampered dist -> abort);
//       - every asset except SHA256SUMS itself has a SHA256SUMS row
//         (an unchecksummed dist file = stale checksums -> abort).
//     When SHA256SUMS is absent (e.g. an un-checksummed dist), the cross-check
//     is skipped and no "checksums" asset is emitted.
//
// Usage:  node gen-assets.mjs [distDir] [--tiers SIDECAR] [--version V]
//         distDir defaults to <repo>/dist; --tiers is the stage-tiers side-channel
//         (build/stage/tiers.json) — when given it MUST exist (a wiring guard);
//         --version stamps the lockstep manifest.version (the driver reads it from
//         runtime/package.json) — when absent the field is omitted.
// =============================================================================

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, basename, extname, posix } from 'node:path';

const SCHEMA_VERSION = 2;
const MANIFEST_NAME = 'manifest.json'; // DESIGN §7 name; the runtime prefers it.
const ASSETS_NAME = 'assets.json'; // schemaVersion-1 back-compat alias (dropped at M5).
const OUTPUT_NAMES = new Set([MANIFEST_NAME, ASSETS_NAME]);
const SUMS_NAME = 'SHA256SUMS';
const LICENSES_NAME = 'licenses.json'; // M5 item 2 shipped-aggregate license inventory (build/bundles/licenses.mjs).

// The named multicall program set (DESIGN §3, minus luatex — dropped from v1 at
// the M2 rebase). STATIC on purpose: busytex dispatches these by argv[0] out of
// ONE opaque `.wasm`, so the set is a property of the engine build config, not
// something the dist inventory can reveal. Sorted (C-locale) for a deterministic,
// diffable manifest. Revisit at the annual rebase if the multicall set changes.
const ENGINES = ['bibtex8', 'kpsewhich', 'makeindex', 'pdftex', 'xdvipdfmx', 'xetex'];

// --- tiny output helpers (mirror build/artifacts/verify-engine.mjs style) ----
function fail(msg) {
  console.error(`\n!! [gen-assets] FAIL: ${msg}`);
  process.exit(1);
}
function note(msg) {
  console.log(`   [gen-assets] ${msg}`);
}

// --- resolve the dist directory + optional tier side-channel ------------------
// Positional distDir (the build passes an absolute path); otherwise default to
// <repo>/dist resolved from this script's location (build/manifest/ -> repo).
// `--tiers PATH` names the stage-tiers side-channel; when given it MUST exist.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

function parseArgs(argv) {
  const opts = { distDir: null, tiers: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tiers') opts.tiers = argv[++i];
    else if (a === '--version') opts.version = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node gen-assets.mjs [distDir] [--tiers SIDECAR] [--version V]');
      process.exit(0);
    } else if (a.startsWith('--')) fail(`unknown argument: ${a}`);
    else if (opts.distDir === null) opts.distDir = a;
    else fail(`unexpected extra argument: ${a}`);
  }
  return opts;
}

// The lockstep package version becomes `manifest.version` and (via pack.mjs) part
// of the archive filenames, so hold it to the same filename-safe token bar
// build/release/pack.mjs uses — a malformed value must STOP the build, not stamp a
// manifest that then mislabels the archives. Mirrors pack.mjs validateVersion.
function validateVersion(v) {
  if (typeof v !== 'string' || v === '') fail('--version was given without a value');
  // `undefined`/`null` are filename-safe tokens, so the regex below would wave them
  // through — but they are the string a driver stamps when `node -p .version` reads a
  // missing/nulled field. Reject them explicitly so a broken lockstep source can
  // never label the manifest+archives "undefined" (defense behind the driver guards).
  if (v === 'undefined' || v === 'null') {
    fail(`--version "${v}" looks like a missing package.json "version" field, not a real version`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(v)) {
    fail(`--version "${v}" is not a filename-safe version token (allowed: [0-9A-Za-z.+-], no leading punctuation)`);
  }
  return v;
}

const opts = parseArgs(process.argv.slice(2));
// The lockstep package version (npm↔assets, DESIGN §4). undefined => field omitted.
const packageVersion = opts.version !== null ? validateVersion(opts.version) : undefined;
const distDir = resolve(opts.distDir || join(repoRoot, 'dist'));

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail(`dist directory not found: ${distDir} (run \`make artifacts STAGE=dist\` first)`);
}
note(`dist: ${distDir}`);

// Read the tier side-channel (per-bundle provided-package names + TL snapshot id)
// if `--tiers` was given. A given-but-missing path is a wiring bug -> fail loud;
// no `--tiers` at all is the standalone dist-inventory mode (provides + snapshot
// facts simply omitted). See MANIFEST_SIDECAR_VERSION in build/bundles/stage-tiers.mjs.
let sidecar = null;
if (opts.tiers !== null) {
  const tiersPath = resolve(opts.tiers);
  if (!existsSync(tiersPath)) {
    fail(`--tiers side-channel not found: ${tiersPath} (stage-tiers.mjs --manifest writes it during staging)`);
  }
  try {
    sidecar = JSON.parse(readFileSync(tiersPath, 'utf8'));
  } catch (e) {
    fail(`--tiers side-channel is not valid JSON (${tiersPath}): ${e && e.message ? e.message : e}`);
  }
  if (typeof sidecar !== 'object' || sidecar === null || !Array.isArray(sidecar.tiers)) {
    fail(`--tiers side-channel malformed (${tiersPath}): expected { texlive, tiers: [...] }`);
  }
  // Fail loud on an incompatible sidecar rather than silently consuming a future
  // shape (stage-tiers stamps MANIFEST_SIDECAR_VERSION; keep them in lockstep).
  if (sidecar.schemaVersion !== 1) {
    fail(`--tiers side-channel schemaVersion ${sidecar.schemaVersion} unsupported (expected 1) — ${tiersPath}`);
  }
  note(`tiers: ${tiersPath} (${sidecar.tiers.length} tier(s))`);
}

// --- deterministic recursive walk -> dist-relative posix paths ---------------
function walk(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...walk(full));
    } else if (dirent.isFile()) {
      out.push(full);
    } else {
      // Symlinks / sockets / fifos have no place in a reproducible dist/.
      fail(`unexpected non-regular file in dist/: ${full}`);
    }
  }
  return out;
}

const toRel = (full) => relative(distDir, full).split(/[\\/]/).join(posix.sep);

// Collect every file except the two outputs we are about to (re)write. Excluding
// manifest.json + assets.json by name makes re-runs idempotent even when they
// already exist (and keeps the tool's own outputs out of the payload inventory).
const relPaths = walk(distDir)
  .map(toRel)
  .filter((rel) => !OUTPUT_NAMES.has(rel));

// "appears exactly once": the fs walk yields each file once; assert defensively.
const seen = new Set();
for (const rel of relPaths) {
  if (seen.has(rel)) fail(`duplicate path encountered during walk: ${rel}`);
  seen.add(rel);
}

// --- role classification (ordered; first match wins) -------------------------
// Each rule is { role, test } where test(ctx) -> boolean. ctx carries the parsed
// path plus a sibling-existence probe over the full file set.
const allRel = seen; // Set<string> of every classified candidate path
function siblingWithExt(rel, ext) {
  const d = posix.dirname(rel);
  const stem = basename(rel, extname(rel));
  const sib = d === '.' ? `${stem}${ext}` : posix.join(d, `${stem}${ext}`);
  return allRel.has(sib);
}

const ROLE_RULES = [
  { role: 'checksums', test: (c) => c.base === SUMS_NAME },
  { role: 'license-inventory', test: (c) => c.base === LICENSES_NAME },
  { role: 'format', test: (c) => c.ext === '.fmt' },
  { role: 'engine-wasm', test: (c) => c.ext === '.wasm' },
  { role: 'bundle-data', test: (c) => c.ext === '.data' },
  { role: 'engine-js', test: (c) => c.ext === '.js' && siblingWithExt(c.rel, '.wasm') },
  { role: 'bundle-js', test: (c) => c.ext === '.js' && siblingWithExt(c.rel, '.data') },
];

function classify(rel) {
  const ctx = { rel, base: basename(rel), ext: extname(rel) };
  for (const rule of ROLE_RULES) {
    if (rule.test(ctx)) return rule.role;
  }
  fail(
    `unclassified dist artifact: "${rel}". No role rule matched. A new dist ` +
      `artifact must be classified deliberately — add a rule to ROLE_RULES ` +
      `(see the header ROLE TABLE) in ${relative(repoRoot, fileURLToPath(import.meta.url))}.`,
  );
}

// --- sha256 (hex) of a dist file ---------------------------------------------
function sha256OfRel(rel) {
  return createHash('sha256').update(readFileSync(join(distDir, rel))).digest('hex');
}

// --- build the asset entries -------------------------------------------------
const assets = relPaths
  .map((rel) => ({
    path: rel,
    bytes: statSync(join(distDir, rel)).size,
    sha256: sha256OfRel(rel),
    role: classify(rel),
  }))
  // Byte/C-locale order over ASCII paths (matches the build's LC_ALL=C sort).
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// --- cross-check against SHA256SUMS when present -----------------------------
const sumsPath = join(distDir, SUMS_NAME);
if (existsSync(sumsPath)) {
  // Parse "<64hex>  <path>" rows (shasum text mode; a leading "./" is stripped).
  const sums = new Map();
  const text = readFileSync(sumsPath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!m) fail(`unparseable SHA256SUMS line: "${raw}"`);
    const hash = m[1];
    const p = m[2].replace(/^\.\//, '');
    if (sums.has(p)) fail(`SHA256SUMS lists "${p}" more than once`);
    sums.set(p, hash);
  }

  const matched = new Set();
  for (const a of assets) {
    const want = sums.get(a.path);
    if (want !== undefined) {
      if (want !== a.sha256) {
        fail(
          `sha256 mismatch for ${a.path}: SHA256SUMS=${want} disk=${a.sha256} ` +
            `(stale or corrupt dist/ — regenerate with \`make artifacts STAGE=dist\`)`,
        );
      }
      matched.add(a.path);
    } else if (a.path !== SUMS_NAME) {
      // A checksums file never lists itself; every OTHER asset must have a row.
      fail(`${a.path} is present in dist/ but absent from SHA256SUMS (stale checksums?)`);
    }
  }
  for (const p of sums.keys()) {
    if (!matched.has(p)) {
      fail(`SHA256SUMS lists "${p}" but it is absent from dist/ (stale dist?)`);
    }
  }
  note(`SHA256SUMS: cross-checked ${matched.size} payload file(s); all hashes match`);
} else {
  note(`${SUMS_NAME} not present; skipping hash cross-check (no "checksums" asset)`);
}

// --- generated timestamp (deterministic; from SOURCE_DATE_EPOCH only) --------
let generated; // undefined => field omitted
let epochSecs; // undefined => no SOURCE_DATE_EPOCH; reused by texliveSnapshot below
const epochRaw = process.env.SOURCE_DATE_EPOCH;
if (epochRaw !== undefined && epochRaw.trim() !== '') {
  const epoch = epochRaw.trim();
  if (!/^\d+$/.test(epoch)) {
    fail(`SOURCE_DATE_EPOCH is set but is not a non-negative integer: "${epochRaw}"`);
  }
  const secs = Number(epoch);
  if (!Number.isSafeInteger(secs)) {
    fail(`SOURCE_DATE_EPOCH out of safe integer range: "${epochRaw}"`);
  }
  epochSecs = secs;
  generated = new Date(secs * 1000).toISOString();
}

// --- texliveSnapshot: TL snapshot id (side-channel facts + SOURCE_DATE_EPOCH) -
// `release`/`tlpdbRevision` are the tlpdb's self-declared identity (via the
// side-channel); `sourceDateEpoch`/`freeze` come from the pinned build epoch
// (freeze = the snapshot DAY). Every field is omitted when its source is absent,
// and the whole object is omitted if nothing is known — so a standalone dist/
// still yields a valid manifest. Fixed key order for determinism.
function buildTexliveSnapshot() {
  const snap = {};
  const tl = sidecar && typeof sidecar.texlive === 'object' && sidecar.texlive !== null ? sidecar.texlive : {};
  if (typeof tl.release === 'string' && tl.release !== '') snap.release = tl.release;
  else if (typeof tl.release === 'number' && Number.isFinite(tl.release)) snap.release = String(tl.release);
  if (Number.isInteger(tl.tlpdbRevision)) snap.tlpdbRevision = tl.tlpdbRevision;
  if (epochSecs !== undefined) {
    snap.sourceDateEpoch = epochSecs;
    snap.freeze = new Date(epochSecs * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  }
  return Object.keys(snap).length > 0 ? snap : undefined;
}
const texliveSnapshot = buildTexliveSnapshot();

// --- bundles: per-tier provided-package index (dist files + side-channel) -----
// A bundle groups a tier's `<name>.js` + `<name>.data` (from the dist inventory);
// `provides` is that tier's package-name list (from the side-channel). A dist
// bundle whose `.data` is byte-identical (equal sha256) to a REAL tier's is an
// ALIAS — emitted as `{ name, aliasOf }`, never a duplicate tier (the
// `texlive-basic`→`core` back-compat copy). `provides` disjointness is the
// resolver's guarantee; this tool only groups + labels.
function buildBundles() {
  // Group bundle-* assets by rel-stem (path minus the .js/.data extension). js and
  // data of one tier share a stem; the display NAME is that stem's basename.
  const groups = new Map(); // stem -> { name, js?, data? }
  for (const a of assets) {
    if (a.role !== 'bundle-js' && a.role !== 'bundle-data') continue;
    const stem = a.path.slice(0, a.path.length - extname(a.path).length);
    const g = groups.get(stem) ?? { name: basename(stem), js: null, data: null };
    if (a.role === 'bundle-js') g.js = a;
    else g.data = a;
    groups.set(stem, g);
  }

  // Side-channel provides, keyed by tier name. Names present here are the REAL,
  // canonical tiers (what the resolver actually packaged).
  const provideByName = new Map();
  if (sidecar) {
    for (const t of sidecar.tiers) {
      if (t && typeof t.name === 'string' && Array.isArray(t.provides)) {
        provideByName.set(
          t.name,
          t.provides.filter((p) => typeof p === 'string'),
        );
      }
    }
  }

  // Alias detection by `.data` sha256: within a set of byte-identical bundles the
  // PRIMARY is the side-channel (real) tier if any, else the lexicographically
  // smallest name; the rest alias the primary. This resolves texlive-basic→core
  // with OR without a side-channel.
  const primaryByDataHash = new Map(); // data.sha256 -> primary bundle name
  const named = [...groups.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const g of named) {
    if (!g.data) continue;
    const h = g.data.sha256;
    const cur = primaryByDataHash.get(h);
    const gIsReal = provideByName.has(g.name);
    if (cur === undefined) {
      primaryByDataHash.set(h, g.name);
    } else if (gIsReal && !provideByName.has(cur)) {
      // A real tier outranks a non-real one that happened to sort earlier.
      primaryByDataHash.set(h, g.name);
    }
  }

  const bundles = [];
  for (const g of named) {
    const primary = g.data ? primaryByDataHash.get(g.data.sha256) : g.name;
    if (g.data && primary !== g.name) {
      // Byte-identical to an earlier (canonical) bundle -> honest alias marker.
      bundles.push({ name: g.name, aliasOf: primary });
      continue;
    }
    const files = [g.data, g.js].filter(Boolean).map((a) => a.path).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const bytes = [g.data, g.js].filter(Boolean).reduce((s, a) => s + a.bytes, 0);
    const provides = provideByName.get(g.name) ?? [];
    if (sidecar && !provideByName.has(g.name)) {
      note(`WARN: bundle '${g.name}' has no side-channel entry; emitting provides:[] (check --tiers)`);
    }
    bundles.push({ name: g.name, files, bytes, provides });
  }
  return bundles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const bundles = buildBundles();

// --- assemble + write (fixed key order, 2-space, trailing newline) -----------
// One shared inventory array, two files: manifest.json (schemaVersion 2 superset)
// and assets.json (the schemaVersion-1 inventory subset — back-compat alias).
const assetEntries = assets.map((a) => ({
  path: a.path,
  bytes: a.bytes,
  sha256: a.sha256,
  role: a.role,
}));

const manifest = {
  schemaVersion: SCHEMA_VERSION,
  ...(packageVersion !== undefined ? { version: packageVersion } : {}),
  ...(generated !== undefined ? { generated } : {}),
  ...(texliveSnapshot !== undefined ? { texliveSnapshot } : {}),
  engines: ENGINES,
  bundles,
  assets: assetEntries,
};

// assets.json stays schemaVersion 1 (inventory ONLY): byte-shape identical to
// what M1 shipped, so its schemaVersion===1 contract and any 0.0.1 consumer are
// unbroken. It is a SUBSET of manifest.json, not a byte-copy.
const inventoryV1 = {
  schemaVersion: 1,
  ...(generated !== undefined ? { generated } : {}),
  assets: assetEntries,
};

const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
const assetsJson = `${JSON.stringify(inventoryV1, null, 2)}\n`;
const manifestPath = join(distDir, MANIFEST_NAME);
const assetsPath = join(distDir, ASSETS_NAME);
writeFileSync(manifestPath, manifestJson);
writeFileSync(assetsPath, assetsJson);

// --- summary -----------------------------------------------------------------
const roleCounts = {};
for (const a of assets) roleCounts[a.role] = (roleCounts[a.role] ?? 0) + 1;
const roleSummary = Object.keys(roleCounts)
  .sort()
  .map((r) => `${r}=${roleCounts[r]}`)
  .join(' ');
note(`classified ${assets.length} asset(s): ${roleSummary}`);
const bundleSummary = bundles
  .map((b) => (b.aliasOf ? `${b.name}->${b.aliasOf}` : `${b.name}(${b.provides.length})`))
  .join(' ');
note(`bundles: ${bundleSummary || '(none)'}`);
if (texliveSnapshot !== undefined) {
  note(
    `texliveSnapshot: release=${texliveSnapshot.release ?? '?'} tlpdbRevision=` +
      `${texliveSnapshot.tlpdbRevision ?? '?'} freeze=${texliveSnapshot.freeze ?? '?'}`,
  );
} else {
  note('texliveSnapshot: omitted (no --tiers and no SOURCE_DATE_EPOCH)');
}
note(`version: ${packageVersion !== undefined ? packageVersion : 'omitted (no --version; runtime soft-verify tolerates absence)'}`);
note(
  `wrote ${relative(repoRoot, manifestPath)} (${Buffer.byteLength(manifestJson)} bytes) + ` +
    `${relative(repoRoot, assetsPath)} (${Buffer.byteLength(assetsJson)} bytes)` +
    (generated !== undefined ? `, generated=${generated}` : ', generated omitted (no SOURCE_DATE_EPOCH)'),
);
