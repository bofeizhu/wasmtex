# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. This is the top-level entry point;
#   the artifact pipeline it drives runs the vendored busytex (MIT) build
#   UNCHANGED inside the pinned toolchain container (see build/artifacts/).
#
# WasmTeX top-level Makefile.
# =============================================================================
# PARKED FOR M2 (2026-07-22): the container pipeline below was superseded as
# the M0 path by the native-first pivot (DESIGN.md §9 revision). M0 item 5N
# repurposes `make artifacts` for the native host build; the container flow
# returns as the canonical builder at M2 (build logistics & CI).
#
# `make artifacts` (container flow, parked): runs the vendored upstream
# busytex build inside the pinned wasmtex-toolchain image, fully offline,
# against the verified cache (~/.cache/wasmtex/sources), and lands the
# engine wasm/js, worker/pipeline glue, engine .fmt formats, and the
# texlive-basic data bundle in dist/ (git-ignored).
#
# Prerequisites (once): build/toolchain/build-image.sh  and  build/sources/fetch.sh
#
# Long build: native + wasm TeX passes are x86_64-emulated under Rosetta on an
# arm64 host and take hours. STAGE runs a single phase for babysitting/resume:
#   make artifacts STAGE=prep     # stage machinery + sources (offline)
#   make artifacts STAGE=native   # native multicall busytex (slow)
#   make artifacts STAGE=basic     # install-tl texlive-basic + dump .fmt
#   make artifacts STAGE=wasm      # wasm multicall busytex.js/.wasm (slow)
#   make artifacts STAGE=bundle    # pack texlive-basic.js/.data
#   make artifacts STAGE=dist      # assemble dist/ + SHA256SUMS
# STAGE defaults to `all`. Stages share a docker volume and are resumable.
# =============================================================================

.PHONY: artifacts clean-artifacts

STAGE ?= all

artifacts:
	WASMTEX_STAGE=$(STAGE) build/artifacts/build.sh

# Remove the assembled dist/ output and the build-tree docker volume. Does not
# touch the pinned cache or the toolchain image.
clean-artifacts:
	rm -rf dist
	-docker volume rm $${WASMTEX_VOLUME:-wasmtex-m0-work}
