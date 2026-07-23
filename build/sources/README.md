# build/sources/

> The ACTIVE build consumes the TL **2026** pins (`[texlive-source-2026]`,
> `[texlive-iso-2026]`). The TL 2023 blocks were RETIRED at M2 item 9
> (2026-07-24; values recoverable from git history; the cached 2023 files may
> be deleted). Where this README shows 2023 values as format examples they
> remain accurate as examples only.

Fetches and verifies every external input the reproducible build depends on.
`pins.lock` is the single source of truth; `fetch.sh` reads it, downloads each
source into a cache **outside the repo tree**, and verifies it. Nothing is
downloaded that is not pinned with a hash, and any mismatch stops the build.

- `pins.lock` — machine-readable, hand-editable pin list (format below).
- `fetch.sh` — `set -euo pipefail`; downloads + verifies; idempotent; portable
  to bash 3.2 (macOS) and the Linux build container.

## What is pinned

| Id | Kind | Pin | Why |
| --- | --- | --- | --- |
| `busytex` | git | commit `f2bd7b11…d307b` (+ deterministic archive sha256) | upstream MIT build machinery (DESIGN.md §2); vendored at M0 item 3 |
| `expat` | file | `expat-2.5.0.tar.gz` + sha256 | fetched separately by the engine build (`URL_expat`) |
| `fontconfig` | file | `fontconfig-2.13.96.tar.gz` + sha256 | fetched separately by the engine build (`URL_fontconfig`) |
| `texlive-source-2026` | file | `texlive-2026.0` tarball + sha256 | TL 2026 engine sources (M2 rebase; tag is a git-svn branch ref) |
| `texlive-iso-2026` | file | `texlive2026-20260301.iso` + sha512/sha256 | frozen TL 2026 texmf image (release-area exception, see below; re-pin at M3) |
| `toolchain-image` | container | ubuntu digest, emsdk commit, emscripten 3.1.43, built image id | M0 item 1; recorded, not fetched |

`expat` and `fontconfig` are the **only** libraries the busytex Makefile
downloads outside the TL source tree — TL vendors harfbuzz, icu, freetype,
zlib, graphite2, teckit, pplib, zziplib, libpaper, lua53, xpdf itself, so those
are covered by the `texlive-source` pin and are **not** fetched separately.

### Deliberately not pinned

The upstream Makefile has three more acquisition paths that M0 does **not**
use:

- **`download-native`** — upstream CI downloads prebuilt x86_64 native busytex
  helper binaries from a busytex GitHub *release* to skip the native build. We
  build native from source in the pinned container instead (auditable, and no
  opaque binaries in the provenance chain). If a future milestone opts into the
  shortcut, those binaries become artifact-affecting inputs and must be pinned
  here.
- **`ubuntu/*` bundles** (`URL_ubuntu_release` = `packages.ubuntu.com/noble`) —
  builds optional bundles from **rolling** Ubuntu `.deb`s. That repo is not
  frozen and is inherently non-reproducible; it is out of scope for the M0
  baseline (whose one data bundle, `texlive-basic`, comes from the ISO via
  `install-tl`). Pinning it would need a snapshot repo (`snapshot.ubuntu.com`).
- **Example assets** — the Makefile's example target wgets three rotating,
  unpinned files (a Google logo, a Wikipedia SVG, a mozilla/pdf.js PDF).
  Item 4 must avoid exercising that target.

## Lock format (schema 1)

A sequence of blocks. A block starts with a header line `[<id>]` and continues
with `key = value` lines until the next header or EOF. Blank lines and `#`
comment lines are ignored; whitespace around `=` and around values is trimmed;
values never span lines; ids are unique. This is trivially parseable from bash
(`fetch.sh` uses two small awk helpers, `pin_ids` and `pin_get`) and gives a
one-line diff when a single hash changes.

`kind` selects handling:

| kind | Required keys | fetch.sh behaviour |
| --- | --- | --- |
| `file` | `url`, `file`, and ≥1 valid hash (`sha256` and/or `sha512`) | download `url` → `<cache>/<file>`; verify **every** valid hash present |
| `git` | `url`, `commit`, `archive`, `archive_sha256` | clone → hard-verify `HEAD == commit` → emit `<archive>` → verify `archive_sha256` |
| `container` | (free-form) | recorded for provenance; **not** fetched |
| `meta` | (free-form) | schema/bookkeeping; not fetched |

A hash field whose value is not a hex digest of the right length (64 for
sha256, 128 for sha512) is treated as an unset placeholder — it is reported and
skipped, and does **not** satisfy the "≥1 valid hash" rule. A `file`/`git`
block with no valid hash is **refused** as unpinned.

### git integrity anchor

For `git` sources the **commit hash is the integrity anchor** (`fetch.sh` hard
-verifies `git rev-parse HEAD`). `archive_sha256` additionally pins a
deterministic, uncompressed archive of the checkout, produced by:

```sh
git archive --format=tar --prefix=<archive-without-.tar>/ <commit>
```

`git archive` is deterministic for a given commit **and git version** (fixed
uid/gid 0, mtime = commit time, sorted entries), but its tar framing can differ
across git versions. So `archive_sha256` is pinned together with the git
version used to compute it (recorded in the `[meta]` block). A mismatch while
the commit verifies is a git-version framing difference, not corruption — re-pin
`archive_sha256` for the new git in the same commit that changes it.

## Cache location

Default `~/.cache/wasmtex/sources`, overridable with `WASMTEX_CACHE_DIR`. The
cache is **outside the repo tree** by design: multi-GB inputs (the 4.8 GiB ISO)
must never be committable. `.gitignore` also lists `build/sources/cache/` as a
belt-and-suspenders guard in case `WASMTEX_CACHE_DIR` is pointed inside the
tree. Layout:

