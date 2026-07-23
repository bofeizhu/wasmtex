# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. The build config this image later
#   runs is WasmTeX's own, under build/engines/ (forked from busytex/busytex,
#   MIT, at M2 item 3; each file carries its own provenance header).
#
# WasmTeX build-toolchain image — CANONICAL arm64 Linux builder (M3 item 3).
# -----------------------------------------------------------------------------
# A pinned, reproducible container for the WasmTeX (busytex-derived) + TeX Live
# 2026 WebAssembly build. Per the 2026-07-22 DESIGN.md §9 amendment the amd64
# requirement is dropped: the CANONICAL builder is this pinned *arm64* Linux
# container, built natively on the maintainer's Apple-Silicon host (NO Rosetta —
# that is the point). The parked amd64 image survives only as a free
# equivalence-check lane (M3 item 6), built from THIS SAME Dockerfile with
# --platform linux/amd64.
#
# ONE Dockerfile, TWO pinned images (arch-parameterization decision, M3 item 3).
# The base is pinned by the multi-arch manifest-list (INDEX) digest, which is
# arch-agnostic and cryptographically commits to each per-arch manifest; the
# build's --platform (supplied by build-image.sh, default linux/arm64) selects
# which per-arch manifest is pulled. The canonical and equivalence-lane images
# therefore differ ONLY in --platform — exactly the invariant the three-way
# equivalence check needs (a sibling Dockerfile.arm64 would instead risk the two
# drifting apart). This supersedes the M0 amd64-only design, which hardcoded
# FROM --platform=linux/amd64 and tripped the BuildKit
# FromPlatformFlagConstDisallowed lint; that constant, and that lint, are gone.
#
# The authoritative reproducibility anchor for artifacts is the *built image*
# ID emitted by build-image.sh (recorded in pins.lock [toolchain-image-arm64]);
# this Dockerfile is provenance for HOW that image is made (apt resolution and
# the un-checksummed emsdk download are not themselves bit-reproducible — see
# README.md).
#
# PINS (keep in sync with build/sources/pins.lock):
#   base image  ubuntu:22.04 multi-arch manifest-list (INDEX) digest — what the
#               FROM line below pins; --platform selects the per-arch manifest:
#     sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982
#   base image  ubuntu:22.04 linux/arm64 platform digest (index -> arm64/v8; the
#               CANONICAL base this image is built on):
#     sha256:ecd3706b6b5587d1318e1777359b8563f9db6e8e5a81841f04dc3c7edbefbdc1
#   base image  ubuntu:22.04 linux/amd64 platform digest (index -> amd64; the
#               equivalence-lane base, pins.lock [toolchain-image]):
#     sha256:0d779ea97881505f5ef0039336ee85edba27519bdba968c284c86ee066a973c8
#   emscripten  3.1.43                              (unchanged across all lanes)
#   emsdk       commit d9c66fa2c2cd78daeb672967b2ef12bf18adf842  (git tag 3.1.43)
#   emsdk arm64 linux-arm64 prebuilt CONFIRMED present for 3.1.43 (release hash
#               bf3c159888633d232c0507f4c76cc156a43c32dc; wasm-binaries-arm64.tbz2,
#               242,978,805 bytes). The plan's "arm64 prebuilt might be missing"
#               risk did NOT materialize — same emsdk pin holds, no version bump.
#               See docs/plans/M3-journal.md item 3.
#
# Ubuntu 22.04 (not 24.04) is deliberate: (1) era-consistency with the pinned
# emsdk 3.1.43 prebuilt binaries (mid-2023), and (2) the equivalence lane
# compares arm64 vs amd64 on the SAME 22.04 userland, so any artifact-hash
# divergence is attributable to ARCH alone, not a userland-version confound
# (24.04 would move glibc/gcc/autotools under the arm64 lane only). Also: apt
# cmake on 22.04 is 3.22 (< 4), so the native-host cmake-4 policy-floor
# workaround (-DCMAKE_POLICY_VERSION_MINIMUM=3.5) is NOT needed here. Rationale
# in docs/plans/M3-journal.md item 3.
#
# SOURCE_DATE_EPOCH is deliberately NOT baked into this image. It is supplied at
# build-invocation time (exported before the driver runs) so a single image can
# deterministically stamp artifacts for any pinned epoch.
# -----------------------------------------------------------------------------

# The multi-arch INDEX digest; --platform (from the build invocation) resolves
# it to the per-arch manifest. No --platform on FROM: the build's --platform
# (build-image.sh, default linux/arm64) selects the arch, so on the Apple-Silicon
# host the canonical build is NATIVE (no emulation). Passing --platform
# linux/amd64 instead yields the emulated equivalence-lane image from this same
# file.
ARG UBUNTU_INDEX_DIGEST=sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982
FROM ubuntu:22.04@${UBUNTU_INDEX_DIGEST}

ARG EMSCRIPTEN_VERSION=3.1.43
ARG EMSDK_COMMIT=d9c66fa2c2cd78daeb672967b2ef12bf18adf842

