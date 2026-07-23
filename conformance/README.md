# conformance/

The golden-document corpus plus expected assertions (DESIGN.md §8). At M2 this
holds the **seed corpus** (DESIGN.md §9 M2 bullet): hello-world per engine
(`hello-xetex`, `hello-pdftex`), one `bibtex8` document (`bib-cite`), and one
`makeindex` document (`idx-makeindex`). The full §8 corpus — math/`unicode-math`,
TikZ, a multi-chapter `\include` project, a CJK document (using a small open
font in `conformance/fixtures`), and a known-bad document — arrives with M5.

Assertions cover **exit code, PDF page count, extracted text snippets, and
diagnostics shape — no pixel comparisons** (§8).

## Layout

```
conformance/
  run.mjs            # the runner (drives the PUBLIC wasmtex runtime vs. dist/)
  pdf-probe.mjs      # shared PDF text/page probe (also used by the demo smoke)
  package.json       # `npm run conformance` (mirrors demo/); no external deps
  corpus/<name>/
    <entry>.tex ...  # the project sources (the dir IS the project)
    expectations.json
```

Each `corpus/<name>/` directory is a self-contained project: **every file in it
except `expectations.json` is loaded into the runtime `files` map**, keyed by its
path relative to the entry dir (POSIX separators). Text files (`.tex`, `.bib`,
`.sty`, …) are read UTF-8; anything else is passed as raw bytes.

## `expectations.json` schema

```jsonc
{
  "title":        "hello-xetex",          // label (informational)
  "description":  "…",                     // informational
  "engine":       "xetex" | "pdftex",      // the §5.1 engine
  "entry":        "hello.tex",             // root file to compile
  "passes":       "auto" | 1..5,           // optional; default "auto"
  "bibliography": "auto" | "off",          // optional; default "auto"
  "index":        "auto" | "off",          // optional; default "auto"

  "expect": {
    "ok":             true,                // result.ok
    "exitCode":       0,                   // result.exitCode
    "minPages":       1,                   // countPages(pdf).count >= minPages
    "textSnippets":   ["XeTeX", "…"],      // each present in the recovered text
    "absentSnippets": ["LibreOffice"],     // optional negative controls (each ABSENT)
    "diagnostics":    []                   // exact deep-equal vs. result.diagnostics
  },

  "phases": ["engine", "xdvipdfmx"]        // optional; exact executed step sequence
}
```

- **`textSnippets` / `absentSnippets`** are matched **space-stripped** against the
  recovered PDF text (see the probe note). A snippet is found iff its
  whitespace-removed form is a substring of the whitespace-removed recovered
  text; inter-word spaces are kerning, not glyphs, so they never survive. The
  `absentSnippets` are negative controls: they prove the probe *discriminates*
  (a doc that lacked the wanted text would fail `textSnippets`; a probe that
  returned garbage would fail `absentSnippets`).
- **`diagnostics`** is an exact match against the parsed `result.diagnostics`
  (severity/message/file/line), normalized so a missing `file`/`line` compares
  equal whether written or omitted. A clean document is `[]`. The `bib-cite`
  seed deliberately pins the pre-bibtex "Citation … undefined" warnings that the
  multi-pass transcript retains — a real end-to-end exercise of the parser
  (item 8), and a change is a rebase finding (like the fixtures).
- **`phases`** (optional) is the exact executed step sequence. The
  `engine`/`bibtex8`/`makeindex` steps are read from the transcript in execution
  order; the `xdvipdfmx` driver is silent in the transcript, so it is **inferred**
  — a XeTeX job that produced a PDF must have run xdvipdfmx (XeTeX emits an
  `.xdv`, and the sequencing machine finalizes XeTeX only through xdvipdfmx).
  pdfTeX writes the PDF directly, so it has no driver step.

## Running

```
npm --prefix conformance run conformance      # builds the runtime, then runs
# or, once the runtime is built:
node conformance/run.mjs
```

The runner is **guarded**: the `dist/` engine artifacts are git-ignored (built by
`make artifacts`), so on a checkout without them the runner prints a message and
**exits 0 (green skip)** — exactly like the runtime integration tests and the
demo smoke. `WASMTEX_DIST=/path/to/dist` points it at a relocated dist.

### How the runner reaches the runtime (import mechanism)

`run.mjs` drives the **public** API — `createTypesetter` (§5.1) — over the real
busytex wasm, in-process, under Node. The compiled `runtime/dist/**` is
bundler-targeted (extensionless imports) and not Node-native, so the runner
imports the esbuild-bundled Node harness **`runtime/dist/node-harness.mjs`**: a
single self-contained ESM file (the Node-delivery twin of the browser
`dist/worker.js`) that re-exports `createTypesetter` plus a Node `WorkerFactory`
(in-process adapter + Node engine loader + real `EmscriptenEngineHost`). This is
the SAME factory `runtime/test/typeset-integration.test.ts` drives from source —
one definition, two consumers, no duplication. Details:
`docs/plans/M2-journal.md` item 7.

### PDF probe honesty (`pdf-probe.mjs`)

The text probe inflates every FlateDecode stream and recovers the visible text:
for XeTeX via the embedded ToUnicode CMap (glyph → Unicode), for pdfTeX via the
`(…)` string literals. `countPages` inflates object streams too, then reads the
page-tree root `/Type /Pages … /Count N` and cross-checks it against the leaf
`/Type /Page` object tally. It is a structural probe, not a full PDF parser (it
does not resolve `/Kids` references), which is sufficient for the xdvipdfmx /
pdfTeX output the corpus exercises.
