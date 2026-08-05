# ARIA Wave 1 — the loser of a race still did the work

Date: 2026-08-03
Branch: `claude/aria-w1-contention-replay`
Scope: `aria_kernel/contention_replay.py` (new), `state_store.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1 PR 2.6

## The gap

`publish_state` is a compare-and-swap: a plain `git push` to a fast-forward-only
branch, so when two lanes publish from the same tip the **server** rejects the
second. PR 2.3 made that refusal safe — the commit is rolled back, the rows stay
staged, nothing is overwritten.

Safe, and then the story ends. The caller is told to "fetch and rebuild against
the new tip", and on the scheduled lanes there is no caller to do that: the rows
sit in a worktree nothing revisits. **A correct refusal that leaves work stranded
is still work stranded.**

Rebuilding is deterministic, so it should not be by hand.

## The common prefix is proven, not assumed

This is the part that makes the whole thing safe rather than merely convenient.

Every ledger row carries a `ledger_hash` computed over the entire chain behind
it, and the snapshot both lanes published from records each surface's
`row_count` and `tail_ledger_hash`. So _"do these two files share their first N
rows?"_ is exactly answerable: **the row at index N−1 must carry the base's tail
hash in both files.** A match there implies the whole prefix matches — that is
what a hash chain is for.

Anything else is a rewrite wearing an append's clothes, and it is refused rather
than merged.

The resolution is deliberately **not** a git merge. A hash-chained JSONL file has
no meaningful textual merge, and `-X ours` / `-X theirs` would silently drop one
lane's rows — the exact outcome ORPHAN-CRITICAL-484 exists to prevent, arrived at
by a different road.

## The winner is checked too

Tempting to trust the winner because it won. But winning the push means only
_arriving first_; it says nothing about whether that tree descends from the base.
Checking only the loser would let a lane that rewrote its own history absorb the
loser's rows into a chain neither of them shares.

This one is worth reading twice, because **my first test of it did not test it.**
I asserted a refusal using a base hash that matched _neither_ tree, so the
refusal came from the loser's check. Mutating the winner's check away left all
twelve tests green. The isolating test now has the loser descending from the base
cleanly and only the winner diverging.

## Order is the safety property

`publish_with_contention_replay` copies the loser's ledgers **out** before
resetting the worktree, so the rows are never only in memory across a destructive
git operation. Then `git reset --hard` makes the tree exactly the winner's — not
mostly the winner's — and the replay adds this lane's suffix back through the
normal appender, which re-chains every row and refreshes the adjacent index.

A replayed row is **re-chained, not copied**: `ledger_hash` describes the
predecessor, so carrying the old value would produce a file that reads as valid
to a naive eye and fails the real verifier.

## Why the orchestrator is a layer above `publish_state`

`publish_state` has one job: prove descent, then commit and push or refuse.
Retrying needs a **new** snapshot — the surfaces changed and the predecessor is
now the winner's — so folding the loop inward would put the ancestry proof and
the thing it checks inside one function. The proof stays non-omittable either
way: the orchestrator has no path to the branch that does not go through
`publish_state`.

Only a lost race is retried. Any other refusal is a statement about _this_ tree —
unproven ancestry, a lost surface — and retrying would make the same true
statement again, more slowly, resetting the tree each time.

## Replay is not idempotent, and the test found that

Written expecting a refusal on retry; it **duplicated** instead. The cause is
structural: after a successful replay the winner holds the loser's rows, but the
loser's own file is unchanged, so the same suffix is extracted again. The base
advances only when the lane re-snapshots and re-publishes, and a retry between
those two points appended every row twice.

The guard is a **tail** match on logical content, not set membership. Two lanes
can legitimately emit rows that look alike and a membership test would drop
those; requiring the winner's suffix to end with the loser's _entire_ suffix, in
order, describes only the state a prior replay produces.

## Two plan items corrected

**The publish lease is not built, and that is a decision rather than an omission.**
PLAN §2.6 said to reuse `autonomous_host_lease` as an advisory publish lease. Its
purpose was to stop the two lanes racing habitually — but the race is now
_correct and cheap_: one extra fetch, reset, replay and push, measured in
seconds. An advisory lease would add a second coordination mechanism whose own
failure mode — a crashed lane's stale lease blocking a healthy one's publish — is
strictly worse than the problem it removes. Adding a second answer to "who may
publish" is the pattern this wave has spent five PRs removing. The CAS is the
answer.

**A store-checked-out tools root cannot be used until it is bound**, and finding
that out is why the wiring test exists at all. `repo_identity.json` is not a
declared surface — it records an absolute `bound_repo_root`, so it is
machine-local binding state and carrying it across runners would bind the store
to one runner's paths. The published branch therefore does not contain it, and a
fresh checkout is exactly the shape `ensure_tools_dir` refuses:
`ambiguous_tools_root` (covered state, no identity).

The governed way to bind such a root is `integrity migrate-tools-bootstrap` —
**the same step PLAN §2.5 wanted deleted.** PR 2.5 already corrected that on the
grounds that it is a contract migration; this is the second and stronger reason:
delete it and the state-store lane cannot start at all.

## Verification

- `aria-kernel/tests/test_contention_replay.py` — 12 tests over the primitive.
- `aria-kernel/tests/test_publish_contention.py` — 5 tests over a **real bare
  remote and two clones**. The rejection is the server's, not a mock: a mocked
  rejection proves the handler runs, not that it runs on what actually happens.

Mutation-checked, six ways:

| Mutation                                               | Result                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| winner not checked against the base                    | 1 test fails _(after the isolating test; survived before it)_ |
| chain fields copied instead of recomputed              | 1 test fails                                                  |
| prefix hash proof dropped                              | 2 tests fail                                                  |
| all-or-nothing broken (write inside the planning loop) | 2 tests fail                                                  |
| retry guard removed                                    | 1 test fails                                                  |
| truncation accepted instead of refused                 | 2 tests error (index out of range)                            |

One test was rewritten rather than kept: the exhaustion case originally faked a
repeated loss by publishing from inside the rebase hook, and its outcome depended
on fetch ordering — it passed for the wrong reason as often as the right one. The
real race is covered by the tests above; the attempt bound is now asserted
directly, where it can be stated exactly.

Kernel suite 3085 OK; `invariants:fast` 2261 green; run sequentially.

## Finding

- **ORPHAN-HIGH-540** — a lost publish race left the losing lane's rows
  stranded in a worktree nothing revisits. CLOSED here.

Owner: okan
