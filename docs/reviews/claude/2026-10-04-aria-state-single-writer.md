# ARIA review — 2026-10-04: aria/state single writer

- Date: 2026-10-04
- Owner: `claude` (operator `okan`)
- Finding: ARIA-HIGH-342 (HIGH, deadline 2026-10-11)
- Trigger: two long ARIA jobs lost their work at the final `state publish` on the first live
  run, both with exit 3 and the refusal `replay_materialization_budget_exceeded` ("winner and
  loser ledger parsing exceeds the in-memory admission bound").
- Method: read `state_store.py` (publish, contention replay, its admission bound, the
  recovery package), `contention_replay.py`, `memory_gap.py`, the cycle's continuity phase,
  `autonomous_host_lease.py` and the six workflows that run `state publish`. Every claim
  below was reproduced in a hermetic git fixture (a bare remote and two clones) before it was
  fixed: `aria-kernel/tests/test_state_single_writer.py`.

Line numbers in this document are at `origin/main` `bb13c2e8f`, before the fix.

## ARIA-HIGH-342

### What was measured

1. Burn-in run 37178472968 (`aria-auto-cycle`, mode `burn-in-observe`, 04:57-07:01Z). An
   operator-lane `state publish` from `/root/aria-8b` landed on `aria/state` at 06:19Z. Every
   later observe cycle aborted with `state_integrity_gap` and the final publish was refused.
   71 minutes of evidence were lost.
2. Executor run 37192561282 (`aria-agent-executor`, 09:33-13:24Z, 29 of 30 requests
   succeeded). `aria-agent-eval` published `agent-eval-37193991402` at 10:02Z from its own
   concurrency group. The executor's final publish was refused the same way; its results,
   the first live plan's challenger among them, are not on `aria/state` (a copy is on the
   host).

### Root cause (A): nothing makes aria/state single-writer

Six workflows publish `aria/state`, under four different concurrency groups, plus the
operator lane:

| writer                   | concurrency group                     | job bound |
| ------------------------ | ------------------------------------- | --------- |
| `aria-auto-cycle`        | `aria-selfhosted-workspace`           | 360 min   |
| `aria-agent-executor`    | `aria-selfhosted-workspace`           | 510 min   |
| `aria-agent-eval`        | `aria-agent-eval` (ORPHAN-MEDIUM-770) | 25 min    |
| `aria-merge-runner`      | `aria-merge-runner`                   | 15 min    |
| `aria-readiness-claim`   | one per head sha                      | 15 min    |
| `aria-state-maintenance` | `aria-state-maintenance`              | 15 min    |
| operator lane            | none                                  | none      |

`aria-agent-eval.yml:41` keeps its own group on purpose: GitHub keeps one pending run per
group and a newer one evicts it (the ORPHAN-713 harm). So a short writer can always land a
publish inside a long job's restore-to-publish window, and the long job then loses the
fast-forward race.

