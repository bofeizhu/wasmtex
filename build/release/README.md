<!--
  SPDX-License-Identifier: MIT
  SPDX-FileCopyrightText: 2026 WasmTeX contributors
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/release/ — versioned release archives (DESIGN.md §7)

`pack.mjs` turns a **built `dist/`** into the DESIGN §7 release archives,
deterministically, and verifies every archive's bytes back against
`dist/manifest.json` before trusting it. It builds nothing — run `make artifacts`
(dev) or the release workflow's container build first, then pack.

```sh
VERSION=0.1.0 make pack          # → dist/release/*.tar.gz  (verified)
# or directly:
node build/release/pack.mjs --version 0.1.0 [--dist DIR] [--out DIR] [--json]
```

## The archives

| Archive | Contents | For |
| --- | --- | --- |
| `wasmtex-assets-<v>.tar.gz` | the **full `dist/` tree** — engine (`busytex.js`/`.wasm`), every bundle (`core`/`academic` `.js`+`.data`), the `.fmt` formats, `manifest.json`, `assets.json`, `licenses.json`, `SHA256SUMS` | a host that wants everything needed to run **and** verify |
| `wasmtex-bundle-core-<v>.tar.gz` | `core.js` + `core.data` | a host that only needs the always-preloaded tier |
| `wasmtex-bundle-academic-<v>.tar.gz` | `academic.js` + `academic.data` | the on-demand tier, fetched separately |

One per-bundle archive is emitted for each **real (non-alias) bundle** the manifest
lists (`core` + `academic` today; a future `full` tier packs for free). Bundle file
lists come from `manifest.bundles[].files` — **data, not hardcoded names** (DESIGN
rebase-proofing), so a rebase that renames a bundle file is followed with no edit.

The assets archive is self-verifying: extract it and run `shasum -a 256 -c
SHA256SUMS` to confirm the payload, or verify each file against `manifest.json`.

## Version-parameterized

`--version <v>` supplies the filename version; the tool **hardcodes no release
number**. `make pack` requires `VERSION=`. When `manifest.json` carries a package
`version` field (M5 item 8 adds one for the npm↔assets lockstep) that disagrees
with `--version`, the pack **aborts** — a mislabel guard. Until then it packs with
just a note.

## Determinism (DESIGN.md §6.1)

Archives are packed by `tar.mjs`, a small pure-node deterministic writer rather
than the host `tar` (macOS bsdtar vs GNU tar differ in deterministic-flag spelling
and default padding — shelling out would make the bytes host-dependent). Every
archive has:

- **sorted entries** (C-locale, matching `SHA256SUMS`/gen-assets order),
- **fixed metadata** — mode `0644`, uid/gid `0`, empty owner names, typeflag `0`,
- **`mtime` = `SOURCE_DATE_EPOCH`** if set, else the build's own epoch recorded in
  `manifest.texliveSnapshot.sourceDateEpoch`, else `0`,
- **the two POSIX end blocks** (no 20-block padding — a gzip'd tar needs none),
- a **canonical gzip header** — `MTIME=0`, `XFL=0`, `OS=0xFF`, no `FNAME` (the
  `gzip -n` shape, plus the OS byte neutralized so no host identity leaks).

So `pack` twice on the same `dist/` is **byte-identical** (`make pack` twice + `cmp`
proves it; the unit tests assert it). The DEFLATE payload is deterministic for a
fixed node/zlib version; cross-node-version byte-identity is not promised (DESIGN
§6.1 amendment descopes cross-environment byte-repro for v1).

## Verify-vs-manifest (fail-closed)

After writing each archive, `pack.mjs` **re-reads the archive it just wrote** (a
streaming untar+gunzip that hashes each entry) and checks it against
`dist/manifest.json` — the gen-assets integrity manifest, the verification oracle:

- **assets archive** — every manifest asset must be present with a matching
  `bytes` + `sha256`; and every archived file must be either a manifest asset or
  one of the two gen-assets outputs (`manifest.json` / `assets.json`) that are
  deliberately not self-listed. (`SHA256SUMS` **is** a manifest asset — role
  `checksums` — so it is verified normally, not exempted. This mirrors gen-assets'
  own SHA256SUMS-exclusion rules.)
- **each bundle archive** — contains exactly that bundle's declared files, each
  matching the manifest.

Any mismatch, missing asset, or stray file **fails the whole pack** (non-zero
exit). The per-archive report prints name, entry count, raw + gzip bytes, and the
archive's own sha256 (`--json` for a machine-readable form).

## Files

- `pack.mjs` — CLI + importable `pack()` / `buildArchiveSpecs()` / `verifyArchive()`.
- `tar.mjs` — the deterministic USTAR writer + streaming reader/hasher.
- `pack.test.mjs`, `tar.test.mjs` — `node --test` suites (wired into `build.yml`).
- `RELEASE_NOTES.template.md` — the §7 release-notes template (item 8 fills the
  `{{PLACEHOLDERS}}`).

## In the release pipeline (M5 item 8)

`pack.mjs` runs in `.github/workflows/release.yml` **after** the pinned-container
build, against the container-built `dist/` (per DESIGN §9, only container-built,
pin-verified artifacts are released — a native `make pack` is a dev convenience).
Item-8 hooks it already honors: the `--version` ↔ `manifest.version` mislabel
guard, and `SOURCE_DATE_EPOCH` for the archive `mtime`. The `--json` report gives
the workflow each archive's size + sha256 to attach to the GitHub Release and to
fill the release-notes template.
