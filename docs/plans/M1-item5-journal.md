<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# M1 item 5 — worker entry: execution-model study + node-loading journal

Dated 2026-07-23. Durable engineering record for the annual-rebase archaeology:
the empirical basis for the worker's engine-execution model, and the
reverse-engineered contract for driving the vendored file_packager data package
under node. Extends the M0 item-4 journal "6N demo notes" (the glue contract);
the runtime here is original (DESIGN.md §2.4, §5), the glue behavioural-only.

## The question

A compile is several applet runs (xetex, then xdvipdfmx; later bibtex8 /
makeindex) that must share one filesystem, and the 79 MB texlive-basic bundle
must NOT reload per run. Two candidate models:

1. **One instance, many `callMain`** on a single MODULARIZE module (risk: TeX's
   large global/static state pollutes run N+1).
2. Instance-per-applet with a persistent scratch FS re-staged between instances.

The vendored `busytex_pipeline.js` uses model 1 with a linear-memory
snapshot/restore between runs (`mem_header_size = 2**26`; snapshot the low 64 MiB
after init, `HEAPU8.fill(0)` + restore the header after each `callMain`). The 6N
journal noted it also runs `--version` per applet at init on one instance. This
study determined empirically whether model 1 is sound for REAL compiles on our
artifact, and whether the memory reset is required or merely defensive.

## The experiments (node, `dist/busytex.{js,wasm}` + `texlive-basic.{js,data}`)

Throwaway harness (scratchpad, not committed) loaded the engine once, staged
hello-world, and ran applets with/without the reset. Results:

| # | scenario | reset? | outcome |
| --- | --- | --- | --- |
| 1 | `xelatex` hello ×2, one instance | yes | both exit 0; **byte-identical `.xdv`** (536 B) — deterministic |
| 2 | `xelatex` → `xdvipdfmx`, one instance | yes | exit 0/0; **valid `%PDF-1.5`, 3591 B** — shared FS works |
| 3 | `xelatex` → `xdvipdfmx`, fresh instance | no | valid PDF (2-byte ts diff) — different applets tolerate no-reset once |
| 4 | `xelatex` hello ×2, fresh instance | no | run 1 ok; **run 2 OOMs** (`Cannot enlarge memory arrays … (OOM)`) |

`HEAPU8.length` = 512 MiB (no growth; a grow attempt aborts). Post-init memory
past the 64 MiB header is all-zero (the invariant that makes the header-only
restore valid) — verified true.

## Decision (evidence-backed)

**Model 1: ONE persistent MODULARIZE instance + linear-memory snapshot after
load, rolled back after EVERY `callMain`.** The MEMFS lives in the JS heap and
SURVIVES the reset (that is what lets `xdvipdfmx` read `xelatex`'s `.xdv` and
keeps the bundle mounted across jobs). Each new job remounts a clean MEMFS job
dir.

The reset is **REQUIRED, not optional**: EXP4 shows a second same-applet run OOMs
without it (the allocator brk never resets), and EXP1 shows the reset makes
reruns deterministic. EXP3 shows a single `xelatex`→`xdvipdfmx` chain survives
without a reset, but that is fragile and does not generalise to item 6's reruns —
so the uniform reset-after-every-`callMain` is the correct, future-proof rule.
The reset is applied in `engine-host.ts` (`finally` around `callMain`, plus a
belt-and-suspenders reset when opening a job). Documented in `core.ts` and
`engine-host.ts` headers.

Timing (single instance, macOS arm64): load engine + 79 MB bundle 636 ms;
`xelatex`+`xdvipdfmx` compile 596 ms; total ~1.2 s. Peak RSS ~890 MB. The
node-driven integration test runs ~2.4 s wall — well under the 60 s budget.

## Driving the file_packager data package under node (non-obvious)

`texlive-basic.js` is an Emscripten file_packager script hard-wired to a global
carrier named `BusytexPipeline` (`var Module = typeof BusytexPipeline !== …`).
Its `runWithFS` (pushed to `Module.preRun`) is what mounts the LZ4 bundle. Two
node incompatibilities had to be handled to load it offline (worker/browser hit
neither — they have `window`/`location`/IndexedDB):

