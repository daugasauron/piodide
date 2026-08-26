# Agent tools

[← README](../README.md)

All tools operate inside the browser and share `/home/web`.

Browser prompt commands such as `/model`, `/thinking`, and `/demo` are UI
handlers, not agent tools or Slop paths. The agent system message identifies the
selected provider, model, and transport so backend-dependent behavior is still
observable without exposing credentials.

| Tool | Purpose |
| --- | --- |
| `python` | Long-lived Pyodide CPython |
| `read`, `write`, `edit` | Bounded text-file operations |
| `slop` | Shell command/pipeline with Git, curl, and separate stdout/stderr |
| `compile_c`, `link_wasi`, `run_wasi` | Build and run wasm32-wasi programs |
| `compile_raylib`, `raylib` | Build and open C games in a canvas framebuffer |
| `git` | Canonical Git repositories; smart HTTP or bounded GitHub fallback |
| `fetch` | Browser fetch, subject to CORS |
| `download` | Export a file after the user asks |
| `image` | Render PNG, JPEG, GIF, or WebP in the terminal |
| `html_debug` | Check HTML errors in a hidden sandbox |
| `html` | Open a sandboxed, full-screen HTML preview |

| Image output | HTML preview |
| --- | --- |
| ![A Matplotlib image rendered in the terminal](../screens/in-terminal-pictures.png) | ![An interactive HTML preview](../screens/html-tool.png) |

## Python packages

Pyodide has no native `pip` process. Install compatible packages with:

```python
import micropip
await micropip.install("package")
```

Use `/upload` to import host files; it must be initiated by the user.

Slop's host-backed `python` preserves stdout and stderr as exact bytes through
redirects, descriptor duplication, and pipelines, including NUL and output not
terminated by a newline. Both streams flush within the producing invocation and
are limited to 16 MiB each; an over-limit producer returns status 2 after the
bounded prefix. Shell capture remains limited to 1 MiB. Command substitution
rejects NUL with status 2 before changing an assignment, because shell variables
are text; use a file or NUL-safe pipeline instead. `python --help` exposes these
effective stream rules.

## Agent-facing command contract

The shell is a capability-oriented API, not a claim of full POSIX. Agents need
discoverable commands, pipelines and redirects, stable status codes and byte
formats, literal path scoping, and validation before mutation more than they
need job control, native processes, or every historical compatibility flag.
`help BUILTIN`, `COMMAND --help`, and `git help COMMAND` are authoritative for
the accepted subsets. Unsupported or malformed shapes fail explicitly—normally
with status 2—rather than being ignored or approximated. Destructive commands
derive preview and action from the same bounded candidate set.

The exact shell redirect path `/dev/null` is a virtual EOF source and
incremental output sink for builtins and spawned commands. Quiet probes such as
`command -v git >/dev/null` preserve the command's real status without creating
a workspace node; descriptor duplication retains normal left-to-right order.
Other normalized `/dev/*` redirect targets fail before command execution.

