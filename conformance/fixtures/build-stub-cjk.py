#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 WasmTeX contributors
#
# Provenance: ORIGINAL work authored in the WasmTeX repository (see LICENSE).
#   NOT derived from any third-party font — no glyph outlines are copied from
#   fandol, Noto, Source Han, or any other font; every outline is a plain
#   rectangle defined here. No GPL/AGPL or other-wrapper source was consulted.
"""
Generate the CJK test-fixture font `WasmTeXStubCJK-Regular.ttf` used by the
`cjk-hostfont` conformance entry (DESIGN.md §6.3 — the HOST-supplied-font path:
a CJK font passed to the runtime via the `files` map and selected with
\\setCJKmainfont, rather than the bundled fandol).

Why an original stub instead of a real open CJK font: a real CJK face is 5–20 MB
even heavily subset, which is a poor thing to check into a test corpus, and it
would carry a third-party license. A hand-authored stub with simple rectangular
glyphs for exactly the handful of Han codepoints the document uses is ~1.6 KB,
is 100% original work (MIT, under the repo LICENSE — no THIRD_PARTY_NOTICES
entry needed), and exercises the ENTIRE host-font code path: a project-file font
is resolved by path, used for the CJK Unicode range, embedded in the PDF, and is
demonstrably NOT fandol. The conformance assertion is STRUCTURAL (fontProbe: the
host /BaseFont is embedded and fandol is absent — no pixel comparison, §8), so
placeholder-block glyphs are exactly right: the test proves the host-font PATH,
not glyph fidelity.

Keep CHARS in lockstep with conformance/corpus/cjk-hostfont/doc.tex. Rebuild with:

    python3 conformance/fixtures/build-stub-cjk.py

Requires fontTools (pip install fonttools). The output is written to the
cjk-hostfont corpus entry, where the runner loads it as a project file.
"""
import os

# Determinism: fontTools stamps head.created/modified from the wall clock unless
# SOURCE_DATE_EPOCH is set (its timeTools honors it). Pin it to 0 so regenerating
# this fixture is BIT-IDENTICAL to the checked-in .ttf — the provenance claim
# (original work, this script's output) is then verifiable with a plain `cmp`,
# not a TTX-level diff. Set before importing fontTools so it takes effect.
os.environ.setdefault("SOURCE_DATE_EPOCH", "0")

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000

# The exact CJK codepoints conformance/corpus/cjk-hostfont/doc.tex uses:
#   你好世界 (hello world), 主机 (host machine), 字体 (font), 宿 (as in 宿主 = host).
CHARS = "你好世界主机字体宿"

OUT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "corpus", "cjk-hostfont", "WasmTeXStubCJK-Regular.ttf")
)


def box(pen, x0, y0, x1, y1):
    pen.moveTo((x0, y0))
    pen.lineTo((x1, y0))
    pen.lineTo((x1, y1))
    pen.lineTo((x0, y1))
    pen.closePath()


def build():
    glyph_order = [".notdef"]
    cmap = {}
    glyphs = {}
    advances = {}

    pen = TTGlyphPen(None)
    box(pen, 100, 0, 300, 200)
    glyphs[".notdef"] = pen.glyph()
    advances[".notdef"] = UPM

    for i, ch in enumerate(CHARS):
        name = f"cjk{ord(ch):04X}"
        glyph_order.append(name)
        cmap[ord(ch)] = name
        pen = TTGlyphPen(None)
        # A solid full-width block; vary the top edge per character so the glyphs
        # are distinct (a designed artifact, not a single degenerate outline).
        top = 640 + (i % 5) * 40
        box(pen, 80, 0, 880, top)
        glyphs[name] = pen.glyph()
        advances[name] = UPM

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    metrics = {g: (advances[g], 0) for g in glyph_order}
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=880, descent=-120)
    fb.setupNameTable({
        "familyName": "WasmTeX Stub CJK",
        "styleName": "Regular",
        "psName": "WasmTeXStubCJK-Regular",
        "version": "1.000",
        "uniqueFontIdentifier": "WasmTeXStubCJK-Regular;1.000",
        "fullName": "WasmTeX Stub CJK Regular",
        "copyright": "Original work, WasmTeX conformance fixture. MIT (see repo LICENSE).",
    })
    fb.setupOS2(sTypoAscender=880, sTypoDescender=-120, usWinAscent=880, usWinDescent=120)
    fb.setupPost()
    fb.save(OUT)
    print("wrote", OUT)
    print("chars:", CHARS, "count:", len(CHARS))


if __name__ == "__main__":
    build()