1. **IndexedDB guard throws.** `runWithFS` does
   `if (typeof window === 'object') … else if (typeof location !== 'undefined') …
   else throw 'using IndexedDB to cache data can only be done …'`. Under node all
   three globals are absent → the `else` throws inside preRun → instantiation
   fails. Fix (test-only node loader): run the script in a scoped `Function` with
   `location`/`self` injected (any objects). That steers the probe onto the
   "worker" branch, where `indexedDB = self.indexedDB` is `undefined`, so
   `openDatabase`'s `indexedDB.open` throws INSIDE its own try/catch →
   `preloadFallback` → the script's own node branch
   (`require('fs').readFile(REMOTE_PACKAGE_NAME)`). Do NOT inject `window`: its
   `PACKAGE_PATH` branch dereferences `window.location.pathname`.
2. **`PACKAGE_PATH`/`fetchRemotePackage`.** With `process` defined (node),
   `PACKAGE_PATH` stays `''` and `fetchRemotePackage` takes its
   `require('fs').readFile` branch; `REMOTE_PACKAGE_NAME = Module.locateFile('texlive-basic.data')`
   → resolved to the dist path.

The IDB-fallback path logs two `console.error`s; the node loader passes a
filtered `console` so test output stays clean. All of this lives ONLY in
`runtime/test/support/node-engine-loader.ts` — it is TEST-ONLY and never touches
the shipped worker bundle. In the classic worker (`createWorkerModuleLoader`)
none of this applies: the worker has `location`/IndexedDB/`fetch`, so the loader
just sets the global `BusytexPipeline` carrier and `importScripts` the script,
and Emscripten's own worker code fetches the `.wasm`/`.data`.

`argv` dispatch (busytex.c, confirmed): `callMain([applet, …args])` →
Emscripten prepends `thisProgram` as argv[0] → busytex reads argv[1] as the
applet selector (`xelatex`→xetex, `pdflatex`→pdftex, `xdvipdfmx`, …) and resets
`optind`. The bundle carries `xelatex.fmt`/`pdflatex.fmt` at
`/texlive/texmf-dist/texmf-var/web2c/<engine>/…` and `texmf.cnf`, so the
preloaded bundle is self-sufficient for a real compile — the separate
`dist/formats/*.fmt` are NOT needed by the runtime.

## pdfTeX "near-free" (M1 plan test)

Confirmed near-free: pdftex needs only a different format
(`pdflatex.fmt`) and direct `--output-format=pdf` output (no `xdvipdfmx` step) —
one extra branch in `planCompile`, no pdftex-specific host code. Exposed in v1.

## Deferrals (item 5 scope boundaries)

- **§5.3 state machine** (bibtex8 / makeindex / bounded reruns) — item 6. The
  hardcoded single-pass `planCompile` is the marked seam.
- **SyncTeX** — the `synctex` flag is accepted but not yet wired into argv /
  output collection; result `synctex` stays absent. Post-item-5.
- **Multi-file relative includes from a subdir entry** — the host chdir's to the
  entry's directory and uses basenames (correct for the common root-entry case);
  richer texmf-local search-path handling for subdir projects is item 6+.
- **On-demand bundle resolution + integrity manifest** — M4. M1 preloads a
  single bundle, resolved from `assets.json` data (no baked asset names).

## IndexedDB preload cache — DESIGN §5.2 posture (code-review finding)

The vendored `texlive-basic.js` was built with `--use-preload-cache`, so in a
browser/worker with IndexedDB it **unconditionally** caches the 79 MB `.data`
in an `EM_PRELOAD_CACHE` object store (`dist/texlive-basic.js:1187`). DESIGN
§5.2 wants persistence to be an *optional adapter*, not always-on — so this is a
posture deviation to record, not a correctness bug:

