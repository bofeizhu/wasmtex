# build/manifest/

Generates `manifest.json`, the top-level integrity manifest: the TeX Live
snapshot id, the engine list, per-file `{ bytes, sha256 }`, and a per-bundle
provided-package index. Hosts verify installs against it instead of trusting
the tarball.
