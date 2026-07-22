# build/patches/

Our patches against TeX Live sources; each carries a header explaining what,
why, and whether it is upstream-able. Patches are rebased per TL release:
`make rebase TL=2027` applies them to the new snapshot, surfacing conflicts
as the year's work list. The conformance corpus is the acceptance gate for a
rebase.
