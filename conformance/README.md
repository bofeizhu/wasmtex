# conformance/

The golden-document corpus plus expected assertions (DESIGN.md §8). The **seed
corpus** (DESIGN.md §9 M2 bullet): hello-world per engine (`hello-xetex`,
`hello-pdftex`), one `bibtex8` document (`bib-cite`), and one `makeindex` document
(`idx-makeindex`). **M4 item 8 adds the beyond-basic, tier-exercising entries**
targeting the scientific-journal + CJK working set:

- **`sci-paper`** — a journal-style pdfTeX paper (`siunitx` + `mathtools` +
  `pgfplots`, all in the `academic` tier) with `natbib` + `bibtex8` citations
  against the `plainnat` `.bst`. Drives the **§5.4(a) static `\usepackage` scan**
  (academic preselected before pass 1) AND the full citation pipeline
  (`engine → bibtex8 → engine → engine`, `\citep`/`\citet` resolved).
- **`cjk-ctex`** — a Chinese XeTeX document via `\documentclass{ctexart}` using the
  **bundled `fandol`** font (no host font). Drives the **§5.4(b) missing-file
  retry** *independently* of the scan (the scan reads `\usepackage`, not
  `\documentclass`, so `ctexart.cls` is a miss → academic mounts → the re-run
  compiles).
- **`pkg-core-only`** — a `\usepackage{longtable}` doc that **locks the unknown-name
  policy**: `longtable` is core-served but is not a `provides` name in any tier, so
  the resolver must NOT mount academic (`bundlesLoaded=['core']`).

**M5 item 4 completes the §8 corpus** with the remaining doc types:

- **`unicode-math`** — a XeTeX document with `\usepackage{unicode-math}` +
  `\setmathfont{latinmodern-math.otf}` (an OpenType math font in the `academic`
  tier). Drives the **§5.4(a) scan** (unicode-math preselects academic). xdvipdfmx
  writes a ToUnicode CMap for the OTF math font, so the math ROUND-TRIPS — the
  recovered text carries the real operators (∫ ∞ ∑ √), a direct render proof.
- **`multi-include`** — a multi-file `\include` project (`report.cls` +
  `\tableofcontents` + two chapters), all **core**-served (`bundlesLoaded=['core']`,
  `resolution=none`). A forward `\ref` from chapter 1 to chapter 2 makes pass 1 emit
  "Rerun to get cross-references right"; the §5.3 auto-rerun runs a second pass
  (`phases=['engine','engine']`). Pins the retained pass-1 undefined-reference
  diagnostics (file/line across the `\include`d file), like `bib-cite`.
- **`known-bad`** — the ERROR-PATH lock: `\usepackage{nosuchpackagexyz}` (in no
  tier). Asserts `ok:false`, `exitCode:1`, **`noPdf`** (no output PDF), and the exact
  error **diagnostics** shape. Confirms the §5.4(b) retry is BOUNDED — one academic
  mount attempt then a clean fail (`bundlesLoaded=['core','academic']`), never a
  download loop (the corpus counterpart to the integration test's
  "genuinely-missing package" case).
- **`tikz-standalone`** — a focused `\documentclass{standalone}` figure cropped to
  one page, `\usepackage{pgfplots}` driving the **§5.4(a) scan**. A real tikzpicture
  (two plotted functions, title, axis labels, legend); the labels recover as text.
- **`cjk-hostfont`** — the §6.3 **host-supplied-font** path: a CJK font passed via
  the runtime `files` map and selected by a project-relative path with
  `\setCJKmainfont`, NOT the bundled fandol. `\usepackage{xeCJK}` drives the scan;
  xeCJK loads no default font, so fandol never enters. Asserts (fontProbe) the host
  font is embedded and — the load-bearing control — **`absentFonts`** proves NO
  fandol is embedded. The `WasmTeXStubCJK-Regular.ttf` fixture is ORIGINAL work (see
  `fixtures/`), not a vendored third-party font.
