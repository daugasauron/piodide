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
search. Committed binaries live in `../bin/`; the host repository rebuilds
every installed C utility with `npm run build:slop`. The copy mounted at
`/home/web/slop` is a partial audit snapshot, not a self-contained in-browser
checkout: the npm project and app-side TypeScript dependencies are not mounted.

Slop deliberately provides a documented bounded API for agents, not full
POSIX. `help BUILTIN` and each installed command's `--help` output define the
accepted subsets. An accepted flag must perform its stated operation;
unsupported flags fail explicitly (normally with status 2) before mutation. Status 0 means the
requested operation happened, stdout remains payload, stderr remains
diagnostics, and machine formats such as Git `-z` remain byte-exact. Limits
fail explicitly rather than truncating or silently approximating behavior.
The exact redirection path `/dev/null` is a virtual EOF source and incremental
output sink for builtins and spawned commands. It creates no workspace node,
preserves the invoked command's status, and follows normal left-to-right
descriptor ordering. Other normalized `/dev/*` redirect targets fail before
the command runs instead of inheriting host-specific device behavior.
Use `rg PATTERN -` for piped stdin; no path means recursive workspace search.
Common inspection with `ls -lthr` is supported as a bounded size/name listing:
`-h` formats sizes, `-t` sorts newest first, `-r` reverses, and `-d` lists a
directory operand rather than traversing it.
High-value bounded compatibility forms include `readlink -f` for existing
paths, no-clobber `cp -n`, `xargs -I`, multi-file `wc`, `find -mindepth`/`-path`,
raw-suffix `tail -c`, quiet predicate `cmp -s`, NUL-safe `sort -z`/`uniq -z`, adjacent-group `uniq -d`/`uniq -u`, bounded `paste -sd,`, sorted-manifest
`comm -123`, `du -a -d 1`, `mktemp -t`, `truncate -s SIZE`,
structured `stat -c`, two-file unified `diff`, `git add -u`, real `git add -N`
intent-to-add entries, and `git log --format=%s`
for one subject per line. One-commit review can use bounded `git show --stat`
with optional path selectors. Permission mode fields are intentionally absent from
`stat` because the WASI filestat ABI does not expose them.
Recursive `cp` preflights every physical source root and effective target before
the first write. A target equal to or below its source—including through an
existing destination symlink—returns status 1 and exactly
`cp: recursive destination is within source`, while component-prefix siblings
remain valid. The planner accepts at most 100 sources, 4,096 encoded bytes per
operand, 65,536 aggregate path bytes, 128 normalized components per operand,
and 40 symlink resolutions. These failures are invocation-atomic; ordinary I/O
failures after copying begins retain the existing partial-copy contract.
`rm [-f] [-r|-R] [--] PATH...` accepts compact `-rf`/`-fr` and builds one
complete physical deletion plan before unlinking anything. It recursively
scans directories, deduplicates duplicate/overlapping selections, unlinks a
final symlink without following it, and resolves intermediate links physically.
A later missing operand (unless `-f`), directory without recursion, loop, or
path/traversal bound leaves every selected path unchanged. `.`/`..` operands
and physical root are refused. Limits are 100 operands, 4,096 bytes per path,
65,536 aggregate path bytes, 128 normalized components, 40 symlink traversals,
128 recursion levels, and 100,000 scanned/planned entries. Invocation and
limit failures return 2; deterministic filesystem failures return 1. A race or
I/O failure after the validated commit begins can leave earlier removals and
is not rolled back.
`mv [-f|-n|--force|--no-clobber] [--] SOURCE... DEST` uses the same source,
path, component, and symlink bounds. Multiple sources require an existing
physical destination directory and map to `DEST/basename(SOURCE)`. Before the
first rename, the complete plan rejects missing sources, directory cycles,
duplicate targets, overlapping source/target operands, and incompatible root
types. Ordered force/no-clobber behavior applies per source; a skipped source
stays in place. Successful batches are silent, symlink entries remain links,
and merges into an existing directory preserve entry types. Once a validated
batch starts, an unexpected runtime failure stops it without rolling back
earlier moves.
`mkdir [-p] [--] DIRECTORY...` plans the whole request before creating its
first directory; option-looking names require `--`. The planner simulates
operands left-to-right, so plain dependent forms such as `mkdir a a/b` remain
valid while a reversed missing-parent form, duplicate, existing final,
non-directory component, dangling link, or loop rejects without mutation.
`-p` plans missing components and accepts duplicates, existing directories,
and final links that physically resolve to directories. Parent links resolve
before `..` through at most 40 traversals. Limits are 100 operands, 4,096 bytes
per path, 65,536 aggregate path bytes, 128 normalized components, and 1,024
planned creations. A runtime failure after execution begins stops the plan but
does not roll back directories already created.
`rmdir [--] DIRECTORY...` resolves and simulates the complete request in
operand order before its first removal. Thus `child parent` succeeds when the
child is the parent's only entry, while `parent child`, duplicates, or a later
missing, nonempty, non-directory, final-symlink, or resolution failure leaves
every selected directory unchanged. Intermediate links resolve physically;
`.`/`..` operands and physical root are refused. Limits are 100 operands,
4,096 bytes per path, 65,536 aggregate path bytes, 128 normalized components,
and 40 symlink traversals. Invocation and limit failures return 2;
deterministic filesystem failures return 1. If a commit-phase removal fails,
earlier empty directories are recreated in reverse order; concurrent external
mutation is outside this bounded rollback contract.
`du -a -d DEPTH [--] PATH...` provides deterministic logical-size inspection,
not allocation-block accounting. Both initial options are required and may be
reversed; `DEPTH` is decimal 0..128 and limits emitted rows while directories
still total every descendant regular file. Symlinks contribute zero and are
never followed. Bytewise lexical traversal produces postorder decimal-byte,
tab, lexical-path records. The complete scan and at most 16 MiB of output are
staged before emission, so scan/limit failures expose no partial totals. Bounds
are 64 paths, 4,096 bytes per path, 65,536 operand bytes, 128 levels, and
100,000 entries/records. Overlapping operands are measured independently.
`find [PATH...] [-mindepth N] [-maxdepth N] [-name GLOB] [-path GLOB]
[-type f|d|l] [-print|-print0|-delete]` accepts one optional final action and
defaults to newline output. It parses the complete expression before walking;
syntax errors return 2 without mutation. `-delete` is silent and visits
directories postorder, unlinks matching files and symlinks without following
targets, and removes a matching directory only after its visited children.
Runtime failures return 1 but do not roll back earlier removals. Traversal is
bounded to 100 starting paths, 128 levels, and 100,000 aggregate entries.
`mktemp [-d] [-t] [-dt|-td] [--] [TEMPLATE.XXXXXX]` creates one exclusive
file or directory and prints its path. Flags precede the optional template;
exactly six `X` bytes in its final component are replaced. `-t` uses nonempty
`TMPDIR` or `/tmp`, accepting relative, absolute, or symlinked existing
directories. Parent traversal is resolved physically through 40 links while
the printed path retains its lexical `TMPDIR` spelling. The final component is
bounded to 1,024 bytes and the complete path to 4,096 bytes and 128 normalized
components. Syntax and limits fail with status 2 before creation; filesystem
failures use status 1. Candidate creation is atomic and exclusive with 128
collision attempts. Removal races and stdout failure after creation are not
rolled back. WASI does not carry a creation mode, so Pyodide host-managed modes
(typically `0644`/`0755`) are observable rather than Unix `0600`/`0700`; do not
treat this command as a permission boundary.
`touch [-c] [--] FILE...` requires options before operands (use `--` for an
option-looking path) and preflights every operand before updating or creating
anything. It resolves at most 40 symlinks to a physical regular-file target or
a missing final leaf whose parent already exists; `-c` skips only that missing
leaf. Missing parents, loops, directories, and other deterministic path errors
return status 1 without mutation. Malformed requests and limits return status
2. Limits are 100 operands, 4,096 bytes per path, 65,536 aggregate path bytes,
and 128 normalized components. An unforeseen runtime failure stops execution
without promising rollback of earlier timestamp updates.
Regular-file installation uses `install [--] SOURCE... DEST`, while
`install -d [--] DIRECTORY...` creates directory paths. Both forms preflight
the complete bounded request before mutation. Source and destination-parent
links resolve physically through at most 40 links; a final destination link is
rejected rather than followed. Copy preflight also rejects missing or
non-regular sources, a non-directory multi-source destination, source/target
identity, and duplicate effective targets. The limits are 100 sources or
directories, 4,096 bytes per operand, 65,536 aggregate path bytes, and 128
normalized components. Metadata flags are explicitly unavailable. A runtime
I/O failure after a valid plan starts stops the batch without rollback.
Symbolic links use `ln -s [-f] [--] TARGET LINK`, including compact `-sf` and
`-fs`; options are parsed only before the first operand. Hard-link mode is
unavailable across the browser workspace and returns status 2 before touching
the destination. The physical destination parent is resolved through at most
40 links before applying `..`, and `-f` replaces the final regular-file or symlink entry without
following its referent. Directories are never removed. Target and link operands
are each bounded to 4,096 bytes, and link names to 128 normalized components.
Deterministic path errors occur before force replacement. An unexpected
failure after unlink begins is not rolled back.
Noninteractive commit validates the complete argv before mutation. It accepts
short, compact, and long message forms, multiple `-m` paragraphs, piped `-F -`,
tracked-only `-a`/`--all` (including `-am`), `--allow-empty`, and quiet output.
`--no-verify` and `--no-gpg-sign` are explicit no-ops because hooks and signing
are unavailable. Path operands, unknown options, editor message files, and
contradictory sources fail with status 2. Explicit author/committer names,
emails, and bounded Git dates are honored. History correction supports
`git commit --amend` with a supported message form or `--no-edit`.
Merge requires globally clean tracked/index state but permits unrelated
ordinary and ignored untracked leaves. A bounded `HEAD`-versus-target path plan
rejects exact, ancestor, and descendant collisions before mutation, including
ignored and byte-identical data, while permitting container directories and
non-colliding siblings. Already-up-to-date merges succeed without touching
untracked paths. `git merge --no-commit BRANCH` reports success when it prepares
a clean merge and leaves `MERGE_HEAD` for the later commit.
`git cherry-pick COMMIT` requires repository-wide clean tracked/index state.
Unrelated ordinary and ignored untracked leaves are preserved, while a bounded
parent-versus-commit path plan rejects exact, ancestor, and descendant collisions
before mutation, including ignored and byte-identical data. A clean conflicting
pick can be abandoned with `git reset --hard HEAD`; cherry-pick sequencing and
continue/abort modes are not part of the bounded API.
Path recovery preserves Git's index/worktree layers: `git checkout -- paths`
and plain `git restore` copy the index to the worktree, while
`git checkout REF -- paths` updates only those paths in both layers without
moving `HEAD`. Bounded
`git restore [-s|--source REF] [-S|--staged] [-W|--worktree] [--] PATH...`
accepts literal cwd-relative exact files or directory prefixes and coordinates
requested layers transactionally. It validates the full source/candidate/type
plan, builds any index result privately, snapshots and revalidates worktree
leaves, applies them under rollback, and publishes the index last. HEAD, refs,
unselected paths, and the unrequested layer never change. Limits are 100 paths,
4,096 UTF-8 bytes each, 65,536 aggregate path bytes, depth 128, 100,000
expanded/result entries, a 16 MiB index, 16 MiB per source/rollback file, and
64 MiB aggregate source or rollback bytes. Operational/no-match/collision and
rollback failures return 1; grammar/path/type/bound failures return 2 without
planned mutation. Pathspec magic, interactive conflict selection, submodules,
special files, and replacing nonempty untracked directories are unavailable.
Missing restore/checkout operands and conflicting reset modes fail before
mutation. Reset commit operands accept refs, object IDs, and ancestry
expressions such as `HEAD^` and `HEAD~2`, bounded to 4,096 UTF-8 bytes and
validated as commits before mutation. Path-form
`git reset [--mixed] [COMMIT] -- PATH...`
unstages literal exact files or directory-prefix descendants, resolved from the
command cwd and confined to the worktree, without changing
the worktree. It validates source objects and the complete source/current/result
entry plan, builds a private scratch index, and performs one final canonical
index write; a directory is never materialized as a blob entry. No-match is a
silent success. Limits are 100 operands, 4,096 UTF-8 bytes each, 65,536 operand
bytes, 100,000 source/current/result entries, and a 16 MiB input/result index.
Repository/object/index/write failures return 1; invalid syntax, revision,
path, or bounds return 2 without mutation. Pathspec magic, interactive reset,
submodules, and path forms with `--soft`/`--hard` remain unavailable.
Bounded `git rm [-r] [--] PATH...` removes clean tracked entries from both the
worktree and index. Every literal cwd-relative selector must match; `-r`
expands directory prefixes, and duplicates/overlaps are deduplicated. Selected
stage-0 entries must match HEAD and their current worktree mode and bytes.
Final symlinks are unlinked, intermediate symlink ancestry is refused,
untracked/ignored paths remain, and selected directories are removed only when
empty. It prepares a private scratch index and bounded rollback snapshot before
deletion, revalidates paths, publishes the index last, and attempts complete
restoration after a synchronous failure. Success emits deterministic
cwd-relative Git-quoted `rm PATH` lines; browser crashes and concurrent changes
are not transactional.

