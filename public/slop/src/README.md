# Slop build-shell sources

This directory contains the enhanced Slop shell, the browser-native `make`, and
the bounded command-line utilities installed with it.

`slop.c`, `make.c`, and `coreutils.c` execute child programs through the custom
`piodide.spawn` import. The bounded in-browser linker rejects unresolved custom
imports, so builds first link `spawn_stub.c`; `patch_import.py` then replaces
that exported placeholder structurally with the real import.

`coreutils.c` is a multicall binary installed under several command names.
`sed.c` and `ar.c` implement practical, bounded subsets suitable for the
browser workspace. `grep.c` is also installed as `rg` for recursive agent
search. Committed binaries live in `../bin/`; every installed C utility is
rebuilt by `npm run build:slop`.

`git.c` builds the native `/bin/git` frontend. It forwards Git CLI arguments to
the browser-hosted libgit2 Wasm engine, which shares `/home/web` directly.
`/bin/python`, `/bin/python3`, and `/bin/curl` are host marker entrypoints.
The browser curl implementation is installed as `/home/web/slop/curl-host.ts`
so its parser, Fetch boundary, limits, and file handling can be audited in the
same workspace.

Make and coreutils use spawn ABI v3. Slop uses v4, which adds stderr file and
stderr-to-stdout routing after the v3 environment fields.
