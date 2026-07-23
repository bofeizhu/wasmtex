<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# Sequencing detector fixtures — generator note

These `*.txt` files are **verbatim transcripts captured from the real pinned
engine** (`dist/busytex.{js,wasm}` + `texlive-basic.{js,data}`, TeX Live 2026
busytex build; regenerated at the M2 rebase from TL 2023) — not hand-written.
They ground the §5.3 rerun-marker detector
and the bibtex8/makeindex exit-code semantics in actual engine output, per M1
rebase-proofing rule 2 (parser/detector fixtures come from real transcripts and
regenerate at every rebase). `sequencing.test.ts` reads them directly.

Each file's first line is `# exit=<code>` (the applet's real process exit code,
stripped before matching); the remainder is the exact streamed transcript
(stdout+stderr joined by `\n`), including the Emscripten `program exited (with
status: N)…` trailer, so the detector is proven robust against real noise.

## What each fixture is, and why

| fixture | document | marker(s) present |
| --- | --- | --- |
| `rerun-crossref-pass1.txt` | `\tableofcontents` + forward `\ref`/`\pageref`/`\label`, pass 1 | `There were undefined references.` **and** `Label(s) may have changed. Rerun to get cross-references right.` |
| `rerun-citations-pass2.txt` | bibtex doc, engine pass 2 (after `bibtex8` wrote the `.bbl`) | `Label(s) may have changed. Rerun to get cross-references right.` |
| `undefined-refs-only-pass1.txt` | bibtex doc, pass 1 (citations undefined, no `.bbl` yet) | `There were undefined references.` only (no `Rerun`/`Label(s)` line) |
| `quiescent-crossref-pass2.txt` | the crossref doc, pass 2 (all refs resolved) | none |
| `quiescent-hello-pass1.txt` | `Hello world.`, pass 1 | none |
| `bibtex8-clean.txt` | `bibtex8 --8bit main.aux`, all citations found | exit 0 |
| `bibtex8-warning-undefined-entry.txt` | `bibtex8`, one cited key absent from the `.bib` | exit 1, `Warning--I didn't find a database entry…` |
| `bibtex8-error-missing-bst.txt` | `bibtex8`, `\bibliographystyle{nosuchstylexyz}` | exit 2, `I couldn't open style file…` |
| `makeindex-clean.txt` | `makeindex main.idx` on a 2-entry `.idx` | exit 0 |

## Exact verified marker strings (single line each, TL 2026)

- `LaTeX Warning: There were undefined references.`
- `LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.`

The detector anchors on the whitespace-normalized substrings `Rerun to get`,
`Label(s) may have changed`, and `There were undefined references` (see
`sequencing.ts`). Only these three, verified above, are trusted — no folklore
strings.

## Verified bibtex8 / makeindex exit codes (grounds the abort threshold)

`bibtex8` follows BibTeX's `history`: **0** spotless, **1** warning (e.g. a
missing database entry — common, `.bbl` still valid), **2** error (bad/absent
`.bst` or `.bib` — `.bbl` unusable), 3 fatal. Decision (see `core.ts`):
**exit ≤ 1 continue, exit ≥ 2 abort.** `makeindex` clean is 0; a non-zero exit
aborts (it is only ever invoked on a validated non-empty `.idx`).

## Source documents (exact) + which pass each fixture is

Each fixture is ONE applet run's transcript, sliced out of a full compile driven
through the worker core (`createWorkerCore`, which runs the §5.3 machine). All
entries are `main.tex`, engine `xetex`. Six compiles produce the nine fixtures:

1. **crossref** — `passes=auto, bib=off, index=off`; sequence
   `engine → engine → xdvipdfmx`. Pass 1 → `rerun-crossref-pass1.txt`,
   pass 2 → `quiescent-crossref-pass2.txt`.
   ```tex
   \documentclass{article}
   \begin{document}
   \tableofcontents
   \section{First}\label{sec:first}
   See section~\ref{sec:second} on page~\pageref{sec:second}.
   \newpage
   \section{Second}\label{sec:second}
   Back to~\ref{sec:first}.
   \end{document}
   ```
