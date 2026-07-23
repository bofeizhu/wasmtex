#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Original work authored in the WasmTeX repository (see LICENSE). Not derived
# from any third-party source.
#
# Canonicalize kpathsea `ls-R` filename databases for REPRODUCIBILITY
# (M3 item 5, DESIGN.md §6.1).
# =============================================================================
# THE BUG. install-tl runs `mktexlsr`, which walks each texmf tree and writes an
# `ls-R` database listing every directory and its entries. mktexlsr records
# directory blocks AND the entries within each block in *readdir order* — the
# order the filesystem returns them — NOT sorted. A fresh docker work volume is a
# fresh ext4 filesystem with a RANDOMIZED htree hash seed (mkfs picks it), so the
# readdir order of any directory differs from one volume to the next. Two
# otherwise-identical clean builds therefore emit `ls-R` files with the same
# entries in a DIFFERENT byte order, which flows into the packed
# `texlive-basic.data` (and its file_packager `.js` metadata, SHA256SUMS, and
# assets.json) — the exact divergence build/repro-check.sh caught between two
# container builds. SOURCE_DATE_EPOCH does not touch this: it is ordering, not a
# timestamp.
#
# THE FIX (at the source, per DESIGN.md §6.1). After install-tl, rewrite each
# `ls-R` into a CANONICAL byte-order that is a pure function of the file SET, not
# of readdir order: within every directory block sort the entries, and sort the
# blocks by their directory header — all by raw bytes (= `LC_ALL=C`, locale- and
# host-independent). kpathsea reads `ls-R` into a directory->files hash and does
# not care about line order (block order or within-block order), so this is
# strictly behavior-preserving; it only removes the nondeterminism.
#
# FORMAT (matched to kpathsea's documented filename-database format — the
# `ls-R`/"Filename database" section of the kpathsea manual — cross-checked
# against the actual files mktexlsr produced in this build):
#   * A leading `% ...` comment line (preserved verbatim).
#   * Then directory blocks. A line that ends in ':' AND starts with './' or '/'
#     (a path) is a directory HEADER and sets the current directory; every
#     following non-blank line that is not itself a header is an ENTRY (a bare
#     filename) in that directory; a blank line is a separator. The path
#     requirement is kpathsea's own header rule — a hypothetical filename that
#     merely ends in ':' stays an entry instead of hijacking the block.
# The canonical output re-emits: the comment, a blank line, then each block as
# `<header>\n<sorted-unique entries…>\n\n`, blocks in sorted-header order. Empty
# blocks (a header with no entries) are preserved. The transform is IDEMPOTENT.
#
# DUPLICATE HEADERS ARE MERGED (a second nondeterminism source, subtler than
# order). install-tl's updmap writes the font-map dirs incrementally, so a single
# directory such as `./texmf-var/fonts/map/dvips/updmap:` is listed by mktexlsr
# MULTIPLE times, each occurrence carrying a DIFFERENT subset of the map files
# (the split — which file lands in which occurrence — is itself readdir/timing
# dependent). We accumulate every occurrence's entries under the one header and
# emit a single block with their sorted UNION, deduplicated — so neither the
# split, the occurrence count, nor intra-block order can perturb the bytes. This
# matches the consumer exactly: kpathsea folds all `dir:` lines for the same
# directory into one hash bucket regardless.
#
# Usage:  normalize-lsr.py <ls-R> [<ls-R> …]     (rewrites each file in place)
# The Makefile invokes it over `find <tree> -name ls-R` after install-tl.
# =============================================================================
import sys


def canonicalize(data: bytes) -> bytes:
    lines = data.split(b"\n")

    # Preserve leading comment line(s) verbatim (mktexlsr writes exactly one
    # "% ls-R -- …" line; be tolerant of more).
    i = 0
    comment = []
    while i < len(lines) and lines[i].startswith(b"%"):
        comment.append(lines[i])
        i += 1

    # Parse into records: header(bytes) -> list of entry lines. Sorting the dict
    # keys later gives canonical block order; a dict preserves first-seen headers
    # but order is irrelevant since we sort.
    records = {}
    preheader = []  # non-blank lines before the first header (never emitted by
    #                 mktexlsr; preserved verbatim so the transform is lossless).
    cur = None
    for ln in lines[i:]:
        if ln == b"":
            continue
        if ln.endswith(b":") and ln.startswith((b"./", b"/")):
            cur = ln
            records.setdefault(cur, [])
        elif cur is not None:
            records[cur].append(ln)
        else:
            preheader.append(ln)

    out = bytearray()
    for c in comment:
        out += c + b"\n"
    out += b"\n"
    for ln in preheader:
        out += ln + b"\n"
    for header in sorted(records):
        out += header + b"\n"
        # sorted UNIQUE entries: a directory holds each filename once, and the
        # union-of-occurrences may repeat one (see DUPLICATE HEADERS above).
        for entry in sorted(set(records[header])):
            out += entry + b"\n"
        out += b"\n"
    return bytes(out)


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: normalize-lsr.py <ls-R> [<ls-R> …]\n")
        return 2
    for path in argv[1:]:
        with open(path, "rb") as f:
            original = f.read()
        canonical = canonicalize(original)
        if canonical != original:
            with open(path, "wb") as f:
                f.write(canonical)
            sys.stderr.write("normalize-lsr: canonicalized %s\n" % path)
        else:
            sys.stderr.write("normalize-lsr: already canonical %s\n" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