- **The storage-less path is proven.** With no IndexedDB the loader falls back
  to a direct read (browser fetch / node `fs`) — exactly the path the node
  integration test exercises. Cold-start correctness with zero storage holds
  (DESIGN §10), so the cache is a genuine cache, never a correctness dependency.
- **It is inherited from the upstream-built bundle**, not authored here; the
  runtime cannot un-set it without rebuilding the file_packager output.
- **Planned removal:** drop `--use-preload-cache` (or gate it behind a host
  opt-in) when the bundle is rebuilt at the M2 TL-2026 rebase, restoring the
  strict §5.2 "optional adapter" stance. Tracked for docs/LOG.md at close-out.

## Post-review fixes (code review, 2026-07-23)

Five should-fixes applied before commit (evidence in this journal / the tests):

1. **Failing-compile log** — xetex switched `batchmode`→`nonstopmode` so the
   `! …` error lines (with `l.N`) stream to the terminal and land in
   `result.log` (batchmode wrote them only to `<job>.log`). Verified: a
   `\undefinedcmd` doc now yields `ok:false, exitCode:1` and a log containing
   "Undefined control sequence" (1007 vs 436 chars). Real-wasm assertion added.
2. **`_flush_streams`** — called after every `callMain` (before the memory
   reset and sink swap). Emscripten buffers a run's final no-newline line in a
   JS-heap TTY buffer that SURVIVES the linear-memory reset; without the flush
   it is lost, or surfaces inside the next job's stream under the wrong jobId (a
   content-level §5.2 break). Verified: `--version` leaves 2 buffered lines that
   the flush surfaces; a two-job (`alpha`→`broken`→`bravo`) run shows no
   cross-job leakage. Real-wasm isolation assertion added.
3. **`..` traversal** — `parseProjectFiles` (file keys) and `parseCompile`
   (`entry`) now reject any path with a `..` or empty segment (absolute /
   `//` / leading-or-trailing slash), so staging/`chdir` cannot escape the job
   dir or clobber `/texlive`. Hostile-suite tests added.
4. **Zero-past-header invariant** — `engine-host.load()` now scans HEAP32 past
   the 64 MiB header once per session and throws (pointing at MEM_HEADER_SIZE)
   if non-zero, so a rebase whose static segment outgrows the header fails loud
   instead of silently zeroing live state. Enforced against real wasm by the
   integration test's init.
5. **This IndexedDB posture note** (above).

Cheap nits also applied: `describeError` deduped (exported from `core.ts`);
repeat-init is an idempotent re-ack (never a second `host.load`, so no engine
leak); `synctex:true` emits an explicit advisory log line instead of silent
drop.

# M1 item 6 — §5.3 engine-sequencing state machine

Dated 2026-07-23 (rename-scope: item-6 notes live here, not a new file). The
`planCompile` seam flagged in item 5 is replaced. `worker/sequencing.ts` is the
§5.3 decision machine — a PURE reducer (no FS/engine/protocol beyond types);
`worker/core.ts` drives it, mapping abstract steps to applet runs and reading
back `.aux`/`.toc`/`.idx` snapshots as observations. No walls were hit twice;
this section records the durable design decisions.

## Machine shape (states / transitions)

`beginSequence(options) → {state, step}` issues engine pass 1 always. Each
`advanceSequence(state, observation) → {state, step}` folds one step's outcome
(exit code, per-step transcript, FS facts) and returns the next of: `engine{N}`,
`bibtex8`, `makeindex`, `xdvipdfmx`, `done`, `abort`. Decision cascade after a
step: settle the bibtex8 gate (once, right after pass 1: run iff `bibliography`
on AND `.aux` has `\citation`+`\bibdata`) → settle the makeindex gate (run iff
`index` on AND a non-empty `.idx`) → engine-rerun-vs-finalize. A tool forces one
incorporate pass. Rerun (auto) iff a transcript marker OR `.aux`/`.toc` changed,
under the cap of 5; explicit N runs exactly N engine passes, rerun signals
ignored. XeTeX finalizes through `xdvipdfmx`; pdfTeX writes the PDF direct.

