# build/engines/

Per-program builds linked into one combined multicall WASM binary. It
carries `xetex`, `pdftex`, `luahbtex`, `bibtex8`, `xdvipdfmx`, `makeindex`,
and `kpsewhich`, dispatched by `argv[0]` (the upstream busytex technique).
