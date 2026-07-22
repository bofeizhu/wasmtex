# build/engines/

Per-program builds linked into one combined multicall WASM binary. It
carries `xetex`, `pdftex`, `bibtex8`, `xdvipdfmx`, `makeindex`, and
`kpsewhich`, dispatched by `argv[0]` (the upstream busytex technique).
(`luahbtex` is M0-baseline only — dropped from v1 scope 2026-07-22; it
exits the build at the M2 rebase, which is when this directory
materializes. See DESIGN.md §3/§9.)
