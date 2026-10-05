# ARIA — the state snapshot trusts the clock to see a mutation between its passes (2026-10-04)

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-353

`build_snapshot` reads every attested leaf between two namespace projections and then
re-validates the directory trie. Both comparisons use one stat identity, `_stat_identity`
(`aria-kernel/aria_kernel/state_snapshot.py:1228`): `st_dev`, `st_ino`, `st_mode`, `st_mtime_ns`,
`st_ctime_ns`. It has no size and no content. Pass one is compared with pass two by that identity
(`state_snapshot.py:327`), and the final directory revalidation compares the same identity
(`state_snapshot.py:1094`).

Linux takes inode timestamps from the coarse clock, so a write lands on a jiffy boundary: 1 ms at
HZ=1000, 4 ms at HZ=250. Some filesystems keep whole seconds. Two changes inside one tick leave both
timestamps exactly as they were. Two mutations are then invisible to the snapshot:

- a same-size rewrite of an attested leaf after it was read, with the same inode and the same
  timestamps. The manifest pins a sha256 of bytes that are no longer on disk.
- an entry created in a walked directory after pass two. A directory's size does not change for
  one entry, so nothing in its identity moves. If the entry matches a surface, the manifest misses
  a surface that is present.

Measured. Both `tests/test_state_snapshot.py` tests that exercise exactly these cases failed
together on the aria-kernel workflow's `suite (4)` shard, with `AssertionError: SnapshotError not
raised` at lines 433 and 598. That happened on PR 1785 (run 37233417889, attempt 1, job
111527684043; attempt 2 passed) and on PR 1756 (run 37240561964, attempt 1, job 111548268721).
Locally, on this host (HZ=1000, measured tick 1.000 ms), the unmodified tests failed 7/200 and 2/200
in isolation, and once in a whole-module run. The fixture write and the mutation are a median of
1.06 ms and 1.48 ms apart, about one tick. So the outcome depended on whether the tick advanced in
between. The other mutation tests replace an inode or change the set of matches, so they never
depended on the clock.

Rule: a snapshot manifest attests only bytes and a namespace it has re-observed after its last
read. No consistency check of the snapshot depends on the filesystem clock advancing.

Fix (product, not test):

- After pass two, every attested leaf is read again and its sha256 is compared with the manifest
  entry (`_reverify_snapshot_leaf_contents`). This costs one more read of the attested bytes,
  bounded by `SNAPSHOT_MAX_INPUT_BYTES`.
- Each walked directory's projection row carries an entry-set digest: name, inode and file type of
  every entry, sorted, from `d_ino` and `d_type`. It is scanned once per directory per pass, not
  once per surface, and charged to the same discovery budget. Pass one and pass two compare it, and
  the final revalidation re-scans each directory against pass two's digest.

Tests. A `_timestamps_frozen_in_one_tick` fixture makes every stat the snapshot observes report
unchanging timestamps, which is the worst case. Both tests run under it and fail deterministically
without the fix (20/20 runs). Disabling either half of the fix fails its own test. A new test
checks that a quiet tree builds the same manifest with frozen timestamps, so neither new check
refuses an untouched tree. The fd-exhaustion test now opens its window when the final directory
revalidation starts, because the leaf re-read runs between pass two and that revalidation.

Not covered: a change that restores the same bytes, or the same entry set, inside one tick (ABA).
No stat or content check can see that without a filesystem change counter (statx
`STATX_CHANGE_COOKIE`), which Python does not expose.
