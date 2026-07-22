# WasmTeX — Claude Code conventions

DESIGN.md is the founding design document and source of truth; PROMPT.md is
the bootstrap/milestone kickoff prompt. Read the relevant DESIGN.md sections
before substantive work. Deviations from DESIGN.md are recorded in
DESIGN.md via explicit commits, never silently.

## Model levels & orchestration

Three-level setup — the main session orchestrates, subagents do the work:

- **Planning & orchestration — Fable 5 Ultracode** (main session).
  Project settings pin `model: fable` at `xhigh` effort. Ultracode cannot
  be persisted in settings, so start working sessions with
  `claude --effort ultracode` (or run `/effort ultracode` in-session) to
  enable workflow orchestration.
- **Coding & testing — Opus 4.8 max**: delegate implementation to the
  `coder` agent and test authoring/verification to the `tester` agent. The
  main session plans, decomposes, and integrates; it does not hand-write
  non-trivial code.
- **Code review — Fable 5 high**: run the `code-reviewer` agent on every
  substantive diff before it is committed.

Cycle: plan (main session) → `coder` implements → `tester` verifies →
`code-reviewer` approves → small conventional commit on `main`, CI green.

## Rules that bind every agent

- **Provenance (DESIGN.md §2, constitutional)**: code derives only from
  busytex/busytex (MIT) or original work in this repo. Never open, read,
  copy, or adapt GPL/AGPL sources — including other WASM TeX wrappers.
  Maintain THIRD_PARTY_NOTICES.md and per-file provenance headers.
- **Reproducibility**: artifacts must rebuild bit-for-bit from
  build/sources/pins.lock inside the pinned container.
- **Tests define done**: runtime code lands with unit tests; build changes
  land with a conformance run.
- **Engineering log**: dated entries in docs/LOG.md — attempts, failures
  and fixes, deferrals.
