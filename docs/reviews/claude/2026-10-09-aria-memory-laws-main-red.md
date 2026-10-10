# ARIA — main red on the aria-kernel lane after the memory laws (#1920) (2026-10-09)

Owner: claude (fix), okan (review). Follow-up of ARIA-HIGH-401
(`docs/reviews/claude/2026-10-10-aria-memory-laws.md`).

## ARIA-HIGH-407 — two fixtures still rewrote memory ledgers through the kernel writer

### Symptom

`aria-kernel` on main 5df672355 (run 37988641808): suite (4) and suite (5) red, one error each.

| Test                                                                                                                         | Surface                                                                                     | Refusal                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `test_evidence_checkpoints.EvidenceCheckpointTests.test_a_rewritten_sealed_segment_refuses_the_publish`                      | `agent_invocation_request_segments`                                                         | `memory_history_rewrite_refused: … row 1 would change` |
| `test_branch_update_lineage.MergeLaneMergeStateTests.test_behind_is_not_updated_when_the_head_is_not_one_aria_can_vouch_for` | `change_committed` (through `tests/_helpers/declared_fixtures.py rewrite_declared_fixture`) | `memory_history_rewrite_refused: … row 0 would change` |

### Root cause

PR #1920 made the ledger writer (`ledger._rewrite_jsonl_unlocked` → `memory_class.refuse_history_rewrite`)
refuse any rewrite that changes a recorded row of a memory-class surface, and flagged the
change ledgers and the agent-invocation request segments as memory. That law is correct and
stays. Two fixtures built their state by editing memory history through the kernel's own
rewrite API, which the law now refuses:

1. The checkpoint test simulated tampering with a sealed segment by calling
   `rewrite_declared_jsonl` on it. A tamper does not go through the kernel. The writer
   refusing it is correct; the fixture has to write the bytes the way an attacker would.
2. The lineage test's `setUp` appended the delivered commit (`e…`) and one test then rewrote
   that row to `d…`. That edits memory history to build a starting state that could have been
   appended directly.

`rewrite_declared_fixture` gave no warning: it handed any surface to the kernel writer, so
the failure showed up as a `LedgerIntegrityError` deep inside the test.

### Why #1920's own CI did not stop it

It did catch it. #1920's `aria-kernel` run on its final head 1cbfd32bf (run 37986145901,
started 20:18:57Z) reported exactly these two errors at 20:38Z and 20:40Z and concluded `failure`.
The PR was merged at 20:30:29Z, while that run was still in progress. `aria-kernel` is not a
required status check on `main`. The required set is `sens-enterprise-summary`, `merge-gate`,
`aria-merge-authority` and `build-status`, and `merge-gate` (in `ci-affected.yml`) does not
aggregate the `aria-kernel` workflow. So nothing blocked the merge. The previous head's run
(6d24639d1, 37984320025) was cancelled by the push of 1cbfd32bf.

On main, the push run for cb6184b1e (37987461773) was cancelled at 20:42:40Z: `aria-kernel.yml`
has `cancel-in-progress: true` per ref, and 5df672355 landed on top of it. The earlier
`cancelled` main runs (c65bd1aa6 → 37982081357, 6b1fdef8a → 37979854966) come before #1920 and
were cancelled the same way by the next merge. They don't explain this break. The first
main run that finished on #1920's code is 5df672355's, and it is red.

This PR does not change the required-check set. That is a repository settings decision
for the operator: `aria-kernel` is path-filtered and takes about 20 minutes per shard.

### Fix (tests only; the law is unchanged)

- **Tamper test** (`test_evidence_checkpoints.py`): the sealed segment is now tampered with an
  out-of-band filesystem write (`rewrite_declared_out_of_band`: re-chained bytes, no kernel call).
  Because #1920 made the segments memory, the test now checks two independent walls:
  1. the lane's publish refuses at the snapshot builder with
     `snapshot_memory_surface_rewrite:agent_invocation_request_segments:agent-invocations/requests/<seg>`
     (ARIA-HIGH-263's prefix check, which the segments joined), and the state branch HEAD
     does not move;
  2. the evidence checkpoint, the property this test was written for, still refuses on its
     own. A state commit that reached the branch without the publish, carrying a snapshot that
     truthfully claims the tampered bytes, fails `_verify_snapshot_and_collect_evidence` with
     `state_commit_evidence_checkpoint_mismatch:<same key>`. Control run: with the tamper
     removed, the same out-of-band commit verifies cleanly and the publish is not refused.
- **Lineage test** (`test_branch_update_lineage.py`): `setUp` no longer writes the change
  ledger. Each test records its delivered commit once with `_deliver(sha)`, in the order it
  happened (`e…` for the two vouchable-head tests, `d…` for the refused one). The state is
  the same as before, built only by appends.
- **Helper** (`tests/_helpers/declared_fixtures.py`): `rewrite_declared_fixture` refuses every
  surface in `state_manifest.memory_surfaces()` up front. The message names the two legitimate
  ways to build the state: `append_declared_fixture` in final row order, or
  `rewrite_declared_out_of_band` for a tamper or loss. Its remaining callers
  (`test_publish_contention.py`, surface `cycles`) are not memory and keep working. A new
  test (`test_memory_retention.FixturesBuildMemoryLegitimately`) pins the refusal on every
  memory surface and the non-memory rewrite.

No other test rewrites a memory surface through the kernel except the refusal tests in
`test_memory_retention.py`, which assert the refusal. The full aria-kernel suite run is listed
in the PR.