`git rm --cached [-r] [--] PATH...` shares literal selection but leaves HEAD
and every worktree path unchanged. It accepts an entry matching either HEAD or
the worktree, preserving modified worktrees and retained newly staged files but
refusing unique staged content. Both modes refuse unmerged indexes, submodules,
`-f`, implicit `.`, and pathspec magic. Repository/index/content/runtime
failures return 1; grammar, unmatched paths, and bounds return 2 without
planned mutation. Limits are 100 selectors, 4,096 UTF-8 bytes per path, 65,536
selector bytes, depth 128, 100,000 index/removal entries, a 16 MiB index,
16 MiB per worktree file, 64 MiB aggregate worktree bytes, and 8 MiB output in
non-cached mode.
`git add (-N|--intent-to-add) [--] PATH...` gives agents an exact, bounded way
to expose ordinary-untracked regular files and final symlinks to ordinary diff
without staging their bytes. Literal exact and directory-prefix operands create
canonical empty-blob stage-0 entries with Git's real intent flag; cached diff
and commit omit them, status reports ` A` (or ` D` when the worktree leaf is
gone), ordinary add materializes them, reset/cached rm removes them, and mv
preserves the marker. The index-v3 adapter presents a compatible v2 view to
older consumers and restores flags on writes. Planning is atomic through a
private scratch index and one publication write. Limits are 100 operands, 4,096
UTF-8 bytes each, 65,536 aggregate bytes, depth 128, 100,000 candidates/result
entries, and a 16 MiB index; force, dry-run, interactive modes, pathspec magic,
submodules, conflicts, and special files remain unavailable.
Bounded `git mv [--] SOURCE DESTINATION` renames one literal cwd-relative
tracked path without collapsing the index and worktree layers. The destination
must be wholly absent and is never existing-directory shorthand. A file or
final symlink remaps one stage-0 entry; a directory moves its entire current
tree, including untracked descendants, while remapping only tracked index keys.
Each entry retains its exact OID and mode, preserving separately staged content
and current worktree edits. The source topology and complete private scratch
index validate before the filesystem rename, the index publishes last, and an
index failure restores the old path and serialized index or reports an explicit
rollback failure. HEAD is unchanged and success is silent. Intermediate
symlink ancestry, unmerged entries, submodules, force, multiple sources,
destination-directory shorthand, pathspecs, and rename detection are absent.
Repository/index/collision/runtime failures return 1; invocation/path/bounds
return 2. Limits are two paths, 4,096 UTF-8 bytes each, 8,192 operand bytes,
depth 128, 100,000 scanned/index entries, and a 16 MiB input/result index.
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
Bounded `git clean` accepts compact and long preview/force forms, `-z`/`--null`,
and narrow `-X`/`--ignored-only`; it stays within the invocation directory by
default and accepts literal selectors after `--`. Human output retains prefixed
lines; null output is raw repository-relative path records terminated by NUL,
including embedded tabs/newlines. Preview and action share one fully validated
deterministic candidate list. Ordinary mode protects ignored entries. `-X`
instead selects only ignored untracked leaves, and `-X -d` adds an ignored
directory only when every descendant is selected, including truly empty
ignored directories. The no-follow walker protects tracked, staged, ordinary,
re-included, git-dir, and out-of-scope entries; final ignored symlinks are
eligible leaves. Compact `-nXdz`/`-fXdz` is accepted, while broad `-x` remains
unavailable. Limits are 100 selectors, 4,096 bytes per path, 65,536 selector
bytes, depth 128, 100,000 scanned entries/candidates, and 8 MiB output.
Bounded `git stash [push]`, `list`, `apply`, `pop`, and `drop` operate on tracked
changes and the top entry only. Clean pushes succeed idempotently; apply/pop
restore as unstaged changes, and a conflicting pop returns status 1 without
dropping its recovery ref. Unsupported messages, selectors, `--index`, and
untracked modes fail with status 2 before mutation. Worktree decisions hash
exact bytes, so rapid same-size text and binary edits remain visible to status,
add, cleanliness checks, and stash. Hard reset shares the symlink-safe recovery
path used by restore.
Machine-oriented review workflows can use `git diff
--quiet`/`--exit-code`, literal-path-filtered `git ls-files -z`, and exact staged rename
coalescing. Their status contract is 0 for no selected difference, 1 only for
a computed difference, and 2 for invocation, repository, revision, or diff
failures; existing diagnostics are preserved. Diff name projections honor bounded path selectors and provide
byte-exact `-z` fields. Unstaged name and numstat projections reuse the native
full-patch comparison as an authoritative changed-path set, so an immediate
same-length rewrite cannot disappear behind racy index stat metadata. Name
projections stage output with limits of 100,000 records, 4,096 UTF-8 bytes per
path, and 8 MiB of output; excess returns status 2 without partial stdout.
Native patch context is available through `-UN`,
`-U N`, `--unified=N`, or `--unified N`, bounded to decimal 0 through 1,000;
repeated settings use the last value. Bounded `git diff/show --numstat` provides text line
counts and `-` binary markers across worktree, staged, revision, triple-dot, and
one-commit comparisons; its `-z` form terminates each raw path with NUL, and
exact moves stay as separate delete/add records. Search output can be bounded per file with `-m`, while
`grep -L` and `rg --files-without-match` list nonmatching files.
For lossless pathname-only output, `rg --files -0 PATH...`,
`rg -0l PATTERN PATH...`, and the corresponding `--null`,
`--files-with-matches`, and `--files-without-match` spellings terminate each
raw path with NUL. This is separate from `--null-data`, which changes input
record framing. Null-path mode rejects ordinary match output, explicit line
numbers, count/quiet modes, stdin, and mixed NUL-data mode. It stages output
before stdout and caps explicit inputs at 100, traversal at 128 levels and
100,000 visited/emitted paths, each path at 4,096 bytes, and output at 1 MiB.
Completed empty listings return 0, empty pathname searches return 1, and
invalid, inaccessible, or over-bound requests return 2 with no path output.
`git ls-files` accepts terminal literal selectors after `--` for cached,
staged, modified, deleted, and other projections. Paths resolve lexically from
the invocation directory and select an exact repository path plus its `path/`
descendants; absolute paths must remain within the worktree. Selection never
dereferences links, overlapping paths do not duplicate records, no match is a
successful empty result, and the complete read-only output is staged. The
bounded subset accepts 100 paths of at most 4,096 UTF-8 bytes, examines at most
100,000 candidates, emits at most 16 MiB, and deliberately omits pathspec magic
and `--error-unmatch`.
Tracked and historical source search can use bounded `git grep` with one byte
BRE/ERE/fixed pattern, one optional commit/tree, cwd-relative exact/prefix/glob
pathspecs, line numbers, file listing, quiet predicates, and NUL-field output.
Worktree mode reads only regular stage-0 tracked paths; historical mode walks
canonical tree/blob objects. Status 0 means matched, 1 means a complete
no-match result, and 2 means usage, inspection, regex, I/O, or limit failure.
Default output is atomic; only `-q` and explicit `--max-results` may stop early.
Independent caps cover 100,000 candidates/matches, 128 levels, 8 MiB per file,
64 MiB file data, 16 MiB / 200,000 historical metadata objects, a 16 MiB index,
64 KiB pattern, 100 pathspecs, 4,096-byte paths, 1,000,000-byte output, and
100,000,000 regex/pathspec steps. Stdin, attributes, textconv, PCRE, context,
boolean expressions, submodules, and broad Git pathspec magic remain absent.
NUL-producing Git and `find -print0` workflows can be filtered with `grep -z`
or `grep --null-data` and `rg --null-data`, then passed through clustered
`sort -zu`, `sort -rz`, `uniq -z`, `uniq -cz`, `uniq -zd`, or `uniq -zu`,
projected with bounded `cut -z`, and passed to `xargs -0` without
changing embedded newlines, tabs, spaces, or invalid UTF-8 bytes. NUL-search
output items are also NUL-terminated; explicit `-n` emits record ordinals,
while unnumbered `rg --null-data` leaves path records unprefixed. Ripgrep `-z`
is reserved for compressed search. NUL operations read and validate before
output. Search caps input and output at 16 MiB and 100,000 records, with 1 MiB
per record; sort/uniq use the same input bounds plus 32 MiB generated-output
and 64 MiB working-memory bounds. `uniq -d` emits one representative for each
adjacent repeated group, `uniq -u` emits singleton groups, and using both emits
their union. These selectors compose with `-c` and `-z`; LF and NUL modes both
compare raw bytes and prevalidate the complete bounded input before stdout.
Sorted LF-delimited manifests can be compared with
`comm [-123] [--] FILE1 FILE2`. It uses unsigned-byte ordering, retains
duplicates pairwise, permits one stdin operand, and prevalidates both inputs
and their ordering before output. Each input is capped at 16 MiB, 100,000
records, and 1 MiB per record. NUL-delimited `comm` is intentionally absent;
keep arbitrary paths in the NUL-safe filters above.
Sorted payload manifests can be reconciled with
`join [-1 FIELD] [-2 FIELD] [-t BYTE] [-a 1] [-a 2] [-v 1|2] [--] FILE1 FILE2`.
It compares fields 1 through 1,000 as unsigned bytes, performs deterministic
Cartesian expansion for duplicate keys, and supports bounded outer or anti
rows. Default whitespace fields normalize to spaces; a one-byte `-t` preserves
empty fields and becomes the output delimiter. Each input uses the same
16 MiB/100,000-record/1 MiB-record limits as `comm`; output is predicted before
writing and capped at 32 MiB, 100,000 records, and 2 MiB per record. NUL records,
CSV quoting, numeric/locale keys, and implicit sorting remain unavailable.
Forward binary inspection uses
`xxd [-g 1|2] [-c COLS] [-l LENGTH] [-s OFFSET] [--] [FILE|-]`.
It prints deterministic eight-digit lowercase absolute offsets, padded grouped
hexadecimal bytes, and printable ASCII with `.` substitution. Columns range
from 1 through 256; offset and length are unsigned decimal values capped at
16 MiB. The complete input and predicted output (each at most 16 MiB) are
validated before stdout. Piped or redirected stdin remains subject to Slop's
global 1 MiB stage buffer, so larger artifacts should use a path operand.
Reverse mode, autoskip, include-file output, and arbitrary formats are absent.
Reversible raw-byte transport uses
`base64 [-d|--decode] [--] [FILE|-]`. Encoding is canonical RFC 4648 basic
alphabet with required padding, no wrapping, and no trailing newline. Strict
decode ignores ASCII space, tab, CR, and LF, while rejecting all other garbage,
bad padding/tails, and nonzero discarded pad bits before stdout. Input is
capped at 16,777,216 bytes, encoded output at 22,369,624 bytes, and decoded
output at 12,582,912 bytes. Named files and direct `< file` redirects may use
the full input bound; ordinary pipelines retain the 1 MiB stage limit. Status 3
means malformed encoded data and status 4 means a path/input/result bound.
Wrapping, URL alphabets, ignore-garbage mode, and multiple inputs are absent.
Printable raw-byte inspection uses
`strings [-n MIN] [--] [FILE...]`. Printable means exactly ASCII bytes
`0x20..0x7e`; every maximal run of at least `MIN` bytes is emitted unchanged
and followed by LF. `MIN` defaults to 4 and is strict decimal 1..65,536. Runs
remain separate across ordered inputs, stdin may occur once, and symlinks must
resolve to regular files. The command stages the full result before stdout and
is bounded to 100 operands, 4,096 bytes/path, 16 MiB per input/stdin/output,
and 64 MiB aggregate named-file input. Named input and direct `< file` can use
16 MiB; ordinary pipelines remain capped at 1 MiB. Locale/Unicode classes,
recursion, labels/offsets, object formats, alternate encodings/separators, and
other binutils modes are absent.
`truncate -s SIZE [--] FILE` performs one bounded in-place resize. `SIZE` is
one to 20 ASCII decimal digits from 0 through 67,108,864; signs, suffixes,
whitespace, relative adjustments, and reference sizes are absent. Shrinking
discards the suffix, growing preserves the prefix and adds observable zero
bytes, and an existing regular file keeps its inode and hard-link identity. A
missing final entry is created, but a final symlink (including a dangling one)
or non-regular file is rejected. Parent links resolve physically through at
most 40 traversals. Input paths are capped at 4,096 bytes and 128 normalized
components. Syntax/path/type failures occur before opening the target. A
runtime resize failure after missing-file creation may leave the new empty
file; changes are not rolled back. Status 2 is reserved for invalid invocation
or bounds, status 1 for operational failure, and success emits no output.
`tail -c BYTES [--] [FILE|-]` emits a raw byte suffix with no inserted newline.
The unsigned decimal count is capped at 16 MiB and compact `-cN` is accepted.
It consumes the full input into a bounded circular suffix buffer before stdout,
so late read failures are atomic. Signed byte positions, multipliers,
`--bytes`, multiple inputs, and follow mode remain absent. Piped input retains
the shell's 1 MiB stage limit; use a path for larger artifacts.
`cmp [-s] [--] FILE1 FILE2` provides a strict raw-byte predicate with one
optional stdin operand. Status 0 means equal, 1 means different, and 2 means
invalid invocation or I/O failure; missing and extra operands are never
silently accepted. Normal output identifies the first one-based byte and line
only after both streams validate through EOF. `-s` suppresses stdout and
stderr for every outcome. Listing, skip, and byte-printing modes are absent.
`paste [-s] [-d DELIMS] [--] [FILE...]` provides parallel columns and
serial joins over opaque LF-delimited byte records. Its delimiter list contains
literal UTF-8 scalar values that cycle per row; an empty list suppresses
separators and backslashes are not escapes. It prevalidates up to 32 operands,
16 MiB and 100,000 aggregate input records, 1 MiB per record, and 32 MiB
predicted output before writing. NUL-record paste is intentionally absent.
`head (-z|--zero-terminated) [-n N|-nN] [--] [FILE...]` selects the first
0..100,000 opaque NUL records per input (10 by default), preserving terminators
and a nonempty final unterminated record. It concatenates up to 100 inputs
without headers and buffers each selected prefix, so a read or limit failure
cannot leak partial bytes from that input. Limits are 1 MiB per record including
NUL, 16 MiB examined/emitted per input, and 64 MiB per invocation. Byte mode,
signed counts, multipliers, and alternate delimiters are unavailable with `-z`.
Common compact spellings such as `head -n2`, `tail -c32`, `sed -nE`, and `xargs -0r` are
accepted. `read -r` preserves backslashes (as does plain `read`); a line may
contain at most 4,095 bytes, and overflow fails without changing the target
variable. Builtin `printf [--] FORMAT [ARG...]` prevalidates its bounded
conversion set and 32-bit base-0 integers before emitting output. `echo`
interprets only one initial exact `-n`; all other operands are literal. Missing
`printf` string/integer arguments use empty/zero, while missing `%c` emits NUL.
Exhausted `while` loops retain the last body status or zero, and executable
`printf`, `true`, and `false` applets keep xargs dispatch consistent with direct shell use.
Semicolon-separated one-line `if`, `for`, and `while` compounds are accepted,
without splitting quoted text, inline function bodies, or command substitutions.
Quoted `|`, `<`, `>`, and descriptor-looking words remain ordinary arguments.
`basename` and `dirname` honor `--`, `wc` accepts its common long aliases, and
streamed `sha256sum` covers file and stdin integrity checks without loading the
whole input. Its `-c`/`--check` mode accepts one canonical manifest from a file
or stdin, prevalidates up to 1 MiB, 4,096 records, and 4,096 bytes per record,
then streams every target. Ordinary records use 64 hex bytes, `  ` or ` *`,
and a literal nonempty cwd-relative path. LF/backslash paths use a leading
backslash marker and `\n`/`\\` escapes; unmarked backslashes stay literal for
old manifests. Result and diagnostic paths use the same one-line rendering.
Carriage return stays literal, while NUL and decoded target `-` are invalid.
Hash mode refuses an encoded record above 4,096 bytes. Ordered per-path results
use status 0 for all matches, 1 for any mismatch, target read, or record-output
failure, and 2 for invocation, manifest, bound, or output errors.
Git identity probes support `rev-parse --verify`, `--quiet`,
`--short[=N]`, and `--git-common-dir`; linked worktrees remain outside the
bounded API.
Everyday review forms include path-bounded `git status -sbz -uno -- src`,
`git status --short --untracked-files=all`, `git diff --color=never --stat`,
`git branch --show-current`, and `git remote get-url`. Status accepts bounded
untracked modes `no`, `normal`, and `all`; any other option before `--` fails
with status 2 before repository inspection, while every word after `--` is a
literal path. Diff parser, repository, revision, bound, and computation errors
use status 2 in every output mode and never emit a partial machine projection.
Status 1 remains reserved for a valid `--quiet`/`--exit-code` difference or
`--check` finding; ordinary patch and projection comparisons use status 0.
`branch --show-current` emits
zero bytes when detached. Branch query, listing,
rename, and deletion modes validate their complete argument shape before any
mutation. Verbose branch listing accepts compact `-a`/`-r`/`-v` clusters;
`-v` adds subjects and `-vv` adds configured materialized upstream divergence,
bounded to 100,000 commits per pair and 1,000 upstream-bearing rows. Missing
upstreams render as `gone` without fetching. Branch-name operands to
`git switch --detach` resolve to commit IDs so `HEAD` is actually detached.
`git help COMMAND` advertises the supported short and long forms.
Shell guard clauses can distinguish a well-formed false `test`/`[` predicate
(status 1) from a malformed expression (status 2). Integer operands are strict,
and `-h`/`-L` tests the link itself, including a broken symlink. Timestamp
guards follow links and treat an existing source as newer than a missing output.
`test --help` documents the guard subset; `-r`/`-w`/`-x` fail explicitly
because WASI provides no truthful permission modes. Use `command -v` to probe
commands and `-e`/`-f` to probe workspace objects.
Shell state changes are similarly explicit: `export` and `unset` validate all
names before changing any variable, while `readonly` and `umask` return status
2 instead of claiming state the runtime cannot enforce. `shift` accepts one
decimal count from 0 through 128, and `return`/`exit` accept one decimal status
from 0 through 255; malformed operands are never coerced to zero.
`set` validates a complete option request before changing `errexit`, `nounset`,
`xtrace`, or `pipefail`, and prints their stable on/off state without operands;
`set -- [ARG...]` atomically replaces the active script, function, or sourced
file's positional vector, while bare `set --` clears it. `$#`, `$1`…`$@`, and
`shift` immediately observe the replacement. The vector is bounded to 100
arguments, 4,096 bytes each, and 65,536 bytes total; failures leave the
old vector intact, and positional replacement cannot be combined with option
changes. `local` validates every name before changing function scope. Bare or level-1
`break`/`continue` works only in an active loop, and command substitutions do
not inherit the caller's loop-control context.
`source [--] FILE [ARG...]` scopes supplied positional parameters to the
sourced file and restores the caller afterward; ordinary assignments still
persist. `return` exits the current sourced file without returning from a
surrounding function. Source nesting fails explicitly beyond eight levels so
the bounded line tables cannot exhaust the WASM stack.
An exact standalone quoted `"$@"` expands to one word per current positional
parameter, preserving empty and whitespace-containing arguments across
scripts, functions, `sh -c`, and sourced-file scopes; with no parameters it
expands to zero words. It observes `shift`. Concatenated forms such as
`"pre$@post"` fail explicitly rather than flattening boundaries; `$*` and
unquoted `$@` remain joined scalar expansions.
`help [BUILTIN]` exposes detailed builtin contracts. `command -v`, `type`, and
`which` require query names, accept `--`, and distinguish a missing name
(status 1) from malformed usage (status 2).
`command [--] NAME [ARG...]` invokes a builtin or executable while bypassing
functions, enabling exact `command "$@"` forwarding. `pwd` accepts `-L`,
`--logical`, and `--`; it and `cd -L` use the shell's logical cwd. Physical `-P` requests fail explicitly. Nested `eval` is limited
to eight so recursive agent-generated input cannot trap the WASM stack.
`env` without operands prints the current environment. Bounded launcher mode
is `env [-i] [-u NAME]... [--] COMMAND [ARG...]`: `-i` starts from an exact
empty environment and repeated `-u` removes exact case-sensitive ASCII names
without mutating the caller. The child snapshot receives no synthetic `PATH`,
`PWD`, `TERM`, or runtime marker, so an empty launch must use an explicit
command path. Duplicate and absent removals succeed; names must match
`[A-Za-z_][A-Za-z0-9_]*` within 255 bytes. The full request and snapshot are
validated before lookup or launch: 60 removals, 64 child-vector entries, 126
words after `env`, 4,096 bytes per word, 65,536 argument bytes, 1,024
environment entries, 65,535 bytes per encoded entry, and 1 MiB including
terminators. Piped stdin uses the shell's 1 MiB stage bound. Child status
0..125 passes through, 126 means cannot launch, 127 means not found, and syntax
or bounds return 2. `--` protects a dash-leading command. Assignment operands,
`-uNAME`, default-path injection, chdir/split/argv0/signal/debug options,
wildcard removal, and NUL listing are absent; use shell-prefix assignments for
additions or overrides.
`git config [--global|--local] --unset NAME` safely removes one stored setting,
targeting repository-local storage by default. Status 0 means exactly one value
was removed; no match or multiple selected values returns 5 without mutation.
Global operations use `$HOME/.gitconfig`; `HOME` must be an absolute path inside
the `/home/web` workspace and defaults to `/home/web` when absent.
Config flags must precede operands unless `--` ends option parsing, and invalid
shapes return 2 before repository discovery. Unset preserves unrelated config
bytes and caps keys at 4,096 bytes, the selected file at 1 MiB, and parsed
entries at 100,000.
Agent timing scripts can use UTC-only `date`, including `+FORMAT` and `%s`, and
finite `sleep` durations with `s`, `m`, or `h` suffixes up to 60 seconds.
Line-oriented transforms include one bounded `sort -k` field key with an
optional numeric modifier. Fields use whitespace runs by default, or exactly
one non-NUL byte from `-t BYTE`, `-tBYTE`, or `--field-separator=BYTE`;
adjacent separators create empty fields, numeric parsing stays inside the key,
and ties use the complete raw record. Sort keys accept equivalent separated
`-k KEY`, compact `-kKEY`, and long `--key KEY`/`--key=KEY` spellings. `cut -c` supports unions of closed or
open UTF-8 code-point ranges. `cut -z`/`--zero-terminated` selects one byte-delimited
field from bounded NUL records, preserving opaque bytes and validating 16 MiB
input/output, 100,000 records, and 1 MiB per record before stdout. More complex
key spans and field lists fail explicitly.
Search accepts matching long aliases for its documented short flags, including
`--extended-regexp`, `--recursive`, `--with-filename`, and `--regexp=PATTERN`.
Both `grep` and `rg` union repeated `-e`/`--regexp` patterns rather than letting
the final flag overwrite earlier patterns. Up to 64 independently validated
patterns and 65,536 aggregate pattern bytes are accepted; duplicate matches
select a record once and `-v` inverts the union. Line-mode search preflights at
most 100 explicit inputs and buffers at most 1,000,000 output bytes. It examines
at most 16 MiB, 100,000 records, and 1 MiB per record before publishing output,
so invalid patterns, later file errors, and resource failures are atomic.
`realpath` reuses the bounded physical resolver behind `readlink -f`. Default
and `-e` mode require every component to exist and retain per-operand streaming
output. `-m`/`--canonicalize-missing` resolves the existing prefix physically,
then permits and lexically normalizes a missing suffix. Its complete 1..100
operand result is staged before stdout, with 4,096-byte input/result, 256
processed-component, and 40-link bounds. `-e` and `-m` are mutually exclusive;
`-P` is an accepted explicit spelling of the only supported traversal mode.
Branch-review workflows can use `git merge-base A B`, the silent ternary
predicate `git merge-base --is-ancestor A B`, `git diff A...B`, and
path-filtered `git log -- PATH`. The ancestry predicate returns 0 only for
true, 1 only for a fully evaluated false result, and 2 for invocation,
repository, revision, object, or traversal errors. It resolves both commit-ish
operands first, ignores stdin/index/worktree state, and caps the descendant walk
at 100,000 unique commits and 1,000,000 parent edges.
Object guards can use exact `git cat-file -e OBJECT`, a silent ternary
predicate over the existing ancestry, tag-peeling, and `REV:path` expression
surface. It returns 0 for a readable object, 1 for an unresolved or missing
object, and 2 for invalid invocation, repository discovery, or corrupt object
validation; expressions are capped at 4,096 UTF-8 bytes and stdin/index/worktree
state is ignored. The `-t`, `-s`, and `-p` modes keep their normal output.
Staging guards can use `git check-ignore [-q|--quiet] [--] PATH...` for existing
or prospective paths. It emits ignored original operands, returns 0 when any
match and 1 when none do, and never reports an index-tracked path. Exact
`--stdin -z`/`-z --stdin` mode preserves literal UTF-8 tabs, newlines, leading
dashes, and input order in NUL-delimited records; LF-framed operand mode rejects
newline-containing names. The complete batch, repository inspection, and
bounded output are staged before publication. Paths are lexical, traversal
through worktree symlinks is rejected, and nested
`.gitignore` plus `.git/info/exclude` matching is shared with
`ls-files --exclude-standard`. Usage returns 2; repository, limit, path, and
inspection errors return 128. Operand mode accepts 100 paths; NUL stdin accepts
4,096 records and 1,000,000 bytes. Further limits are 4,096 UTF-8 bytes per
path, 1 MiB output, 128 components and ignore files, 1 MiB per ignore file, 8
MiB aggregate rules, 100,000 patterns, and a 16 MiB / 100,000-entry index. It
deliberately omits global excludes, `--no-index`,
verbose provenance, and pathspec magic.
Log/show machine projections support literal text with `%H`, `%h`, `%s`, `%n`,
`%%`, and ASCII `%xNN`; show name-only and
name-status output reuse the byte-exact diff projections, while numstat caps
records, paths, blobs, line counts, examined bytes, and output before returning
status 2 without a partial projection. Log also accepts first-parent
`--name-only`, `--name-status`, and `--numstat` projections. Projected text
blocks end with an empty line; `-z` blocks end with an empty NUL record, and
custom formats must be single-line and contain `%H` or `%h`. Output is buffered
and bounded to 1,000 selected commits, 100,000 records, and 8 MiB before any
bytes are returned. Bounded
`git apply [--cached] [-R|--reverse] [--check] [--] [PATCH|-]` validates one
UTF-8 Git patch transactionally before changing regular files or the index.
Reverse and cached modes may each appear once; reverse exchanges paths, ranges,
additions/deletions, creations/removals, and exact
rename direction while preserving context and no-final-newline bytes. Check
and action use the same fully staged plan; status 0 is applicable/applied, 1 is
valid but inapplicable to the selected worktree/index layer, and 2 is invalid,
bounded, or a repository/input/I/O failure, with no stdout. Cached mode reads
only index preimages, stages a private replacement index, and never changes
HEAD or worktree bytes. Caps are
8 MiB input, 100 sections, 10,000 hunks, 100,000 total lines, 4,096 bytes per
target path, 16 MiB per source/result file, and 64 MiB aggregate source/result.
Cached mode also caps current/result indexes at 100,000 entries and 16 MiB.
Binary, symlink, mode-only, combined, three-way, fuzzy, reject-file, and prefix
remapping forms are unavailable.
Reachability scripts can use `git rev-list --count [--max-count N] REVISION`;
listing and counting share a unique merge-DAG walker, commit-ish tags are
peeled, and uncapped traversal fails atomically above 100,000 commits.
Short porcelain status C-quotes unusual paths, while its `-z` form emits exact
rename destination/source fields in Git order. Unsupported status options emit
one stable `git: unsupported status option: OPTION` line without exposing
missing `.git/shallow`, graft, or other engine metadata paths.
`sed -i[SUFFIX]` prevalidates every explicit regular input before creating a
temporary or writing, then writes through a sibling temporary and leaves the
current original in place if its stream processing fails. Missing paths,
directories, and `-` reject the whole request before any earlier input changes.

