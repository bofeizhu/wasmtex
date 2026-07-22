# SPDX-License-Identifier: MIT
# DERIVED WORK (DESIGN.md §2.1). Derived from busytex/busytex
#   <https://github.com/busytex/busytex> at commit
#   f2bd7b11ee1b7b093638321c1f3e5d70389d307b (MIT; pinned in
#   build/sources/pins.lock [busytex], hard-verified at fetch time). The
#   upstream repository has no top-level LICENSE file; its README "License"
#   section is the statement of record. See THIRD_PARTY_NOTICES.md / NOTICE.
#
# OUR maintained copy, forked from upstream emcc_wrapper.py at the WasmTeX
#   TL-2026 rebase (M2 item 3) when build/upstream/ was dissolved into
#   build/engines/. The body below is UNMODIFIED vs the pinned upstream file
#   (no substantive change was needed): it is the EM_COMPILER_WRAPPER shim the
#   Makefile's CCSKIP_*_wasm variables use to reuse native-built TeX/ICU/
#   FreeType helper tools during the wasm pass. Retained verbatim so the wasm
#   build of the kept engines (xetex/pdftex) and their ICU/freetype deps works.
import os
import sys
import subprocess
import shutil

K = [i for i, a in enumerate(sys.argv) if a == '--'][0]
replace = [a for i, a in enumerate(sys.argv) if 1 <= i < K]

copy = [(r, sys.argv[i]) for i in range(1 + K, len(sys.argv)) if sys.argv[i - 1] == '-o' for r in replace if os.path.basename(sys.argv[i]) == os.path.basename(r)]

logfile = open('emcc_wrapper.txt', 'a+')

if copy:
    dirname = os.path.dirname(copy[0][1])
    if dirname:
        os.makedirs(dirname, exist_ok = True)
    shutil.copy2(*copy[0])
    print('Copying ' + str(copy[0]), file = logfile)
    sys.exit(0)
else:
    print('Not copying ' + str(sys.argv), file = logfile)
    sys.exit(subprocess.call(sys.argv[1 + K:]))
