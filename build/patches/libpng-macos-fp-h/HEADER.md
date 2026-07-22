<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE). The patched
  file (libpng) carries its own license (libpng license); this HEADER and the
  accompanying diff's *changes* are original WasmTeX work, not derived from
  any GPL/AGPL source. The diff's context lines necessarily quote small
  excerpts of the patched libpng source, which remain under the libpng
  license.
-->

# Patch: libpng-macos-fp-h

- **Target:** `libs/libpng/libpng-src/pngpriv.h` in the TeX Live 2023 source
  tree (`texlive-source-2023.0`, libpng 1.6.39). Applied with `patch -p1` from
  the staged `source/texlive/` root by `build/artifacts/build-native.sh`
  (`do_prep` → `apply_macos_patches`, idempotent). This modifies only the
  extracted TeX Live work copy at build time, never the source tree in-repo.
- **Milestone:** M0 item 5N (native arm64 macOS build).

## What

Remove `|| defined(TARGET_OS_MAC)` from the preprocessor guard (pngpriv.h:517-518)
that selects the classic Mac OS `<fp.h>` floating-point header over the standard
`<math.h>`:

```c
-#  if (defined(__MWERKS__) && defined(macintosh)) || defined(applec) || \
-    defined(THINK_C) || defined(__SC__) || defined(TARGET_OS_MAC)
+#  if (defined(__MWERKS__) && defined(macintosh)) || defined(applec) || \
+    defined(THINK_C) || defined(__SC__)
```

With the term removed, none of the remaining classic-Mac macros are defined
under Apple clang, so the guard's `#else` branch includes `<math.h>` (correct).

## Why

On a modern macOS SDK, `TARGET_OS_MAC` is defined to `1` — it is set on *every*
Apple platform (macOS/iOS/…), pulled in transitively by system headers libpng
already includes before this point (verified: just `<stdlib.h>` is enough). It is
therefore a false signal for "classic Mac OS (pre-OSX Carbon)", which is the era
`<fp.h>` belongs to. `<fp.h>` does not exist on modern macOS, so the native TeX
Live build fails compiling every libpng translation unit:

```
pngpriv.h:524:16: fatal error: 'fp.h' file not found
  524 | #      include <fp.h>
```

Upstream busytex builds on Linux, where none of these macros are defined and the
`#else` (`<math.h>`) branch is taken — so the bug is invisible there and no
Makefile/CFLAGS knob exists to redirect it. The other guard terms (`__MWERKS__`,
`applec`, `THINK_C`, `__SC__`) are genuine classic-Mac / CodeWarrior / THINK C /
Symantec C signals and are left intact; only the modern-Apple false positive is
removed. The `#include <float.h>` above (which actually provides the
`DBL_DIG/DBL_MIN/DBL_MAX` the block's comment requires) is unchanged.

## Upstream-able?

**Yes.** Using `TARGET_OS_MAC` as a classic-Mac-OS discriminator is incorrect on
any Apple platform since Mac OS X; the standard `<math.h>` path is what current
Apple toolchains want. A libpng bug report / PR narrowing this guard (e.g. gating
on `TARGET_OS_MAC` only together with a pre-OSX signal, or dropping it) would be
appropriate. Recorded here so the TL-rebase patch-replay (`make rebase`) resurfaces
it if a future libpng still carries the guard.
