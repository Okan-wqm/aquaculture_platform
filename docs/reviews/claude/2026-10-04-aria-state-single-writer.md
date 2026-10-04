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

- `aria_kernel/state_writer_lease.py`: the record is the existing `RemoteCasLease` (epoch
  fence, owner, target ref, head sha, expiry) plus the run id, kept as `lease.json` on the
  branch `aria/state-lease`. Every change is a commit pushed by exact sha without force, so
  the server's fast-forward rule is the compare-and-swap, as for `aria/state` and the cold
  store `aria/state-cold`. `build_remote_cas_lease` gains a TTL so the expiry is the holder's
  job bound rather than the five-minute heartbeat.
- The lease is taken BEFORE the checkout: `restore-aria-state` takes it when the lane sets
  `writer-lease-ttl-minutes` (its own `timeout-minutes`) and exports
  `ARIA_STATE_WRITER_LEASE_ID`. A writer that finds it held waits up to
  `writer-lease-wait-seconds`, then yields: no checkout, `writer-lease=yielded`, the holder,
  run id and expiry in a warning and the step summary. Nothing was restored, so nothing is
  lost, and no pending run is evicted.
- `state publish` and the merge lane's intent publisher refuse without the current lease
  (`state_writer_lease_required`, `state_writer_lease_not_held`). The operator lane is the
  same CLI, so `state lease acquire` refuses it while a job holds the branch.
- `release-aria-state-lease` gives it back in an `always()` step after the last publish; in
  the executor and the cycle the announce step of the existing abort gate also releases. A
  runner that dies outright frees the branch at the recorded expiry. Fencing is by lease id,
  so a holder past its expiry may publish only while nobody has taken the lease since.
- The contention replay refuses (`replay_unreplayable_surface_changed`) before any reset when
  the loser changed a non-ledger surface the winner does not already hold, instead of
  reporting success over a dropped surface.
- The continuity phase treats a tools root outside the workspace as detached from the store
  (`memory_gap.tools_root_is_detached`): no reference, so genesis or unknown, with the note
  `tools_root_detached_from_state_store`. A tools root inside the workspace keeps the store
  as its reference, so a lane mis-bound to an empty in-workspace root is still caught.

Gates: `EveryWriterTakesTurns` fails when a kernel function calls
`publish_with_contention_replay` without `require_held_writer_lease`, when a publishing job's
TTL differs from its `timeout-minutes`, when it has no `always()` release after its last
publish, or when a kernel step after the restore can run on a yielded restore.

## aria-state-maintenance

It is safe to re-enable once this lands. Compaction rewrites ledgers, which no replay can
carry, so it was the writer most exposed to interleaving; it now holds the lease from before
its restore to after its publish, and no other compliant writer can publish in between. When
a long job holds the lease, maintenance waits 300 s and then yields by name; that day's
compaction runs at the next schedule that finds the branch free.

## Not done

- The replay is not streamed. With turns in place it runs only after a lease expiry; at
  current sizes it refuses by name rather than reconciling.
- Hosted writers yield while a self-hosted job holds the lease (up to 510 minutes). A yielded
  `aria-readiness-claim` is not re-triggered for its head sha, and a yielded merge-runner or
  eval run waits for its next schedule. Throughput of those lanes during long jobs is the cost
  of no lost work; ARIA-HIGH-342 tracks it (owner `claude`, deadline 2026-10-11).
- No live run has exercised the lease branch yet: `aria/state-lease` is created by the first
  writer that acquires it, and branch rulesets on GitHub were not readable from this host.
