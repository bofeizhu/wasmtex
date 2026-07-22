# build/

The reproducible artifact pipeline (Docker + bash/python). Same inputs
produce byte-identical artifacts: everything is pinned in
`build/sources/pins.lock`, and CI runs the full build twice and fails on any
artifact-hash mismatch. `SOURCE_DATE_EPOCH` and stable file ordering in
archives are mandatory.
