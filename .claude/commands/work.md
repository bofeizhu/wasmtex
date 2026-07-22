---
description: One autonomous WasmTeX iteration — orient from disk, advance the active milestone by one committed unit, then yield. Designed for `/loop /work`.
---

Continue WasmTeX autonomously. Do ONE bounded unit of work, close it out cleanly, then yield. Workflow / multi-agent orchestration is authorized whenever a step warrants fan-out.

## Orient — from disk, every time

Context may have been compacted; trust only the repo:

1. `git status` + `git log --oneline -10`; the tail of `docs/LOG.md`; the active milestone's checklist in `docs/plans/`.
2. Active milestone = first incomplete one in DESIGN.md §9 (strict order; M0 follows bootstrap).
3. Check for still-running background tasks/builds before launching anything — never start a duplicate build.

## Pick one unit

- No committed plan for the active milestone yet? The unit is writing it: `docs/plans/M<n>.md` with scope, the PROMPT.md acceptance checks, the exact pins to be locked, and an ordered checkbox list. Commit it, and present the plan prominently in this iteration's summary (PROMPT.md: announce the plan before executing it).
- Otherwise: the first unchecked item — preferring finishing or unblocking in-flight work over starting anything new.
- A unit ≈ one reviewable conventional commit, never "the rest of the milestone".

## Execute (CLAUDE.md binds every agent)

- Plan and integrate here; delegate: `coder` implements, `tester` writes/runs tests, `code-reviewer` reviews every substantive diff before commit.
- Provenance is constitutional: derive only from busytex/busytex (MIT) and this repo; never open GPL/AGPL sources, including other WASM TeX wrappers. Keep THIRD_PARTY_NOTICES.md and provenance headers current as files land.
- Reproducibility: everything fetched gets pinned + hashed in `build/sources/pins.lock`; no "latest" anywhere.
- Kick long container/TeX builds off in the background and yield; don't sit polling.

## Close out the iteration

- The unit's tests/checks are green, or the failure is recorded honestly.
- Tick the plan checkbox; append to today's `docs/LOG.md` entry (attempted / failed→fixed / deferred).
- Small conventional commit(s) on `main`, reviewer-approved, with the CI-workflow-equivalent checks passing locally. NEVER push, create remotes, tag releases, or publish — those are user-only calls; park them in LOG.md under "Deferred".

## Yield or stop

- Waiting on a background build → schedule the wakeup for when it should plausibly finish (20+ min; match the build), not sooner.
- Unit done, more remain → short wakeup (~2 min) and continue.
- Milestone acceptance checks ALL pass → record results in LOG.md, commit, then STOP the loop with a summary for the user (PROMPT.md: stop and summarize before starting the next milestone).
- The same step has failed twice with no new information, or a user-only decision blocks all remaining work → STOP the loop, stating exactly what is needed and what state everything was left in.
