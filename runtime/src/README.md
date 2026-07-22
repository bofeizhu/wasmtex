# runtime/src/

The runtime library source implementing the DESIGN.md §5 API:
`createTypesetter` and the `Typesetter`, `typeset()` job objects with
`done` / `onLog` / `cancel`, engine sequencing (§5.3), bundle resolution
with the missing-file retry (§5.4), and the tested diagnostics parser. No
hidden persistence — correctness assumes a cold, storage-less context.
