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

- **(a/b) build/engines provenance headers** — every file under
  `build/engines/` (our maintained build config, forked from busytex at M2 item
  3) carries an `SPDX-License-Identifier: MIT` header AND one provenance marker:
  either original WasmTeX work, or a `DERIVED WORK` header that names the pinned
  `[busytex]` commit (from `build/sources/pins.lock`). The per-file headers are
  the provenance record — the M0 `PROVENANCE.md` manifest + vendored-sha256
  tamper check were retired when `build/upstream/` was dissolved. A headerless
  file, a file with no marker, or a derived header omitting the commit fails.
- **(c) Patches** — every `build/patches/<name>/*.patch` has a sibling
  `HEADER.md`, and both the patch and its header carry the diff-context-excerpt
  licensing-clause reference (the context lines quote small excerpts of the
  patched source under that source's own license). The patch's clause is a
  leading comment that `patch` ignores when applying.
- **(d) Copyleft tripwire** — no `SPDX-License-Identifier:` line naming GPL/AGPL
  appears in any `runtime/` or `demo/` source (DESIGN.md §7). It matches only
  SPDX identifier lines, so prose that merely mentions GPL does not trip it.
- **(e) SPDX MIT headers** — every original `build/`, `demo/`, and `runtime/`
  source (`*.sh`, `*.mjs`, `*.py`, `*.html`, `*.ts`, `Dockerfile`) carries an
  `SPDX-License-Identifier: MIT` header. Exemptions (docs, config, lockfiles,
  `*.patch`, and the `*.c` / `Makefile` under `build/engines/` that (a/b) covers
  instead) are enumerated inline in the script.

File enumeration uses `git ls-files --cached --others --exclude-standard`, so
git-ignored build outputs (`dist/`, `build/out/`, `node_modules/`, Playwright
reports) are excluded while a not-yet-committed new source is still audited by a
pre-commit local run.
