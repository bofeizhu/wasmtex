<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE). The patched
  file (libpng) carries its own license (libpng license); this HEADER and the
  now-removed diff's *changes* were original WasmTeX work, not derived from
  any GPL/AGPL source. The diff's context lines necessarily quoted small
  excerpts of the patched libpng source, which remain under the libpng
  license — the diff-context-excerpt licensing clause (retained here for the
  archival record).
-->

# Patch: libpng-macos-fp-h — RETIRED at TL 2026 (M2 item 4, 2026-07-23)

**Status: RETIRED.** The defect this patch fixed no longer exists in the TL 2026
source tree, because libpng upstream removed the offending guard entirely between
1.6.39 (TL 2023) and 1.6.55 (TL 2026). The `pngpriv-h.patch` diff was removed;
this HEADER is kept as the archival record so the annual rebaser knows the patch
existed, why it was needed, and why it is gone (do not resurrect it against a
future libpng that no longer carries the guard).

## Why it is gone (TL 2026 evidence)

In `libs/libpng/libpng-src/pngpriv.h` at TL 2023 (libpng 1.6.39) the floating-point
header selection read (the block this patch narrowed):

```c
#  include <float.h>

#  if (defined(__MWERKS__) && defined(macintosh)) || defined(applec) || \
    defined(THINK_C) || defined(__SC__) || defined(TARGET_OS_MAC)
   /* ... #include <fp.h> ... */
#  else
#     include <math.h>
#  endif
```

At TL 2026 (libpng 1.6.55) that entire classic-Mac `<fp.h>` branch is gone. The
block was reorganized to unconditionally include `<math.h>` (pngpriv.h ~541-560):

```c
#if defined(PNG_FLOATING_POINT_SUPPORTED) ||\
    defined(PNG_FLOATING_ARITHMETIC_SUPPORTED)
   /* ... DBL_DIG / DBL_MIN / DBL_MAX ... */
#  include <float.h>

#  include <math.h>
   /* (only an Amiga SAS/C _M68881 special-case remains; no TARGET_OS_MAC, no <fp.h>) */
#endif
```

There is no `TARGET_OS_MAC` and no `<fp.h>` reference anywhere in the 2026
`pngpriv.h`, so the modern-Apple false positive that broke the native macOS build
cannot occur. Verified 2026-07-23 by extracting the file from the pinned
`texlive-source-2026.0.tar.gz` (pins.lock [texlive-source-2026]).

## Historical record (what the patch did, TL 2023)

Removed `|| defined(TARGET_OS_MAC)` from the `pngpriv.h` guard that selected the
classic Mac OS `<fp.h>` header over `<math.h>`. On a modern macOS SDK
`TARGET_OS_MAC` is defined to `1` on *every* Apple platform (pulled in
transitively by system headers), so it was a false signal for "classic Mac OS
(pre-OSX)". `<fp.h>` does not exist on modern macOS, so every libpng translation
unit failed to compile (`fatal error: 'fp.h' file not found`). Upstream busytex
builds on Linux, where none of these macros are defined and the `<math.h>` branch
is taken, so the bug was invisible there. The other guard terms (`__MWERKS__`,
`applec`, `THINK_C`, `__SC__`) are genuine classic-Mac / CodeWarrior / THINK C /
Symantec C signals and were left intact.

## Upstream-able? (moot)

Was **yes** — and upstream libpng did exactly this (dropped the `TARGET_OS_MAC`
term and the `<fp.h>` path) by 1.6.55. No further action.
