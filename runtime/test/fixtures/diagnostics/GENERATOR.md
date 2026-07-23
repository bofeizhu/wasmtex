<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# Diagnostics parser fixtures — generator note

These `*.txt` files are **verbatim `result.log` transcripts captured from the
real pinned engine** (`dist/busytex.{js,wasm}` + `texlive-basic.{js,data}`,
TeX Live 2026 busytex build; regenerated at the M2 rebase from TL 2023) — not
hand-written. They ground the §5.1
diagnostics parser (`runtime/src/diagnostics.ts`) in actual engine output, per
M1 rebase-proofing rule 2 (parser fixtures come from real transcripts and
regenerate at every rebase; the conformance corpus re-runs them).
`diagnostics.test.ts` reads them directly and asserts the exact
`Diagnostic[]` each produces.

Each file's **first line** is a `# generator:` note naming the engine and the
document that produced it; the parser test (`readFixture`) strips the leading
`# `-comment line(s) and parses the exact bytes that follow. The remainder is the exact
`result.log` (every applet pass's streamed stdout+stderr joined by `\n`,
including the Emscripten `program exited …` trailer and the `xdvipdfmx`
`main.xdv -> main.pdf` tail), so the parser is proven robust against real noise.

## What each fixture is, and why

| fixture | document | what the parser must extract |
| --- | --- | --- |
| `undefined-control-sequence.xetex.txt` | `\undefinedcontrolsequencexyz` on l.4 | 1 error `Undefined control sequence.`, file `main.tex`, line 4 |
| `undefined-control-sequence.pdftex.txt` | same, pdfTeX engine | identical 1 error — the pdfTeX-only `! ==> Fatal error occurred …` terminator is **excluded**, so both engines agree |
| `missing-input-file.txt` | `\input{nosuchinputfile}` | 1 error `LaTeX Error: File \`nosuchinputfile.tex' not found.` (filename verbatim for M4), file `main.tex`, line 4; the `! Emergency stop.` terminator excluded |
| `missing-package.txt` | `\usepackage{nosuchpackagexyz}` | 1 error `LaTeX Error: File \`nosuchpackagexyz.sty' not found.`, file `main.tex`, line 3; Emergency stop excluded |
| `missing-package.pdftex.txt` | same, pdfTeX engine | identical 1 error; proves both terminator forms (`Emergency stop` + `==> Fatal error`) are excluded when a real error precedes them |
| `no-end-document.txt` | `\begin{document}` with **no** `\end{document}` | 1 error `Emergency stop.` — a STANDALONE terminator (no preceding `! …`) is PROMOTED to an error so a failed compile is never silent (no file/line: the stack is already empty at EOF) |
| `undefined-references.txt` | `\ref{nosuchlabel}` + `\cite{nosuchcite}` | 3 warnings (Reference / Citation / "There were undefined references.") — the doc reruns to the **5-pass cap** (the rerun marker never clears), so each warning appears 5×; global dedup collapses them |
| `error-in-subfile.txt` | error `\undefinedsubcmd` INSIDE `\input{chapters/broken}` | 1 error attributed to the **subfile** `chapters/broken.tex`, line 4 — the case naive line-scanners get wrong |
| `package-warning.txt` | local `localpkg.sty` with `\PackageWarning`+`\MessageBreak` | 1 warning, `(localpkg)` continuation **folded**, file `localpkg.sty` (the open .sty), line 3 |
| `class-warning.txt` | local `localcls.cls` with `\ClassWarning`+`\MessageBreak` | 1 warning, `(localcls)` continuation folded, file `localcls.cls`, line 4 |
| `clean.txt` | `Hello, world.` | **zero** diagnostics |
| `overfull-box.txt` | `\hbox to 5pt{aaa…}` | **zero** diagnostics — proves Overfull/Underfull boxes are excluded by default |

`xetex` and `pdftex` variants are captured wherever the two engines' transcripts
differ around a diagnostic — at minimum the undefined-control-sequence case (in
both) and the missing-package case (in both), which together pin the
terminator rule for each engine's distinct wording.

## Terminator notices are context-dependent, not "always consequences"

