# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. This is the top-level entry point;
#   the artifact pipeline it drives builds OUR maintained engine config at
#   build/engines/ (forked from busytex, MIT, at M2 item 3; macOS host fixes are
#   make-variable overrides in the driver).
#
# WasmTeX top-level Makefile.
# =============================================================================
# `make artifacts` (NATIVE flow — the active dev path per the DESIGN.md §9
# native-first pivot): builds our engine config (build/engines/) RAW on the
# arm64 macOS host, fully offline, against the verified cache
# (~/.cache/wasmtex/sources), and lands the engine wasm/js, engine .fmt formats,
# and the core + academic data bundles in dist/ (git-ignored). The build tree lives
# out of tree (~/.cache/wasmtex/build); only dist/ enters the repo.
#
# Prerequisites (once):
#   build/sources/fetch.sh                 # fetch + verify the pinned sources
#   build/toolchain/native-host.md         # set up the pinned emsdk + brew tools
# The driver sources build/toolchain/native-env.sh itself (idempotent), so
# `make artifacts` works whether or not you have already sourced it.
#
# Long build (native + wasm TeX passes). STAGE runs a single phase for
# babysitting/resume (make is incremental; stages share the work tree):
#   make artifacts STAGE=prep      # stage machinery + sources (offline)
#   make artifacts STAGE=native    # native multicall busytex
#   make artifacts STAGE=basic     # install-tl combined tiers tree + dump .fmt
#   make artifacts STAGE=wasm      # wasm multicall busytex.js/.wasm
#   make artifacts STAGE=bundle    # stage disjoint tiers + pack core/academic.js/.data
#   make artifacts STAGE=dist      # assemble dist/ + SHA256SUMS (+ verify gate)
#   make artifacts STAGE=verify    # execution gate alone (env imports + engine run)
# STAGE defaults to `all`.
#
# `make artifacts-container` (M3 item 4): the CANONICAL builder — the same engine
# config, offline pre-staging, stage sequence and verify gate as the native flow,
# run inside the pinned arm64 toolchain image (pins.lock [toolchain-image-arm64]),
# fully offline. Per DESIGN.md §9 only container-built, pin-verified artifacts are
# ever released; the native flow above is a development vehicle. Same STAGE knob.
# See build/artifacts/README.md.
#
# `make pack VERSION=<v>` (M5 item 7, DESIGN.md §7): pack the versioned release
# archives from an already-built dist/ — `wasmtex-assets-<v>.tar.gz` (the full
# asset set) + one `wasmtex-bundle-<tier>-<v>.tar.gz` per bundle — deterministically
# (sorted, SOURCE_DATE_EPOCH mtime, canonical gzip), each VERIFIED byte-for-byte
# against dist/manifest.json before it is trusted. Writes to dist/release/. Does NOT
# build: run `make artifacts` (dev) or the release workflow's container build first.
# The release workflow (M5 item 8) runs this after the container build. See
# build/release/README.md.
# =============================================================================

.PHONY: artifacts artifacts-container pack clean-artifacts rebase-check repro-check

STAGE ?= all
# Extra args forwarded to build/repro-check.sh (e.g. REPRO_ARGS=--reuse-current).
REPRO_ARGS ?=

# Native host flow (active).
artifacts:
	WASMTEX_STAGE=$(STAGE) build/artifacts/build-native.sh

# Container flow (M3 canonical builder). Same STAGE knob as `artifacts`.
artifacts-container:
	WASMTEX_STAGE=$(STAGE) build/artifacts/build.sh

# `make pack VERSION=<v>` (M5 item 7, DESIGN.md §7): pack + verify the versioned
# release archives from a built dist/ into dist/release/. VERSION is required (it
# names the archives; the packer hardcodes no release number). Guards on a built
# dist/ (needs dist/manifest.json — the verification oracle gen-assets writes).
VERSION ?=
pack:
	@test -n "$(VERSION)" || { \
	  echo "!! make pack: VERSION is required, e.g. \`VERSION=0.1.0 make pack\`."; exit 1; }
	@test -f dist/manifest.json || { \
	  echo "!! make pack: dist/ not built — run \`make artifacts\` (dev) or the release container build first."; \
	  echo "   pack needs dist/manifest.json (the gen-assets integrity manifest) to verify against."; exit 1; }
	node build/release/pack.mjs --version "$(VERSION)"

