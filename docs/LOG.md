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

## 2026-07-22 — M0 item 1: toolchain container (loop, iterations 2–3)

**Attempted / done.** `coder` agent built `build/toolchain/`: Dockerfile
(ubuntu:22.04 @ amd64 digest `0d779ea9…`, forced `--platform
linux/amd64`; emsdk at commit `d9c66fa2` = tag 3.1.43; apt set = upstream
busytex CI prerequisites ∪ what its Makefile invokes that a bare
ubuntu:22.04 lacks, incl. `libarchive-tools` for the split-ISO bsdtar),
`build-image.sh`, real README contract. Built image ID
`sha256:1b37eac1…b436dce6` — the container pin for pins.lock (item 2).
Smoke check passed and was re-verified from the main session: emcc 3.1.43,
`uname -m` = x86_64. Provenance: only busytex (MIT) at the pinned commit
was consulted; no GPL/AGPL source opened.

**Failed → fixed.** (1) False alarm: main session declared the image build
"died" because `docker images` showed nothing and no build process was
found — in fact BuildKit tags the image only at the export stage, and the
first probe raced the ~5.5 min Rosetta build (apt layer alone 253 s).
Lesson: verify container builds via the build's exit code or log, never a
point-in-time `docker images`. (2) Review (request-changes) caught the
README attributing non-reproducibility to apt alone while `emsdk install`
also fetches un-checksummed binaries from storage.googleapis.com at
image-build time; fixed — the built-image digest is the pin covering
both. Also fixed: misleading ARG comment; smoke check now also exercises
the non-login-shell `ENV` path.

**Timing.** Cold amd64-under-Rosetta image build ≈ 5.5 min (apt 254 s,
emsdk 71 s). Warm rebuild fully cache-hit with identical image ID.

**Deferred.** emsdk layer keeps its git history + download cache
(hundreds of MB of image bloat); slimming it would change the image ID
already produced, so deliberately left for a future re-pin commit.
Item 1's "record build args in pins.lock" lands with item 2, which must
carry `UBUNTU_DIGEST`, `EMSCRIPTEN_VERSION`, `EMSDK_COMMIT`, and the
image ID above.

## 2026-07-22 — M0 item 2: pins.lock + fetch.sh (loop, iterations 4–6)

**Attempted / done.** `coder` agent authored `build/sources/pins.lock`
(INI-style blocks, awk-parsed — macOS ships bash 3.2, no associative
arrays), `fetch.sh` (atomic tmp-then-rename downloads, per-pin sha256
and/or sha512, refuses unpinned or non-hex hashes, idempotent), and the
real sources README. All six pins recorded: busytex `f2bd7b1` (git,
commit-verified + archive hash), texlive-source 2023.0, expat 2.5.0 and
fontconfig 2.13.96 (the only libs upstream fetches outside the TL tree),
the 4.77 GiB TL 2023 ISO, and the item-1 container pins. Full fetch ran:
~10 min cold (ISO at ~9 MB/s), 9 s idempotent re-verify of 4.90 GiB.
ISO checksum three-way agreement: downloaded bytes == mirror's published
.sha512 == lock. Review (request-changes): duplicate-block-id guard
added (dup ids silently resolved to the first block — reproducibility
hazard), remediation hints on mismatch paths, README notes upstream's
unpinned example-asset wgets. Re-verified green after fixes.

**Failed → fixed.** (1) The agent initially wrote a real-looking
*invented* sha256 as the ISO placeholder; caught before landing —
replaced with a non-hex `PENDING-FIRST-FETCH` sentinel that fetch.sh
treats as unset. Lesson: never write hash-shaped placeholders. (2)
`ftp.math.utah.edu` (the mirror M0.md suggested) fails TLS through this
environment's proxy; switched to `ftp.tu-chemnitz.de/pub/tug/historic/`
(range-capable, publishes .sha512). (3) Agent's completion-waiter
failed to wake it after the ISO download; nudged from the main session.

**Deferred.** `texlive-source` is pinned via a mutable git-svn branch
ref URL (byte-matches upstream's own `URL_texlive`; sha256 fails
closed) — switching to the underlying commit's codeload URL would drop
the mutable-ref dependency; revisit at item 3/4. GitHub on-the-fly
archives are not guaranteed byte-stable; a future hash mismatch means
"GitHub regenerated the tarball" (loud fail is the intended signal).
Upstream's `download-native` release binaries and rolling-`.deb` bundle
path deliberately not pinned (documented in the README); busytex
THIRD_PARTY_NOTICES entry lands with item 3 when code is vendored.

## 2026-07-22 — M0 item 3: vendor busytex machinery (loop, iteration 7)

**Attempted / done.** `coder` agent vendored 10 upstream files into
`build/upstream/busytex/` from the commit-verified cache clone
(`rev-parse` == `f2bd7b1`): Makefile, busytex.c, packfs.c/.py,
emcc_wrapper.py, cosmo_getpass.h, ubuntu_package_preload.py,
busytex_pipeline.js, busytex_worker.js, upstream README. Selection rule:
Makefile + every repo-local path it references + the two JS glue files
the demo loads. Each file: pristine body + provenance header;
PROVENANCE.md manifest records upstream and vendored sha256 per file.
Excluded: CI workflows, example/ tree, busytexmk.py, arXiv/cosmo
helpers (enumerated with reasons in the agent report / PROVENANCE.md).
THIRD_PARTY_NOTICES.md rewritten with the real busytex entry (verbatim
README license quote; upstream has no LICENSE file) and a
fetched-not-vendored table mirroring pins.lock. DESIGN.md §4 gained the
staging-area note (recorded deviation, per plan). Review: APPROVE —
reviewer independently re-verified all 10 body hashes, the license
quote, and the container git-archive check.

