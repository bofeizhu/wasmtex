<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/audit/ — license / provenance audit

`license-audit.sh` is the one-command provenance audit for DESIGN.md §2 + §7.
It runs identically on the maintainer's macOS/BSD host and in CI on ubuntu/GNU
(the `.github/workflows/license-audit.yml` job just invokes it), and fails
closed — any violation prints `FAIL: …` and the script exits non-zero.

```sh
bash build/audit/license-audit.sh
```

## What it checks

- **(a/b) Vendored busytex tree** — every file under `build/upstream/busytex/`
  (except the ours-authored `PROVENANCE.md` manifest) carries a provenance
  header naming the pinned upstream commit; the on-disk file set is exactly the
  manifest's rows (bijective); and every manifest `Vendored sha256` matches the
  file on disk. The hash check doubles as a tamper detector — a mutated body or
  header changes the hash and fails. The pinned commit is read from
  `build/sources/pins.lock` `[busytex]`.
- **(c) Patches** — every `build/patches/<name>/*.patch` has a sibling
  `HEADER.md`, and both the patch and its header carry the diff-context-excerpt
  licensing-clause reference (the context lines quote small excerpts of the
  patched source under that source's own license). The patch's clause is a
  leading comment that `patch` ignores when applying.
- **(d) Copyleft tripwire** — no `SPDX-License-Identifier:` line naming GPL/AGPL
  appears in any `runtime/` or `demo/` source (DESIGN.md §7). It matches only
  SPDX identifier lines, so prose that merely mentions GPL does not trip it.
- **(e) SPDX MIT headers** — every original `build/` and `demo/` source
  (`*.sh`, `*.mjs`, `*.py`, `*.html`, `Dockerfile`) carries an `SPDX-License-
  Identifier: MIT` header. Exemptions (docs, config, lockfiles, `*.patch`, the
  vendored tree) are enumerated inline in the script.

File enumeration uses `git ls-files --cached --others --exclude-standard`, so
git-ignored build outputs (`dist/`, `build/out/`, `node_modules/`, Playwright
reports) are excluded while a not-yet-committed new source is still audited by a
pre-commit local run.
