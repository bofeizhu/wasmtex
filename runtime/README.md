# runtime/

The `motex` npm package: a typed ESM runtime (TypeScript, ESM, `.d.ts`)
implementing the original API in DESIGN.md §5 — `createTypesetter`, job
objects with streaming logs, parsed diagnostics, engine choice, auto
bibliography/index/rerun passes, and cancellation. No DOM: it runs entirely
via `Worker` + `fetch` + `WebAssembly`.
