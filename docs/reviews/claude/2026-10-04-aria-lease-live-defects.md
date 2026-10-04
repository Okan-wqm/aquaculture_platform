# ARIA review — 2026-10-04: two defects of the live aria/state writer lease

- Date: 2026-10-04 (fixed 2026-10-05)
- Owner: `claude` (operator `okan`)
- Finding: ARIA-HIGH-350 (HIGH, deadline 2026-10-11)
- Trigger: the writer lease (ARIA-HIGH-342, PR #1779) went live on `main`, and its first
  live operations showed two defects.
- Method: read `state_writer_lease.py`, `state_writer_fence.py`, the store's git runner in
  `state_store.py` and the restore action. Both defects are reproduced in a hermetic fixture
  (a bare remote and two clones) before they are fixed:
  `aria-kernel/tests/test_state_writer_lease_live.py`.

Line numbers are at `origin/main` `484dc54d3`, before the fix.

## ARIA-HIGH-350

### Defect 1: data pushes ran the repository's git hooks

From the operator checkout `/root/aria-8b`, which has no `node_modules`,
`state lease release --force-foreign` failed with
`state_writer_lease_release_failed: aria/state-lease refused 3 release pushes`. The real cause
was `.husky/pre-push: ts-node: not found`.

- `_push_record` (`state_writer_lease.py:451-466`) ran `git push` from the repository root,
  so husky's pre-push code gate ran on a push of a data branch, and the function returned only
  `returncode == 0`. A hook that could not run, an authentication failure and a lost race all
  read "refused".
- `aria/state` publishes escaped the same fate by luck rather than by design. They run from
  the store worktree, where the relative `core.hooksPath=.husky` resolves to nothing. With an
  absolute hooks path the fixture shows `git worktree add` for the store failing in a
  post-checkout hook.

The fix makes every store git operation hook-free by construction. All of them, whether on
`aria/state`, `aria/state-cold`, `aria/state-lease` or the store worktree, go through
`state_store._run_git_bytes_bounded`. That runner now passes `-c core.hooksPath=/dev/null`
before every subcommand. These are data branches, never code, so this is not a bypass of the
code gates: the gates guard code branches, which this runner never pushes. It matches what
`aria/state` publishes already did in practice. The audit found no other kernel push or
commit to an `aria/state*` branch outside that runner.

A refused lease push now returns a `PushResult` carrying git's stderr. `acquire`, `release`,
`repair` and the fence's renewal name it in their errors (`git said: ...`). A refused renewal
whose lease branch did not move is `state_publish_write_denied`, not a lost lease.

### Defect 2: a cancelled holder wedged the lease for its whole TTL

Executor run 37231079995 was cancelled at 22:18Z on 2026-10-04. GitHub ran neither its publish
nor its `if: always()` release step, so its lease, with a 650-minute TTL, stayed held until
07:27Z and would have held every writer off. `acquire_writer_lease`
(`state_writer_lease.py:558-563`) waited on any unexpired lease, whatever had become of its
holder.

The fix adds run-liveness reaping (GSEC-MEDIUM-004), in `state_writer_lease_runs.py`:

- When an acquirer finds a held lease whose owner is a GitHub run attempt
  (`gha:…:run=<id>:attempt=<n>`, the same run id the record names), it asks the Actions API
  about that exact attempt: `GET /repos/{repo}/actions/runs/{id}/attempts/{n}`. It uses the
  token the lane already has (`GH_TOKEN`, passed to the restore action's acquire step); the
  job needs `actions: read`, now granted to `aria-agent-eval` as well, and the contracts
  declare `github_api`.
- When that attempt is `completed`, whatever its conclusion, the acquirer takes the lease over
  by the ordinary compare-and-swap push. The new record carries a `reaped` entry (the
  predecessor's lease id, owner, run, attempt, status and conclusion), and the commit message
  says so.
- No answer means no reap: no token, a network error, a non-200 response or an unreadable
  body. The acquirer keeps waiting or yields as before, and its refusal names the reason
  (`not reaped: run status unavailable: …`). A run still in progress is named too, as is an
  owner that is not a GitHub run: a local or operator owner is never reaped this way.
- An operator's `--force-foreign` release now records what GitHub said about the holder's
  run: concluded with its conclusion, still running, or unanswerable.

## Red, then green

Before the fix, 14 of the 15 new tests failed (18 failures counting subtests). Examples:
`GH013: Repository rule violations found` was missing from
`state_writer_lease_push_failed: … refused 3 pushes; the remote is not accepting writes`;
`git worktree add … ` failed in the fixture's post-checkout hook; the argv lacked
`-c core.hooksPath=/dev/null`; and `acquire_writer_lease()` had no `run_status`. After the
fix all 15 pass, with and without CI-like `GITHUB_*` variables.

## Not done

- Reaping still waits for the API to report the attempt as completed. A runner that vanished
  without GitHub concluding the run is still held until its expiry.
- No live run has exercised the reaper yet; its first reap will be visible on
  `aria/state-lease` as a commit whose message names the reaped run.