- **`journal-ieee`** / **`journal-elsevier`** — the **supplied-class** capability
  proof: a real top-journal class (IEEE's `IEEEtran.cls`, Elsevier's
  `elsarticle.cls`) is placed in the job's `files` map — exactly as a host would
  pass a class WasmTeX does not bundle — and an ORIGINAL minimal paper compiles
  against it. Both mount `academic` via the **§5.4(a) scan** (IEEEtran typesets in
  Times, whose metrics live in `academic`, and the IEEE paper loads the `cite`
  package, which is there too; elsarticle's own `\RequirePackage`s pull an
  `academic` package). The
  IEEE paper's inline `thebibliography` + `\cite` forces the §5.3 auto-rerun
  (`phases=['engine','engine']`). These are **test-only**: the `.cls` files are
  verbatim third-party LPPL-1.3 fixtures (see the repo `THIRD_PARTY_NOTICES.md`),
  are **not** shipped in any bundle or the npm package, and first-class journal
  support is deferred to a future milestone as a **separate package**, never
  folded into `academic`.

Assertions cover **exit code, PDF page count, extracted text snippets, diagnostics
shape, which bundle tiers mounted, and the §5.4 resolution path — no pixel
comparisons** (§8).

## Layout

```
conformance/
  run.mjs             # the runner (drives the PUBLIC wasmtex runtime vs. dist/)
  verify-manifest.mjs # dist/manifest.json integrity check (bytes+sha256, provides)
  pdf-probe.mjs       # shared PDF text/page/font probe (also used by the demo smoke)
  package.json        # `npm run conformance` (mirrors demo/); no external deps
  fixtures/           # generators + provenance for binary fixtures (the CJK stub font)
  corpus/<name>/
    <entry>.tex ...   # the project sources (the dir IS the project)
    <class>.cls       # a supplied third-party class (e.g. journal-ieee's IEEEtran.cls) loads as text
    <font>.ttf        # binary project inputs (e.g. cjk-hostfont's host font) load as bytes
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
    "noPdf":          true,                // optional; assert NO PDF was produced (error path)
    "textSnippets":   ["XeTeX", "…"],      // each present in the recovered text
    "absentSnippets": ["LibreOffice"],     // optional negative controls (each ABSENT)
    "diagnostics":    [],                  // optional; exact deep-equal vs. result.diagnostics

    // -- M4 item 8 + M5 item 4: bundle tiers + font structure ----------------
    "bundlesLoaded":  ["core", "academic"], // optional; exact result.stats.bundlesLoaded
    "embeddedFonts":  ["FandolSong"],       // optional; each must be a substring of some /BaseFont
    "absentFonts":    ["FandolSong"],       // optional; each must NOT be a substring of any /BaseFont
    "requireEmbeddedFontFile": true,        // optional; a font program (/FontFile*) is embedded
    "minCidGlyphs":   30                    // optional; >= N 2-byte CID glyphs in the content stream
  },

  "resolution": "scan" | "retry" | "none", // optional; the §5.4 path that mounted (or didn't) a tier
  "phases": ["engine", "xdvipdfmx"]         // optional; exact executed step sequence
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
  (item 8), and a change is a rebase finding (like the fixtures). The
  `multi-include` entry likewise pins the retained pass-1 undefined-`\ref`
  warnings (cross-reference, not citation), with file/line attributed across an
  `\include`d file.
- **`noPdf`** (optional, M5 item 4) asserts a compile produced **no** PDF —
  `result.pdf` absent. The error-path counterpart to `minPages`: a fatal failure
  (e.g. `known-bad`'s missing package, "no output PDF file produced") must fail
  cleanly, never ship a partial PDF. Paired with `ok:false` + `exitCode` + the
  error `diagnostics`, it locks the whole failure contract.
- **`phases`** (optional) is the exact executed step sequence. The
  `engine`/`bibtex8`/`makeindex` steps are read from the transcript in execution
  order; the `xdvipdfmx` driver is silent in the transcript, so it is **inferred**
  — a XeTeX job that produced a PDF must have run xdvipdfmx (XeTeX emits an
  `.xdv`, and the sequencing machine finalizes XeTeX only through xdvipdfmx).
  pdfTeX writes the PDF directly, so it has no driver step.
- **`bundlesLoaded`** (optional) is an exact match against
  `result.stats.bundlesLoaded` — WHICH tiers actually mounted. The basic entries
  pin `["core"]` (the unknown-name policy, at the corpus level: a core-served doc
  must never pull the ~472 MB academic tier). The academic entries pin
  `["core", "academic"]`.
- **`embeddedFonts` / `requireEmbeddedFontFile` / `minCidGlyphs`** (optional) verify
  a CJK document **structurally**, because a XeTeX-set CJK PDF embeds the CJK font as
  a CID subset WITHOUT a ToUnicode CMap — so `recoverText` recovers only the Latin
  runs, never the Chinese (honest PDF reality, not a probe defect; see `fontProbe`).
  Instead we assert the bundled font is embedded (`FandolSong` in a `/BaseFont`), its
  program is embedded (`/FontFile*` — the PDF is self-contained, no host font), and a
  run of CID glyphs was emitted. When the CJK font is used for nothing but the CJK
  text (Latin uses a separate font), its embedding IS proof the Chinese was set with
  it.
- **`absentFonts`** (optional, M5 item 4) is the negative control for the fonts:
  each name must NOT be a substring of any `/BaseFont`. The `cjk-hostfont` entry
  uses it to prove the **host-supplied** font (`WasmTeXStubCJK`) — not the bundled
  fandol — is the one embedded for the CJK (§6.3). Unlike `cjk-ctex`, that stub font
  carries a plain Unicode cmap, so xdvipdfmx writes a ToUnicode CMap and the Chinese
  ROUND-TRIPS (the characters are asserted as `textSnippets` too, not just
  structurally). The exact counterpart to `embeddedFonts`. ALWAYS pair
  `absentFonts` with a positive check on the same probe (`embeddedFonts` +
  `minPages`/`requireEmbeddedFontFile`): with no PDF (or a probe miss) the
  `/BaseFont` list is empty and every `absentFonts` name vacuously passes —
  the positive check is what proves the probe actually saw a rendered PDF.

### Tiers & the §5.4 resolution (`resolution`)

The runner preloads **`core`** and lists **`academic`** as on-demand
(`bundles: { preload: ['core'], onDemand: ['academic'] }`); academic mounts LAZILY
only when an entry needs it. `resolution` pins the §5.4 path that a tier came in by,
distinguished at the public-API level by the **live** log stream (`Job.onLog`) vs.
the **final** `result.log`:

- **`scan`** — the §5.4(a) static `\usepackage` scan preselected the tier BEFORE
  pass 1, so no pass failed: the live log has no `File \`x' not found` and an
  on-demand tier is in `bundlesLoaded` (`sci-paper`).
