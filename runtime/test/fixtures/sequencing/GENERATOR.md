<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# Sequencing detector fixtures — generator note

These `*.txt` files are **verbatim transcripts captured from the real pinned
engine** (`dist/busytex.{js,wasm}` + `texlive-basic.{js,data}`, TeX Live 2023
busytex build) — not hand-written. They ground the §5.3 rerun-marker detector
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

## Exact verified marker strings (single line each, TL 2023)

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

## How to regenerate (at a TL rebase)

Drive the real `EmscriptenEngineHost` (via `test/support/node-engine-loader.ts`)
against a freshly built `dist/`, compiling the documents in the table above and
writing each applet run's streamed transcript (prefixed with its `# exit=`
header) back into this directory. The throwaway generator that produced this set
is not committed (journal discipline); the documents + invocations above fully
specify the regeneration. Re-verify that the three marker substrings still
appear where expected and that the exit codes are unchanged; update the detector
only if the engine's wording genuinely changed.