This contract is deliberately extended when a common agent workflow is missing,
especially for machine-readable inspection, exact file selection, recovery, or
safe automation. Python remains the escape hatch for transformations such as
JSON, tables, and archives that do not benefit from another partial CLI clone.
Shell wrappers can safely accumulate an exact argv using
`set -- [ARG...]`; it atomically replaces the current script, function, or
sourced-file positional vector, and bare `set --` clears it. Quoted `"$@"`,
`$#`, numbered parameters, and `shift` observe the new vector. The request is
preflighted at 100 arguments, 4,096 bytes each, and 65,536 aggregate
bytes, and cannot be combined with option changes. This provides structured
argument forwarding without adding arrays, word splitting, or general POSIX
`set` syntax.
Run one child without leaking selected caller variables through
`env [-i] [-u NAME]... [--] COMMAND [ARG...]`. Bare `env` still prints the
current environment. Launcher `-i` supplies an exact empty snapshot and adds no
synthetic `PATH`, `PWD`, `TERM`, or internal marker; otherwise the immutable
caller snapshot is copied and every exact `-u` name is removed. The caller is
never changed, even when lookup or the child fails. Names are case-sensitive
ASCII identifiers of at most 255 bytes; duplicate and absent removals succeed.
The command preflights 60 removals, 64 child argv entries, 126 total words after
`env`, 4,096 bytes per word, 65,536 argument bytes, 1,024 environment entries,
65,535 bytes per encoded entry, and 1 MiB of encoded environment. Child streams
and statuses 0..125 pass through; 126 is cannot-launch, 127 is not found, and
invalid/bounded requests return 2 without starting a child. A dash-leading
command needs `--`. Additions and overrides remain shell-prefix assignments;
GNU assignment operands, default PATH injection, chdir, split-string, argv0,
signal/debug controls, wildcard removals, and NUL listing are deliberately
absent.
Temporary Git settings can be removed without text-editing config files using
`git config [--global|--local] --unset NAME`. Local storage is the default;
status 0 proves exactly one selected stored value was removed, while status 5
means no match or ambiguous multiple values and makes no change. Config option
shapes validate before repository discovery. Global operations use
`$HOME/.gitconfig`; `HOME` must be absolute and remain inside `/home/web`, and
defaults to `/home/web` when absent. Unset bounds the key at 4,096
bytes, the selected file at 1 MiB, and parsed entries at 100,000. The rewrite
removes only the matching setting line and preserves unrelated bytes.
Browser-native `make` uses the full subsecond filesystem timestamp exposed by
the runtime. A normal
prerequisite with an mtime equal to its target is conservatively stale, because
an immediate agent edit and prior build output can share one browser timestamp
tick. Normal builds, `make -q`, and automatic `$?` use this same comparison;
order-only prerequisites are excluded from freshness and `$?`. Touch mode
advances an existing target timestamp without changing its bytes. This
intentionally permits an extra build rather than returning status 0 for stale
output, without adding a watch mode, content cache, or broader Make dialect.
Filesystem mutation uses the same validate-before-action principle. In
particular, `cp [-r|-R] [-f|-n] [--] SOURCE... DEST` resolves every recursive
source root and effective target physically before copying anything. It rejects
a target equal to or below its source, including normalized and symlink-aliased
paths, with status 1 and the path-independent diagnostic
`cp: recursive destination is within source`. All roots preflight before the
first write, so a later unsafe or missing source cannot leave an earlier copy.
Bounds are 100 sources, 4,096 encoded bytes per path, 65,536 aggregate path
bytes, 128 normalized components per operand, and 40 link resolutions.
Deletion uses `rm [-f] [-r|-R] [--] PATH...`; compact `-rf` and `-fr` are
accepted. Slop resolves every operand and recursively scans every selected
directory before removing the first entry. A later missing path, a directory
without `-r`, a loop or path limit, or a traversal/depth/entry bound therefore
leaves all selected paths unchanged. Missing operands are ignored only with
`-f`. Duplicate and ancestor/descendant selections are removed once, final
symlinks are unlinked rather than followed, and intermediate symlinks resolve
physically. `.`/`..` operands and physical root are refused. Limits are 100
operands, 4,096 bytes per path, 65,536 aggregate path bytes, 128 normalized
components, 40 link resolutions, 128 recursive levels, and 100,000
scanned/planned entries. Invocation and limit failures return 2; deterministic
filesystem failures return 1. A race or I/O failure during the validated
commit can still follow earlier removals and is not rolled back.
Batch moves use the parallel bounded form
`mv [-f|-n|--force|--no-clobber] [--] SOURCE... DEST`. With multiple sources,
the destination must already resolve physically to a directory. Slop computes
every `DEST/basename(SOURCE)` target before mutation and rejects missing roots,
self/descendant moves, duplicate targets, overlapping operands, and incompatible
root types invocation-wide. `-f` and `-n` are ordered, `-n` skips each existing
target without removing its source, and successful moves emit no output.
Symlink entries are moved as links, including during a directory merge. Limits
match `cp`: 100 sources, 4,096 encoded bytes per path, 65,536 aggregate path
bytes, 128 normalized components, and 40 link resolutions. Runtime failures
after the first rename stop the batch but do not roll back completed moves.
Directory plans use `mkdir [-p] [--] DIRECTORY...`; options must precede
operands, and `--` permits option-looking names. Before the first creation, the
complete request is simulated in operand order against both the physical
filesystem and directories planned by earlier operands. Thus plain
`mkdir a a/b` works, while the reversed order, a duplicate without `-p`, an
existing final entry, a missing parent, or a non-directory component rejects
the whole batch. With `-p`, missing components are planned, duplicates and
existing directories are accepted, and a final symlink succeeds only when it
physically resolves to a directory. Parent links and `..` are traversed in
filesystem order through at most 40 links, so a dangling link cannot be
bypassed lexically. Limits are 100 operands, 4,096 bytes per path, 65,536
aggregate path bytes, 128 normalized components per operand, and 1,024 planned
creations; invocation and limit errors return 2, while deterministic path
errors return 1. Races or storage failures after a validated plan begins may
leave its already-created prefix and are not rolled back.
Empty-directory removal uses `rmdir [--] DIRECTORY...`. The complete request
is resolved and simulated in operand order before mutation, so `child parent`
can remove an emptied parent while `parent child`, a duplicate, a later
missing/nonempty/non-directory operand, a final symlink, or a path-resolution
failure leaves every selected directory unchanged. Intermediate links resolve
physically through at most 40 traversals; `.`/`..` operands and physical root
are refused. Limits are 100 operands, 4,096 bytes per path, 65,536 aggregate
path bytes, and 128 normalized components. Invocation and limit failures
return 2; deterministic filesystem failures return 1. If an unexpected removal
fails after the validated commit starts, earlier empty removals are recreated
in reverse order; concurrent external mutation remains outside the contract.
Bounded logical-size inspection uses `du -a -d DEPTH [--] PATH...`. Both `-a`
and separated `-d` are required, may appear in either initial order, and an
option-looking path requires `--`. `DEPTH` is decimal 0..128 and controls rows,
not aggregation: a directory row always includes every descendant regular
file reached by the complete scan. Regular entries contribute their payload
length, while symlinks are never followed and contribute zero; portable block
allocation and metadata accounting are deliberately absent. Entries are
visited in bytewise lexical order and emitted postorder as decimal bytes, a
tab, the lexical path, and newline. Overlapping operands are independent. The
entire invocation is scanned and its output staged before the first byte is
written, so a missing path, traversal/overflow failure, or bound violation
does not expose partial totals. Limits are 64 operands, 4,096 bytes per path,
65,536 operand bytes, 128 traversal levels, 100,000 entries/records, and 16 MiB
of output. Syntax and operand-limit failures return 2; scan or output failures
return 1. Output delivery itself can still fail after a prefix reaches stdout.
Path planning can use
`realpath [-e|--canonicalize-existing|-m|--canonicalize-missing]
[-P|--physical] [--] PATH...`. Default and `-e` mode require every path to
exist, resolve components and links physically, and preserve their historical
per-operand streaming behavior. `-m` instead permits an arbitrary missing
suffix after a physically resolved existing prefix. A dangling link begins
that lexical suffix, while later `.` and `..` components still normalize; a
missing final slash is accepted and removed, but a slash after an existing
non-directory fails. All `-m` operands are resolved and bounded before stdout,
so a later non-directory traversal, link loop, or limit failure publishes no
partial plan. Options are initial only and `--` permits option-looking paths.
`-e` and `-m` are mutually exclusive. Missing mode accepts 1..100 operands,
at most 4,096 bytes in each input and result, 256 processed components, and 40
link resolutions. Invocation and operand-count errors return 2; resolution and
resource errors return 1. Existing/default mode retains the resolver's 64 KiB
internal path bound and may emit earlier successful operands before a later
failure.
Bounded discovery and cleanup use
`find [PATH...] [-mindepth N] [-maxdepth N] [-name GLOB] [-path GLOB]
[-type f|d|l] [-print|-print0|-delete]`. With no explicit action, matching
paths print one per line. An explicit action must be the final expression and
only one is accepted; `-print0` emits raw NUL-terminated paths, while `-delete`
is silent. The complete expression is parsed before traversal, so missing
filter arguments, unknown expressions, a non-final action, or mixed actions
return status 2 without mutation. Deletion walks directories postorder,
removes matched regular files and symlinks directly, and never follows a
symlink target. A matched directory is removed only after its visited
children, so unmatched contents or `-maxdepth` can leave it nonempty and cause
status 1. Unexpected filesystem errors can occur after earlier matches were
already removed and are not rolled back. At most 100 starting paths, 128
levels, and 100,000 visited entries are accepted across one invocation.
Temporary artifacts use
`mktemp [-d] [-t] [-dt|-td] [--] [TEMPLATE.XXXXXX]`. The optional flags must
precede the template; compact `-dt` and `-td` create a directory beneath
`TMPDIR`. At most one template is accepted, and its final component must
contain a run of six `X` bytes; exactly six are replaced. With `-t`, the
template is one component and nonempty `TMPDIR` is used, falling back to
`/tmp` when unset or empty. Relative, absolute, and symlinked existing
directory values are accepted. The parent is resolved physically through at
most 40 links before creation, while stdout preserves the lexical path agents
can pass back to the shell. The final component is limited to 1,024 bytes and
the full path to 4,096 bytes and 128 normalized components. Syntax and limit
failures return 2 before creation; parent, collision-exhaustion, and I/O
failures return 1. Creation is exclusive and tries at most 128 candidates.
Success emits exactly one newline-terminated path. A race may rename/remove the
artifact afterward, and an output failure may occur after creation without
rolling it back. WASI has no creation-mode field, so the Pyodide host manages
the visible mode (typically `0644` for a file and `0755` for a directory);
exclusive naming is guaranteed, but Unix `0600`/`0700` permissions are not.
Multi-file timestamp updates use `touch [-c] [--] FILE...`; options precede
operands and an option-looking path requires `--`. Before mutation it resolves
every operand through at most 40 links and accepts only physical
regular-file targets or a missing final leaf under an existing parent; `-c`
skips that leaf. Deterministic failures return 1 without touching any operand,
while malformed requests and the 100-operand, 4,096-byte path, 65,536-byte
aggregate, or 128-component limits return 2. Unexpected runtime failures stop
the batch without a rollback guarantee.
Build scripts can use `install [--] SOURCE... DEST` for regular files or
`install -d [--] DIRECTORY...` for parent creation. Options must precede
operands. Copy mode resolves source symlinks to regular files and destination
parent symlinks physically, but rejects a final destination symlink instead of
writing through it. Every source and effective target is checked before the
first write; missing or non-regular sources, a non-directory multi-source
destination, self-copies, and duplicate basename targets return status 1 with
no mutation. Directory mode likewise validates every requested path before
creating the first component. Both forms accept at most 100 sources or
directories and use the `cp` path bounds: 4,096 bytes per operand, 65,536 bytes
aggregate, 128 normalized components, and 40 link resolutions. Metadata flags
remain unavailable with status 2. An unexpected runtime I/O failure stops the
validated batch without rolling back an earlier completed copy or directory.
Symbolic-link creation is the explicit bounded form
`ln -s [-f] [--] TARGET LINK`; `-sf` and `-fs` are equivalent, and options are
recognized only in the initial prefix. A dash-leading target therefore needs
`--`, while the second operand is always the link name. Hard links are not a
portable browser-workspace capability and fail with status 2 before inspecting
or removing `LINK`. The link's existing physical parent is resolved through at
most 40 symlinks before `..` is applied, so a dangling or looping component
cannot be bypassed lexically. Without `-f`, an existing entry fails untouched; with `-f`,
only a regular file or symlink directory entry may be replaced, never a
directory or symlink referent. Both path operands are limited to 4,096 bytes
and the link path to 128 normalized components. Syntax, unsupported mode, and
limit failures return 2; deterministic path failures return 1. Once a valid
forced replacement begins, an unforeseen unlink/symlink race or I/O failure
may still leave the old entry removed; no rollback is promised.
NUL-safe candidate streams can be prefix-bounded with
`head -z|--zero-terminated [-n N|-nN] [--] [FILE...]`. It emits the first ten
records per input by default or 0..100,000 explicitly, preserving raw bytes,
NUL terminators, and a final nonempty unterminated record. Inputs are
concatenated without headers; a failing input emits no partial bytes, although
completed earlier operands remain. Independent bounds are 100 named inputs,
1 MiB per record including NUL, 16 MiB examined/emitted per input, and 64 MiB
per invocation. Byte mode, signed counts, suffix multipliers, and alternate
record delimiters remain outside zero mode.
Structured byte records can be ordered with
`sort [-rznu] [-k KEY|-kKEY|--key KEY|--key=KEY]
[-t BYTE|-tBYTE|--field-separator=BYTE] [--] [FILE]`. The optional separator
is one non-NUL byte distinct from the active LF/NUL record terminator; adjacent
or edge separators create empty fields and a missing field is empty. Fields
are 1..1,000; `KEY` is `N[n]` or equal `N,N[n]`, and separated, compact, and
long spellings are equivalent. Numeric parsing is confined to the selected slice, key ties use
the complete raw record, and `-u` removes only byte-identical records. The
command preserves opaque LF or NUL records, prevalidates before stdout, and
uses the existing 16 MiB input, 100,000-record, and 1 MiB-record limits.
Raw artifact suffixes can use `tail -c BYTES [--] [FILE|-]`, with compact
`-cN` also accepted. Counts are unsigned decimal through 16 MiB, output is
byte-exact with no inserted newline, and a bounded circular buffer defers
stdout until the complete input has been read successfully. Signed offsets,
multipliers, multiple-file headers, and follow mode remain outside the API;
use a path for inputs above the shell pipeline's 1 MiB staging limit.
Exact artifact checks can use `cmp [-s] [--] FILE1 FILE2`. It compares raw
bytes, permits at most one stdin operand, rejects missing or extra operands,
and preserves a strict status contract: 0 equal, 1 different, 2 invalid or
I/O failure. Normal mode reports the first one-based byte/line mismatch only
after both streams validate through EOF; `-s` suppresses both output streams
for every outcome. Full listing, skip, and byte-rendering modes remain outside
the API because `xxd` and Python cover those inspection workflows.
Canonical SHA-256 manifests can use
`sha256sum -c|--check [--] [MANIFEST]`; an omitted manifest or `-` reads stdin.
The complete manifest is validated before any target opens, then targets stream
through the existing hasher. Ordinary records use 64 hexadecimal bytes,
`  ` or ` *`, and a nonempty literal path. A filename containing LF or
backslash produces a marked record with a leading backslash; its path encodes
LF as `\n` and backslash as `\\`. Check mode decodes only those escapes in
marked records, leaving old unmarked backslash paths literal. Check-result and
path-error lines use the same rendering, so every logical result remains one
line. Carriage return and other non-NUL bytes remain literal; decoded path `-`
is invalid. Relative targets resolve from the command cwd. Manifests are
limited to 1 MiB, 4,096 records, and 4,096 encoded bytes per record; hash mode
does not emit a record above the same per-record bound. Status 0 means every
file matched, 1 means a digest, read, or output-record failure, and 2 means
invalid argv, manifest, bounds, or command I/O; malformed manifests emit no
target results.
For patch-sized reviews, bounded `git diff` and `git show` accept the standard
`-U`/`--unified` context spellings with a decimal range of 0 through 1,000;
the bundled native diff engine remains responsible for hunk formation.
Apply or selectively undo a generated patch with
`git apply [--cached] [-R|--reverse] [--check] [--] [PATCH|-]`. Omitted input
and `-` read stdin. One reverse flag exchanges the old/new paths and ranges, `+`/`-` hunk
lines, creations/deletions, and exact rename direction; context and
no-final-newline markers remain exact. This removes only the supplied change
and can preserve unrelated bytes outside its exact hunks. `--check` executes
the identical complete parse/applicability plan without writing. With
`--cached`, preimages come from the current index and one private scratch index
is swapped into place only after every blob and bound validates; HEAD and all
worktree bytes, including unrelated edits and untracked paths, remain untouched.
Status 0 is applicable/applied, 1 is a valid patch that does not fit the selected worktree or index,
and 2 is invalid syntax/structure/path/bounds or repository/input/I/O failure;
stdout is empty. Limits are one
8 MiB UTF-8 patch, 100 sections, 10,000 hunks, 100,000 total lines, 4,096 bytes
per target path, 16 MiB per current/result file, and 64 MiB aggregate
source/result; cached mode additionally caps the current/result index at 100,000
entries and 16 MiB. Expected failures do not mutate the selected layer or any
worktree path. Binary, symlink,
mode-only, combined, three-way, fuzzy, reject-file, and prefix remapping remain
outside the API.
To make ordinary `git diff` review a new file without staging its bytes, use
`git add (-N|--intent-to-add) [--] PATH...`. Operands are literal exact files
or directory prefixes resolved from the command cwd; tracked matches are
unchanged, while selected ordinary-untracked regular files and final symlinks
receive a canonical empty-blob stage-0 entry with Git's real intent-to-add
flag. The index is serialized as version 3 only while an intent flag exists;
the compatibility layer presents version 2 to index consumers that do not
understand extended flags and restores the flags on their writes. Status shows
an existing intent entry as ` A` (or ` D` after its worktree leaf disappears),
ordinary diff compares the empty placeholder with the worktree, cached diff
and its projections omit the placeholder, and commit never records it. A later
ordinary add stages the actual bytes; reset or cached rm removes the entry, and
mv transfers its marker.