`git.c` builds the native `/bin/git` frontend. It forwards Git CLI arguments to
the browser-hosted libgit2 Wasm engine, which shares `/home/web` directly.
`/bin/python`, `/bin/python3`, `/bin/curl`, `/bin/cc`, `/bin/compile`, `/bin/ld`,
and `/bin/link` are host marker entrypoints. Python stdout/stderr travel through
raw Pyodide writer callbacks and are flushed before each invocation ends, so
NUL and unterminated bytes remain in their selected redirect, duplicate, or
pipeline sink instead of leaking into a later command. Each Python program
stream is capped at 16 MiB; the shell's pipeline/substitution capture cap remains
1 MiB. Text command substitution rejects NUL with status 2 before applying its
surrounding assignment; binary records belong in a file or pipeline.
The browser curl implementation is installed as `/home/web/slop/curl-host.ts`
so its parser, Fetch boundary, limits, and file handling can be audited in the
same workspace.

Make and coreutils use spawn ABI v3. Slop and the Git frontend use v7, which
includes the v6 stderr and ordered stdout/stderr descriptor routing plus an
explicit argument count, so empty child-process arguments are distinct from
the legacy list terminator. The `env` launcher uses v8, retaining counted argv
while marking its supplied environment exact so the runtime cannot add default
metadata. Slop and Git each cap a serialized child argv at
1 MiB; Slop separately caps a parsed command at 127 total words.
Nested guests inherit their caller's stdout and stderr sinks, so Make recipe
descendants remain inside the surrounding pipe or redirection.
Make freshness compares the filesystem's full seconds-plus-subseconds mtime.
A normal prerequisite equal to its target is conservatively stale, while an
order-only prerequisite remains excluded. Normal builds, question mode, and
automatic `$?` share this comparison; `$?` omits order-only dependencies.
Touch mode advances an existing target without changing its bytes, so an
immediate same-tick edit cannot be reported current merely because its coarse
seconds field matches the output.
