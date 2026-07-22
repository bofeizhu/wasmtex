# Kickoff prompt for Claude Code (paste as the first message in the new repo)

You are bootstrapping **MoTeX**, a new standalone open-source project:
an MIT-licensed, current-TeX-Live WebAssembly typesetter designed for
embedding in host applications. `DESIGN.md` in the repo root is the founding
design document — read it fully before doing anything; it is the source of
truth for goals, non-goals, API shape, build pipeline, licensing posture,
and milestones. Where this prompt and DESIGN.md conflict, DESIGN.md wins;
record any deliberate deviation from it in `DESIGN.md` §-notes via PR-style
commits rather than silently drifting.

## Non-negotiable working rules

1. **Provenance (DESIGN.md §2 is constitutional).** You may derive code from
   exactly two places: the upstream `busytex/busytex` repository (MIT) and
   original work you write here. Engine/tool sources come from the pinned
   TeX Live snapshot and its normal dependencies. Never read, copy, or adapt
   code, prose, or API designs from GPL- or AGPL-licensed projects — if a
   web search or dependency chain surfaces one (including other WASM TeX
   wrappers), do not open its source; note the encounter in the commit
   message of whatever you were doing so the audit trail shows it was
   avoided. Maintain `THIRD_PARTY_NOTICES.md` from day one; every vendored
   file gets a provenance header.
2. **Reproducibility before features.** Every artifact must be rebuildable
   bit-for-bit from `build/sources/pins.lock` inside the pinned container.
   No "works on my machine" artifacts may ever be committed or released.
3. **Tests define done.** Runtime code lands with unit tests; build changes
   land with a conformance-corpus run. A milestone is complete only when its
   acceptance checks (below) pass in CI, not just locally.
4. **Honest engineering log.** Keep `docs/LOG.md` — one dated entry per work
   session: what was attempted, what failed (especially Emscripten/TeX build
   failures and their fixes), what was deferred. TeX toolchain knowledge
   rots fast; the log is how the annual rebase stays cheap.
5. **Small commits on `main`,** conventional messages, each leaving CI
   green. No long-lived branches while the project is single-maintainer.

## Bootstrap (do this first)

1. `git init`; add `LICENSE` (MIT, current year, the repo owner as holder),
   `THIRD_PARTY_NOTICES.md` (skeleton), `.editorconfig`, `.gitignore`,
   `README.md` (short: what/why/status table pointing at DESIGN.md),
   `docs/LOG.md`.
2. Verify the working name: check the `motex` name on npm and GitHub. If
   taken, propose three alternatives and pick one; update DESIGN.md's title
   note and all references in one commit.
3. Scaffold the layout from DESIGN.md §4 with placeholder READMEs per
   directory stating that directory's contract.
4. Set up CI skeletons (GitHub Actions): `build` (container build, cached),
   `runtime-tests` (vitest or node:test on `runtime/`), `license-audit`
   (fails on missing provenance headers or copyleft deps in `runtime/`).
   They may be mostly-empty but must be green from the first push.

## Milestone plan — work strictly in order

Execute the milestones exactly as DESIGN.md §9 defines them. For each:
announce the plan, do the work, run the acceptance checks, record results
in `docs/LOG.md`, then stop and summarize before starting the next.

**M0 — Faithful baseline (start here).**
Vendor/fork the upstream busytex build machinery and reproduce its existing
build — its currently pinned TeX Live, unchanged — inside our own pinned
container. Do not modernize anything yet; the point is proving the
toolchain. Acceptance: (a) `make artifacts` produces the engine wasm/js,
worker/pipeline glue, formats, and at least one data bundle from a clean
container; (b) a second clean build produces identical sha256s; (c) the
`demo/` page loads those artifacts and compiles a hello-world document to a
valid PDF in Chromium via Playwright; (d) THIRD_PARTY_NOTICES.md covers
everything vendored.

**M1 — Rebase to TeX Live 2026.**
Pin a dated TL 2026 snapshot in `pins.lock` (historic archive URL + hashes,
never "latest"), port the build patches, get all engines + `bibtex8` +
`xdvipdfmx` + `makeindex` + `kpsewhich` building as the combined multicall
binary, dump formats. Expect engine build-system drift; solve it patch by
patch and document each in `build/patches/*/HEADER.md`. Acceptance: corpus
seed documents (hello-world per engine, one bibtex8 document, one makeindex
document) compile in the demo; reproducibility check still green.

**M2 — Runtime v1.**
Implement the `motex` npm package exactly per DESIGN.md §5: `createTypesetter`,
job objects with `done`/`onLog`/`cancel`, the correlated worker protocol
(every message carries `jobId`; foreign/late ids are dropped), streaming
log lines, the diagnostics parser, engine sequencing per §5.3. Replace the
vendored glue with this runtime in `demo/`. Acceptance: the §8 runtime unit
tests pass, including: late-message-after-cancel cannot resolve a newer
job; cancel kills in-flight work and the next job starts clean; a
deliberately broken document yields structured diagnostics with file/line.

**M3 — Bundles + manifests.**
tlpdb-driven `core`/`extended`/`full` tiering, per-bundle provided-package
indexes, the top-level integrity `manifest.json` (per-file bytes + sha256 +
TL snapshot id), and on-demand resolution: static `\usepackage` scan plus
the missing-file log-feedback retry (§5.4). Acceptance: a document needing
an `extended`-only package compiles with `core` preloaded and exactly one
retry; manifest verification round-trips in a unit test.

**M4 — Release engineering.**
`assets-vX.Y.Z` GitHub Release automation (combined + per-bundle archives +
manifest.json), npm publish dry-run, README with a 20-line quickstart, the
license audit wired as a required check, release notes template containing
the aggregate-distribution licensing statement from DESIGN.md §7.

**M5 — Hardening.**
Full conformance corpus (incl. the CJK document with a project-supplied
font, per §6.3), Firefox/WebKit advisory runs, size-budget file + CI check,
soak test: 50 sequential jobs with random cancellations — no cross-job
contamination, memory returns to baseline after `dispose()`.

## Embedding profile to keep in mind throughout

The first consumer embeds MoTeX in a hidden Electron view behind a custom
URL scheme, with zero browser storage, verifying every downloaded byte
against `manifest.json`, and surfacing logs/diagnostics to an LLM agent
that authored the LaTeX. Concretely: never assume `https:`, never assume
IndexedDB, never fetch anything outside `assetsBaseUrl`, keep every
artifact path flat-listable in the manifest, and treat cancellation +
result correlation as correctness features, not conveniences.

Begin with the Bootstrap section now. After bootstrap, present the M0 plan
(including which upstream busytex commit you will pin) before executing it.
