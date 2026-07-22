/*
 * SPDX-License-Identifier: MIT
 * Vendored from busytex/busytex <https://github.com/busytex/busytex>
 *   at commit f2bd7b11ee1b7b093638321c1f3e5d70389d307b
 *   (pinned in build/sources/pins.lock; commit hard-verified at fetch time).
 * License: MIT, per the upstream README "License" section; the upstream
 *   repository has no top-level LICENSE file. See THIRD_PARTY_NOTICES.md.
 * Vendored UNMODIFIED (M0 item 3): the file body below is byte-for-byte
 *   identical to the pinned commit; the only change is this provenance header.
 * build/upstream/ is an M0-only staging area (see build/upstream/README.md),
 *   dissolved into build/engines/ etc. at M1. Do not modify vendored files
 *   here except via documented item-4 patches.
 * Per-file manifest with sha256: build/upstream/busytex/PROVENANCE.md.
 */
/*
 * An implementation of the deprecated `getpass()` function for Cosmopolitan Libc.
 * It is included directly in `texlive/texk/dvipdfm-x/dvipdfmx.c`.
 */
#ifdef __COSMOPOLITAN__
#include <stdio.h>
#include <stdlib.h>
static char* getpass(const char* prompt) {
  fprintf(stderr, "Password encryption is not supported\n");
  exit(1);
}
#endif
