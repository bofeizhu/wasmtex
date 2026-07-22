<!--
  SPDX-License-Identifier: MIT
  Original work authored in the WasmTeX repository (see LICENSE).
-->

# build/engines/ — WasmTeX engine build config (ours)

Per-program builds linked into one combined multicall WebAssembly binary. The
binary carries `xetex`, `pdftex`, `bibtex8`, `xdvipdfmx`, `makeindex`, and
`kpsewhich`, dispatched by `argv[0]` (the multicall technique originated by
busytex). This directory is **our maintained build config**, not a vendored
mirror.

## Provenance (DESIGN.md §2.1)

The config was **forked from busytex/busytex** (MIT, pinned commit
`f2bd7b11ee1b7b093638321c1f3e5d70389d307b` in `build/sources/pins.lock`
`[busytex]`) at the TL-2026 rebase (M2 item 3), when the M0 staging area
`build/upstream/` was dissolved. From that point this config is maintained
here and is no longer a faithful mirror of the pin.

Each file carries its own header — either **derived-from-busytex** (naming the
commit, with the substantive modifications listed) or **original WasmTeX work**:

| File | Header | Notes |
| --- | --- | --- |
| `Makefile` | derived-from-busytex | LuaTeX / bench / Ubuntu / example / Cosmopolitan paths dropped; `OPTS_LIBS_wasm` folded in; format set trimmed to the non-lua retained set. |
| `busytex.c` | derived-from-busytex | multicall dispatcher; lua applet entries dropped. |
| `emcc_wrapper.py` | derived-from-busytex (body unmodified) | `EM_COMPILER_WRAPPER` shim reused verbatim by the Makefile's `CCSKIP_*_wasm` vars. |
| `README.md` | original WasmTeX | this file. |

The `build/audit/license-audit.sh` (a)/(b) checks enforce that every file here
carries one of those two header kinds, and that a derived-from-busytex header
names the pinned commit — the **headers are the provenance record**; there is no
separate `PROVENANCE.md` manifest anymore.

## What is built, and what was dropped at the fork

**Kept (DESIGN.md §3 program set):** `xetex`, `pdftex`, `bibtex8`,
`xdvipdfmx`, `makeindex`, `kpsewhich`, plus the `texlive-basic` install +
`.fmt` dump + file_packager bundle path.

**Dropped at M2 item 3** (the annual-rebase surface shrink is a deliverable
metric — see `docs/plans/M2-journal.md`):

- **LuaTeX** end to end — `luahbtex`/`luatex` objects, the `lua53` link dep,
  the LuaTeX symbol-redefine machinery, the `busytex_libluahbtex.a` and `lua53`
  targets, and the lua wrappers/format rename/prune (DESIGN.md §9 amendment:
  LuaTeX exits v1 and the rebase surface).
- **The bench / native-fat path** — `busytexextra` + `packfs.c`/`packfs.py`
  (no longer forked), `dist-native-full`, `download-native`.
- **The rolling-Ubuntu-`.deb` bundle path** — `ubuntu_package_preload.py`,
  `build/wasm/ubuntu/%.js`, `ubuntu-wasm`, `TEXMFFULL`, `URL_ubuntu_*`.
- **Cosmopolitan accommodations** — `cosmo_getpass.h` (no longer forked) and
  its inject into `dvipdfm-x/dvipdfmx.c` (the header was `#ifdef
  __COSMOPOLITAN__`, a no-op on our native/wasm targets).
- **The `example/` asset target** and the `texlive-extra` / `texlive-full`
  install profiles (only the `texlive-basic` bundle path is kept).

## Retained format set

The `.fmt` dump/prune keeps exactly **`xetex/xelatex.fmt`** and
**`pdftex/pdflatex.fmt`** — what the runtime `FORMAT_*` constants
(`runtime/worker/core.ts`) and the conformance corpus actually use. Every other
dumped format (including the unused plain `tex/tex.fmt`, and any lua format that
might leak in via a dependency) is pruned.

## How it is driven

`build/artifacts/build-native.sh` (the active native dev flow) syncs these files
into an out-of-tree work sandbox and runs `make` there, applying host-specific
macOS overrides (Apple-ld frameworks, cmake policy floor, offline URL blanks).
The parked container flow (`build/artifacts/build.sh` +
`run-in-container.sh`) is re-pointed at this directory when it is re-pinned at
M3 (DESIGN.md §9). See `build/artifacts/README.md`.
