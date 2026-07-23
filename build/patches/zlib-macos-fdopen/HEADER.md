<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE). The patched
  file (zlib) carries its own license (zlib license); this HEADER and the
  now-removed diff's *changes* were original WasmTeX work, not derived from
  any GPL/AGPL source. The diff's context lines necessarily quoted small
  excerpts of the patched zlib source, which remain under the zlib license —
  the diff-context-excerpt licensing clause (retained here for the archival
  record).
-->

# Patch: zlib-macos-fdopen — RETIRED at TL 2026 (M2 item 4, 2026-07-23)

**Status: RETIRED.** The defect this patch fixed no longer exists in the TL 2026
source tree, because zlib upstream removed the offending guard between 1.2.13
(TL 2023) and 1.3.2 (TL 2026). The `zutil-h.patch` diff was removed; this HEADER
is kept as the archival record so the annual rebaser knows the patch existed,
why it was needed, and why it is gone.

## Why it is gone (TL 2026 evidence)

In `libs/zlib/zlib-src/zutil.h` at TL 2023 (zlib 1.2.13) the classic-Mac guard
this patch narrowed read:

```c
#if defined(MACOS) || defined(TARGET_OS_MAC)
#  define OS_CODE  7
#  ifndef Z_SOLO
#    if defined(__MWERKS__) && __dest_os != __be_os && __dest_os != __win32_os
       ...
#        define fdopen(fd,mode) NULL /* No fdopen() */
```

At TL 2026 (zlib 1.3.2) that whole block collapsed to just the genuine classic-Mac
macro, and the `TARGET_OS_MAC` term AND the entire `#ifndef Z_SOLO ... fdopen ...
NULL` machinery are gone (zutil.h ~148-150):

```c
#if defined(MACOS)
#  define OS_CODE  7
#endif
```

Upstream additionally ADDED correct modern-Apple handling further down — an
`#ifdef __APPLE__ #define OS_CODE 19` clause and an `#ifndef OS_CODE #define
OS_CODE 3 /* assume Unix */` fallback — so a modern macOS build now resolves the
Unix default with no `fdopen` macro at all. There is no `TARGET_OS_MAC` and no
`fdopen` reference anywhere in the 2026 `zutil.h`. Verified 2026-07-23 by
extracting the file from the pinned `texlive-source-2026.0.tar.gz`
(pins.lock [texlive-source-2026]).

## Historical record (what the patch did, TL 2023)

Removed `|| defined(TARGET_OS_MAC)` from the `zutil.h` guard. Inside
`#if defined(MACOS) || defined(TARGET_OS_MAC)`, when `__MWERKS__` was not defined,
zlib assumed the platform had no `fdopen()` and did `#define fdopen(fd,mode) NULL`.
Because the full (non-`Z_SOLO`) zlib build also pulls in `<stdio.h>`, the system
header's real `FILE *fdopen(int, const char *)` prototype was then mangled by the
macro into a syntax error, failing the native macOS build. `TARGET_OS_MAC` is
defined to `1` on every modern Apple platform, so it was a false signal for
pre-OSX classic Mac OS (where `fdopen()` genuinely did not exist). `MACOS` (the
genuinely classic-Mac macro) was left in place. freetype's *bundled* zlib copy
(`libs/freetype2/freetype-src/src/gzip/zutil.h`) has the identical block but is
compiled with `Z_SOLO`, which guards out both the stub and the `<stdio.h>`
include, so only the standalone `libs/zlib` build was ever hit.

## Upstream-able? (moot)

Was **yes** — and upstream zlib did exactly this (dropped the `TARGET_OS_MAC`
term and the `fdopen` stub) by 1.3.2. No further action.