```
$WASMTEX_CACHE_DIR/
  texlive2023-20230313.iso
  texlive-source-2023.0.tar.gz
  expat-2.5.0.tar.gz
  fontconfig-2.13.96.tar.gz
  busytex-f2bd7b11.tar          # deterministic git-archive of the pinned commit
  git/busytex/                  # working clone (checkout verification)
```

## Run it

```sh
build/sources/fetch.sh                        # fetch/verify everything
WASMTEX_CACHE_DIR=/data/cache build/sources/fetch.sh
```

Idempotent: a cached file is re-verified (hashed) and skipped, never
re-downloaded; downloads resume a partial `*.part` on retry. The only network
access is to the `url` fields in the lock (plus the git clone url).

## How to add or update a pin

1. Discover the hash by downloading the exact URL once, e.g.:
   ```sh
   curl -fL <url> | sha256sum          # → sha256 for a `file` pin
   ```
   For a `git` pin, clone, `git checkout <commit>`, confirm
   `git rev-parse HEAD`, then
   `git archive --format=tar --prefix=<name>/ <commit> | sha256sum`.
2. Add/edit the block in `pins.lock` with `url`, `file`/`commit`, the hash(es),
   and a `comment` naming the upstream source (e.g. the Makefile variable).
3. Run `fetch.sh` — it downloads and independently re-verifies. `fetch.sh` never
   writes the lock; the lock is authored by hand so review sees every pin change.

For a source with a publisher-provided checksum (the ISO), record that checksum
directly (the ISO's `sha512` is TUG's own published value) so every fetch
cross-checks against the upstream publisher, not just against our own record.

## Mirrors and the rotation rule

**Historic archives only.** TeX Live's yearly ISO lives at a CTAN "current"
Images URL (`…/systems/texlive/Images/texliveYYYY-*.iso`) that **rotates** — it
is overwritten when the next TL ships, so its bytes and any hash pinned to it
die annually. `pins.lock` therefore points only at a TUG **historic** archive
mirror, which keeps each year's frozen image permanently. `fetch.sh` encodes no
"current" URL.

**Release-year exception (sanctioned, M2 plan "ISO availability" risk).** In a
TL release year the historic archive may not yet carry the consolidated ISO
(2026: only the component `.tar.xz` files are archived). The lock may then pin
the exact **dated** ISO (`texliveYYYY-YYYYMMDD.iso`, never a rotating symlink)
from the CTAN release area, under three conditions: the publisher's checksum
file is recorded (`checksum_url`) and three-way verified; the rotation failure
mode is documented in the lock block itself (the URL 404s when the next TL
ships — content hashes still fail closed); and the block carries an explicit
re-pin instruction pointing at the historic path for when the ISO is archived
there. See `[texlive-iso-2026]`.

Well-known TUG historic mirrors carrying `systems/texlive/2023/`:

| Mirror | Base URL |
| --- | --- |
| TU Chemnitz (DE) — used by `pins.lock` | `https://ftp.tu-chemnitz.de/pub/tug/historic/` |
| Utah (US) — canonical primary | `https://ftp.math.utah.edu/pub/tex/historic/` |
| Authoritative mirror index (+ rsync) | `https://www.tug.org/historic/` |

To switch mirrors, change only the `url` (and `checksum_url`) in the
`texlive-iso` block; the `sha512`/`sha256` are content hashes and stay identical
across mirrors, so a mirror swap is verified automatically. The `pins.lock`
mirror was selected because the canonical Utah host was unreachable through this
environment's TLS proxy at authoring time; both serve identical bytes.

## Reproducibility caveats

- **GitHub auto-archives** (`texlive-source`, and the git clone) are generated
  on the fly; GitHub does not guarantee byte-stable tarballs across infra
  changes. A `texlive-source` sha256 mismatch most likely means GitHub
  re-generated the tarball — investigate before re-pinning (the `git` clone of
  the tag is the fallback source of truth for those bytes).
- **git-archive framing** is git-version sensitive — see "git integrity anchor".
- **The container image** (`toolchain-image`) is pinned by its built `image_id`,
  not just the Dockerfile: `apt-get` resolution and `emsdk install` downloads
  are not themselves reproducible. See `build/toolchain/README.md`.

## How verification failures present

`fetch.sh` runs under `set -euo pipefail` and exits non-zero, loudly, on the
first problem:

- **Hash mismatch** — prints `MISMATCH sha256|sha512 for <file>` with the
  expected and actual digests, deletes the just-downloaded file, and exits 1.
- **Unpinned source** — `FATAL [<id>]: refusing unpinned source …` when a
  `file`/`git` block has no valid hash.
- **Wrong commit** — `FATAL [<id>]: HEAD <x> != pinned <commit>` and exit 1.
- **Malformed block** — missing `url`/`file`/`commit`/`kind`, or an unknown
  `kind`, each a `FATAL` with exit 1.
- **archive_sha256 mismatch** — reported with a note that the commit itself is
  verified and the likely cause is a git-version framing difference.

A clean run ends with `All pinned sources present and verified.`, a status
table (`skip`/`fetched`/`recorded` per id), and the total cache size.

## Provenance

`pins.lock` and `fetch.sh` are original work (MIT, this repo). The URLs,
commits and digests they record were read from upstream busytex (MIT) at the
pinned commit (`Makefile`, `.github/workflows/build-wasm.yml`) and from official
TeX Live / TUG distribution channels. No GPL/AGPL project source was opened
(DESIGN.md §2). Fetching GPL-licensed *source tarballs* (the TL tree contains
GPL members) into the cache is expected and fine — DESIGN.md §7 covers the
aggregate; what is forbidden is deriving this repo's code from GPL code.
