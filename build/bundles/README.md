# build/bundles/

tlpdb-driven tiering: resolve TeX Live's own package database into a **disjoint
`file → tier` map** plus a per-tier package / provided-file index — the data the
multi-bundle build (M4 item 3), the `manifest.json` generator (item 4), and the
runtime's §5.4 on-demand resolution consume. Pure, zero-dependency Node ESM (only
`node:` builtins); no build step and no container run happen here.

All code is original work (SPDX-MIT). The only external input is TeX Live's
`texlive.tlpdb`, which is package **metadata** (data, not third-party code) — it
is parsed, never copied. No GPL/AGPL sources and no other WASM-TeX wrapper were
consulted.

## Modules

- **`tlpdb.mjs`** — `parseTlpdb(text) → Map<name, TlpdbPackage>`. A robust parser
  for the real `texlive.tlpdb` stanza format: blank-line-separated records,
  `key value` fields (repeatable `depend`), space-indented `runfiles/srcfiles/
  docfiles/binfiles size=N` file lists with trailing `key="value"` annotations,
  `RELOC/` relocation (normalized to `texmf-dist/`), per-arch `binfiles` (arch
  noted, native paths dropped), and `catalogue-*` fields. Keeps only what the
  resolver needs — `depends[]`, `runfiles[]` (installed paths), `runsizeBlocks`,
  `binaryArchs[]`, `catalogue{}` — and drops src/doc/bin path lists (irrelevant
  to a WASM engine). `size=` counts 4096-byte TeX Live blocks (`BLOCK_SIZE`).

- **`tiers.mjs`** — the **committed tier definition as data** (`TIERS`, an ordered
  array, `core` first). This is config, not logic: adding a package/collection to
  a tier, or adding a whole new tier (e.g. a future `full`), is an edit here and
  never a change to the resolver.
  - `core` — `collection-basic` + `collection-latex` + `collection-xetex`
    (exactly what today's `texlive-basic` installs; `scheme-basic` expands to the
    first two). Always preloaded.
  - `academic` — the journal + CJK working set: `collection-latexrecommended`,
    `collection-mathscience`, `collection-latexextra`, `collection-pictures`,
    `collection-fontsrecommended`, `collection-langchinese`, `collection-langcjk`,
    plus the `fandol` font (a deliberate DESIGN §6.3 exception so ctex compiles
    out of the box). On-demand.

- **`resolve.mjs`** — the resolver + CLI. `resolveTiers(db, tiers)` expands each
  tier's roots via transitive `depend` (cycle-guarded), assigns every file to the
  **first** tier that reaches it (so `academic` = its closure MINUS `core`), and
  returns `fileToTier`, per-tier `{ collections, packages, provides }` (where
  `provides` maps a package → the `.sty`/`.cls`/`.def` basenames it ships), counts,
  and a disjointness result. `formatSummary` renders the human report; `toJson`
  serializes the full resolution deterministically.

- **`gen-profile.mjs`** (M4 item 3) — emits the `install-tl` profile
  COLLECTION-selection lines (`<collection>  1`) for the DISTINCT union of every
  tier's collections. The multi-bundle build does ONE combined install
  (scheme-basic + these), so `tiers.mjs` is the single source of truth for the
  install too; the Makefile's `build/texlive-tiers.profile` rule appends this
  output. Collections only — a tier's `extraPackages` (e.g. `fandol`) come in via a
  collection's `depend` graph, since install-tl profiles can't select bare packages.

- **`stage-tiers.mjs`** (M4 item 3) — splits the ONE pruned combined install into
  **disjoint per-tier trees** by HARDLINK, driven by `resolveTiers`' `fileToTier`:
  a file the resolver assigns to a later tier goes to that tier's tree; EVERYTHING
  else (core package files + every install-generated / non-tlpdb file — the
  full-tree `ls-R`, `texmf.cnf`, the retained `.fmt`s and font maps, `fonts.conf`,
  the root `tex/` inis) falls to the base tier `core`. Each tree is then
  file_packager'd into `core.{js,data}` / `academic.{js,data}`, mounting at the
  same `/texlive` root (disjoint ⇒ no collisions). Writes `<out>/tiers.txt` (the
  packaged-tier list the drivers read). `core`'s ls-R over-lists academic paths on
  purpose — the DESIGN §5.4(b) missing-file retry trigger items 5/7 consume.

## CLI

```sh
node build/bundles/resolve.mjs [--tlpdb PATH] [--json OUT]
```

Prints the per-tier summary (packages, files, estimated size, disjointness). With
`--json OUT`, also writes the full resolution (`fileToTier` + per-tier indexes) as
deterministic JSON. The tlpdb defaults to `$WASMTEX_TLPDB`, else the ISO-staged
copy the native build unpacks under `~/.cache/wasmtex/.../tlpkg/texlive.tlpdb`.

Current pinned TL 2026 (tlpdb revision 78233) resolution:

| tier     | collections | packages | files  | est. size¹ |
| -------- | ----------: | -------: | -----: | ---------: |
| core     |           3 |      157 |  6 106 | ~100.8 MiB |
| academic |           7 |    2 414 | 31 363 | ~745.1 MiB |

¹ Estimated from tlpdb block counts (× 4096, per-file ceil) — a conservative
**upper bound** on uncompressed bytes; the shipped LZ4-packed `.data` is much
smaller (today's `core`-equivalent `texlive-basic.data` is 52.7 MB). Item 3
measures the real packed sizes.

## Tests

```sh
node --test build/bundles/tlpdb.test.mjs build/bundles/resolve.test.mjs \
             build/bundles/gen-profile.test.mjs build/bundles/stage-tiers.test.mjs
```

`tlpdb.test.mjs` checks the parser on crafted stanza fixtures (every field form).
`resolve.test.mjs` checks resolver invariants on synthetic dbs **and** against the
real pinned tlpdb — disjointness, `core ⊇` LaTeX base, `academic` markers
(`siunitx`/`tikz`/`xeCJK`/`ctex`/`fandol`), and **stable counts** as a drift
baseline. The real-tlpdb group skips cleanly when the ISO-staged tlpdb is absent
(e.g. CI without the native build), like the runtime's `assets.test` and the
conformance runner. `gen-profile.test.mjs` checks the collection union (dedup +
sort, no `collection-luatex`, `extraPackages` excluded). `stage-tiers.test.mjs`
checks the disjoint split on a tmpdir fixture — academic-owned files diverted,
everything else to `core`, hardlinked (same inode), symlinks skipped. All four
suites run in `build.yml` CI (synthetic groups; real-tlpdb group skips green).
