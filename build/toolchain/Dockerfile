# SPDX-License-Identifier: MIT
# Provenance: original work authored in the WasmTeX repository (see LICENSE).
#   Not derived from any third-party source. The build machinery this image
#   later runs (busytex/busytex, MIT) is vendored separately under
#   build/upstream/ at M0 item 3, each file with its own provenance header.
#
# WasmTeX build-toolchain image (M0 item 1).
# -----------------------------------------------------------------------------
# A pinned, reproducible container for the busytex + TeX Live 2023 WebAssembly
# build. Every pin below is lifted verbatim into build/sources/pins.lock at
# M0 item 2. The authoritative reproducibility anchor for artifacts is the
# *built image* digest emitted by build-image.sh; this Dockerfile is provenance
# for HOW that image is made (apt package resolution is not itself
# bit-reproducible — see README.md).
#
# PINS (keep in sync with build/sources/pins.lock):
#   base image  ubuntu:22.04, linux/amd64 platform-specific manifest digest
#               (what the FROM line below resolves to):
#     sha256:0d779ea97881505f5ef0039336ee85edba27519bdba968c284c86ee066a973c8
#   base image  ubuntu:22.04 multi-arch manifest-list (index) digest, recorded
#               for cross-reference only (NOT used by FROM):
#     sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982
#   emscripten  3.1.43                                (matches busytex CI)
#   emsdk       commit d9c66fa2c2cd78daeb672967b2ef12bf18adf842  (git tag 3.1.43)
#
# The base is pinned by the platform-specific linux/amd64 digest and MUST be
# built with --platform=linux/amd64 (see build-image.sh). The dev host may be
# arm64 (Apple Silicon); the build then runs under Rosetta emulation, which is
# expected and acceptable (DESIGN.md §6.1; docs/plans/M0.md Risks).
#
# SOURCE_DATE_EPOCH is deliberately NOT baked into this image. It is supplied
# at build-invocation time (exported before `make artifacts`) so a single image
# can deterministically stamp artifacts for any pinned epoch.
# -----------------------------------------------------------------------------

# ARGs for the pins above. UBUNTU_DIGEST is consumed by FROM only; the
# emsdk pins are declared after FROM because that is where RUN needs them.
ARG UBUNTU_DIGEST=sha256:0d779ea97881505f5ef0039336ee85edba27519bdba968c284c86ee066a973c8
# The constant --platform=linux/amd64 is deliberate: this image must be x86_64
# regardless of the build host (arm64 dev machine vs x86_64 CI), so the WASM
# artifacts match upstream busytex CI. build-image.sh passes the same flag.
# BuildKit lints this as FromPlatformFlagConstDisallowed; the warning is
# expected here — the constant is the point, not an accident.
FROM --platform=linux/amd64 ubuntu:22.04@${UBUNTU_DIGEST}

ARG EMSCRIPTEN_VERSION=3.1.43
ARG EMSDK_COMMIT=d9c66fa2c2cd78daeb672967b2ef12bf18adf842

LABEL org.opencontainers.image.title="wasmtex-toolchain" \
      org.opencontainers.image.description="Pinned emsdk + TeX Live build toolchain for WasmTeX (M0)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/wasmtex/wasmtex"

# Deterministic environment hygiene: a fixed, locale-package-free UTF-8 locale
# (C.UTF-8 is built into glibc on Ubuntu 22.04) and UTC time. These stabilise
# tool output (sort order, timestamps) for the build that runs later.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Build prerequisites.
#   Upstream busytex CI runs on the GitHub-hosted `ubuntu-22.04` runner, which
#   preinstalls a full build toolchain and then adds only a few extras. A bare
#   ubuntu:22.04 has neither, so we install BOTH: the extras the CI names
#   explicitly (build-wasm.yml "Install Prerequisites" + the README "Building
#   from source" list) AND the toolchain the runner provides implicitly but the
#   busytex Makefile actually invokes (enumerated from the Makefile at the
#   pinned commit: gcc/g++/make, cmake, perl for install-tl, python3 for
#   emcc_wrapper.py, and bsdtar for the split-ISO extraction). Recommends are
#   left enabled to mirror the runner rather than a hand-minimised image.
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      `# --- busytex CI "Install Prerequisites" (.github/workflows/build-wasm.yml) ---` \
      gperf \
      p7zip-full \
      strace \
      icu-devtools \
      `# --- busytex README "Building from source" apt list ---` \
      wget \
      cmake \
      git \
      `# --- provided implicitly by the GH ubuntu-22.04 runner; invoked by the Makefile ---` \
      build-essential \
      ca-certificates \
      curl \
      perl \
      python3 \
      libarchive-tools \
      xz-utils \
      bzip2 \
      pkg-config \
      file \
      autoconf \
      automake \
      libtool \
    ; \
    rm -rf /var/lib/apt/lists/*

# Emscripten via emsdk, hard-pinned to the commit of git tag 3.1.43.
#   A full (non-shallow) clone guarantees the tagged commit is present, then we
#   check it out explicitly — no `git pull`, no reliance on the moving default
#   branch. `emsdk install/activate` then downloads the linux/amd64 3.1.43
#   toolchain (LLVM/clang + a bundled node) at build time.
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
# to PATH for interactive use.
ENV EM_CONFIG=${EMSDK}/.emscripten \
    PATH=${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}

WORKDIR /work
CMD ["bash", "-l"]
