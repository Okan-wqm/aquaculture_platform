# ARIA — executor diagnosis: what the 543 harness releases were, and why #1906's challenger waited 11 h (2026-10-10)

Owner: claude (implementation and diagnosis), okan (review; the capacity decision in
ARIA-HIGH-425; the runner action in ARIA-HIGH-426).

Sources, all read-only:

- the bound aria/state copy f5c5c86a1 (2026-10-10 10:37Z): `agent-invocations/claims.jsonl`,
  `governance.jsonl`, `agent-invocations/transcripts.jsonl`,
  `agent-invocations/outputs/content-addressed/`;
- the self-hosted runner's own diagnostic logs on NLDW4-4-34-28
  (`/home/gharunner/actions-runner/_diag/Worker_*.log`), one file per job: workflow, event,
  run id, step results;
- origin/main 2b8385600 for the code.

The scripts are in the session scratchpad (`executor/*.py`). The GitHub runs API was not used
(the PAT answers 401, and this lane makes no network calls).

Two claims from the plan's §1 were not reopened: the 3-day versus 7-day sweep (the effective
policy is 7 days) and "infrastructure releases burn the budget" (they do not, see
`agent_invocations.py:2550-2648`).

## The 543 releases, by cause

| Release reason                                                                            | n   | Window (UTC)          | Cause                                                                                         | Status                                                 |
| ----------------------------------------------------------------------------------------- | --- | --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `claude_cli_exit_1`                                                                       | 161 | 08-21 15h → 08-22 21h | Anthropic seven-day limit                                                                     | proven → ARIA-HIGH-425                                 |
| `claude_cli_exit_1`                                                                       | 5   | 08-06 → 08-09         | expired OAuth session                                                                         | documented, not re-provable (see below)                |
| `claude_cli_exit_1`                                                                       | 31  | 08-24 00h → 08-25 07h | not known                                                                                     | UNVERIFIED                                             |
| `native_runtime_execution_unavailable`, exit 1, `provider_nonzero`                        | 226 | 09-21 08h → 09-25 02h | Anthropic seven-day limit                                                                     | proven → ARIA-HIGH-425                                 |
| same                                                                                      | 10  | 10-01 23:07 → 23:31   | Anthropic seven-day limit                                                                     | proven (ARIA-HIGH-290's measurement) → ARIA-HIGH-425   |
| same                                                                                      | 1   | 09-19 22:02           | a resume with no transcript ("No conversation found")                                         | ARIA-HIGH-179, RESOLVED                                |
| `native_runtime_execution_unavailable`, exit 0, `control_or_transport_unavailable`        | 12  | 09-19 13h → 09-20 01h | the Z.ai transport run as a Claude failover rung, verdict released                            | ARIA-HIGH-161, RESOLVED                                |
| `native_runtime_execution_unavailable`, Z.ai HTTP 200, `control_or_transport_unavailable` | 27  | 09-20 11h             | cost ledger refused `convergence_id: null` after the verdict was written                      | ARIA-HIGH-180, RESOLVED                                |
| `native_runtime_admission_unavailable`                                                    | 70  | 09-18 21h → 09-19 21h | task binding `target_revision_mismatch` for one request in the planner hook's shared checkout | loop fixed by #1619; the wrong name is ARIA-MEDIUM-427 |

The rows add up to 543: 197 + 276 + 70.

How each row was attributed:

- **Seven-day limit, August (161).** 13 sealed outputs from claims between 08-21 15:33Z and
  08-22 04:29Z carry the CLI notice "You've hit your weekly limit · resets Aug 23, 10am (UTC)".
  The 161 exit-1 releases fall between 08-21 15h and 08-22 21h, before that reset.
- **Seven-day limit, September (226).** The stored Claude transcripts carry the CLI's
  `rate_limit_event`. Its `seven_day` utilization reads:
  - 0.63 on 09-19 13:27Z;
  - 0.88 on 09-20 12:50Z;
  - 0.98 by 09-21 03:35Z, with `resetsAt` 2026-09-25 06:00Z.

  The last Claude success was at 09-21 08:21Z (run 35575497386). From 08:24:28Z on, every
  Claude attempt exited 1: 226 attempts over nine runs, 10 in that run and 27 in each of the
  next eight. The Z.ai attempts in the same run kept succeeding (16 between 08:16 and 09:29Z),
  so the host was fine and only the Anthropic route had failed. The first Claude success came
  at 09-25 08:27Z, on the next window (0.06, resets 10-02 06:00Z). No main merge landed between
  09-21 17:16Z and 09-25 08:30Z, so the recovery was the reset, not a fix.

- **Seven-day limit, October (10).** All 10 releases are AIR-aria-challenger-planner-83a038b1b7ac.
  That is the request ARIA-HIGH-290 names for the notice "You've hit your weekly limit · resets
  6am (UTC)" measured on 10-01. The recorded `stderr_tail` holds only the workspace-trust notice,
  as ARIA-HIGH-290 also recorded.
- **ARIA-HIGH-179 (1).** The one exit 1 on 09-19 22:02Z is run 35471772861, request
  AIR-aria-challenger-planner-2d16fdbb749e, `resumed_from` set. That is ARIA-HIGH-179's observed
  case. The seven-day utilization was 0.76 at that time.
- **ARIA-HIGH-161 (12).** One release is in run 35444645590, the run ARIA-HIGH-161 measured.
  The other 11 are in run 35471772861, which started 09-19 22:02Z. The fix (74710fb4b) reached
  main only with 1b75edf22 (09-20 00:41Z).
- **ARIA-HIGH-180 (27).** All 27 are in run 35485712865, the run ARIA-HIGH-180 measured on main
  0239eecc8. The fix (2dca7bb15) reached main with #1635 at 09-20 12:01Z.
- **Expired OAuth session (5).** One release per night, 08-06 → 08-09. The cause is documented
  in `tools/aria-poc/ci_executor.py:5342-5346` and ARIA-HIGH-157's notes. This store keeps no
  stderr or result for those attempts, so it cannot be re-proven here.
- **UNVERIFIED (31).** The releases on 08-24 and 08-25 fall after the Aug 23 10:00Z reset. No
  stderr, transcript or result is stored for them. Proving their cause needs the job logs of runs
  32674328825, 32800394101 and 32805160410.

Every one of these reasons is harness-class (`agent_invocations.py:2550-2648`). None of them
charged a request's requeue budget.

## ARIA-MEDIUM-422 — an expiry after only harness releases spent the single re-mint

### Symptom

An `anchor_stale` claim row from the age sweep says `anchor_expired`
(`agent_invocations.py:3403`). The release-reason table classifies that reason as
`unclassified` (`agent_invocations.py:2705-2712`). The expiry cause read that row alone
(`anchor_stale._causes`). So a request the queue reached, and the harness then handed back
(`native_runtime_*`, `claude_cli_exit_<n>`), spent its lineage's one re-mint
(`ANCHOR_STALE_REMINT_BUDGET = 1`) as if the request had been unreachable. When its successor
expired, the successor went to the operator as `remint_budget_spent`.

On the bound store, 46 of the 1,202 ANCHOR_STALE requests were claimed and then released only
for harness reasons:

| Role                          | Count |
| ----------------------------- | ----- |
| `evidence_judgment`           | 25    |
| `human_required_adjudication` | 10    |
| `maintenance_utility`         | 5     |
| `adversarial_judgment`        | 5     |
| `consensus_arbitration`       | 1     |

- 34 already carry a disposition record with `expiry_fault_class: unclassified`. 26 of those are
  `producer_unverified` judges, which PR-6 (ARIA-HIGH-418) re-decides.
- None has a successor yet, so no decision has flipped so far. The cost would fall on the
  successors PR-6 re-mints.
- Five consensus arbiters released 8-9 times as `native_runtime_execution_unavailable` and 4
  times as `judge_verdict_contract_violation` are the counter-case. Past
  `FREE_CONTRACT_VIOLATIONS` a violation is the request's own fault, so they correctly keep
  spending.

### Root cause

Two owners already existed and the cause consulted neither:

- `_request_fault_requeue_count` decides whether a release charges the request;
- `classify_release_reason` decides the class of a reason.

### Fix (reader, not a new ledger reason)

`anchor_expiry_cause.expiry_causes(claims)` is now the one place an expired request's cause is
derived. It takes the reason from the last `anchor_stale` row. An `ANCHOR_EXPIRED` expiry of a
request that was claimed and never charged by a release
(`_request_fault_requeue_count == 0`) is harness-class. `anchor_unreachable` and
`anchor_undatable` are facts about the request's own anchor, so they keep their class.

`anchor_stale` calls `expiry_causes` and its own `_causes` is gone. hr agreed to this edit in
the file it owns. `ANCHOR_EXPIRED` is spelled once, in `anchor_expiry_cause`, and the writer
(`agent_invocations._anchor_expiry_reason`) imports it, the same pattern as the outage prefix.
main approved that line outside the brief's ownership.

Because it is a reader, the rows already written are priced the same way, and no reason
vocabulary grows. `release_reason` is a closed, ledger-anchored table, and a new reason there
would be a one-way door.

`tests/test_anchor_expiry_after_harness_releases.py` drives the production writers: fan-out
mint, `claim_request` and `release_claim`, the `sweep_expired_anchors` age sweep, and the lease
sweep that disposes. It pins:

- a judge released twice for harness reasons expires, is re-minted, and its successor's expiry
  is re-minted again (before the fix: `remint_budget_spent`);
- the age sweep writes `ANCHOR_EXPIRED`;
- an ancestor released once for `submit_rejected` still spends;
- contract violations past the free allowance still spend;
- an ancestor nobody claimed still spends.

### Not done here

- The lineage cap (`MAX_EXPIRY_LINEAGE_REMINTS = 2`) is unchanged, so a lineage whose host never
  serves still ends at the operator.
- No disposition already written is rewritten. The 34 records keep `unclassified`. A re-decided
  record (PR-6) prices its own cause from the ledger.

## ARIA-HIGH-425 — the seven-day window is spent to exhaustion every week, and nothing paces it

### Symptom

397 of the 543 releases fall inside an exhausted Anthropic seven-day window (table above). The
exhaustion recurs every week:

| Window resets     | Peak reading              | Effect                                                           |
| ----------------- | ------------------------- | ---------------------------------------------------------------- |
| 2026-09-25 06:00Z | 0.98 by 09-21 03:35Z      | 4 days of failed dispatch                                        |
| 2026-10-02 06:00Z | limit hit (ARIA-HIGH-290) | 10-01 23h releases                                               |
| 2026-10-09 06:00Z | 0.99 at 10-08 17:00Z      | hidden that night by ARIA-HIGH-426, which failed every run first |

The current window (resets 10-16 06:00Z) read 0.44 at 10-10 10Z, 1.2 days in. The account is
shared with interactive Claude Code sessions, so not every unit of consumption is ARIA's.

### Root cause

Every Claude transcript carries the CLI's `rate_limit_event`, including at 0.98:

- `status: allowed_warning`, with `surpassedThreshold` 0.75;
- `unifiedWindows.seven_day.utilization`;
- `resetsAt`.

No reader consumes it. The stream reader handles `user`, `assistant` and `result` only
(`tools/aria-poc/claude_runtime.py:1667-1681`). The only Anthropic quota signal ARIA acts on is
the exhaustion notice (`claude_runtime.py:1766-1777`, `provider_cooldown.py:86-88`). That signal
arrives after the window is gone.

ARIA-HIGH-290 (RESOLVED) made the exhaustion recognised and cooled, so attempts are no longer
wasted. It does not prevent the exhaustion. Until the reset, every Anthropic-only role
(`primary_plan`, the implementer) waits.

### Fix direction (not implemented here; decision needed)

This is tier 2, make it automatic, and the right fix is a choice between:

- **capacity:** a larger plan or a second seat for the runner, the operator's call;
- **pacing:** the admission reads the last `seven_day` utilization and `resetsAt` from the
  attempt's own stream, and above a threshold reserves Anthropic for the roles only it can serve.

The stub carries owner claude and deadline 2026-10-17.

## ARIA-HIGH-426 — a root-owned file in the runner workspace stops every ARIA lane, silently

### Symptom (#1906's challenger: created 10-08 19:08:09Z, first claim 10-09 06:30:22Z)

The runner's own job logs:

| Worker log                             | Workflow / event / run                                | First failed step                                                | Result                                         |
| -------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `_diag/Worker_20261008-192425-utc.log` | aria-agent-executor / workflow_dispatch / 37831508928 | `Reset the persistent workspace, keeping installed dependencies` | Failed at 19:24:28Z                            |
| `_diag/Worker_20261008-220137-utc.log` | aria-auto-cycle / schedule / 37850756000              | same                                                             | Failed (20 s job)                              |
| `_diag/Worker_20261008-220229-utc.log` | aria-agent-executor / workflow_dispatch / 37850844306 | same                                                             | Failed (21 s job)                              |
| (none, 22:02:50Z → 06:27:47Z)          | no ARIA job reached the runner                        |                                                                  |                                                |
| `_diag/Worker_20261009-062747-utc.log` | aria-agent-executor / workflow_dispatch / 37891508302 | none                                                             | Succeeded; claimed the challenger at 06:30:22Z |

The aria/state publish history agrees. After `rescue-20261008-manual-2` at 21:15Z, the next
publish is `executor-37891508302` at 07:47Z.

### Root cause

Every self-hosted ARIA lane runs in one persistent workspace (concurrency group
`aria-selfhosted-workspace`, `aria-agent-executor.yml:76-78`). Its first step is:

```
set -euo pipefail; git reset --hard; git clean -ffdx -e node_modules
```

That is `aria-agent-executor.yml:184-191` and `aria-auto-cycle.yml:198-205`. `git clean` exits 1
when it cannot remove a path, which was reproduced here with an unremovable file under the same
shell flags. A process running as root had written into that workspace:

- `/root/aria-recovery/2026-10-09-runner-workspace-root-owned` holds 2,355 root-owned files of
  `.aria-state-store`, with mtimes from 2026-10-08 19:52Z;
- the directory was created 10-09 06:02Z;
- the operator log records "Permission denied" and a `chown -R gharunner` fix.

After that, every lane failed in under 30 s, red but unnoticed. ARIA-HIGH-415 makes the
notification channel real. Nothing refuses a root write into that tree, and nothing names the
foreign owner.

UNVERIFIED: the 19:24Z failure predates the earliest backed-up file (19:52Z). Its exact path
(the memory note says `__pycache__`, which was not backed up) is not proven.

### Operator / runner action (needed now; main may do it)

1. Before the next ARIA run, as root:
   `find /home/gharunner/actions-runner/_work -xdev ! -user gharunner -print` must print
   nothing. If it prints anything, run `chown -R gharunner:gharunner` on exactly those paths,
   or move them aside.
2. Never run python or `aria_kernel` as root with the working directory, `ARIA_TOOLS_DIR` or
   `ARIA_WORKSPACE_ROOT` under `/home/gharunner/actions-runner/_work`. Operator work belongs in
   its own checkout.

### Fix direction (stub, owner claude, deadline 2026-10-17)

- **Make it impossible:** the kernel CLI refuses to write a store under the runner's work root
  when its euid is not the runner user's.
- **Detectable:** the reset step names the foreign-owned paths and the remedy instead of
  failing anonymously.

## Why the `29 2 * * *` executor cron did not fill 21:02 → 06:30

- **Proven:** had a run started in the gap, it would have failed at the same reset step. The
  three runs before it did, and the root-owned tree stayed until 06:02Z.
- **Proven:** the runner received no job of any ARIA workflow between 02:31:59Z (a
  dataflow-watchdog probe) and 06:27:47Z, although it and the shared group were idle. So no
  schedule-triggered executor run reached the runner in the gap. No schedule-triggered executor
  job has reached it on 10-08, 10-09 or 10-10 either.
- **Observed on idle days:** GitHub creates this cron hours late.
  - On 10-06 the runner was idle from 06:24 and the schedule job started only at 09:10:39
    (run 37441121465), so it was created after about 06:24, at least 3.9 h late.
  - On 10-07 the runner was idle from 01:49 to 08:09 and the job started at 10:33:20
    (run 37597499191), so it was created after about 08:05, at least 5.5 h late.
  - The 17:13 auto-cycle cron of 10-08 (run 37850756000) has a run id between two dispatches
    created around 19:24 and 22:02. Run ids are assigned at creation, so it was created at
    about 22:01, roughly 4.8 h late.
- **UNVERIFIED:** whether the 10-09 cron run was created after 06:27 and evicted from the
  group's single pending slot by a chained dispatch (the ORPHAN-713 mechanism), failed its
  hosted preflight, or was never created. This needs the runs API: `aria-agent-executor`
  runs with `event=schedule` for 10-08..10-10 (`created_at`, `status`, `conclusion`, job count).
  No stub is written for an unproven cause.

## ARIA-MEDIUM-427 — a task-binding refusal is released under the fleet's admission reason

### Symptom

All 70 `native_runtime_admission_unavailable` releases are one request,
AIR-aria-challenger-planner-2d16fdbb749e:

- they come from seven planner-dispatch daemon runs, 10 each, 09-18 21:35Z → 09-19 21:35Z;
- 70 of 70 are preceded within 60 s by a `runtime_task_binding_unavailable` governance row for
  the same request, reason `target_revision_mismatch` (anchor b8febe12, HEAD moving with main).

The fleet's own refusals with `managed_session_logged_out` are different requests and released
no claim: 29 rows from executor run 35399433212, 09-18 22:07-22:24Z. Yet ARIA-HIGH-366, the
outage seam docstring and the executor comment read these 70 as "73 logged-out releases".

The loop itself ended when #1619 (1b75edf22, 09-20 00:41Z) gave the planner hook a per-request
worktree. There has been no such release since.

### Root cause

`ci_executor.TASK_BINDING_REFUSAL` (`tools/aria-poc/ci_executor.py:3945-3951` at 2b8385600, used
at `:4310` and `ci_executor_judge_batch.py:244-247`) released with
`native_runtime_admission_unavailable`.
That is the reason of the fleet's `no_eligible_provider` (`:3940-3943`). Two causes under one
name: the claims ledger, the only record of why a claim came back, cannot tell them apart.

### Fix (one name per cause)

`TASK_BINDING_REFUSAL` now releases as `native_runtime_task_binding_unavailable`. That name
already exists and the hash-changed binding path already uses it (`ci_executor.py:4817`,
`ci_executor_judge_batch.py:308`). The change does not touch accounting. Both names are in
`HARNESS_FAULT_RELEASE_REASONS`, `classify_release_reason` says `harness` for both, and
`parse_release_reason` gives fault domain `harness` for both.
`test_native_admission_undecided.TheReleaseReasonIsRegisteredEverywhere` already loops
`TASK_BINDING_REFUSAL` through those three checks. One new assertion there names the reason
and separates it from the fleet's `no_eligible_provider` reason.

So nothing that the release reason drives changes:

- the requeue count (`_request_fault_requeue_count`);
- the derived state;
- the anchor-expiry pricing above, which reads the same count.

The child's summary class (`policy_violation`, non-retryable) is unchanged, as is the
fleet's own refusal.

### Not done here

The "73 logged-out releases" sentence in `provider_outage_seams.py:4-8` and
`tests/test_provider_outage_signal.py:5` is left as written. It is history in another PR's
docstring, and this review records the measurement. The seam itself is right for a logged-out
session.