- **`retry`** — the §5.4(b) missing-file retry: a pass failed `File \`x' not found`
  (streamed LIVE), the tier mounted, and the re-run succeeded — the worker SPLICES
  the failed probe out of the authoritative `result.log`. So the live log HAS
  `not found` but `result.log` is clean, and an on-demand tier is in `bundlesLoaded`
  (`cjk-ctex` — `ctexart.cls`).
- **`none`** — no on-demand tier mounted and no probe failed (`bundlesLoaded ==
  preload`, live log clean) (`pkg-core-only` and the basic entries).

An entry that expects an on-demand tier (via `bundlesLoaded`) is **green-skipped
per-entry** if that tier's `.js`/`.data` are absent from `dist/` (a core-only build),
so the basic corpus still runs; the whole-run skip still guards engine/core absence.

### Manifest verification (`verify-manifest.mjs`)

`run.mjs` runs a **preflight** that checks the shipped `dist/manifest.json` is
internally consistent: every PRESENT asset's recorded `{bytes, sha256}` matches the
actual file, and the per-bundle `provides` index is present + disjoint across tiers.
A corrupt/truncated download fails here, loud, before any compile. It is also
runnable standalone (`node conformance/verify-manifest.mjs`), and green-skips when
`manifest.json` is absent. This checks the shipped BYTES, complementing
`runtime/test/manifest.test.ts` (which checks the parse/type contract).

## Running

```
npm --prefix conformance run conformance      # builds the runtime, then runs
# or, once the runtime is built:
node conformance/run.mjs
```

The runner is **guarded**: the `dist/` engine artifacts are git-ignored (built by
`make artifacts`), so on a checkout without them the runner prints a message and
**exits 0 (green skip)** — exactly like the runtime integration tests and the
demo smoke. `WASMTEX_DIST=/path/to/dist` points it at a relocated dist. The runner
reads **`manifest.json`** (schemaVersion 2, for the `provides` index the §5.4 scan
needs), so `manifest.json` — not `assets.json` — is in the required set alongside
the engine + `core` tier; the academic tier is per-entry-guarded (above).

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

`fontProbe` (M4 item 8) reads the `/BaseFont` names, whether a font program is
embedded (`/FontFile*`), and the count of 2-byte CID glyphs in the content stream.
It exists because a CJK CID subset ships **without** a ToUnicode CMap, so
`recoverText` cannot reconstruct the Chinese as Unicode — the `cjk-ctex` entry
asserts the Chinese via the font/glyph STRUCTURE instead (no pixel comparison, §8).
