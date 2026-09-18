# The lane refused because it had worked — 2026-09-07

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `13d6c0cd2`.

Not from a branch. This one surfaced by watching the closure-reconcile lane run for the first
time with real content, one merge after I built it.

## PROC-HIGH-030 — the reconcile lane could not finish a run that resolved a CRITICAL

**Severity:** HIGH. **Owner:** infra-expert. **State:** IN-PROGRESS.

### Evidence

`finding-closure-reconcile.yml` run #3 fired on the merge of PR #1461 and did exactly what it was
built to do, right up until it refused itself:

```text
Reconcile plan (2 findings closed on origin/main but not RESOLVED):
  BILLING-CRITICAL-006: OPEN → RESOLVED  (commit 4c35ddac10e6)
  BILLING-CRITICAL-007: OPEN → RESOLVED  (commit 9362fcbbf448)
Resolved 2 findings from origin/main.
OK: registry chain valid (1870 entries).

debt-plan repin: active_critical_ids CHANGED — refusing, nothing was written.
```

`repin-debt-plan.ts` refused on **any** difference between the registry's active-CRITICAL id list
and the manifest's. Its message names the reason — "a new active CRITICAL needs a truth-table row
with an owner and a bucket" — and that reason is real, but it only describes an ADDITION. The
difference here was a REMOVAL, and a removal is what a successful reconcile of a CRITICAL always
produces. The lane's own success was the thing that stopped it.

So the lane never opened its PR, `main` kept the two findings OPEN while carrying their `Closes:`
trailers, and `finding-registry-closure-drift` went red for the next contributor. That was
PR #1462, green until it was rebased onto the new main and inherited the failure:

```text
BILLING-CRITICAL-006 is OPEN but 4c35ddac10e6 on origin/main carries its Closes: trailer
BILLING-CRITICAL-007 is OPEN but 9362fcbbf448 on origin/main carries its Closes: trailer
```

That is the exact tax `PROC-MEDIUM-029` was closed to remove, reappearing on the machinery built to
remove it. The lane automated the work and then blocked on the approval step it had itself made
necessary.

### Rule violated

A gate that refuses must distinguish the judgement it needs a human for from the arithmetic it was
built to do.

### Fix

The two directions are not symmetric, and version two treated them as if they were.

- **An added active CRITICAL still refuses**, with the same reason, now naming the ids that were
  added. A new one needs a truth-table row with an owner, a deadline and a bucket, and the
  contract spec compares the id list with `toEqual`, so a manifest listing an id its own table does
  not carry is a false statement in a file whose only job is to be true.
- **A removed one is recorded.** A CRITICAL leaves the active set because a merged commit closed it
  and `finding-registry reconcile` marked it RESOLVED. The manifest's id list is rewritten from the
  registry, the finding's row is lifted out of the active table, and an entry is appended to
  `Resolved Evidence` naming the closing commit and the bucket it left — the move the two entries
  already in that section were made by hand.

Three details are load-bearing and each is here because the obvious version is wrong:

- The entry is appended to the **end of the `Resolved Evidence` section**, not the end of the file.
  Those coincide today because it is the last section; writing to the file's end would keep working
  until someone adds a section after it and then silently misfile every future closure.
- The entry is **wrapped to the prose width** and uses the short sha the existing entries use. The
  docs gate exempts tables and code blocks from MD013; a bullet is neither, and the first version
  emitted 115-character lines that would have failed `docs-check` on the lane's own PR.
- The manifest's id list is rewritten by a **textual edit of that array block only**, preserving the
  file's indentation, for the same reason `planManifest` already avoids `JSON.stringify`: the file
  is prettier-dirty at base and a reserialize would churn hundreds of unrelated lines.

The three existing properties are untouched: the refusal is still a precondition checked before the
first byte is written, every anchor miss still throws during planning with the filesystem
untouched, and the script is still TypeScript so `tools/gates/tsconfig.json` type-checks it.

### Verification

Mutation-verified in both directions against the real registry.

- **Removal** (the live case): `reconcile` resolved BILLING-CRITICAL-006 and 007, then the repin
  completed — `active_critical_count: 31 → 29`, `active_critical_ids: 31 → 29`, both rows out of
  the active table and into `Resolved Evidence` with their closing commits.
- **Addition**: an id removed from the manifest so the registry appears to have gained one. The
  repin refused, named `["DEPLOY-CRITICAL-017"]`, and wrote nothing.

`enterprise-grade-debt-plan-contract`, `finding-registry-integrity`,
`finding-registry-closure-drift` and `billing-cycle-terms-single-source`: 30/30. `tsc` and `eslint`
clean on the changed tool — the first draft used non-null assertions on `closing_commits`, which
the repo forbids; it narrows through `flatMap` instead.

## What this does not do

It does not make the lane fully autonomous. The reconcile PR still needs a human merge, which is
`PROC-MEDIUM-029`'s remaining half and a policy decision about an audit artifact — unchanged and
still open for the owner. What changed is that the lane can now produce that PR at all when a
CRITICAL is involved, instead of failing at the step after the work was done.
