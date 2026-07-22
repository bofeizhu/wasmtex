# conformance/

The golden-document corpus plus expected assertions (DESIGN.md §8):
hello-world, math + `unicode-math`, TikZ, bibliography via `bibtex8`,
`makeindex`, a multi-chapter `\include` project, a CJK document (using a
small open font in `conformance/fixtures`), and a known-bad document.
Assertions cover exit code, PDF page count, extracted text snippets, and
diagnostics shape — no pixel comparisons in v1.
