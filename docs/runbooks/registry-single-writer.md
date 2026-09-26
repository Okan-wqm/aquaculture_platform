# Runbook — the finding registry's single writer

**Audience:** repository operator (admin rights required for the two flips).
**Frequency:** once, to activate the self-healing lane; then read-only.

## The contract

`docs/reviews/_registry/findings.jsonl` is an append-only, hash-chained audit
artifact. Lanes append rows in PRs; **main is the only writer of the chain's
health**. Every push to main, the `finding-closure-reconcile` lane:

1. verifies the chain read-only and names any break (`chain break at entry N`);
   a break it cannot name is refused, never guessed at;
2. heals a stacked tail with `rechain-from N` — the recomputation happens on
   main, against main's own canonical prefix, which is why two lanes appending
   rows without folding each other is an inconvenience and no longer a
   six-fold-per-night ritual;
3. records the closures the merge's own `Closes:` trailers already reach
   (`reconcile`), re-pins the debt plan and the authority hash;
4. opens/updates `automation/finding-closure-reconcile` and **requests
   auto-merge**, so the PR merges itself the moment its checks pass.

The reconcile PR passes through branch protection unchanged — auto-merge moves
who performs the merge, never which checks run. The staleness sweep
(`finding-state-sweep.yml`) keeps its human review on purpose: closures are
arithmetic, STALE/BLOCKED transitions are a judgement.

## Why this runbook exists

On 2026-09-21 the lane opened #1666 four minutes after #1652 merged and the PR
then waited ten hours for a human while `finding-registry-closure-drift` was
red on every PR opened in the meantime. The reporter inherits the merger's
debt; the delay hurt everyone except its cause. The lane code above ends that;
the two repository settings below let it actually act.

## Flip 1 — allow auto-merge on the repository

```bash
gh api -X PATCH repos/Okan-wqm/aquaculture_platform \
  -f allow_auto_merge=true
```

Without this, the lane's `gh pr merge --auto` prints a notice and the lane
behaves exactly as before (the step is deliberately non-fatal — a heal lane
must not go red for lacking the permission that would make it autonomous).
After the flip, verify with the next closure-carrying merge: the reconcile PR
should merge itself once `detect-changes`/`validate-closes`/`invariants-fast`
pass on it.

If branch protection requires approvals, either lower it for this branch
pattern or rely on Flip 2 — a merge queue performs the merge for queued PRs
without an approval step of its own (the required checks are the gate).

## Flip 2 — the merge queue on main (kills the BEHIND treadmill)

The workflows already answer `merge_group` (`ci-affected.yml` fans out every
lane; `aria-merge-authority.yml` gates it). Create the ruleset:

```bash
gh api -X POST repos/Okan-wqm/aquaculture_platform/rulesets \
  -H 'Accept: application/vnd.github+json' \
  --input - <<'JSON'
{
  "name": "main merge queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_seconds": 3600,
        "max_entries_to_build": 2,
        "max_entries_to_merge": 2,
        "merge_method": "merge"
      }
    }
  ]
}
JSON
```

The four required checks stay as they are (`merge-gate`, `aria-merge-authority`,
`build-status`, `sens-enterprise-summary`) — those are the checks the queue
waits for, and #1663 made each of them answer the queue's group.

**Order of operations:** flip only when no PR is mid-CI (a flip mid-run parks
that run's report in the queue's first group). After the flip, merges into
main serialize: a PR enters with `gh pr merge --auto` (or the button's "Add to
merge queue"), the queue builds the group against a frozen base, and the
registry-touching PR that would previously turn BEHIND/DIRTY and silently
never start CI is bounced by the queue with a visible conflict instead —
fold, re-enqueue, done. That is the intended behaviour: the conflict was
always there; it was invisible.

## Operating under the contract

- **`finding-registry-closure-drift` red on a fresh PR** used to mean "someone
  did not merge the reconcile PR". It now means the lane failed — read its
  Actions run; the refusal names its reason.
- **A registry-appending PR** still folds main before enqueueing (the queue
  bounces the conflict otherwise). The fold is one `remerge`, not six: the
  chain's hashes are recomputed on main regardless.
- **The reconcile PR's own diff** is mechanically derived (trailers → rows,
  rechain, repins). Review it after the fact in history; do not block on it —
  that review delay is the ten-hour red window this lane closed.
