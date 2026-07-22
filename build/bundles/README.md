# build/bundles/

tlpdb-driven tiering (`core` / `extended` / `full`) plus the Emscripten file
packager. Bundles are generated from TeX Live's own package database
(tlpdb), which yields an exact `package -> files -> bundle` mapping; each
bundle embeds its provided-package index.
