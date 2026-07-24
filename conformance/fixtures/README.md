<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# conformance/fixtures/

Generators for binary conformance fixtures whose provenance must be recorded.

## `WasmTeXStubCJK-Regular.ttf` (the host-supplied CJK font)

The `cjk-hostfont` corpus entry exercises DESIGN.md §6.3's **host-supplied-font**
contract: a CJK font passed to the runtime through the `files` map and selected by
a project-relative path with `\setCJKmainfont` — the real §6.3 path, distinct from
the bundled-`fandol` fallback that `cjk-ctex` uses.

That needs a CJK font checked into the repo. Rather than vendor a real open CJK
face (5–20 MB even heavily subset, and third-party-licensed), the fixture is a
**hand-authored stub**: `build-stub-cjk.py` builds a ~1.6 KB TrueType font with
plain rectangular glyphs for exactly the nine Han codepoints the test document
uses (`你好世界主机字体宿`). It exercises the entire host-font code path — a
project-file font resolved by path, used for the CJK Unicode range, embedded in
the PDF, and demonstrably **not** fandol — while the conformance assertion is
purely **structural** (fontProbe: the host `/BaseFont` is embedded and fandol is
absent; no pixel comparison, §8), so placeholder-block glyphs are exactly right.

- **License / provenance: ORIGINAL work, MIT** (under the repo `LICENSE`). It is
  **not** derived from any third-party font — every glyph outline is a rectangle
  defined in `build-stub-cjk.py`; no outlines were copied from fandol, Noto,
  Source Han, or any other font, and no GPL/AGPL or other-wrapper source was
  consulted (DESIGN.md §2). Because it is original repo work, it needs **no**
  `THIRD_PARTY_NOTICES.md` entry (that file inventories third-party material).
- **The generated `.ttf` lives in the corpus entry**, not here:
  `conformance/corpus/cjk-hostfont/WasmTeXStubCJK-Regular.ttf`. The runner loads
  every file in a corpus entry dir into the runtime `files` map, so the font must
  sit in the entry to be delivered as a project file (the §6.3 contract). This
  directory holds the *generator* and this provenance note.

Rebuild (keep `CHARS` in lockstep with `../corpus/cjk-hostfont/doc.tex`):

```
python3 conformance/fixtures/build-stub-cjk.py   # requires fontTools
```
