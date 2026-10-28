# ARIA D6-SEC review: non-blocking findings (2026-10-25)

The D6-SEC package (the sandbox-pin lift never runs git with configuration the seat's tree chooses:
ARIA-HIGH-964, with ARIA-LOW-971) was reviewed on branch `feat/aria-d6-seat-pin-proof` at head
`d460f7917` (the test commit `746707d90` and the fix commit) under lenses security and ssot. Neither
lens found a blocker: both confirmed that ARIA-HIGH-964 and ARIA-LOW-971 meet their close
conditions. The nine points below did not block the merge. Each one's path and line were re-read at
`d460f7917` before registration, the four probes behind the points were run again by the clerk
(their temporary files under the clerk's own directory), and none was dropped: every evidence line
holds, with these corrections to the review's wording. The unbounded read the ssot review cites at
`validation.py:744` is the `handle.read()` at `:741` (`:744` is a `close`). The record parser in
`autonomy_evidence.py` reads one path with `ls-tree -z`, not `-r`. The `_object_oid` call the ssot
review places at `main_anchor.py:496` and `:518` is at `:381`, inside `_read_verified`, which those
two lines call.

Nine points are seven findings, in two merges. The security review's unbounded pre-admission read
and the ssot review's point that the lift reads and hashes every file of base_sha's tree are the
same lines (`validation.py:619-632`) with the same fix, so they are registered once, at the higher
severity, with the per-lift volume in the failure scenario; that point's second claim, the
check-then-use guard `_refuse_pin_path_through_symlink`, is a reading of the same concept as the
second-reader finding and is registered there. The ssot review's two object-format points (the hash,
and the spelling of git's format) share the `main_anchor.py` `oid_length == 64` site, the owner
module and the restatement scan, so they are one finding with two required parts.

The ARIA finding id space ends at 999 (`nextFindingId` in `tools/gates/finding-registry-store.ts`
refuses a fourth digit), and the ids 974 to 992 were already claimed (the allocator reads the
registries of all sibling worktrees, the reservation ledger and the id aliases), so ARIA-MEDIUM-993
to ARIA-LOW-999 were the only seven left. The second merge was made to fit them, not only because
the points overlap: eight separate findings needed id 1000, which the registry refuses ('Finding ID
space exhausted for domain ARIA (maximum 999)'). The merged finding keeps each point's evidence and
its own close part and test, so no condition was lost. After these rows the ARIA domain has no free
id: the next ARIA finding needs the id format widened first, or a different domain.

Three existing rows are touched by these points and are not edited here (the registry is append-only
and chained): ARIA-LOW-972's evidence lines are stale and its scope widened (first finding);
ARIA-LOW-973 now stands on `validation.py:664` and `:689` (last finding); ARIA-MEDIUM-966 is the
subject of the third finding. The ids continue after the D6 review's last row (ARIA-LOW-973); the
allocator started at ARIA-MEDIUM-993.

## ARIA-MEDIUM-993

lift_sandbox_pin reads and hashes every tracked path of base_sha from the seat's tree in full, with
no size bound and before path admission, so a seat that swaps any tracked non-test file for a huge
sparse file exhausts kernel memory instead of being refused by name; every lift also reads all
14,493 tracked blobs (about 149 MiB) of aqua-saas

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens security (with the ssot point on the same reads);
  registered by the D6-SEC findings clerk; non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964 (the fix commit that introduced the reads).
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:619-632` (the comparison loop: `_read_beneath` for every
    base path, listed or not, then blob_object_id over the whole read, before `_admit_pin_path`)
  - `aria-kernel/aria_kernel/validation.py:741` (handle.read() with no limit)
  - `aria-kernel/aria_kernel/validation.py:664` (ls-tree is asked for no sizes (no -l), so nothing
    bounds a read by the base blob's size)
  - `aria-kernel/aria_kernel/git_object_id.py:90-92` (blob_object_id concatenates header and content
    (a second copy) and takes bytes, not a stream)
- Rule: Untrusted input is bounded where it is read (root CLAUDE.md, Security: input validation;
  ARIA-LOW-972's rule), and a seat's untrusted output is refused by a named error, never by a crash.
- Failure scenario: A hostile seat replaces any tracked file that is not a test (README.md, say)
  with a sparse file (truncate -s 64G; no disk blocks used). The comparison loop reads that file
  whole into kernel memory before path admission could refuse it by name, then builds a second copy
  to hash it. The reviewer's probe, run again at d460f7917 with a 3 GiB sparse README.md and the
  address space capped at 2 GiB, ends in MemoryError ('the kernel read the whole non-test file
  before admission'). At f5c9dc45f, the version before the fix commit, the same probe is refused by
  name (red_first_pin_path_not_a_test: 'README.md'), because git's stat comparison saw the size
  change and never read the file. Uncapped, the same file runs the kernel out of memory on the prod
  droplet. Even with no hostile seat, every lift reads and hashes every blob of base_sha's tree
  (14,493 blobs, about 149 MiB on aqua-saas at this head). The bound that ARIA-LOW-972 asks for
  covers the admitted pin files only, so it does not reach these comparison reads, which can
  legitimately be larger than any pin limit. It needs an active seat, and nothing calls the lift in
  production yet (ARIA-HIGH-963).
- Verified: At d460f7917 the clerk ran
  /root/aria-handover/2026-10-21/build/D6-SEC/clerk/probes/probe_lift_seat_tree.py bigfile from
  aria-kernel/ (a copy of the reviewer's probe that writes its temporary files under the clerk's own
  directory): the sparse file uses 0 blocks and the lift raised MemoryError. The f5c9dc45f result is
  the reviewer's log. The blob count and size come from 'git ls-tree -r -l HEAD' (14,493 blobs,
  148.6 MiB). The security review's MEDIUM point and the ssot review's 'reads and hashes every file'
  point are one finding: same lines, same fix.
- Related: ARIA-LOW-972 (its evidence lines validation.py:621-622, :450 and :553-562 no longer
  match: the unbounded read is now :741 and covers every tracked file, not only the lifted ones; its
  row is not edited here); ARIA-MEDIUM-994 (the bound belongs in the one reader); ARIA-HIGH-964 (the
  fix commit that introduced the reads); ARIA-HIGH-963 (the lift has no caller yet).
- Close condition: The comparison reads nothing it cannot bound: base sizes come from ls-tree -r -l;
  a path whose fstat size differs from its base blob's size counts as changed without being read;
  only a file of equal size is read, never past the base blob's size, and hashed as a stream (no
  second copy); a changed path's content is read for the pin only after path admission and only up
  to the pin's file-size limit (ARIA-LOW-972). Tests through the lift: a tracked non-test file
  replaced by a sparse file larger than the process's address space is refused by name
  (red_first_pin_path_not_a_test), not MemoryError; a same-size file whose bytes differ is still
  seen as changed.

## ARIA-MEDIUM-994

lift_sandbox_pin's `_read_beneath` and `_is_symlink_at` are a second owner for reading a tree
another party writes without following a link, although untrusted_tree.UntrustedTree is documented
as the one way the host reaches such a tree; the two answer the same entries in different words, and
`_read_beneath` opens the last component before it checks its type

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens ssot; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:696-752` (`_read_beneath` and `_is_symlink_at`: an
    O_NOFOLLOW walk per component, O_NONBLOCK, a regular-file check on the descriptor)
  - `aria-kernel/aria_kernel/validation.py:726` (the last component is opened before its type is
    known)
  - `aria-kernel/aria_kernel/untrusted_tree.py:22-30` (UntrustedTree: 'the one way the host reaches
    such a tree', the same walk, refusals by UntrustedEntryRefused)
  - `aria-kernel/aria_kernel/untrusted_tree.py:154-171` (open_file and read: lstat the entry, open
    it, check the descriptor; read takes a limit)
  - `aria-kernel/aria_kernel/validation.py:783-794` (`_refuse_pin_path_through_symlink`, called at
    :767: a third, check-then-use component walk, for the write into the kernel's own worktree; the
    seat does not race it)
- Rule: One owner per concept (ARIA-CRITICAL-214): reading a tree another party writes, without
  following a link, belongs to untrusted_tree.UntrustedTree, and every host reader reads through it.
- Failure scenario: The same tree read through both owners gives different answers (the reviewer's
  probe, run again by the clerk at d460f7917). A link as the last component is
  UntrustedEntryRefused(symlink) for UntrustedTree and ('symlink', target) for `_read_beneath`; a
  FIFO is refused versus ('other', b''); a regular file where a directory should be is
  refused(regular_file) versus 'missing'; an absent path raises FileNotFoundError versus 'missing'.
  A rule added to one owner (the size bound of ARIA-LOW-972, a new refusal class) has to be made
  twice, or the two drift. `_read_beneath` also opens the last component before it checks the type,
  where UntrustedTree lstats first and never opens a device node; a seat cannot create a device
  node, so that needs a privileged writer. Nothing calls the lift in production yet (ARIA-HIGH-963).
- Verified: At d460f7917 the clerk ran
  /root/aria-handover/2026-10-21/build/D6-SEC/clerk/probes/probe_two_untrusted_readers.py from
  aria-kernel/ (PYTHONPATH=.): the six-row table is identical to the reviewer's. A grep finds no use
  of `_read_beneath` or `_is_symlink_at` outside validation.py.
- Related: ARIA-MEDIUM-993 (the size bound lands in the one owner); ARIA-LOW-971 (closed by
  d460f7917; its test must stay green); ARIA-LOW-972.
- Close condition: UntrustedTree gains one entry accessor that answers missing, regular file (its
  bytes, bounded by a limit the caller passes), link target or other; lift_sandbox_pin reads through
  it; `_read_beneath` and `_is_symlink_at` are deleted; the write-side guard moves to the same
  owner, or its different job (a kernel-made worktree no seat races) is stated at its definition.
  Tests: the probe's six paths get one answer each through the one reader; the ARIA-LOW-971 swap
  test (a parent directory swapped for a symlink) still gets red_first_pin_path_escapes_worktree; a
  FIFO or a device node as the last component is never opened.

## ARIA-MEDIUM-995

ARIA-MEDIUM-966 is still OPEN although d460f7917 deleted the duplicate it describes (the lift's own
name-status argv and zip parse), and its close condition (a working-tree mode in change_paths that
lift_sandbox_pin reads through) contradicts the ARIA-HIGH-964 fix, because it would run git diff
over the seat's tree again

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens ssot; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964.
- Evidence:
  - `docs/reviews/claude/2026-10-25-aria-d6-review-findings.md:140-172` (the ARIA-MEDIUM-966 section
    and its close condition)
  - `docs/reviews/_registry/findings.jsonl:3248` (the ARIA-MEDIUM-966 row, state OPEN)
  - `aria-kernel/aria_kernel/validation.py:659-693` (the lift now reads base entries with ls-tree
    and the tree with ls-files --others against an empty gitdir; no name-status argv or zip parse is
    left in validation.py)
  - `aria-kernel/aria_kernel/change_paths.py:65-70` (name_status_args, the owner, still takes two
    revisions)
- Rule: A tracked finding states the work still to be done (root CLAUDE.md, Review Finding
  Traceability): an OPEN row whose subject is gone, and whose close condition asks for the fault
  ARIA-HIGH-964 removed, sends the next implementer to the wrong change.
- Failure scenario: Someone who takes ARIA-MEDIUM-966 as written gives change_paths a working-tree
  mode and has lift_sandbox_pin run git diff over the seat's tree, which is the command that ran a
  seat-chosen clean filter in the kernel (ARIA-HIGH-964's probe). The row also stays OPEN, and in
  the projection, for good, because no commit's Closes: trailer names it: d460f7917 closes
  ARIA-HIGH-964 and ARIA-LOW-971 only.
- Verified: At d460f7917: grep -rn name-status over aria-kernel/aria_kernel finds the argv in
  change_paths.py (the owner) and nothing in validation.py; the registry row is OPEN.
- Related: ARIA-MEDIUM-966; ARIA-HIGH-964.
- Close condition: ARIA-MEDIUM-966 is closed by a commit whose Closes: trailer names it and whose
  body says that d460f7917 removed the lift's own argv and parse (the data-only comparison owns the
  lift's changed-path read; change_paths keeps the revision-to-revision reads), citing the
  ARIA-HIGH-964 tests in aria-kernel/tests/test_seat_pin_proof.py (SeatTreeIsReadAsDataTests) that
  fail if git runs over the seat's tree; or its row is rewritten to that scope with the
  contradicting condition removed. This finding closes with it.

## ARIA-LOW-996

A FIFO named .gitignore anywhere in the seat's tree stalls lift_sandbox_pin's listing for
hermetic_git's 60 s timeout and then raises a raw subprocess.TimeoutExpired, not a named
GovernanceError, although `_read_beneath`'s docstring says a fifo cannot stall the kernel

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens security; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:689-690` (ls-files --others --exclude-standard: git opens
    an in-tree ignore file with a blocking open())
  - `aria-kernel/aria_kernel/validation.py:703` (the docstring claim 'a fifo cannot stall the
    kernel')
  - `aria-kernel/aria_kernel/workspace_view.py:69-77` (hermetic_git: timeout=60;
    subprocess.TimeoutExpired is not caught)
- Rule: A seat's untrusted output is refused by a named error, never by a crash or a stall: every
  refusal of the lift is a GovernanceError that names its reason.
- Failure scenario: A seat that runs mkfifo tests/.gitignore (or in any directory of the tree) makes
  the lift wait out the 60 s timeout and then raise subprocess.TimeoutExpired out of
  lift_sandbox_pin. The reviewer's probe, run again at d460f7917, printed 'lift raised
  subprocess.TimeoutExpired ... elapsed: 60.1s'. It needs an active seat and costs one lift 60 s and
  a raw exception; no data or execution is exposed. Nothing calls the lift in production yet
  (ARIA-HIGH-963).
- Verified: At d460f7917 the clerk ran
  /root/aria-handover/2026-10-21/build/D6-SEC/clerk/probes/probe_lift_seat_tree.py fifo from
  aria-kernel/: 'lift raised subprocess.TimeoutExpired ... elapsed: 60.1s'.
- Related: ARIA-LOW-973 (the other raw exception out of the lift's listing); ARIA-MEDIUM-994 (the
  one reader a kernel-side walk would use).
- Close condition: The listing cannot block on an entry the seat made: either the lift catches the
  timeout and raises a GovernanceError named red_first_sandbox_unreadable, or the listing is built
  by a kernel-side walk that applies ignore rules only from regular files. Test: a FIFO named
  .gitignore in the tree makes lift_sandbox_pin raise a GovernanceError whose reason starts with
  red_first_sandbox_unreadable, not subprocess.TimeoutExpired.

## ARIA-LOW-997

lift_sandbox_pin has its own judge of 'this path changed against base_sha' (raw on-disk bytes
against the base blob id) that disagrees with git's for any file the checkout converts (eol, a
smudge filter such as LFS, ident), so a seat that only added a test gets the whole pin refused; it
fails closed, and aqua-saas has no eol or filter rules

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens ssot; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:619-632` (the comparison: bytes read from disk, blob id
    computed with no conversion)
  - `aria-kernel/aria_kernel/git_object_id.py:90-92` (blob_object_id hashes the bytes as given
    (hash-object --no-filters))
  - `.gitattributes:1-28` (aqua-saas's .gitattributes holds two merge= rules only (:10, :28): no
    eol, text, filter or ident)
- Rule: One judge per question: whether a path changed against base_sha is answered once, and for a
  checkout that converts files the answer must not differ from git's (the same class as
  ARIA-LOW-970: a repository property the lift's rule does not know).
- Failure scenario: In a repository whose .gitattributes says '\*.txt eol=crlf', a seat that only
  adds tests/test_calc.py leaves git status at '?? tests/', yet the file notes.txt on disk is
  b'one\r\ntwo\r\n' while its blob holds LF. The lift reads it as changed and refuses the whole pin:
  red_first_pin_path_not_a_test: 'notes.txt'. It fails closed; only repositories other than
  aqua-saas are affected.
- Verified: At d460f7917 the clerk ran
  /root/aria-handover/2026-10-21/build/D6-SEC/clerk/probes/probe_eol_conversion.py from aria-kernel/
  (PYTHONPATH=.): the output is the one above.
- Related: ARIA-LOW-970 (the same class: untracked .pyc files refuse the pin); ARIA-MEDIUM-993.
- Close condition: The lift compares each file with the base blob as the checkout writes it (for
  example git cat-file --filters in the kernel's own repository, with kernel configuration only and
  never the seat's tree), or it states the limit where the lift is admitted and refuses by a named
  code that names the conversion. Test: the probe's repository ('\*.txt eol=crlf') with a seat that
  only adds tests/test_calc.py lifts that file, or is refused by the named conversion code.

## ARIA-LOW-998

git_object_id is not the one owner of the git object hash and format: `main_anchor._object_oid`
computes the same object id as blob_object_id and picks the digest by 'oid_length == 64', git's
format spelling is mapped in git_containment, state_store (a raw KeyError on an unknown spelling)
and the lift, and nothing detects it, because test_git_object_id.py does not test blob_object_id

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens ssot; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-LOW-518.
- Evidence:
  - `aria-kernel/aria_kernel/main_anchor.py:334-338` (`_object_oid`: the object header, sha1 or
    sha256 by 'oid_length == 64')
  - `aria-kernel/aria_kernel/main_anchor.py:381` (the call in `_read_verified`, which re-hashes each
    object against its id)
  - `aria-kernel/aria_kernel/main_anchor.py:496` (a blob read through `_read_verified`)
  - `aria-kernel/aria_kernel/main_anchor.py:518` (blob reads through `_read_verified`)
  - `aria-kernel/aria_kernel/git_object_id.py:90-92` (blob_object_id: the same hash for a blob)
  - `aria-kernel/aria_kernel/git_object_id.py:39-43` (ObjectFormat, the owner, valued by id length;
    no parse of git's spelling)
  - `aria-kernel/aria_kernel/git_containment.py:265` (`_OBJECT_FORMATS`: a string-to-string table of
    git's two spellings)
  - `aria-kernel/aria_kernel/git_containment.py:943` (the lookup of the rev-parse
    --show-object-format answer, refusing object_format_unresolvable)
  - `aria-kernel/aria_kernel/state_store.py:2245` (ObjectFormat[...strip().upper()], new in the
    D6-SEC diff: an unknown spelling raises a raw KeyError)
  - `aria-kernel/aria_kernel/validation.py:631` (ObjectFormat(len(oid)): the format taken from the
    id's length)
  - `aria-kernel/tests/test_git_object_id.py:15-21` (the imports: blob_object_id is not among them)
  - `aria-kernel/tests/test_git_object_id.py:33-43` (the restatement scan: id regexes and len(...)
    == 40 tests only)
- Rule: One owner per concept: git_object_id.py names itself the one owner of what a git object id
  is (ARIA-LOW-518) and owns ObjectFormat, and the D6-SEC fix commit says blob_object_id is now the
  one owner of the blob hash; every other module reads a hash and a format through it.
- Failure scenario: Hash: two code paths build the object header and hash it, one per owner. A
  change to the header, or a third object format, lands in one and not the other, and no test fails:
  the scan looks for id shapes and length tests, and `_object_oid` builds its header with an
  f-string over a kind argument. Format: an unknown spelling is refused by a named reason in one
  reader (git_containment: object_format_unresolvable), by a raw KeyError in another (state_store)
  and not at all in the rest, where an id's length decides, so a format git adds is found one reader
  at a time. Read from the code; not probed.
- Verified: At d460f7917: a grep of aria-kernel finds blob_object_id only in validation.py,
  state_store.py and git_object_id.py, and the header b'blob %d\0' only in git_object_id.py; the
  existing restatement scan in test_git_object_id.py does not match ObjectFormat(len(oid)) or
  'oid_length == 64'. The ssot review's two points (the hash, and the format spelling) are one
  finding here: they share the main_anchor 'oid_length == 64' site, the owner module and the
  restatement scan.
- Related: ARIA-LOW-999 (the same kind of finding: git facts restated outside an owner).
- Close condition: Two parts, both required. (1) The hash: git_object_id has one object_id(kind,
  body, ObjectFormat) (blob_object_id is its blob case), `main_anchor._object_oid` is deleted and
  `_read_verified` reads through it; test_git_object_id checks blob_object_id and the new function
  against git hash-object for sha1 and sha256, and its restatement scan fails on a hashlib.sha1 or
  sha256 construction over an object header outside the owner. (2) The format: git_object_id gains
  one parse of the rev-parse --show-object-format answer (and the id-length mapping, if the lift
  keeps it) that refuses an unknown spelling by a named error; git_containment, state_store,
  validation and main_anchor read a format through it; tests: an unknown spelling raises the named
  error, not KeyError, and the scan also fails on a second spelling table or length-to-format test.

## ARIA-LOW-999

The submodule mode constant ('160000') and a parser for git ls-tree -z records each exist in several
modules and the lift adds one more of each; its new listings also decode with text=True, where
`workspace_view._listing` reads bytes and calls os.fsdecode

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the D6-SEC review round 1, lens ssot; registered by the D6-SEC findings clerk;
  non-blocking at merge.
- Plan item(s): D6; ARIA-HIGH-964.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:656` (`_GITLINK_MODE` = '160000')
  - `aria-kernel/aria_kernel/workspace_view.py:57` (`_GITLINK_MODE` = '160000')
  - `aria-kernel/aria_kernel/main_anchor.py:393` (`_GITLINK_MODE` = '160000')
  - `aria-kernel/aria_kernel/validation.py:659-672` (`_base_tree_entries`: a parser of ls-tree -r -z
    records that unpacks meta.split(' ') into three names, unchecked)
  - `aria-kernel/aria_kernel/self_improvement.py:669-674` (a second parser of ls-tree -r -z records)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:1776-1812` (a third reader of ls-tree -z records
    (one path, not -r), with checks of the mode, type and id and named errors)
  - `aria-kernel/aria_kernel/validation.py:664` (the ls-tree listing decoded as text (hermetic_git's
    default text=True))
  - `aria-kernel/aria_kernel/validation.py:689` (the ls-files listing, decoded the same way)
  - `aria-kernel/aria_kernel/workspace_view.py:140-147` (`_listing`: text=False and os.fsdecode)
- Rule: One owner per concept: a git constant and the parse of a git record format are stated once
  and every reader reads through that owner.
- Failure scenario: The parsers read one record format and differ in what they check: the lift's
  unpacks meta.split(' ') into three names, so a malformed record raises a raw ValueError where
  autonomy_evidence raises a named error (read from the code; not probed). The text decoding raises
  UnicodeDecodeError on a non-UTF-8 path name, which ARIA-LOW-973 tracks and which now stands on
  lines :664 and :689 (that row's own evidence lines are the older :603-606 and :610-611; it is not
  edited here).
- Verified: At d460f7917 the nine locations are as cited. The autonomy_evidence reader takes one
  path (ls-tree -z, no -r), so it shares the record format and its checks, not the -r listing.
- Related: ARIA-LOW-973 (the decoding); ARIA-LOW-998 (the same kind of finding).
- Close condition: One module owns the gitlink mode and the ls-tree -z record parse (mode, type, id,
  path; a named error on a malformed record), and the lift, self_improvement, autonomy_evidence,
  workspace_view and main_anchor read through it; listings are read as bytes and decoded with
  os.fsdecode. Tests: a scan for the gitlink mode literal outside the owner; a malformed ls-tree
  record raises the named error through the lift's reader; the ARIA-LOW-973 test (a path named with
  the byte 0xff is refused by name).