LABEL org.opencontainers.image.title="wasmtex-toolchain" \
      org.opencontainers.image.description="Pinned emsdk + TeX Live build toolchain for WasmTeX — canonical arm64 Linux builder (M3)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/bofeizhu/wasmtex"

# Deterministic environment hygiene: a fixed, locale-package-free UTF-8 locale
# (C.UTF-8 is built into glibc on Ubuntu 22.04) and UTC time. These stabilise
# tool output (sort order, timestamps) for the build that runs later.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Build prerequisites — enumerated from what OUR build config actually INVOKES
# (build/engines/Makefile + the build/artifacts driver), NOT the M0 busytex-CI
# mirror. The M0 set (20 pkgs) is halved to 10 here; the full drop list and the
# per-tool justification are in docs/plans/M3-journal.md item 3. Recommends are
# left enabled (mirror the runner rather than a hand-minimised image).
#   build-essential  gcc/g++/make/binutils(objcopy)/libc-dev — the Makefile's
#                    CC/CXX/AR/LD/nm + recursive $(MAKE), and the native helper
#                    tools (ctangle/otangle/web2c/icupkg/pkgdata/genccode) whose
#                    output the wasm pass reuses via the CCSKIP_* wrappers.
#   cmake            expat 2.5.0 build (CMAKE_native / emcmake cmake).
#   perl             install-tl (the build/texlive-%.txt rule).
#   python3          REDEFINE_SYM/EXTERN_SYM inline scripts, emcc_wrapper.py,
#                    tools/file_packager.py (the bundle step).
#   gperf            fontconfig 2.13.96 sub-build: its configure hard-requires
#                    gperf to generate fcobjshash.h and aborts without it. Our
#                    Makefile never names gperf, but the fontconfig configure it
#                    invokes does — a real transitive prerequisite.
#   libarchive-tools bsdtar — reads the pinned TL 2026 ISO9660 image directly to
#                    stage the texmf repository (the drivers' do_prep; the
#                    Makefile's texmfrepo rule itself is a fail-loud stub).
#   xz-utils         `tar -xf *.tar.xz` of the ISO archive packages (Makefile
#                    build/texlive-%.txt) + install-tl's own package extraction.
#   curl             the Makefile source/%.txt download rules. The offline build
#                    pre-stages sources so curl is not reached, but curl is the
#                    tool those rules invoke — kept for a faithful builder.
#   ca-certificates  TLS trust store for the emsdk https git-clone below (+ curl).
#   git              clones emsdk at image-build time (the RUN two steps down).
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      git \
      gperf \
      libarchive-tools \
      perl \
      python3 \
      xz-utils \
    ; \
    rm -rf /var/lib/apt/lists/*

# Emscripten via emsdk, hard-pinned to the commit of git tag 3.1.43.
#   A full (non-shallow) clone guarantees the tagged commit is present, then we
#   check it out explicitly — no `git pull`, no reliance on the moving default
#   branch. `emsdk install/activate` then downloads the 3.1.43 toolchain
#   (LLVM/clang + a bundled node) for the CONTAINER's architecture: inside a
#   linux/arm64 image emsdk detects `aarch64` (ARCH=arm64) and fetches
#   wasm-binaries-arm64.tbz2 — confirmed present for 3.1.43 (see the pins block).
#   emsdk prints "WARNING: arm64-linux binaries are not available for all
#   releases" for any explicit (non-`latest`) version on arm64-linux; it is
#   informational — 3.1.43 specifically HAS the arm64 prebuilt, so install
#   succeeds. This is the SAME emsdk pin the native (darwin-arm64) and amd64
#   (linux-amd64) lanes resolve; only the platform binaries differ.
ENV EMSDK=/opt/emsdk
RUN set -eux; \
    git clone https://github.com/emscripten-core/emsdk.git "${EMSDK}"; \
    git -C "${EMSDK}" checkout "${EMSDK_COMMIT}"; \
    test "$(git -C "${EMSDK}" rev-parse HEAD)" = "${EMSDK_COMMIT}"; \
    "${EMSDK}/emsdk" install "${EMSCRIPTEN_VERSION}"; \
    "${EMSDK}/emsdk" activate "${EMSCRIPTEN_VERSION}"; \
    # Make the full emsdk env (incl. bundled node) available to login shells,
    # e.g. `docker run ... bash -lc '...'`.
    printf '. "%s/emsdk_env.sh" > /dev/null 2>&1\n' "${EMSDK}" > /etc/profile.d/emsdk.sh; \
    chmod 0644 /etc/profile.d/emsdk.sh

# Resolve emcc/em++ in non-login shells too. EM_CONFIG points emcc at the
# activated toolchain (absolute node/llvm paths live inside it), so `emcc`
# works without sourcing emsdk_env.sh; the login-shell profile above adds node
# to PATH for interactive use and for the driver's `node` invocations.
ENV EM_CONFIG=${EMSDK}/.emscripten \
    PATH=${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}

WORKDIR /work
CMD ["bash", "-l"]
