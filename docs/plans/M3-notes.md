# M3 (build logistics & CI) — accumulated notes

Findings parked here during M0–M2 so the M3 plan starts informed.
Not a plan yet; the M3 plan is written when M3 starts.

## CI runner landscape (verified 2026-07-22)

- GitHub-hosted standard runners are free/unlimited for public repos,
  including **macOS arm64** (`macos-14/15/26`, M1: 3 vCPU, 7 GB RAM,
  ~14 GB usable SSD; ~5-job macOS concurrency cap; 6 h job wall) and —
  since 2025-08 — **Linux arm64**. macOS "larger runners" are paid
  regardless of repo visibility.
- Disk, not CPU, is the binding constraint for our build on hosted
  runners: ~5 GB source cache + ~6 GB work tree already crowds 14 GB.
  M3 needs footprint engineering: stage only the archive packages
  `texlive-basic` reads instead of extracting the full ISO; prune
  between stages; `actions/cache` the work tree.

## The amd64 question (2026-07-22 analysis)

- wasm artifacts are host-arch-independent by construction (wasm32
  target); arm64-built wasm runs in amd64 browsers/apps unchanged.
  amd64 was never a runtime requirement.
- amd64's only real role was "canonical reproducibility platform,
  because CI = amd64 Linux". Free arm64 Linux runners void that
  premise. The **container** (pinned userland) and the **architecture**
  are separable decisions; only the container is load-bearing for
  reproducibility.
- Residual empirical question: artifacts produced by *running native
  binaries* during the build — the `.fmt` dumps (LuaTeX's the most
  suspect: possible wordsize-sensitive Lua state) and bundle packing —
  are the only places host arch could leak into bytes. TeX's
  fixed-point design + LE-everywhere + pinned SOURCE_DATE_EPOCH make
  bit-identity likely but unproven.
- **Decided at roadmap level 2026-07-22 (DESIGN.md §9 amendment):** the
  amd64 requirement is dropped; canonical builder = pinned arm64 Linux
  container. The three-way hash check {arm64 macOS, arm64 Linux
  container, amd64 Linux container} remains as M3's *validation* gate:
  if hashes diverge, the diff pinpoints what the arm64-canonical builder
  must additionally pin; amd64 survives only as a free verification
  lane if it earns its keep. Note: with LuaTeX dropped from v1 (same
  amendment), the most arch-suspect artifact (luahblatex.fmt with
  possible Lua state) exits the shipped set at the M2 rebase anyway.
- The parked amd64 container + `-j1`/jobserver findings remain valid
  fallbacks either way (see docs/plans/M0-item4-journal.md).
