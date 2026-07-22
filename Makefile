# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. This is the top-level entry point;
#   the artifact pipeline it drives runs the vendored busytex (MIT) build
#   UNCHANGED (macOS fixes are make-variable overrides in the driver, never
#   edits to build/upstream/).
#
# WasmTeX top-level Makefile.
# =============================================================================
# `make artifacts` (NATIVE flow, M0 item 5N — the active dev path per the
# DESIGN.md §9 native-first pivot): drives the vendored upstream busytex build
# RAW on the arm64 macOS host, fully offline, against the verified cache
# (~/.cache/wasmtex/sources), and lands the engine wasm/js, worker/pipeline
# glue, engine .fmt formats, and the texlive-basic data bundle in dist/
# (git-ignored). The build tree lives out of tree (~/.cache/wasmtex/build);
# only dist/ enters the repo.
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
#   make artifacts STAGE=basic     # install-tl texlive-basic + dump .fmt
#   make artifacts STAGE=wasm      # wasm multicall busytex.js/.wasm
#   make artifacts STAGE=bundle    # pack texlive-basic.js/.data
#   make artifacts STAGE=dist      # assemble dist/ + SHA256SUMS (+ verify gate)
#   make artifacts STAGE=verify    # execution gate alone (env imports + engine run)
# STAGE defaults to `all`.
#
# `make artifacts-container` (PARKED for M2): the pinned-container flow built in
# the original M0. Superseded as the M0 path by the native-first pivot; it
# returns as the canonical builder at M2 (build logistics & CI). See
# build/artifacts/README.md.
# =============================================================================

.PHONY: artifacts artifacts-container clean-artifacts

STAGE ?= all

# Native host flow (active).
artifacts:
	WASMTEX_STAGE=$(STAGE) build/artifacts/build-native.sh

# Container flow (parked for M2). Kept reachable, unchanged.
artifacts-container:
	WASMTEX_STAGE=$(STAGE) build/artifacts/build.sh

# Remove the assembled dist/ output and the native build tree. Does not touch
# the pinned source cache or the toolchain. The (parked) container flow's docker
# volume is also removed if present (harmless no-op without docker).
clean-artifacts:
	rm -rf dist
	rm -rf "$${WASMTEX_WORK_DIR:-$$HOME/.cache/wasmtex/build/native/busytex}"
	-docker volume rm $${WASMTEX_VOLUME:-wasmtex-m0-work} 2>/dev/null