`! Emergency stop.` and `! ==> Fatal error occurred …` are TeX *terminators*.
They are **dropped** when a real `! …` error precedes them in the same failure
(pending or already emitted) — that is the common case (missing-input,
missing-package, and pdfTeX's `==> Fatal error` after any halt), where the
terminator adds nothing and pdfTeX prints one that XeTeX does not, so dropping
keeps both engines' output identical. But a **standalone** terminator with no
preceding error (`no-end-document.txt`) is **promoted** to a `severity:'error'`
diagnostic, because otherwise a genuinely failed compile would return an empty
`diagnostics` array — a §5.2/§10 hazard, and exactly the shape an LLM-authored
document trips (a forgotten `\end{document}`).

## File attribution (the parenthesis stack), grounded here

TeX prints `(<file>` when it opens a file and `)` when it closes it, nested and
often several per line. The parser mirrors this with a stack and reports a
diagnostic's `file` as the innermost open file. Two fixtures prove it does the
hard part rather than the easy one:

- `error-in-subfile.txt`: at the error line the stack is
  `main.tex` → `chapters/broken.tex` (opened by `(./chapters/broken.tex` on the
  previous line), so the error is attributed to the subfile.
- `package-warning.txt` / `class-warning.txt`: the warning fires while the
  package/class file is open, so `file` is `localpkg.sty` / `localcls.cls`, and
  the reported `on input line N` is that file's own line — a self-consistent
  attribution that a root-file-only scanner cannot produce.

## Source documents (exact — line numbers are load-bearing)

Every fixture is the `result.log` of ONE compile of a `main.tex` entry with the
engine noted and `passes=auto, bibliography=off, index=off`. The `l.N` /
`on input line N` the parser extracts is fixed by the exact line the erroring
command sits on, so these bodies are reproduced verbatim (a blank line 3 is
deliberate where it positions an error on l.4). The M2 rebase confirmed that
different fillers producing the same `l.N` yield the same transcript, but the
exact bodies below are the pinned, deterministic input.

- `undefined-control-sequence.{xetex,pdftex}.txt` (engine xetex / pdftex):
  ```tex
  \documentclass{article}
  \begin{document}

  \undefinedcontrolsequencexyz
  \end{document}
  ```
- `missing-input-file.txt` (xetex):
  ```tex
  \documentclass{article}
  \begin{document}

  \input{nosuchinputfile}
  \end{document}
  ```
- `missing-package.{,pdftex.}txt` (xetex / pdftex): error reported at l.3
  (`\begin{document}`) after the failed `\usepackage` on l.2:
  ```tex
  \documentclass{article}
  \usepackage{nosuchpackagexyz}
  \begin{document}
  \end{document}
  ```
- `no-end-document.txt` (xetex) — no `\end{document}`:
  ```tex
  \documentclass{article}
  \begin{document}
  ```
- `undefined-references.txt` (xetex) — `\ref`+`\cite` on l.3; reruns to the
  5-pass cap (refs never resolve):
  ```tex
  \documentclass{article}
  \begin{document}
  See~\ref{nosuchlabel} and~\cite{nosuchcite}.
  \end{document}
  ```
- `error-in-subfile.txt` (xetex) — `main.tex` + `chapters/broken.tex`; the error
  is on l.4 of the SUBFILE:
  ```tex
  % main.tex
  \documentclass{article}
  \begin{document}
  Intro in the root file.
  \input{chapters/broken}
  After.
  \end{document}
  ```
  ```tex
  % chapters/broken.tex
  Some prose in the subfile.

  Another paragraph, then a bad macro:
  \undefinedsubcmd
  trailing text.
  ```
- `package-warning.txt` (xetex) — `main.tex` + `localpkg.sty` (`\PackageWarning`
  on l.3 of the .sty):
  ```tex
  % main.tex
  \documentclass{article}
  \usepackage{localpkg}
  \begin{document}
  Body.
  \end{document}
  ```
  ```tex
  % localpkg.sty
  \ProvidesPackage{localpkg}[2026/01/01 v1.0 local test package]
  % deliberately noisy
  \PackageWarning{localpkg}{This package is deliberately noisy\MessageBreak and warns across two lines}
  \endinput
  ```
- `class-warning.txt` (xetex) — `main.tex` + `localcls.cls` (`\ClassWarning` on
  l.4 of the .cls; the class's fixed `2026/01/01` date is intentional and
  version-independent):
  ```tex
  % main.tex
  \documentclass{localcls}
  \begin{document}
  Body.
  \end{document}
  ```
  ```tex
  % localcls.cls
  \NeedsTeXFormat{LaTeX2e}
  \ProvidesClass{localcls}[2026/01/01 v1.0 local test class]
  \LoadClass{article}
  \ClassWarning{localcls}{This class is deliberately noisy\MessageBreak on two lines}
  \endinput
  ```
- `clean.txt` (xetex):
  ```tex
  \documentclass{article}
  \begin{document}
  Hello, world.
  \end{document}
  ```
- `overfull-box.txt` (xetex) — the `\hbox` is on l.3; exactly **48** `a`s make it
  `235.0pt too wide` (Latin Modern `lmr` metrics; stable across the TL 2023→2026
  rebase, so the width + glyph run reproduce byte-for-byte):
  ```tex
  \documentclass{article}
  \begin{document}
  \hbox to 5pt{aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}
  \end{document}
  ```

## How to regenerate (at a TL rebase)

Drive the real `EmscriptenEngineHost` (via `test/support/node-engine-loader.ts`)
against a freshly built `dist/`, compiling each document above through the
worker core (`createWorkerCore`, so the §5.3 sequencing runs) and writing the
`result` message's `log` field (prefixed with the existing `# generator:` note,
then a trailing `\n`) back into this directory. The throwaway generator is not
committed (journal discipline); the bodies above fully specify it.

After regenerating, re-run `diagnostics.test.ts`: if the pinned engine's wording
genuinely changed, update the expected `Diagnostic[]` in that test (and the
parser only if a new marker family appeared), never the other way round.

**TL 2026 rebase deltas (M2 item 6), for the next rebaser's eye.** Regenerating
against TL 2026 changed ONLY version strings + render byte counts and the
expected `Diagnostic[]` needed NO change. The version churn: the XeTeX banner
(`0.999995`→`0.999998`, `2023`→`2026`), `LaTeX2e <2022-11-01> patch level 1`
→ `LaTeX2e <2025-11-01>` (the ` patch level 1` suffix is gone in the newer
release), `L3 programming layer` date, `article.cls` date, and the `.xdv`/`.pdf`
byte tallies. The ONE structural change: TL 2026's kernel no longer auto-loads
`(…/ts1cmr.fd)` at `\begin{document}`, so that line vanishes from every doc that
reaches the body — but it was always a balanced `(…)` that opened AND closed
before the diagnostic, so it never sat on the parser's paren stack at an error,
and attribution/line were unaffected. This is exactly the version-agnostic
property rebase-proofing rule 2 predicts: the parser anchors on the `! `/
`Warning:` markers and the paren stack, not on incidental font-descriptor loads.