**Verified.** `git archive` framing for the busytex pin is identical
under host git 2.48.1 and the container's git 2.34.1 (both produce the
pinned `archive_sha256` `f670beff…`); recorded as a pins.lock comment,
no re-pin needed. Vendored Makefile parses under the container's GNU
Make 4.3 (`make -n` on two targets).

**Deferred.** `ubuntu_package_preload.py` is unused by M0's build path
(only the `build/wasm/ubuntu/%.js` recipe uses it) but vendored to keep
the Makefile's path references closed; drop at M1 if still unused.

## 2026-07-22 — M0 item 4 (container attempt) + native-first pivot

**Attempted.** `coder` agent wired the containerized `make artifacts`:
root Makefile, `build/artifacts/build.sh` (preflight pins check,
`--network none`, ro cache mount), `run-in-container.sh` (repro env,
offline pre-staging into the exact `source/<id>` paths the upstream
Makefile's download recipes produce — zero vendored-file edits, no
patches needed), journal at docs/plans/M0-item4-journal.md. Prep stage
verified offline (4.8G texmf repo staged from the ISO, 11524 packages).

**Failed → diagnosed.** `make -j4 native` died repeatedly with
`write jobserver: Bad file descriptor` — GNU Make's jobserver pipe fds
do not survive process spawning under Rosetta emulation; hits both
autotools and CMake sub-makes (first at zziplib's literal
`cd ../zlib && make rebuild`). Not fixable per-leaf without whack-a-mole
patching. Fix chosen: `-j1` on this host (no jobserver exists at -j1),
`WASMTEX_JOBS` override for real x86_64 builders. Operational fixes:
named container (`wasmtex-m0-build`), dropped `--rm` (keep logs for
post-mortem), `docker wait` for blocking supervision — the third
yield-and-wait agent failure this project (items 1 and 2 each needed a
manual nudge after their waiters never fired) made in-session
babysitting the standing rule.

**Pivot (user direction).** Serial emulated builds are prohibitively
slow for bootstrap. User directive: arm64 macOS is first-class now —
build raw on the host (no container), prove the toolchain, and drive
fast toward the wrapper-layer MVP (the project core); container/amd64/
CI/reproducibility logistics return after the MVP round. Recorded as an
explicit DESIGN.md §9 revision (milestones reordered: M0 native
baseline → M1 runtime MVP → M2 build logistics & CI → M3 TL 2026 →
M4 bundles → M5 release+hardening) + §6.1 bootstrap note. M0 plan
gained a revised work list (4N–8N); items 1–3 stand; the amd64
container wiring is committed as parked-for-M2, per-file provenance
headers intact. The orphaned serial build container was stopped and
removed (its driver agent died in a session restart). Constitutional
floor preserved: only container-built, pin-verified artifacts are ever
released; native host builds are dev-only.

## 2026-07-22 — M0 item 4N: native host toolchain (loop, post-pivot)

**Attempted / done.** `coder` agent set up the native arm64 toolchain:
emsdk cloned out-of-tree (`~/.cache/wasmtex/toolchain/emsdk`),
hard-detached and rev-parse-verified at the same pinned commit as the
container (`d9c66fa2`, tag 3.1.43); `install`+`activate` pulled the
darwin-arm64 binaries of the same emscripten-releases build
(`bf3c1598…`) the container resolves. Homebrew footprint kept minimal
by static analysis of the vendored Makefile: installed only cmake 4.4.0,
gnu-sed 4.10 (GNU `sed -i` is on the critical texlive.patched path),
GNU make 4.4.1 (host ships 3.81); verified-unneeded: p7zip, wget,
autotools, pkg-config (never invoked on the native+wasm path);
`/usr/bin/tar` already is bsdtar. New `build/toolchain/native-env.sh`
(sourceable, idempotent, bash+zsh, nounset-safe) and `native-host.md`
(host contract: hard pins vs documented-not-pinned, apt→macOS
translation table, setup, smoke). Smoke passed end-to-end: emcc 3.1.43
native arm64, hello.c → wasm → runs under emsdk node; independently
re-verified from the main session.

**Failed → fixed.** Review (request-changes): (1) emsdk_env.sh failure
was swallowed — a cloned-but-never-activated emsdk yielded rc=0 with no
emcc; added a post-activation guard (emcc present + version pinned to
3.1.43, loud return 1). (2) native-host.md's setup snippet claimed
"aborts otherwise" but ran sequentially; now `&&`-chained with a loud
abort. Nit: THIRD_PARTY_NOTICES emsdk clause extended to cover the
native path; GPL brew tools noted as host-only, outside the artifact
provenance chain.

**Deferred.** cmake 4.4.0 removed compat with `cmake_minimum_required
< 3.5` — TL 2023 CMakeLists may trip it; remedies documented in
native-host.md §5, handed to 5N. fontconfig-on-darwin build risk → 5N.
Hard host pinning → M2. `_wt_rc` leaks into the sourcing shell
(namespaced, harmless; noted by review, accepted).
