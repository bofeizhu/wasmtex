# SPDX-License-Identifier: MIT
# Vendored from busytex/busytex <https://github.com/busytex/busytex>
#   at commit f2bd7b11ee1b7b093638321c1f3e5d70389d307b
#   (pinned in build/sources/pins.lock; commit hard-verified at fetch time).
# License: MIT, per the upstream README "License" section; the upstream
#   repository has no top-level LICENSE file. See THIRD_PARTY_NOTICES.md.
# Vendored UNMODIFIED (M0 item 3): the file body below is byte-for-byte
#   identical to the pinned commit; the only change is this provenance header.
# build/upstream/ is an M0-only staging area (see build/upstream/README.md),
#   dissolved into build/engines/ etc. at M1. Do not modify vendored files
#   here except via documented item-4 patches.
# Per-file manifest with sha256: build/upstream/busytex/PROVENANCE.md.
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
