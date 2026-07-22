<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# Diagnostics parser fixtures — generator note

These `*.txt` files are **verbatim `result.log` transcripts captured from the
real pinned engine** (`dist/busytex.{js,wasm}` + `texlive-basic.{js,data}`,
TeX Live 2023 busytex build) — not hand-written. They ground the §5.1
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

## How to regenerate (at a TL rebase)

Drive the real `EmscriptenEngineHost` (via `test/support/node-engine-loader.ts`)
against a freshly built `dist/`, compiling each document in the table above and
writing its `result.log` (prefixed with the `# generator:` note) back into this
directory. The throwaway generator that produced this set is not committed
(journal discipline); the documents + engine choices above fully specify the
regeneration. After regenerating, re-run `diagnostics.test.ts`: if the pinned
engine's wording genuinely changed, update the expected `Diagnostic[]` in that
test (and the parser only if a new marker family appeared), never the other way
round.
