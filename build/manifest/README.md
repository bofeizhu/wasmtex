# build/manifest/

Generates the machine-readable asset inventory the runtime consumes instead of
hardcoded asset names (M1 rebase-proofing rule 1: *asset inventories are data,
never code constants*).

## `gen-assets.mjs` → `dist/assets.json` (schemaVersion 1, current)

`gen-assets.mjs` reads a built `dist/` and emits `dist/assets.json`. It is
original, zero-dependency node ESM (only `node:` builtins), run by the dist
stage of `build/artifacts/build-native.sh` (so `make artifacts STAGE=dist`
regenerates it) and standalone as `node build/manifest/gen-assets.mjs [distDir]`.

### Schema

```json
{
  "schemaVersion": 1,
  "generated": "2026-06-16T14:06:37.000Z",
  "assets": [
    { "path": "busytex.wasm", "bytes": 30366631, "sha256": "cf02…", "role": "engine-wasm" }
  ]
}
```

- `schemaVersion` — integer schema stamp. Bumped when the shape changes (M4, see
  below).
- `generated` — ISO 8601 build stamp derived from `SOURCE_DATE_EPOCH`.
  **Omitted entirely** when that env var is unset, so the field never carries a
  wall-clock time (determinism). The pinned build always sets it.
- `assets` — one entry per file in `dist/` (except `assets.json` itself), sorted
  by `path` in byte/C-locale order. Each entry carries the dist-relative POSIX
  `path`, the on-disk `bytes` and `sha256`, and a `role`.

Output is `JSON.stringify(…, null, 2)` + a trailing newline, with keys emitted
in a fixed order. **Idempotent**: re-running on an unchanged `dist/` produces a
byte-identical `assets.json`.

### Roles

Assigned by an ordered, data-driven rule table (first match wins), documented in
the generator header. Structural (sibling-pairing) rules are preferred over
exact names so an artifact rename/re-tier at the annual rebase reclassifies
without code changes.

| role            | matched by                                             |
| --------------- | ------------------------------------------------------ |
| `checksums`     | basename `SHA256SUMS`                                   |
| `format`        | extension `.fmt` (engine format dumps)                 |
| `engine-wasm`   | extension `.wasm` (the single multicall engine)        |
| `bundle-data`   | extension `.data` (Emscripten file_packager data)      |
| `engine-js`     | `.js` with a sibling `<stem>.wasm` (engine loader)     |
| `bundle-js`     | `.js` with a sibling `<stem>.data` (bundle loader)     |

(The `glue-pipeline` / `glue-worker` roles were retired at M2 item 3 when the
vendored busytex worker/pipeline glue was dropped from `dist/`.)

A file matching **no** rule is a hard error: a new dist artifact must be
classified deliberately, not silently dropped or mislabeled. The runtime's
`AssetRole` type (`runtime/src/protocol.ts`) mirrors these six roles with an
open `(string & {})` arm; `runtime/test/assets.test.ts` pins the schema against
that type.

### `SHA256SUMS` handling

`assets.json` is **not** listed inside `SHA256SUMS`; `SHA256SUMS` **is** listed
inside `assets.json` (role `checksums`). The build writes `SHA256SUMS` first
(over every file except itself), then runs the generator, which:

- cross-checks every payload file's `sha256` against its `SHA256SUMS` row (a
  mismatch, a `SHA256SUMS` row with no file, or a dist file with no row is a
  hard error — catches a stale/corrupt `dist/`);
- excludes only `assets.json` from the inventory (listing it would be a
  self-reference fixpoint), so every other artifact — `SHA256SUMS` included — is
  inventoried.

When `SHA256SUMS` is absent (an un-checksummed `dist/`), the cross-check is
skipped and no `checksums` asset is emitted.

## `manifest.json` (M4, forward-compatible evolution)

At M4 (bundles + manifests) this directory also generates `manifest.json`, the
top-level integrity manifest hosts verify installs against: the TeX Live
snapshot id, the engine list, per-file `{ bytes, sha256 }`, and a per-bundle
provided-package index (DESIGN.md §4). `assets.json` is its deliberate
precursor — same per-file `{ path, bytes, sha256, role }` backbone. M4 bumps
`schemaVersion` and adds the snapshot id and per-bundle package indexes; the
runtime types already leave room for the added fields (open `AssetRole` arm plus
forward-compat index signatures on `AssetsInventory`/`AssetEntry`).
