# Engineering Log

One dated entry per work session recording what was attempted, what failed and
how it was fixed, and what was deferred. This log is kept because TeX toolchain
knowledge rots fast: the annual rebase to the next TeX Live release depends on
an honest record of why the build is shaped the way it is.

## 2026-07-22 — Bootstrap

**Attempted / done.** Repo initialized on `main`. Claude Code levels
configured (session: Fable 5 at xhigh — ultracode per session; `coder` and
`tester` agents: Opus 4.8 max; `code-reviewer`: Fable 5 high). All
PROMPT.md Bootstrap files authored via an orchestrated workflow (2 scouts,
4 author agents, 1 reviewer): LICENSE, THIRD_PARTY_NOTICES.md skeleton,
.editorconfig, .gitignore, README, this log, the DESIGN.md §4 scaffold
(placeholder READMEs), and three green-by-construction CI skeletons
(build, runtime-tests, license-audit).

**Name check (Bootstrap step 2).** npm `motex` is TAKEN (v0.0.0
placeholder by "catise", published 2026-02-06); a `motex` GitHub org also
exists. Renamed the project to **wasmtex** (verified free on npm and
GitHub). Alternatives considered: livetex, wotex, motexjs (npm-free; the
first two collide with existing GitHub users). Local directory is still
named `motex`; renaming it is optional and deferred.

**Failed → fixed.** (1) Workflow subagents referencing the new
`.claude/agents` types failed — the agent registry loads at session start;
fixed by resuming with explicit model/effort overrides at the same levels.
(2) On workflow resume, `args` arrived undereferenced, leaving literal
"undefined" in LICENSE and THIRD_PARTY_NOTICES.md; caught by the author
agent and the review pass, fixed by hand. Lesson: workflow scripts should
parse `args` defensively (`typeof args === 'string' ? JSON.parse(args) :
args`). (3) Code review (request-changes) also caught
`.claude/scheduled_tasks.lock` missing from .gitignore; fixed.

**M0 pin research (for the upcoming plan).** Upstream busytex/busytex
HEAD: `f2bd7b11ee1b7b093638321c1f3e5d70389d307b` (2026-06-16, branch
`main`, MIT per README — note: upstream has no top-level LICENSE file).
Its build pins TeX Live 2023 (texlive-source tag `texlive-2023.0` +
`texlive2023-20230313.iso`), Emscripten 3.1.43 via emsdk on ubuntu-22.04
CI, single top-level Makefile, no Docker. The CTAN URL for yearly ISOs
rotates — M0 must mirror the split-ISO cache.

**Deferred.** GitHub remote + first push (user's call); local directory
rename; npm-name squat dispute for `motex` (moot after rename).

## 2026-07-22 — M0 plan (autonomous loop, iteration 1)

**Attempted / done.** Added `.claude/commands/work.md` (the `/loop /work`
iteration prompt driving autonomous sessions). Environment check: Docker
29.6.1 running (engine platform linux/arm64 — Apple Silicon), 844 GiB
free.
Authored `docs/plans/M0.md`: pins table (busytex `f2bd7b1`, TL 2023 via
historic mirror, emsdk 3.1.43, amd64 base image by digest), the four
PROMPT.md acceptance checks, an 8-item commit-sized work list, and
standing decisions — notably pinning `--platform linux/amd64` under
Rosetta so local artifacts stay comparable with x86_64 CI.

**Deferred.** Whether emulated amd64 build time is tolerable is unproven;
revisit at work item 4 if needed (documented deviation path in the plan).
CI execution of the M0 acceptance checks deferred to M4 per DESIGN.md §9
(explicit deviation from PROMPT.md rule 3, recorded in the plan).

**Review.** `code-reviewer` pass on this diff: request-changes (record the
`build/upstream/` layout extension in DESIGN.md at creation time; label
the CI-deferral deviation; three nits). All applied before commit.
