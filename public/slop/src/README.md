# Slop build-shell sources

This directory contains the enhanced Slop shell, the browser-native `make`, and
the bounded command-line utilities installed with it.

`slop.c`, `make.c`, and `coreutils.c` execute child programs through the custom
`piodide.spawn` import. The bounded in-browser linker rejects unresolved custom
imports, so builds first link `spawn_stub.c`; `patch_import.py` then replaces
that exported placeholder structurally with the real import.

`coreutils.c` is a multicall binary installed under several command names.
`sed.c` and `ar.c` implement practical, bounded subsets suitable for the
browser workspace. Committed binaries live in `../bin/`.

`/bin/python` and `/bin/python3` are marker entrypoints routed by Slop to the
page's long-lived Pyodide CPython runtime; they are not separate WASI binaries.

Make and coreutils use spawn ABI v3. Slop uses v4, which adds stderr file and
stderr-to-stdout routing after the v3 environment fields.
