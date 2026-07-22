# build/toolchain/

The pinned emsdk and container definition. Their versions — the emsdk
version and the container digest — are recorded in `build/sources/pins.lock`
so the build is reproducible: the same inputs produce byte-identical
artifacts.