The existing cross-host lease (`autonomous_host_lease.py`, checked by the "Pre-flight -
cross-host autonomous-loop lease check" step in the executor and the cycle) does not cover
this. It is a file inside the tools root that a writer only sees after a restore, it is a
trusted witness rather than a mutex (its own docstring says so), and the workflows refuse
only a lease held by a non-GitHub host.

Reconciling after the fact cannot replace turns. The contention replay
(`state_store.py:4832`, `rebase_store_onto_remote`) resets the loser onto the winner's tree
and appends back only ledger suffixes. `_recovery_surface_metadata` (`state_store.py:2833`)
preserves only `ledger` and `index` surfaces, so any other class is the winner's afterwards:
an agent output artifact (`agent-invocations/outputs/**/*.md`), a lock record, a compacted
(rewritten) ledger. Measured in the fixture with a ledger well under the bound: the loser's
artifact was gone from disk and from the branch while the publish returned
`published: true`. The executor produces exactly those artifacts, and maintenance rewrites
ledgers. A writer that interleaves with another can therefore lose work even when the replay
succeeds.

### (B) The admission bound is a deliberate safety limit, kept

`state_store.py:4990-4997` charges `16 x (loser + winner)` whole-file bytes for every
carried ledger, summed, against `_MAX_REPLAY_MATERIALIZATION_BYTES` (256 MiB). It was
introduced by `711a61649` (ARIA-HIGH-001, recovery boundaries) and it prices exactly what
`contention_replay.replay_append_only_suffixes` does: it parses both whole files into Python
rows (`_load_jsonl_stored_verified`), and it keeps the loser's attested bytes in memory. At
today's sizes (raw findings about 24 MB, runs about 17 MB) the bound is exceeded by raw
findings alone, so the replay refuses on every real contention. The fixture reproduces the
measured refusal at that scale: a 9.4 MB ledger on both sides.

That refusal is the guard working: the alternative is an out-of-memory kill on a runner that
already has a measured OOM history (ARIA auto-cycle OOM, 2026-09-02). Raising the constant
would trade a named refusal for a dead runner. Streaming the replay would make the ledger half
scale, but by (A) it would still drop every non-ledger surface. The fix is therefore to make
the race unreachable, not the replay larger.

### (C) The observe burn-in judged the wrong tree

The burn-in step runs its cycles with `--tools-dir` under `RUNNER_TEMP`, and the kernel
refuses one inside the workspace (`observe_burn_in_tools_dir_must_be_outside_workspace_root`).
But `resolve_continuity_reference` (`memory_gap.py:244`) and `continuity_probe_roots`
(`memory_gap.py:284`) take the checked-out store as the reference whenever it exists, whatever
tools root the cycle acts on. After the 06:19Z publish the real store was behind the tip, so
each observe cycle got a critical verdict, ran `restore_and_replay` against the real store it
never writes (`cycle.py:649-682`), failed with the same budget refusal, froze and aborted.
`state_integrity_gap` should not fire there: it was a false positive caused by the check's
scope, and the observe cycle should never have tried to rebase the real store.

## The fix

One writer lease, an extension of the existing `RemoteCasLease`, given a remote transport.
The first revision of this fix was reviewed read-only on PR #1779 (MERGE-WITH-FIXES); the
items below are the design after those fixes, with each review id where it changed it.

- `aria_kernel/state_writer_lease.py`: the record is the existing `RemoteCasLease` (epoch
  fence, owner, target ref, head sha, expiry) plus the run id, the TTL and the SHA-256 of a
  secret, kept as `lease.json` on the branch `aria/state-lease`. Every change is a commit
  pushed by exact sha without force, so the server's fast-forward rule is the
  compare-and-swap, as for `aria/state` and the cold store `aria/state-cold`.
  `build_remote_cas_lease` gains a TTL so the expiry is the holder's job bound rather than the
  five-minute heartbeat.
- The lease is a capability (GSEC-MEDIUM-001). Each acquisition mints a 256-bit secret that
  only the acquirer holds (`--token-file`, mode 0600, never printed); publish, renewal, fence
  and release compare its hash. The CLI has no `--owner` flag, and releasing a lease the
  caller does not hold needs `--force-foreign --reason`, recorded on the lease branch.
- The lease is taken BEFORE the checkout: `restore-aria-state` takes it when the lane sets
  `writer-lease-ttl-minutes` and hands the token on as a masked step output
  (`writer-lease-token`) that the lane passes by `env:` / `with:` to its publish, merge and
  release steps only, never through `GITHUB_ENV` (GSEC-LOW-002). A writer that finds the
  lease held waits up to `writer-lease-wait-seconds`, then yields: no checkout,
  `writer-lease=yielded`, the holder, run id and expiry in a warning and the step summary.
  Nothing was restored, so nothing is lost, and no pending run is evicted.
- The fence is part of the push (GSEC-HIGH-001). `publish_with_contention_replay` resolves
  the token itself, so no caller can skip it, and refuses unless the token holds the current
  lease and the store is on the published tip. It renews the lease by CAS when less than what
  still follows the check is left (80 minutes: the cold staging plus the locked publish arc
  at the git cap). It then pushes the state commit and a fast-forward
  child of the observed lease tip (same lease id, fresh `heartbeat_at`) in one
  `git push --atomic`. A takeover between the check and the push rejects both halves. Any
  contention under a lease is refused as `state_writer_lease_lost`, named from a fresh read of
  the lease, and is never replayed. The orchestrator no longer replays at all; the replay
  primitive stays for `memory_gap.restore_and_replay`. No kernel module calls `publish_state`
  directly.
- The lifecycle bounds are re-derived from the code. The publish attempt is the atomic push,
  then the reconciliation's probe, fetch and owned fast-forward, with one attempt
  (`PUBLISH_MAX_ATTEMPTS = 1`). The publish arc is 2100 s, down from 5400 s. The rebase that
  `memory_gap.restore_and_replay` runs is priced by its own `REBASE_ARC` (1500 s). The
  lifecycle liveness bound is now the checkout arc, 2700 s. The executor's job reserve adds
  the 1800 s writer-lease wait before its restore (`ci_executor_drain.WRITER_LEASE_WAIT_SECONDS`,
  pinned equal to the workflow). The reserve is 8100 s, so the drain window plus reserve is
  485 of the job's 510 minutes, and the post-drain reserve the workflow exports is 3600 s.
- TTL = job timeout + the 80-minute leased-publish margin (GSEC-MEDIUM-003): executor 650,
  cycle 440, eval 105, merge-runner, readiness-claim and maintenance 95.
- `release-aria-state-lease` is each publishing job's last step, with `if: always()` and
  nothing else (GSEC-LOW-001). Release is idempotent. Without the token it releases only a
  lease whose owner is this run's `writer_identity`. The executor and cycle abort gates exempt
  exactly that step by name.
- `state lease repair --reason` (GSEC-HIGH-002) replaces a malformed or missing record with a
  released one as a fast-forward child, and refuses a valid held lease.
  `readiness probe-state-branch-protection` checks that deletion and non-fast-forward rules
  cover all three of `aria/state`, `aria/state-cold` and `aria/state-lease`. The bootstrap
  runbook names the lease branch and the operator sequence: acquire with `--token-file`,
  publish with `--lease-token-file`, release with `--token-file`; the token is never
  exported into the shell.
- The contention replay refuses (`replay_unreplayable_surface_changed`) before any reset when
  the loser changed a non-ledger surface the winner does not already hold, instead of
  reporting success over a dropped surface.
- Continuity (GSEC-MEDIUM-006): only the explicit observe burn-in (`burn_in` mode and the
  observe runtime profile, both set by `autonomy burn-in observe`) may act on a tools root
  outside the workspace; it is then judged against no reference, with the note
  `tools_root_detached_from_state_store`. Any other cycle on such a root gets the blocking
  reason `state_continuity_tools_root_detached_from_state_store`, and recovery refuses to
  rebase the real store on its behalf.

Gates: `EveryWriterTakesTurns` fails when the fence leaves the orchestrator, when anything
outside `state_store` calls `publish_state`, when a publishing job's TTL is below timeout plus
margin, when its release is not a single unconditional last step carrying the token, when the
token reaches a step that does not publish or merge, or when a kernel step after the restore
can run on a yielded restore.

## Re-review of PR #1779 at `ff05a4770` (MERGE-WITH-FIXES; both HIGH findings closed)

The operator ran the protection probe against the live repository after extending ruleset
20441794 to `aria/state-lease`:

```text
$ readiness probe-state-branch-protection --repo Okan-wqm/aquaculture_platform
{"branches":["aria/state","aria/state-cold","aria/state-lease"],"reasons":[],"valid":true}
```

Fixed in this PR:

- R-1 (MEDIUM, regression). A malformed or missing lease record made `state lease acquire`
  exit 3, which the restore action read as a green yield, so one bad record would have made
  every writer yield forever. Exit 3 now means only `state_writer_lease_held` with a holder in
  the verdict. Every other refusal exits 4 and names `state lease repair`. The action yields
  only on exit 3 with a holder present and fails red otherwise.
- R-3 (LOW). The post-drain reserve priced only the locked arc. It now adds the leased
  publish's preamble outside the lock (`state_writer_lease.PUBLISH_PREAMBLE_SECONDS`, 4500 s):
  cold staging (`COLD_PUSH_ATTEMPTS` x 3 x the git cap) plus the fence's lease reads and its
  renewal (3 + 3 x the cap). The post-drain reserve rises from 3600 s to 8100 s and the job
  reserve from 8100 s to 12600 s. The drain window cannot shrink: below 20943 s the
  implementation child (20343 s worst case plus the measured 600 s start window) no longer
  fits, and every implementation would be skipped. So the window stays at 21000 s and the
  executor's `timeout-minutes` rises from 510 to 570 (33600 s = 560 minutes, ten of margin).
  The TTL margin rises from 35 to 80 minutes, because what must still fit after the fence
  check is the cold staging plus the locked publish arc.
- R-4 (LOW). `WriterFence.token` is `repr=False`. The token file is created with
  `O_CREAT|O_EXCL|O_NOFOLLOW` and `fchmod` 0600 before the lease is taken, so a token that
  cannot be kept leaves no lease behind. `state publish --lease-token-file` and
  `state lease release --token-file` read it, and the runbook exports nothing.
- R-6 (LOW). `publish_state`'s `writer_fence` is a required keyword; fixtures pass
  `writer_fence=None` by name. A refused atomic push with neither `aria/state` nor the lease
  branch moved is `state_publish_write_denied`, told apart from a takeover by one probe of
  the lease branch, priced in the attempt arc.

Tracked follow-ups from the re-review (owner `claude`, deadline 2026-10-18, under
ARIA-HIGH-342), named as the re-review names them: R-2, R-5, R-7, R-8, R-9 and R-10.

## aria-state-maintenance

It is safe to re-enable once this lands. Compaction rewrites ledgers, which no replay can
carry, so it was the writer most exposed to interleaving; it now holds the lease from before
its restore to after its publish, and no other compliant writer can publish in between. When
a long job holds the lease, maintenance waits 300 s and then yields by name; that day's
compaction runs at the next schedule that finds the branch free.

## Tracked follow-ups (owner `claude`, deadline 2026-10-18, under ARIA-HIGH-342)

- GSEC-MEDIUM-002: a yield should be a named non-success rather than a green skip; a yielded
  `aria-readiness-claim` should be re-triggered for its head sha; the eval cron should move
  off the executor window.
- GSEC-MEDIUM-004: reap a `gha:` lease whose run has concluded instead of waiting for its
  expiry, and renew a long holder's lease by heartbeat.
- GSEC-MEDIUM-005: governance-ledger audit rows for acquire, renew, fence, release and repair,
  next to the lease-branch commits.
- GSEC-LOW-004: hash the local owner (host, user, checkout path) in the public record.
- GSEC-LOW-005: fetch the lease branch with `--depth=1`.

## Not done

- The replay is not streamed. With the orchestrator no longer replaying, it runs only for
  `memory_gap.restore_and_replay`; at current sizes it refuses by name rather than
  reconciling.
- Hosted writers yield while a self-hosted job holds the lease (up to 650 minutes); see
  GSEC-MEDIUM-002 above.
- No live run has exercised the lease branch, the atomic push or the masked token output yet.
  The ruleset was extended to `aria/state-lease` by the operator outside this diff, and the
  probe above confirms it covers all three branches.
