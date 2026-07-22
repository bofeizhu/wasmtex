# build/sources/

Fetches and verifies the TeX Live snapshot and its dependencies. `pins.lock`
records everything the build pins: the TeX Live snapshot id (a dated
historic-archive snapshot, never "latest"), dependency tarball hashes, the
emsdk version, and the container digest.
