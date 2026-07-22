<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE). The patched
  file (zlib) carries its own license (zlib license); this HEADER and the
  accompanying diff's *changes* are original WasmTeX work, not derived from
  any GPL/AGPL source. The diff's context lines necessarily quote small
  excerpts of the patched zlib source, which remain under the zlib license.
-->

# Patch: zlib-macos-fdopen

- **Target:** `libs/zlib/zlib-src/zutil.h` in the TeX Live 2023 source tree
  (`texlive-source-2023.0`, zlib 1.2.13). Applied with `patch -p1` from the
  staged `source/texlive/` root by `build/artifacts/build-native.sh`
  (`do_prep` → `apply_macos_patches`, idempotent). This modifies only the
  extracted TeX Live work copy at build time, never the source tree in-repo.
- **Milestone:** M0 item 5N (native arm64 macOS build).

## What

Remove `|| defined(TARGET_OS_MAC)` from the "classic Mac OS" platform guard
(zutil.h:140):

```c
-#if defined(MACOS) || defined(TARGET_OS_MAC)
+#if defined(MACOS)
 #  define OS_CODE  7
 #  ifndef Z_SOLO
 ...
 #        define fdopen(fd,mode) NULL /* No fdopen() */
```

## Why

Building the full (non-`Z_SOLO`) zlib fails on macOS:

```
zutil.h:147:33: note: expanded from macro 'fdopen'
  147 | #        define fdopen(fd,mode) NULL /* No fdopen() */
_stdio.h:322:7: note: to match this '('
... 4 warnings and 3 errors generated.
make: *** [Makefile:532: native] Error 2
```

Inside `#if defined(MACOS) || defined(TARGET_OS_MAC)`, when `__MWERKS__` is not
defined (i.e. any non-CodeWarrior compiler), zlib assumes the platform has no
`fdopen()` and does `#define fdopen(fd,mode) NULL`. Because the full zlib build
also pulls in `<stdio.h>` (not `Z_SOLO`), the system header's real
`FILE *fdopen(int, const char *)` prototype is then mangled by the macro into a
syntax error.

`TARGET_OS_MAC` is defined to `1` on every modern Apple platform (pulled in
transitively by system headers), so it is a false signal for pre-OSX classic Mac
OS — where `fdopen()` genuinely did not exist. Modern macOS is Unix and has
`fdopen()`. Removing the term makes the guard fall through to zutil.h's Unix
default (`OS_CODE 3`, `fdopen` untouched), which is correct. `MACOS` (the other,
genuinely classic-Mac macro) is left in place. Upstream busytex builds on Linux
where neither macro is defined, so this never bites there.

Note: freetype's *bundled* copy of this file
(`libs/freetype2/freetype-src/src/gzip/zutil.h`) has the identical block but is
compiled with `Z_SOLO` defined (ftgzip.c), which guards out both the `fdopen`
stub and the `<stdio.h>` include — so it is unaffected and needs no patch. Only
the standalone `libs/zlib` build (full zlib, no `Z_SOLO`) is hit.

## Upstream-able?

**Yes** — same category as the libpng fix: `TARGET_OS_MAC` is the wrong
discriminator for classic Mac OS on any post-OSX Apple toolchain. Recorded here
so `make rebase` resurfaces it if a future bundled zlib still carries the guard.