## Divergence from upstream (behavioural reference only)

`busytex_pipeline.js` (MIT) uses a FIXED command list — one xetex pass without
bibtex; `xetex → bibtex8 → xetex → xetex` with bibtex — and has NO rerun
detection. Our §5.3 machine is original: it reruns *until quiescent* driven by
real markers + file change, bounded by `passes`. The e2e bibtex doc converges to
3 passes on its own (measured), matching upstream's fixed 3 by *detection*, not
by hardcoding. Only applet argv (`bibtex8 --8bit <job>.aux`, `--8bit` from
upstream) and the multi-pass-for-bibtex fact were taken as behaviour.

## Real fixture strings (verified against the pinned TL2023 engine)

Captured via a throwaway host harness (not committed; documents +
regeneration in `runtime/test/fixtures/sequencing/GENERATOR.md`). Verified
single-line markers the detector anchors on (whitespace-normalized substrings):

- `LaTeX Warning: There were undefined references.`
- `LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.`

Quiescent passes (resolved crossref pass 2; hello) and tool transcripts carry
none — no false positives. Folklore was avoided: only strings observed in real
output are trusted.

## bibtex8 failure semantics — decision + rationale

**exit ≤ 1 → continue; exit ≥ 2 → abort** (`BIBTEX_ABORT_EXIT = 2`). Grounded in
real captures: a missing database entry warns with exit **1** and still writes a
usable `.bbl`; a missing `.bst` or `.bib` errors with exit **2** and leaves the
`.bbl` unusable. This is BibTeX's `history` (0 spotless / 1 warning / 2 error /
3 fatal). Warnings are common in real bibliographies, so aborting on them would
break the common case; errors/fatals mean the bibliography is wrong or absent,
so a numeric threshold (not English-string matching, which is rebase-fragile)
aborts and surfaces the transcript. This is stricter and simpler than upstream,
which force-resets bibtex's exit to 0 unless stdout contains a fatal-message
string — we prefer the exit code as the stable signal. makeindex: non-zero
aborts (only ever invoked on a validated non-empty `.idx`).

## "There were undefined references" + the cap (accepted trade-off)

§5.3 lists unresolved references as a rerun condition, so the detector matches
it. A *permanently* undefined `\ref`/`\cite` keeps emitting it, so on its own it
would rerun to the cap of 5 — this is exactly latexmk's bounded-repeat behaviour
and the hard cap is the deliberate bound. Resolvable forward references also
trip `Label(s) may have changed`, so this marker only ever adds passes for the
genuinely-unresolvable case; it never removes a needed pass. Accepted as
spec-faithful; a future refinement (rerun on undefined-refs only while the `.aux`
is still changing) is possible but deviates from §5.3's literal wording.

## Bib-integration path reality

The `texlive-basic` bundle carries `plain.bst` (+ alpha/unsrt/plainnat/… and the
makeindex `.ist` styles). So the bibtex8 e2e integration test runs FULLY — no
need to supply a `.bst` as a project input (§6.3) or defer to M4's extended
bundle. `runtime/test/typeset-integration.test.ts` compiles a real 2-citation
document through `xelatex → bibtex8 → xelatex → xelatex → xdvipdfmx` and asserts
3 passes + a valid PDF + resolved citations.

## Degenerate `passes: 1` + bibliography (documented)

Tools are gated by their own options + FS facts, independent of `passes`. With
an explicit pass count too low to incorporate a tool's output (e.g. N=1 with a
bibliography), bibtex8 still runs once but no later pass re-reads its `.bbl` —
the caller's explicit choice, not an error. Unit-tested.

## Gates (all green)

typecheck (tsc `tsconfig.test.json`); full suite 115 tests / 7 files
(sequencing 41 new, worker-core +6, integration +2 real-wasm); `build:worker`
esbuild bundle 27.3 kB, self-contained (sequencing imports only types, so no
`node:` leakage); `build/audit/license-audit.sh` all checks pass (new `.ts`
carry SPDX MIT; no copyleft in runtime/).