The complete selector/candidate plan is checked against ignores and file types,
built in a private scratch index, revalidated against the worktree, then
published in one index write. A missing or ignored selector fails the whole
request. Status 0 is silent success, 1 covers repository/index/worktree,
missing/ignored, concurrency, or publication failures, and 2 covers grammar,
path/type, or limit failures. Limits are 100 operands, 4,096 UTF-8 bytes per
path, 65,536 aggregate operand bytes, depth 128, 100,000 candidates/result
entries, and a 16 MiB index. Force, dry-run, interactive/patch modes, pathspec
magic, submodules, unmerged entries, and special files remain outside this
bounded surface.
For bounded two-layer recovery use
`git restore [-s|--source REF] [-S|--staged] [-W|--worktree] [--] PATH...`.
Each operand is a literal cwd-relative exact tracked file or directory prefix;
`--` protects leading-dash names. With no layer flag, worktree bytes come from
the index. Staged recovery defaults to `HEAD`, and an explicit source supplies
every requested layer. Staged-only recovery never touches worktree bytes;
worktree-only recovery never changes the index. HEAD, refs, and unselected
paths remain unchanged, including for tracked additions and deletions, final
symlinks, and executable modes.

Restore resolves and validates the complete source and selector expansion,
checks index/worktree topology and types, reads bounded source blobs and
rollback snapshots, and constructs any resulting index in a private scratch
directory before mutation. Worktree leaves are revalidated and changed under
rollback; the canonical index publishes last. A worktree fault restores every
selected byte/type, while an index-publication fault restores both layers.
Success is silent status 0; repository/ref/object/index/worktree, no-match,
collision, concurrency, publication, or rollback failures return 1; grammar,
encoding, type, and bound failures return 2. Limits are 100 paths, 4,096 UTF-8
bytes per path, 65,536 aggregate path bytes, depth 128, 100,000 expanded/result
entries, a 16 MiB index, 16 MiB per source/rollback file, and 64 MiB aggregate
source or rollback bytes. Pathspec magic, interactive conflict selection,
submodules, special files, and replacing nonempty untracked directories remain
unavailable.
To unstage literal files or whole directories without touching worktree bytes,
use `git reset [--mixed] [COMMIT] -- PATH...`. Operands resolve literally from
the command cwd, and absolute operands must remain in the worktree. Directories select all
tracked descendants and never become index entries themselves; exact files,
deletions, additions, and file/directory transitions reproduce the selected
source subtree in the index. A valid no-match selection is a silent status-0
no-op. The complete source/current/result plan and selected source objects are
validated before updates are applied to a private scratch index, followed by
one canonical index write. Failures preserve the original serialized index and
worktree. Limits are 100 operands, 4,096 UTF-8 bytes each, 65,536 operand bytes,
100,000 source/current/result entries, and a 16 MiB input/result index. Status 1
is reserved for repository, object, index, or write failures; malformed syntax,
bad revisions or paths, and bound violations return 2. Interactive reset,
pathspec magic, submodules, and path forms with `--soft` or `--hard` are outside
the bounded API. Whole-tree and path reset commit operands accept refs, object
IDs, and ancestry expressions such as `HEAD^` and `HEAD~2`, bounded to 4,096
UTF-8 bytes and validated as commits before mutation.
To remove clean tracked paths from both the index and worktree, use
`git rm [-r] [--] PATH...`. Every literal cwd-relative selector must match;
`-r` selects tracked descendants of a directory prefix, with duplicate and
overlapping matches deduplicated. Each selected stage-0 entry must match both
HEAD and its current worktree mode and bytes. Final symlinks are unlinked,
intermediate symlink ancestry is refused, and untracked or ignored files are
never selected; selected directories are removed only when empty afterward.
The command builds a complete private scratch index and bounded worktree
snapshot before deletion, revalidates each path, and publishes the index only
after the worktree succeeds. A synchronous runtime failure triggers best-effort
restoration of removed files, symlinks, modes, directories, and the original
index. Success reports deterministic cwd-relative, Git-quoted `rm PATH` lines.
Browser-process crash and concurrent filesystem mutation are not transactional.