2. **bibtex (clean)** — `main.tex` + `refs.bib`, `bib=auto`; sequence
   `engine → bibtex8 → engine → engine → xdvipdfmx`. Pass 1 →
   `undefined-refs-only-pass1.txt`, the bibtex8 run → `bibtex8-clean.txt`,
   pass 2 → `rerun-citations-pass2.txt`.
   ```tex
   % main.tex
   \documentclass{article}
   \begin{document}
   Text citing~\cite{knuth1984} and~\cite{lamport1994}.
   \bibliographystyle{plain}
   \bibliography{refs}
   \end{document}
   ```
   ```bibtex
   % refs.bib
   @book{knuth1984, author = {Donald E. Knuth}, title = {The {\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}
   @book{lamport1994, author = {Leslie Lamport}, title = {{\LaTeX}: A Document Preparation System}, publisher = {Addison-Wesley}, year = {1994}}
   ```
3. **hello** — `bib=off, index=off`; pass 1 → `quiescent-hello-pass1.txt`.
   ```tex
   \documentclass{article}
   \begin{document}
   Hello world.
   \end{document}
   ```
4. **bibtex (warning)** — `main.tex` (below) + the same `refs.bib`, `bib=auto`;
   the bibtex8 run (exit 1, cites a key absent from the `.bib`) →
   `bibtex8-warning-undefined-entry.txt`.
   ```tex
   \documentclass{article}
   \begin{document}
   Text citing~\cite{knuth1984} and~\cite{missing}.
   \bibliographystyle{plain}
   \bibliography{refs}
   \end{document}
   ```
5. **bibtex (error)** — `main.tex` (below) + `refs.bib`, `bib=auto`; the bibtex8
   run (exit 2, missing `.bst`) → `bibtex8-error-missing-bst.txt`.
   ```tex
   \documentclass{article}
   \begin{document}
   Text citing~\cite{knuth1984}.
   \bibliographystyle{nosuchstylexyz}
   \bibliography{refs}
   \end{document}
   ```
6. **makeindex** — `index=auto, bib=off`; the makeindex run (2-entry `.idx`) →
   `makeindex-clean.txt`.
   ```tex
   \documentclass{article}
   \usepackage{makeidx}
   \makeindex
   \begin{document}
   \index{alpha}\index{beta}
   Text.
   \printindex
   \end{document}
   ```

## How to regenerate (at a TL rebase)

Drive the real `EmscriptenEngineHost` through `createWorkerCore` against a
freshly built `dist/`, capturing each `host.run()`'s streamed transcript + exit
code, and write the sliced pass (prefixed with its `# exit=<code>` header, then a
trailing `\n`) back here. The throwaway generator is not committed (journal
discipline); the documents + slicing above fully specify it. Re-verify that the
three marker substrings still appear where expected and that the exit codes are
unchanged; update the detector only if the engine's wording genuinely changed.

**TL 2026 rebase deltas (M2 item 6).** Regenerating against TL 2026 changed ONLY
version strings + render byte counts; the detector needed NO change and every
exit code held (bibtex8 clean 0 / warning 1 / error 2, makeindex 0). The three
bibtex8 transcripts (`bibtex8-{clean,warning-undefined-entry,error-missing-bst}`)
are byte-for-byte identical to TL 2023 — BibTeX prints no version banner here.
Version churn: the XeTeX banner (`0.999995`→`0.999998`, `2023`→`2026`),
`LaTeX2e <2022-11-01> patch level 1` → `<2025-11-01>`, the `L3` date, and
`makeindex, version 2.17 [TeX Live 2023]` → `2.18 [TeX Live 2026]`. One benign
structural change: TL 2026 no longer auto-loads `(…/ts1cmr.fd)` at
`\begin{document}` (its disappearance also un-wraps a col-79 line break in
`quiescent-crossref-pass2`) — it carries no marker, so detection is unaffected.