# `make rebase-check` (M2 item 8, DESIGN.md §6.2): the mechanical ACCEPTANCE tail
# of the annual rebase — a fail-fast, ordered aggregator of the six gates the
# runbook's Phase 5 lists, one entry point across five directories and six tools
# for an operation run once a year. It doubles as the executable form of the
# acceptance list (docs/rebase.md Phase 5), kept honest because it runs.
#
# It VERIFIES the rebase; it does NOT perform it. The judgment phases (pin
# research, patch re-test, drift fixes) and the multi-hour, staged, resumable
# build are Phases 1-3 of docs/rebase.md — driven by hand, never folded into a
# one-shot check (hence `-check`, not the §6.2 `make rebase` name). It assumes
# dist/ is already built (`make artifacts`) and verifies that output; it guards
# on dist/ presence with a clear message rather than a deep error otherwise.
# Order is cheap->heavy so a regression fails as early as possible.
# Prerequisites: Node; Playwright browsers for the demo smoke (runbook Phase 0).
rebase-check:
	@test -f dist/assets.json || { \
	  echo "!! rebase-check: dist/ not built — run 'make artifacts' first (runbook Phase 3)."; \
	  echo "   rebase-check verifies the build's OUTPUT; it does not perform the build."; \
	  exit 1; }
	@echo "== rebase-check: acceptance gates (docs/rebase.md Phase 5) =="
	@echo "-- [1/6] fetch verify (pins present + hash-verified) --"
	build/sources/fetch.sh
	@echo "-- [2/6] execution gate (env-import sanity + engine banner) --"
	node build/artifacts/verify-engine.mjs dist
	@echo "-- [3/6] license / provenance audit --"
	build/audit/license-audit.sh
	@echo "-- [4/6] runtime suite (typecheck + vitest) --"
	npm --prefix runtime run typecheck && npm --prefix runtime test
	@echo "-- [5/6] conformance corpus (public API over real wasm) --"
	npm --prefix conformance run conformance
	@echo "-- [6/6] demo smoke (Playwright) --"
	npm --prefix demo test
	@echo "== rebase-check: all acceptance gates green =="

# `make repro-check` (M3 item 5, DESIGN.md §6.1): the build-twice reproducibility
# gate. Runs TWO clean CANONICAL container builds from scratch and asserts their
# dist/ artifacts (SHA256SUMS + assets.json + every payload byte) are identical;
# any divergence prints a per-file report and fails. This is a MULTI-HOUR gate
# (each clean container build is ~34 min on an 8-core arm64 host, longer in CI),
# so it is DELIBERATELY NOT part of `rebase-check`'s fast acceptance tail — it is
# its own step in the annual rebase (docs/rebase.md Phase 5) and its own CI job.
#
# WHERE IT RUNS (standing decision 2026-07-23, docs/plans/M3.md): container
# builds run on CI runners ONLY — do NOT invoke this target on the dev machine.
# Default is the canonical two-build mode; the one-build variant CI can use when
# a pin-verified dist/ is already present (on-disk dist/ = build #1) is
#   make repro-check REPRO_ARGS=--reuse-current
# See build/repro-check.sh --help.
repro-check:
	build/repro-check.sh $(REPRO_ARGS)

# Remove the assembled dist/ output and the native build tree. Does not touch
# the pinned source cache or the toolchain. The container flow's docker work
# volume is also removed if present (harmless no-op without docker).
# The work-dir default below duplicates build-native.sh's WASMTEX_WORK_DIR
# default — the annual rebase bumps both together (docs/rebase.md §3a).
clean-artifacts:
	rm -rf dist
	rm -rf "$${WASMTEX_WORK_DIR:-$$HOME/.cache/wasmtex/build/native/busytex-2026}"
	-docker volume rm $${WASMTEX_VOLUME:-wasmtex-work} 2>/dev/null