To stop tracking without changing HEAD or any worktree byte, add `--cached`.
Cached mode permits a selected entry when its mode/content matches either HEAD
or the worktree. This keeps modified worktrees when the index still matches HEAD
and permits newly staged files when the worktree retains the staged copy, while
refusing to discard the only reference to unique staged content. Both modes
refuse unmerged indexes, submodules, `-f`, implicit `.`, and glob/pathspec magic.
All selectors, index entries, content comparisons, the index lock, and the
complete scratch-index result validate before mutation. Status 0 means removed;
repository/index/content-safety/runtime failures return 1, while grammar,
unmatched selectors, paths, and bounds return 2 without planned mutation.
Limits are 100 selectors, 4,096 UTF-8 bytes per path, 65,536 selector bytes,
depth 128, 100,000 index/removal entries, a 16 MiB input/result index, 16 MiB
per compared or snapshotted worktree file, 64 MiB aggregate worktree bytes,
and 8 MiB output in non-cached mode.
For a tracked rename that preserves distinct index and worktree layers, use
`git mv [--] SOURCE DESTINATION`. Both paths are literal and cwd-relative;
the destination is a new exact path, never destination-directory shorthand.
A file or final symlink must be a stage-0 entry. A directory must contain at
least one tracked descendant: its entire current worktree tree, including
untracked descendants, moves as one filesystem object, while only existing
tracked index keys are remapped. Every remapped entry retains its exact object
ID, mode, and staged content, so an unstaged edit or a separately staged version
is not collapsed into the other layer. HEAD never changes.

