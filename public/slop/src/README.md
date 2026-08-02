# Slop build-shell sources

This directory contains the enhanced Slop shell, the browser-native `make`, and
the bounded command-line utilities installed with it.

`slop.c` and `make.c` execute child programs through the custom
`piodide.spawn` import. The bounded in-browser linker rejects unresolved custom
imports, so builds first link `spawn_stub.c`; `patch_import.py` then replaces
that exported placeholder structurally with the real import.

`coreutils.c` is a multicall binary installed under several command names.
`sed.c` and `ar.c` implement practical, bounded subsets suitable for the
browser workspace. Committed binaries live in `../bin/`.

`/bin/python` and `/bin/python3` are marker entrypoints routed by Slop to the
page's long-lived Pyodide CPython runtime; they are not separate WASI binaries.

The spawn I/O structure uses ABI v3. Its last two fields carry the shell's
NUL-separated environment so exported variables are inherited by child WASI
programs. The first seven fields remain compatible with ABI v2.