The source and destination topology, every current/result index path, source
scan, absent destination in both index and worktree, index lock, and complete
private scratch index validate before the worktree rename. The index is
published afterward; an index failure renames the worktree back and restores
the original serialized index, with an explicit rollback-failure diagnostic if
that recovery itself fails. Intermediate symlink ancestry, unmerged entries,
submodules, force/overwrite, multiple sources, moving into an existing
directory, pathspec magic, and rename detection are unavailable. Success is
silent status 0; repository/index/collision/runtime failures return 1, and
grammar/path/bound failures return 2. Limits are two paths, 4,096 UTF-8 bytes
per path, 8,192 operand bytes, depth 128, 100,000 scanned/index entries, and a
16 MiB input/result index. Concurrent external mutation and browser-process
crash remain outside the transactional guarantee.
`git tag (-d|--delete) [--] NAME...` removes one through 100 exact local
tags as one bounded request. Names are literal short tag names, not revisions,
patterns, or `refs/tags/...` spellings; `--` protects a valid leading dash.
The command rejects duplicates, validates the complete loose/packed ref
namespace, captures each unpeeled object ID, and stages deterministic
operand-order `Deleted tag NAME (was 7-HEX)` lines before mutation. Packed refs
publish through their lock file, loose refs are revalidated before unlink, and
a synchronous failure restores every captured ref or reports an explicit
rollback failure. HEAD, branches, objects, index, worktree, remotes, and tag
peeling remain unchanged. Status 0 means every tag was deleted, 1 covers a
missing tag or repository/ref/runtime/rollback failure, and 2 covers invocation,
name, duplicate, or bound rejection; nonzero requests publish no success lines.
Limits are 4,096 UTF-8 bytes per name, 65,536 aggregate name bytes, depth 128,
100,000 scanned ref entries, 16 MiB of packed refs, 4,096 bytes per selected
loose ref, and 1 MiB of staged output. Remote deletion, wildcards, reflog policy,
force modes, and broader upstream tag syntax are unavailable.
For an exact cleanup plan use
`git clean [-n|--dry-run] [-f|--force] [-d] [-z|--null]
[-X|--ignored-only] [-- PATH...]`.
Preview wins when both preview and force are present. Human mode retains
`Would remove`/`Removing` lines; null mode emits only each deterministic
repository-relative candidate path followed by NUL, so tabs and newlines are
unambiguous and the preview can be consumed by another bounded tool. The
complete selectors, traversal, candidate list, and selected output projection
are validated before stdout or deletion. Ordinary mode protects tracked,
staged, ignored, out-of-scope, and empty directory trees; `-d` opts into
eligible nonempty ordinary-untracked trees. `-X` instead selects only ignored
untracked leaves, including final symlinks without following them. With `-d`,
it also selects an ignored directory only when every extant descendant is
selected, including truly empty ignored directories; ordinary, re-included,
tracked, or staged content blocks directory removal. Compact `-nXdz`/`-fXdz`
forms are accepted, while broad `-x` remains unavailable. Status 0 is a
completed preview/action, 1 is a repository/traversal/preflight/deletion
failure, and 2 is invalid grammar, selector encoding, or selector bounds. An
ignored-only runtime deletion failure can follow earlier bottom-up removals;
its stdout is the successful plan prefix and stderr safely quotes the failing
path. Limits are 100 selectors, 4,096 UTF-8 bytes per selector/candidate path,
65,536 selector bytes, depth 128, 100,000 scanned entries/candidates, and 8 MiB
selected output.
Status automation can use `git status [-s|--short] [-b|--branch] [-sbz]
[--porcelain[=v1]] [-z] [-uno|-unormal|-uall] [--] [PATH...]` (with equivalent
`--untracked-files=no|normal|all` spellings). Option parsing stops exactly at
`--`, including for names such as `--short` and `-z`. An unsupported option
before it fails with status 2 and one stable `git: unsupported status option:
OPTION` diagnostic before repository discovery or optional metadata probes;
porcelain v2 is deliberately outside this bounded API.
`git diff --quiet` and `--exit-code` are strict ternary predicates: status 0
means the selected tracked diff is empty, 1 means it contains differences, and
2 means parsing, repository discovery, revision resolution, or computation
failed. Quiet mode emits no payload; exit-code mode retains the selected
renderer. This avoids preflight wrappers around generated review checks.
The same status-2 classification applies to repository, revision, parsing,
bound, and computation failures in ordinary patch and machine-projection modes;
those failures never return partial projected stdout. Ordinary comparisons
still return 0 whether clean or changed unless a predicate or check was asked
for.
Unstaged `--name-only`, `--name-status`, and `--numstat` projections verify the
same content comparison as the full patch instead of trusting racy index stat
metadata. Immediate same-byte-count rewrites therefore remain visible across
human and machine forms. Name projections buffer output before returning it and
limit the complete comparison to 100,000 records, 4,096 UTF-8 bytes per path,
and 8 MiB of output; an over-limit request returns status 2 with no partial
stdout. Use `-z` for byte-exact NUL-terminated path fields.
History inspection can use first-parent `git log --name-only`, `--name-status`,
or `--numstat`. Text output has explicit empty-line commit boundaries; `-z`
uses raw path fields and an empty NUL record after each commit block. Projected
custom formats must be single-line and include `%H` or `%h`, keeping identity
and framing explicit for agents.
Reachability checks can use `git rev-list --count [--max-count N] REVISION`.
It counts unique commits across merge DAGs, peels commit-ish tags, emits one
decimal line, and bounds uncapped walks to 100,000 commits without partial
output. Plain `git rev-list` uses the same unique walker for OID output.
For a direct branch-containment predicate, use
`git merge-base --is-ancestor ANCESTOR DESCENDANT`. It is silent and reserves
status 0 for true, 1 for a fully evaluated false result, and 2 for invocation,
repository, revision, object, or traversal errors. Both commit-ish operands are
resolved before a descendant-only walk bounded to 100,000 unique commits and
1,000,000 parent edges; the index, worktree, refs, and stdin are not consulted.
Use the exact `git cat-file -e OBJECT` form as a silent object-existence
predicate. Status 0 means the expression resolves to a readable object, 1
means it does not resolve (including missing or dangling objects), and 2 means
invalid invocation, repository discovery, or object validation failed. The
object expression is limited to 4,096 UTF-8 bytes and retains the existing
revision syntax, including ancestry, tag peeling, and `REV:path`; stdin, the
index, and worktree contents are ignored. The `-t`, `-s`, and `-p` inspection
modes retain their normal payloads.
Inspect known index or worktree paths with
`git ls-files [-z]
[--stage|--cached|--modified|--deleted|--others [--exclude-standard]]
[-- [PATH...]]`. Options remain initial; every terminal operand after `--` is
a literal path, including option-looking names. Relative paths are normalized
from the invocation directory, absolute paths must stay within the discovered
worktree, and an exact path also selects its lexical `path/` descendants.
Selectors never dereference worktree or indexed symlinks, glob characters are
literal, overlapping operands do not duplicate records, and records retain the
existing index ordering and projection format. A valid empty match is status 0
with no output. Operand, repository, index, containment, and bound errors are
status 2 with no partial stdout or repository effects. The complete read-only
result is staged and limited to 100 selectors, 4,096 UTF-8 bytes per selector,
100,000 candidate entries, and 16 MiB of output. Full Git pathspec magic and
`--error-unmatch` deliberately remain outside this lookup primitive.
Before staging or generating a path, use
`git check-ignore [-q|--quiet] [--] PATH...`. It reports each ignored original
operand with LF, returns 0 when any input is ignored, and returns 1 with no
output when none are ignored; tracked paths are never reported. The exact
`git check-ignore --stdin -z` (either option order) accepts and emits literal
NUL-delimited UTF-8 records, preserving tabs, newlines, leading dashes, and
input order, so prospective and hostile filenames can be checked without
enumeration. LF-framed operand mode rejects newline-containing names. The
complete NUL batch, repository inspection, and bounded output are staged before
anything is published. Usage errors return 2; repository, bounded-input,
invalid-path, and index/ignore inspection errors return 128 without partial
output. Operand mode is limited to 100 paths; NUL stdin accepts 4,096 records
and 1,000,000 bytes. Each path is limited to 4,096 UTF-8 bytes, output to 1
MiB, path depth and applicable ignore files to 128, each ignore file to 1 MiB,
aggregate ignore data to 8 MiB, patterns to 100,000, and the index to 16 MiB /
100,000 entries. Matching reuses the same root-to-leaf `.gitignore` and
`.git/info/exclude` behavior as `ls-files --exclude-standard`; paths are
lexical, applicable ignore-file symlinks are skipped, and traversal through a
worktree symlink is rejected. Global excludes, `--no-index`, provenance, and
pathspec magic remain outside the bounded API.
Use `git show-ref [--head]` when an agent needs a deterministic full-name ref
inventory, and `git show-ref --verify [--quiet] [--] REF` for one exact `HEAD`
or `refs/...` predicate. Loose refs override packed refs, symbolic refs resolve
through at most 32 links, dangling symbolic refs are omitted, and output is
sorted bytewise after an optional leading `HEAD` record. Direct 40-hex refs are
reported even if their objects are missing; packed tag peel records are
validated but not printed. Listing and a missing quiet verification are
silent on stderr; statuses are 0 for found, 1 for empty/not found, 2 for usage
or a bound, and 128 for discovery/corrupt-state failures. Inspection is atomic
and read-only, including in uploaded bare repositories. The command caps the
logical namespace at 4,096 refs, `.git/refs` traversal at 8,192 entries, names
at 1,024 bytes, each loose payload at 4,096 bytes, aggregate loose data at
4,000,000 bytes, `packed-refs` and output at 1,000,000 bytes, and deliberately
omits patterns, dereferencing output, stdin modes, formatting, and pseudorefs
other than optional `HEAD`.
Inspect a historical or arbitrary tree without checking it out using
`git ls-tree [-r] [-t] [-z] [--name-only] [--max-count=N] [--] TREEISH`.
Commit-ish values resolve to their tree, explicit trees are accepted, and the
index, worktree, and stdin are ignored. The default form emits immediate
`MODE TYPE OID<TAB>PATH` records in stored Git order; `-r` emits leaf/gitlink
records depth-first, while `-r -t` includes each directory before descending.
Use `-z` for raw tree path bytes and NUL terminators. Text mode leaves printable
ASCII paths unquoted and deterministically quotes tabs, newlines, backslashes,
quotes, non-ASCII bytes, and invalid
UTF-8 with named or three-digit octal escapes. An omitted `--max-count` means a
complete result or atomic failure; only an explicit value authorizes a
successful early prefix. The walk is read-only and caps tree depth at 128,
examined entries at 100,000, decoded tree visits at 4,096, one decoded tree at
8 MiB, aggregate decoded trees at 32 MiB, recursive paths and stdout at
1,000,000 bytes, the tree-ish expression at 4,096 bytes, and commit/tag peeling
at 1,000,000 bytes per object / 4,000,000 bytes total. Missing required
subtrees, malformed entries, and limit failures never leak partial output.
Search only tracked current bytes or one historical tree with
`git grep [-n] [-i] [-F|-E] [-l|-q] [-z] [--max-results=N] [-e] PATTERN
[REVISION] [-- PATHSPEC...]`. Worktree mode follows the stage-0 index but reads
current regular-file bytes, skipping tracked deletions, symlinks, submodules,
and untracked files. A revision resolves to one commit or tree and ignores both
index and worktree. Candidates are sorted by unsigned raw path bytes and paths
are reported relative to the command cwd. `-z` emits the raw identifier,
optional decimal line number, and content as separate NUL-terminated fields;
binary matches use identifier plus `binary`, while `-l` emits only identifiers.
Status is 0 for a match, 1 for a complete no-match search, and 2 for usage,
repository, object, regex, I/O, or limit failure. Default results are buffered
atomically; `-q` and explicit `--max-results=1..100000` alone may stop early.
The byte regex subset covers BRE/ERE literals, `.`, anchors, classes/ranges,
groups, alternation, and `*`/`+`/`?`; counted repeats, backreferences, POSIX
named classes, attributes, textconv, and boolean expressions are excluded.
Limits are 100,000 candidate entries and matches, 128 levels, 8 MiB per file,
64 MiB file data, 16 MiB historical tree data / 200,000 decoded objects, a
16 MiB index, a 64 KiB pattern, 100 pathspecs, 4,096 path bytes, 1,000,000
stdout bytes, and 100,000,000 matching and pathspec steps. Stdin is ignored.
Repeated `-e PATTERN`, `--regexp PATTERN`, and `--regexp=PATTERN` operands form
one union for `grep` and `rg`: any pattern selects a record once, while `-v`
selects only records matching none. Every pattern validates independently
before input inspection, preventing a later valid pattern from masking an
earlier invalid regex. The set is bounded to 64 patterns and 65,536 aggregate bytes.
Line mode preflights up to 100 explicit inputs and atomically buffers at most
1,000,000 output bytes while examining at most 16 MiB, 100,000 records, and
1 MiB per record. Thus missing later operands and line resource failures return
status 2 with no partial stdout. NUL search retains its separate 16 MiB output
bound and byte-exact record behavior.
When output itself is a pathname set, use `rg --files -0 PATH...` or
`rg -0l PATTERN PATH...`; `--null` is the long alias, and
`--files-without-match` is also supported. These modes emit raw NUL-terminated
paths without changing input record framing, so newline-containing filenames
compose with `sort -z` and `xargs -0`. They stage the complete invocation and
bound it to 100 explicit inputs, depth 128, 100,000 visited/emitted paths,
4,096 bytes per path, and 1 MiB output. A file listing succeeds when empty;
pathname search returns 1 when empty, while invalid combinations, stdin,
inspection failures, or a bound return 2 with zero pathname output. Do not
combine path-NUL mode with ordinary match output, `-n`, `-c`, `-q`, or
`--null-data` (the last one instead selects NUL-delimited input records).
Machine path streams can stay byte-exact through `grep -z`/`--null-data` or
`rg --null-data`, then `sort -z`, `uniq -z`, and `xargs -0`. Adjacent group
selection can use `uniq -d` for repeated groups or `uniq -u` for singleton
groups; both compose with counts and NUL records. `uniq` compares raw bytes and
prevalidates its bounded input before output in LF and NUL modes. NUL search treats
embedded newlines and invalid UTF-8 as record data, buffers the complete
bounded invocation before output, and terminates every successful output item
with NUL. Explicit `-n` means a one-based record ordinal; unnumbered
`rg --null-data` suppresses rg's normal implicit line number so it remains a
safe path filter. Each record is capped at 1 MiB, with 16 MiB and 100,000-record
input and output limits. Ripgrep's short `-z` remains reserved for compressed
search, so use its `--null-data` spelling.
Extract one byte-delimited field without leaving a raw path stream using
`cut (-z|--zero-terminated) [-d BYTE] -f FIELD [--] [FILE]`. The default
delimiter is tab, fields range from 1 through 1,048,577, and a record with no
delimiter passes through unchanged. Existing empty fields and missing selected
fields emit empty records, and every input record—including a nonempty final
unterminated record—is NUL-terminated on output. Input and output are each
capped at 16 MiB, with at most 100,000 records and 1 MiB per record; the full
input and predicted output validate before stdout. Use a file operand for data
over the shell's separate 1 MiB pipeline transport bound. Character selection
and NUL delimiters are outside this mode.
For sorted line manifests, `comm [-123] [--] FILE1 FILE2` provides native set
intersection and difference without a Python detour. It compares raw
LF-delimited records in unsigned-byte order, retains duplicate multiplicity,
accepts one stdin operand, and prevalidates both inputs and sortedness before
stdout. Each input is bounded to 16 MiB, 100,000 records, and 1 MiB per record.
It deliberately has no `-z`; arbitrary pathnames should stay in the NUL-safe
pipeline above or use Python when a two-set comparison is required.
Payload-bearing manifests can use bounded
`join [-1 FIELD] [-2 FIELD] [-t BYTE] [-a 1] [-a 2] [-v 1|2] FILE1 FILE2`.
It merge-joins sorted unsigned-byte keys, expands duplicate groups
deterministically, and supports inner, outer, or one-sided anti output. Both
inputs, field presence, sort order, and the predicted result are validated
before stdout; use Python for CSV quoting, locale/numeric keys, or NUL records.
Binary artifacts can be inspected with
`xxd [-g 1|2] [-c COLS] [-l LENGTH] [-s OFFSET] [FILE|-]`. Its lowercase
hex/ASCII rows have deterministic absolute offsets, preserve every input byte,
and are preflight-bounded to 16 MiB input and output. Large artifacts should be
passed by path because ordinary shell pipelines and stdin redirects retain the
global 1 MiB stage bound. Reverse conversion and arbitrary formatting remain
outside the API.
Reversible binary transport uses `base64 [-d|--decode] [--] [FILE|-]`.
Encoding emits canonical RFC 4648 basic-alphabet data with required padding,
no wrapping, and no trailing newline. Strict decode ignores ASCII space, tab,
CR, and LF, but rejects other garbage, impossible tails, noncanonical padding,
and nonzero discarded pad bits before stdout. Input is capped at 16,777,216
bytes, encoded output at 22,369,624 bytes, and decoded output at 12,582,912
bytes. Named input and direct `< file` redirection can reach the full input
bound; ordinary pipeline transport remains capped at 1 MiB. Status 3 identifies
malformed encoded data and status 4 a path/input/result bound. URL alphabets,
wrapping, ignore-garbage behavior, and multiple inputs remain outside the API.
Printable binary clues can be extracted with
`strings [-n MIN] [--] [FILE...]`. It treats only raw ASCII bytes `0x20..0x7e`
as printable, emits maximal qualifying runs followed by LF, defaults `MIN` to
4, and accepts strict decimal 1..65,536. Runs do not cross input boundaries;
stdin may appear once and named regular-file inputs remain ordered and may be
repeated. The complete result is staged before stdout. Limits are 100 operands,
4,096 bytes/path, 16 MiB per file/stdin/output, and 64 MiB aggregate named-file
input. Named files and direct `< file` redirection reach 16 MiB, while ordinary
pipeline transport remains 1 MiB. Use it for deterministic byte triage, not
Unicode, recursive search, object formats, labels/offsets, alternate encodings,
or broader binutils compatibility.
In-place file sizing uses `truncate -s SIZE [--] FILE`. This deliberately
accepts one strict decimal byte size from 0 through 67,108,864 and one regular
file, creating a missing final entry when its parent exists. Growth preserves
the prefix and exposes zero bytes; existing inode and hard-link identity are
preserved. Final symlinks are rejected with a no-follow open, while parent
symlinks may resolve physically through 40 traversals. Paths are bounded to
4,096 bytes and 128 normalized components. Static validation occurs before the
open; a runtime resize failure after missing-file creation may leave the new
empty file. Use Python for sparse-allocation policy, multiple files, reference
sizes, suffix multipliers, or relative size arithmetic.
Tabular and one-line assembly use
`paste [-s] [-d DELIMS] [--] [FILE...]`. Normal mode zips up to 32 inputs,
while `paste -sd, -` joins one input into a comma-delimited row. Payload bytes
remain opaque and delimiters cycle as literal UTF-8 scalar values. Paste opens
and reads every input, enforces its 16 MiB/100,000-record aggregate and 1 MiB
record bounds, and predicts at most 32 MiB output before emitting stdout.
NUL-delimited records and GNU delimiter escapes remain explicitly outside the
contract.

## Boundaries

- No host shell, subprocesses, sockets, or host filesystem access.
- Browser `fetch` follows CORS. A simple request may reach its server even when
  the response is blocked; see [Browser curl](curl.md).
- HTML previews have no browser storage or relative `/home/web` URLs; inline assets and state.
- The wasm32 heap has a hard ceiling near 4 GiB.
- Prefer bounded reads, output, and allocations.

See [WASI](wasi.md) for compiled programs, [raylib](raylib.md) for games, and
[Slop](slop.md) for shell syntax.
