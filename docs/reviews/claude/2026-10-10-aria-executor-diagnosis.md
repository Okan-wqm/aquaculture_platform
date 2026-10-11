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

## ARIA-HIGH-425 — fix: a spent Claude window moves every read seat to Z.ai until the reset (2026-10-10, wave 2)

### Decision

Operator decision 2026-10-10: "if the Claude quota runs out, switch to Z.ai in every area until
the window resets, then return to Claude." Z.ai was already registered. The fix extends the one
owner of provider exhaustion, `provider_cooldown`. There is no second router.

### Why the failover never fired

- **The fleet already failed over on a cooldown.**
  - `native_admission._native_runtime_admission` refuses a cooled provider without a probe.
  - Every read-only ladder has `zai` as a rung (`runtime_profiles.json`, `provider_routing`).
  - Production runs every ci_executor request through that admission:
    `aria-config/genesis_policy.json` has `adaptive_runtime.enabled: true`, and
    `ci_executor._admit_native_route` reads `active_provider_cooldowns`.
- **The cooldown was never written.** The bound governance (f5c5c86a1) holds **zero**
  `provider_quota_cooldown` rows and zero `model_credit_exhausted` rows, ever.
  - In August and September (before ARIA-HIGH-290 reached main on 10-04), the native lane mapped
    a non-zero exit to `provider_nonzero` and released `native_runtime_execution_unavailable`.
    No cooldown was written, so the next admission re-admitted Anthropic. That is the 226
    September releases while Z.ai kept succeeding.
  - Since ARIA-HIGH-290, only the notice's wording is matched (`USAGE_LIMIT_NOTICE_RX`). That
    match has not fired in production. On 10-08 the window reached 0.99, and ARIA-HIGH-426 hid it.
  - A 429 whose text is the CLI's `API Error: 429 … rate_limit_error` matches
    `UNREACHABLE_MARKERS` instead. Its cooldown would be a 900 s `unreachable` back-off,
    doubling to 3600 s, against a window that resets days later. The red run below shows this.
- **Nothing read the vendor's own reading.**
  - The CLI's `rate_limit_event` has this schema, read from the runner's binary
    (`/home/gharunner/.local/share/claude/versions/2.1.278`) and from 2.1.296:
    - `status`: allowed | allowed_warning | rejected;
    - `resetsAt` and `rateLimitType` for the binding window, plus `utilization` when known;
    - `unifiedWindows.{five_hour, seven_day, seven_day_overage_included}.{utilization, resetsAt}`.
  - The CLI emits it "when rate limit info changes".
  - In the store: 339 events in 239 transcripts, 176 `allowed` five_hour and 163
    `allowed_warning` seven_day. There are no `rejected` samples, because a refused attempt
    stores no transcript.

### What Z.ai can serve (production `runtime_attempt_*` rows, admission `pending_native_submit`)

- **Served on zai already:** adversarial_judgment 98, maintenance_utility 44,
  human_required_adjudication 22, challenger_plan 19, cross_review 16, completeness_critique 2.
- **Not yet served on zai, but zai is their ladder's second rung** (same transport, same
  admission, same submit path): primary_plan, evidence_judgment, consensus_arbitration,
  specialist_domain_review, primary_authoring.
- **glm_first roles never minted in production:** challenger_authoring, verification,
  change_intelligence, goldset_curation.
- **The write seats cannot run on Z.ai.** The zai fleet row has `admits_writes=False`
  (`model_fleet.py:108-116`). `run_zai_chat` is one chat completion with no tool loop
  (`zai_runtime.py:454-468`). `claude_writer` is `["anthropic"]`. ARIA-HIGH-290's operator
  decision of 2026-10-02 states this, and the 2026-09-11 key policy forbids the CLI redirect.
  - This was reported to main with that evidence before any edit.
  - Decision: write seats wait by name, uncharged. Option (b), a Z.ai write runtime, is
    **ARIA-HIGH-434** (stub, OPEN). main is asking okan whether to build it.
- **`aria-drafter` has no spawner in code.** `agent_genesis.py:657` and `draft_intent.py:15`
  name a spawn that nothing implements; no writer of `drafter-invocations.jsonl` exists.
  Genesis skill drafting is `primary_authoring` / `challenger_authoring` on the native lane, and
  those move.

### Fix

1. **The reader** (`claude_runtime.extract_rate_limit_exhaustion`).
   - The run's newest reading decides.
   - A window is spent when the status is `rejected` (the binding window), or when its
     utilization has reached `provider_cooldown.QUOTA_WINDOW_EXHAUSTED_UTILIZATION`.
   - The threshold is 0.98, a named kernel constant pinned with this design. The CLI rounds to
     two decimals. In September, 0.98 turned into the hard stop 5.6 h later. The headroom keeps
     a long run from starting into the wall and leaves the shared interactive sessions room.
   - The record carries every spent window and `resets_at`, the latest of their resets.
   - A `rejected` reading is the run's `credit_exhaustion`. It is checked first, before both
     text shapes, so the existing `ClaudeCreditExhausted` arms do what they already do: cool,
     release `provider_quota_unavailable:anthropic` (harness-class, no budget burn), and
     submit nothing.
   - A threshold reading on any run is `ClaudeRunResult.quota_window`. It is not a failure: a
     served answer stands.
2. **The cooldown ends at the window's reset.**
   - `provider_cooldown.detection_reset` reads the structured `resets_at` before the notice's
     wording. It keeps the same `(now, now + 7 d]` bound, outside which the policy default
     applies.
   - The new signature is `claude_rate_limit_event`, `(anthropic, quota)`, in the closed table.
   - "Back to Claude" is the existing expiry. `active_provider_cooldowns` drops the row at the
     reset, the admission probes Anthropic again, and the first served run closes the outage
     (`record_provider_restored`).
3. **Both spawn sites write the threshold cooldown under the claim they hold.**
   - `ci_executor.invoke_claude_cli` covers the native and spawn lanes.
   - `worker_executor.main` covers the worker lane.
   - Both write after the restore, so the quota outage the cooldown opens is not the one the
     restore closes.
4. **The drain no longer skips a seat the next vendor serves.**
   - `dispatch_failure.resolve_dispatch_route(cooled=…)`: when the declared head is cooled, the
     route is the first live rung that is not. That is the admission's no-probe refusal.
   - The drain reads the cooldowns once per iteration, outside the `ValueError` guard, so a
     malformed row stops it by name.
   - Before this, the run that met the exhaustion opened the `(anthropic, opus,
credit_exhausted)` circuit. It then skipped every claude_first request, and five skips
     stopped the drain.
5. **The spawn lane** (`runtime_profiles.routed_models(cooled=…)`, adaptive policy off) orders a
   cooled vendor's rungs last.
6. **A quota exhaustion is no longer a persistent breaker failure**
   (`ci_executor_drain.PERSISTENT_BREAKER_KIND_BY_CLASS`).
   - The cooldown answers it. As an `executor_environment_failure`, three spent windows inside
     the breaker's window (five-hour windows can do that in a day) tripped the breaker that
     every self-acting profile consults.
   - It still opens the same-run circuit.

### Evidence the fix reads the production signal

- The reader was run over the 239 stored transcripts that carry the event. It fires on 10:
  - nine September readings at 0.98, the first at 09-21 02:44:56Z, which is 5.6 h before the
    hard stop;
  - the 10-08 17:30Z reading at 0.99.
- It fires on no reading below 0.98.
- Each would have cooled Anthropic until its window's reset:
  - 2026-09-25T06:00Z for September, which would have saved the 226 releases;
  - 2026-10-09T06:00Z for October.

### Tests (`aria-kernel/tests/test_claude_quota_window_failover.py`, 18 tests, 56 subtests)

- **Red on the parent code:**
  - With the kernel constant missing, the module fails at import.
  - With only `provider_cooldown.py` changed, 16 of 18 fail for the behaviour under test.
  - The 429 case releases `provider_unreachable:anthropic`.
  - The served-at-threshold case writes no cooldown.
  - The drain dispatches only `AIR-1` and skips the two evidence judges.
  - The breaker records `executor_environment_failure`.
- **Green with the fix:** 18 passed.
- **Route fakes:** the drain's route fakes in `test_executor_drain_mode.py`,
  `test_executor_drain_plan_progress_first.py` and `test_executor_event_driven_planning.py` take
  the new `cooled` keyword. That pins the drain's call.
- **Production shapes:**
  - The stored events are used verbatim.
  - Two cases run the real `ci_executor.py` child against the real kernel claims and submit,
    with a fake `claude` whose stream carries the reading:
    - a 429 with a `rejected` reading is REQUEUED, uncharged, cooled until the window's reset
      (not 900 s), and released `provider_quota_unavailable:anthropic`;
    - a served run at 0.98 is ACCEPTED, and the next request is refused Anthropic by name
      with no second spawn.
  - Every seat of the routing table, with its real profile, goes through the real admission:
    - while cooled, every read seat is admitted on zai/glm-5.3, Anthropic is not probed, and
      the implementer is `no_eligible_provider`;
    - after the reset, every seat is back on its own ladder head;
    - with Z.ai cooled and codex absent too, no seat is admitted.
  - Worker lane: a served run at the threshold keeps its answer and cools under its claim. The
    hook then holds the worker with no claim.

### Not done here

- **The write-seat move to Z.ai** is ARIA-HIGH-434 (OPEN, decision with okan).
- **The live `rejected` emission on a refused 429 is UNVERIFIED.** No refused attempt stores a
  transcript.
  - The runner CLI's schema and its own `weekly-limit-reached → unified-status rejected` path say
    the event carries `rejected`.
  - If it does not, the threshold reading on the previous served run still cools first, and the
    notice regex stays as the fallback.
- **The quota outage still opens one HUMAN_REQUIRED item per transition.** That is the
  ARIA-HIGH-366 contract, unchanged. A weekly threshold cooldown therefore opens one item a week,
  and it resolves itself on the first served run after the reset.
- **The `circuit_breaker.FAILURE_KINDS` comment** still lists "auth/credit/…" as environment
  failures. That file is not this finding's; the drain's mapping is the authority.
- **Judges under an Anthropic cooldown now key the drain's batch route on zai.** Batching stays
  off (`judge_batch_size: 1`), so nothing changes until the operator raises it.

### Peer review of 79b82c8d3 (queue) — one latent defect fixed

- **Defect.** queue confirmed a latent LOW. A `rejected` reading while `isUsingOverage` is true is
  a run that billed extra usage, and its answer stands. The reader nevertheless made it the run's
  credit exhaustion: the served answer was dropped and Anthropic was cooled.
- **Fix.**
  - The reader names that reading `overage_serving`. It is not a refusal and rides the result as
    `quota_window`.
  - The subscription window is still spent. The operator's decision moves work to Z.ai when the
    quota runs out, not onto spend beyond it, so the window cools until its reset all the same.
- **Test.** `test_a_rejected_window_that_overage_served_keeps_its_answer_and_still_cools`. It is red
  on 79b82c8d3, where `extract_credit_exhaustion` returns trigger `rejected` on rc 0.
- **Not affected today.** All 339 stored readings say `isUsingOverage: false`, because overage is
  disabled for the organisation.
- **Perf note, kept as is.**
  - The drain reads the cooldowns once per iteration on purpose, because a child in the same pass
    writes the cooldown the next request must see. It costs about 0.7 s on the 20 MB store,
    against a child of minutes.
  - The extra read in `invoke_claude_cli` is on the legacy spawn lane only.

## ARIA-HIGH-426 — fix (wave 2): the kernel refuses another account's tree, and the reset names it

### Second vector found while fixing

`file_lock.with_exclusive_lock` creates its lock file with `O_CREAT`, mode 0644, and never
unlinks it on POSIX (`file_lock.py:197-221`). Every `state checkout` and every publish takes
`state_store._state_store_lifecycle_lock`, whose lock file is
`<git-common-dir>/aria-state-lifecycle`. So a root-run state command leaves a root-owned lock in
the runner's `.git`, and the runner can no longer open that lock for any later checkout or
publish. Running `chown` on the workspace alone would not fix that. `git reset --hard` and
`git clean` never look at `.git/`.

### Fix, kernel (tier 1 for the store)

`aria_kernel/write_root_owner.refuse_foreign_owned_root` holds one rule. A write root whose
nearest existing ancestor is owned by neither this process's euid nor root is refused. The
refusal is a `GovernanceError` beginning `write_root_foreign_owner:`. It names the root, the
owning account, the uid this process runs as, and the remedy: run the command as the owner
(`sudo -u <owner> ...`), or bind a store of your own. There is no override.

Root-owned trees are left to the OS. Root can always clean them up, so writes there are allowed:

- `/tmp`, where a non-root writer leaves files root can remove;
- `/var/lib/aria/code`, which the gharunner T2 probe reads;
- this host's root-owned `/var/aqua-saas` worktrees, where the operator's own sessions run.

The rule is asked where each write root is resolved:

- **`tool_registry.tools_dir`.** All three resolutions (`--tools-dir`, `ARIA_TOOLS_DIR`, the
  walk-up) are checked before `ensure_tools_dir` creates anything. Every ledger read or write
  resolves through it. The result is memoized per (root, euid).
- **`state_store._state_store_lifecycle_lock`.** The repository and its git common directory are
  checked before the lock file is created and before the first git write of a checkout or
  publish.

`ARIA_WORKSPACE_ROOT` needs no check of its own. The kernel only sets it for a child process
(`planner_dispatch_hook.py:596`) and never resolves it.

### Fix, lanes (tier 3 for what the kernel cannot reach)

CPython writes `aria_kernel/__init__`'s `.pyc` before any kernel code runs. So a root python
that imports the runner's checkout still leaves a root-owned `__pycache__`, and no guard inside
the package can prevent that.

The reset step in `aria-auto-cycle.yml` and `aria-agent-executor.yml` now has one identical body.
It is inline because it runs before checkout. If `git reset --hard` or
`git clean -ffdx -e node_modules` fails, the step:

1. lists, with `find -xdev`, every path not owned by the runner account, skipping
   `node_modules`;
2. emits `::error title=Foreign-owned files in the persistent workspace::`, giving the count,
   the workspace, the remedy (`chown -R <runner>:<runner>` as root, or move the path aside) and
   `sudo -u <runner>`;
3. prints the first 50 paths, each with its owner, to the log and the job summary;
4. exits 1.

A failure with no foreign path gets its own `::error`. The happy path is unchanged: there is no
scan. The step comes before the lease gate, so the abort-gate contract is untouched.

### Evidence

- **Parent code.** `ensure_tools_dir` run as root on a store path inside a tree owned by
  `nobody` creates `.aria-state-store/tools`, owned by root. That is the incident's shape.
- **This code.** The same call raises `write_root_foreign_owner`, and nothing is created.
- **Parent step body.** Run as `nobody` over a root-owned `.aria-state-store/tools/governance.jsonl`,
  it exits 1 and prints only `HEAD is now at …`.
- **This step body.** The same run prints the `::error` with the path
  (`root ./.aria-state-store/tools/governance.jsonl`) and `sudo -u nobody`, and writes the summary.

### Tests

- `tests/test_write_root_owner.py` (5 tests), with the process made root through the module's
  euid seam:
  - every tools-root resolution into a foreign tree is refused, nothing is created, and the
    message names the owner and `sudo -u`;
  - a state checkout of a foreign repository creates no lifecycle lock and no store;
  - a root-owned ancestor and an own tree stay writable;
  - the checkout the suite runs from stays writable.
- `tests/test_workspace_reset_names_foreign_owner.py` (4 tests) runs the step body exactly as
  the workflows carry it:
  - both bodies are identical;
  - a clean reset still removes untracked files and keeps `node_modules`;
  - a path another account owns is named, with the remedy. This test needs root, so in CI it is
    skipped, and here the body runs as `nobody` under `setpriv`;
  - an unremovable path the runner owns gets the other error.

  On the parent, 3 of the 4 are red.

- The in-slot run in the worktree covered 232 tests and passed, with 1 skipped and 140 subtests:
  - both new files;
  - the owner tests `test_tool_registry_binding` and `test_tool_registry_c2_lifecycle`;
  - `test_state_store_hollow_aside_ignored`, `test_t2_boundary_probe` and `test_jev_runtime`;
  - the workflow and contract tests the private snapshot could not run.

  On the snapshot, the 38 Python modules that read these workflows or the contract registry,
  plus the state store and tool registry owner tests, gave 947 passed. The 7 failures there
  were snapshot artifacts (missing `infrastructure/`, `.mcp.json` and the git repository), and
  all 7 are green in the worktree.

- The repo's TS invariants that read workflows: 56 suites, 689 tests.
  `aria-kernel-workflow-setup.spec.ts` caught the first wording of the `::error`: it named
  `aria_kernel`, which the invariant reads as kernel code running before setup. The text now
  says "python and kernel commands", and that suite is green.

### Not done here

- **No host change.** `find /home/gharunner/actions-runner/_work -xdev ! -user gharunner` printed
  0 paths on 2026-10-10. That was a read-only scan, and nothing was changed on the runner host.
- **The `.pyc` vector stays detect-only,** for the reason above. The cycle job sets
  `PYTHONDONTWRITEBYTECODE` (`aria-auto-cycle.yml:203`), but an operator shell does not. That is
  why the remedy names `sudo -u <runner>`.

### Review of 44ce28427 (zai): no defects; one operator-visible effect

- **By design, now stated.** The aria-gateway service's store, `/var/aqua-saas/aria-tools`, is
  owned by `gharunner` (`stat` on 2026-10-11; the service is inactive). A root session in the main
  checkout that resolves it is now refused with `write_root_foreign_owner`. That covers
  `/aria-status` and `/aria-cycle` (`.claude/commands/`, `--tools-dir aria-tools`). Before this
  commit, those commands wrote root-owned files into the gateway's store, which is the hazard this
  finding closes. Run them as the store's owner: `sudo -u gharunner …`. zai measured 0
  non-gharunner files in that store today.
- **Wording, fixed in the next commit.** The refusal said that the runner's workspace reset fails
  on such files, whatever the tree. It now says that the owner's processes could not remove or
  reopen them, and gives the runner's reset as the case that happened.

## ARIA-HIGH-434 — fix (wave 3): the write seats move to Z.ai through a kernel-owned tool loop (2026-10-11)

### Decision

Operator decision 2026-10-10/11: "if the Claude quota runs out, switch to Z.ai in every area".
For the write seats this overrides ARIA-HIGH-290's "wait by name" decision of 2026-10-02. The
2026-09-11 policy stays: the Z.ai key never reaches the `claude` CLI. The write runtime is
therefore the kernel's own. Claude first stays the default.

### Symptom

While Anthropic was cooled, the implementer was `no_eligible_provider` and the worker lane
skipped every assignment (`provider_cooldown`). Nothing could write until the window reset, which
is up to 7 days for the seven-day window. The causes:

- `model_fleet.py:108-116`: the zai row had `admits_writes=False`.
- `zai_runtime.run_zai_chat` (`zai_runtime.py:454-468`) is one completion with no tool loop.
- The routing table's `claude_writer` ladder was `["anthropic"]`, and the loader refuses a
  write-scope ladder that names a provider which cannot write (`runtime_profiles.py:302-303`).

### What the Claude writer runs under (mapped before any edit)

- **Policy.** The per-spawn settings document (`claude_settings.build_settings`) carries:
  - `permissions.deny`: the command policy's Bash projections, `Read(./.env)` and its siblings,
    and the denied tools;
  - `_aria.turn_budget`;
  - the hook matchers.
- **Gate.** The hook broker (`hook_broker._Handler`) calls `hooks.run_hook`. That runs
  `decide_pre_tool`, then `admit_budgeted_turn` (the turn counted in the decision ledger's own
  transaction), then the pre-write checkpoint, the work journal and the session snapshots.
- **Room.** `claude_runtime._apply_write_containment` calls
  `implementation_safety.wrap_managed_claude_in_sandbox`, which calls `wrap_bash_in_sandbox`. The
  room uses:
  - the profile's write scope;
  - READONLY_PATHS read-only;
  - the executor-held commit-capable git containment;
  - `MANAGED_SPAWN_ISOLATION_FLAGS`;
  - `apply_resource_limits` outside it.
- **Kernel MCP view.** The implementer contract's first step is `mcp__aria__plan_verify`
  (`.claude/agents/aria-implementer.md:77`), served by `AriaMcpServer(allow_writes=False)`
  outside the sandbox.
- **After the spawn**, nothing depends on the runtime (`ci_executor._main`): the quarantine
  publication, the identity retirement, the apply gate, the push and the PR.

### Fix

1. **`zai_runtime.run_zai_turn`.** This is the documented OpenAI-compatible function-calling
   form of the same call. The endpoint, the Authorization header built from the held
   credential, and `_classify` are all unchanged. The key handling is untouched and never leaves
   the module.
2. **`tools/aria-poc/zai_tool_loop.py` (new): the loop outside every sandbox.** It adds no
   policy of its own.
   - **Policy.** It reads `build_settings` over `claude_runtime._hook_context`: the document
     the Claude spawn would carry. `_envelope_from_profile` gives the envelope. A rule shape the
     gate cannot apply is refused by name (`zai_room_permission_rule_unsupported`), never skipped.
   - **Tools.** The loop offers the profile's grant ∩ {Read, Grep, Glob, Edit, Write, Bash},
     using Claude Code's input shapes. On top of that it offers the profile's kernel-served MCP
     read tools (`mcp__aria__*`), served in-process by the same `AriaMcpServer(allow_writes=False)`.
     A non-kernel MCP server is refused (`zai_room_mcp_server_unsupported`).
   - **Gate, in the CLI's order.** An unoffered tool is refused. Then, when the PreToolUse
     matcher covers the tool, `hooks.run_hook("pre-tool")` decides it, with the CLI's payload
     shape and the document's turn budget. Then the document's deny rules apply: Bash rules
     through `command_policy.claude_rule_matches`, and the Read rules on every path a read tool
     names. PostToolUse and the session events also go through `run_hook`. The model reads a
     refusal as the hook's own reason.
   - **Room.** It is `wrap_bash_in_sandbox`, built with:
     - the profile's write scope;
     - the SAME git containment (the commit-capable one the executor holds for the implementer;
       otherwise derived read-only, as `_apply_write_containment` derives it);
     - `MANAGED_SPAWN_ISOLATION_FLAGS`;
     - `apply_resource_limits`.

     Bash runs as `bash -c <line>`. The file tools run in `tools/aria-poc/zai_room_child.py`
     (stdlib only, `python -I`, bound read-only alone).

   - **Budgets.**
     - The wall clock is the spawn's `timeout_seconds`, clamped to the job deadline.
     - The turn budget is the hook's.
     - A completion cap of 2 × the turn budget applies, because an HTTP conversation has no CLI
       to end it.
     - Bash timeouts are 120 s by default and 600 s at most. Outputs follow Claude's caps.
   - **Transcript.** It has Claude stream-json shape. `parse_claude_jsonl`,
     `extract_final_message`, `extract_usage`, the progress writer and the envelope builder read
     it unchanged.
   - **Usage.** Usage is the sum over turns. It is `None` if any turn reported none, and is
     never priced as zero.

3. **`ci_executor`.**
   - **Native lane (production).** `_invoke_native_zai` runs the loop for a write-capable
     profile with the held `git_containment` (`_invoke_native` dispatch table). The reservation,
     transcript, envelope, cost row and `runtime_attempt_finished` all read the same as before.
     `provider_session_ids` lists every turn. A room refusal is released as the Claude writer's
     is (`ClaudePolicyViolation` becomes `ClaudeCliUnavailable`).
   - **Spawn lane.** The zai rung of a write-capable profile is the loop
     (`zai_tool_loop.run_zai_writer`). The mapping to the Claude run result is shared
     (`claude_run_result`), so the read rung is unchanged.
4. **Worker lane.**
   - `runtime_profiles.worker_ladder(profile)` is the one answer to "which providers does a
     worker assignment run on". A write-capable target rides the writer ladder (the
     `implementation` seat). Dispatch-request rows carry no role, and the worker profile is the
     implementer's envelope.
   - `worker_route` takes the head unless it is cooled. Past a cooled head, it takes the first
     later rung that is neither cooled nor absent on the host (no Z.ai key means no claim).
   - The hook passes `--model`. The child re-checks the model against the same ladder and runs
     the loop for a zai model.
   - `worker_dispatch_hook.worker_target_profile` / `worker_ladder_for_target` resolve a target's
     agent file from the code tree. They are the one resolver, for the hook and for the
     continuity lease reaper.
   - With every writer suspended, the hook stops by name before any claim
     (`worker_route_unavailable:<target>:every_writer_suspended`).
5. **Admission.**
   - The zai row has `admits_writes=True`.
   - `claude_writer` is `["anthropic", "zai"]`.
   - The loader still refuses a writer ladder that names Codex (new test case `writer_on_codex`).

### Deviations (agreed with main before the edits)

- **No network in the room** (`ROOM_ALLOW_NETWORK = False`). The Claude room shares the host's
  network only because the CLI inside it calls its provider (`MANAGED_SPAWN_ALLOW_NETWORK`).
  Here that call is the loop's, outside the room. The room has the validation sandbox's network
  shape. Measured: the vendor on loopback is unreachable from inside.
- **One room per call.** The workspace persists between calls. `/tmp` and background processes
  do not; the Claude room's live as long as the CLI.
- **The kernel MCP view is offered** next to Read..Bash, because the implementer contract cannot
  start without `plan_verify`.
- **No Claude credential in the room.** The CLI's auth names are removed from the built
  environment. The room refuses to stand if any secret-shaped name remains
  (`zai_room_env_carries_credential_names`), or if the Z.ai key file lies under any path it
  binds (`zai_room_binds_the_credential`).

### Evidence

- **Per-call room overhead.** The median is 58 ms over 5 runs on this host (bwrap, the
  `timeout` limiter as root, `/bin/true`).
- **Production implementer sessions** (aria/state, `tools/agent-invocations/work-journal.jsonl`
  and `tools/hooks/decisions.jsonl`, 5 sessions):
  - 23 to 53 journaled tool calls, median 28;
  - 22 to 36 PreToolUse verdicts, with 5 to 13 of them denies.

  A typical session therefore spends about 2 to 4 s on rooms, against a 30-minute budget.

### Tests (red on 5c1f18262, green with the fix)

- **`aria-kernel/tests/test_zai_tool_loop.py`.** Real bwrap, real hooks and ledgers, a real
  checkout. The vendor is a local HTTP server reached through `zai_runtime`'s urllib.
  - An admitted Edit lands from inside the room, and is journaled and counted.
  - **Golden parity.** The test drives an allowed Edit, a `curl`, a Write under `.github/`, a
    Write outside the workspace, an allowed Bash and the call past a cap of 2. The loop's
    decision ROW equals, field for field (clock, session and chain hash aside), the row
    `hooks.run_hook` writes for the Claude CLI's payload on a twin store. The `.env` Read is
    refused by the document's `Read(./.env)` rule; the CLI's PreToolUse matcher never sends a
    Read to the hook.
  - EROFS on a READONLY path when the room is asked directly, without the gate.
  - **Key absence.**
    - The key is in no room environment value or name, and not in the room's argv.
    - The key file is unreadable inside.
    - A room that would bind it refuses to stand.
    - The key is not in the transcript or in any store file; it was sent only as the vendor's
      Authorization header.
    - The room has no network.
  - The transcript reads as Claude stream-json, usage is summed, and an unknown turn usage
    makes the whole usage `None`.
  - The progress observer sees every event.
  - `plan_verify` is served and recorded; a write tool is not offered; a stdio MCP server is
    refused.
  - The spawn lane's zai rung of a write profile is the loop. Its stdout is the stream, the
    envelope builder reads the answer from it, the rendered request is the user turn byte for
    byte, and the context-usage row is recorded.
  - A quota 429 mid-loop ends it as `zai_quota_refusal`.
  - The completion cap ends a loop that never answers.
  - A cancel stops at the next boundary.
- **`aria-kernel/tests/test_executor_zai_implementation.py`.** This is the real executor child
  on the native managed-subscription lane, on `test_executor_implementation_identity`'s fixture,
  with Anthropic cooled by a `rejected` reading.
  - The implementer is admitted on zai/glm-5.3, and Anthropic is refused by its cooldown with
    0 probes.
  - The vendor's tool calls stand on the kernel-made branch, write the plan's file and commit.
  - The commit verifies against the minted key.
  - The apply gate records the canonical suite at the tip.
  - The branch is pushed and the PR opened.
  - The request is ACCEPTED and the plan is IMPLEMENTATION_RECORDED.
  - The finished row lists every turn's response id.
  - `claude` never ran a model.
  - The key is in no file the kernel wrote and in no output.
  - A `git push` inside the run is refused by the hook's own verdict, and the run still
    delivers.
- **Pins updated to the decision:**
  - `test_claude_quota_window_failover`: every seat, the writer included, runs on zai while
    cooled and on its own head after the reset. The worker is routed to zai while cooled with
    the key on the host, stays on Claude otherwise, and is held by name with no key. The child
    runs the loop in its worktree and refuses a model off its ladder.
  - `test_provider_routing`, `test_provider_quota_cooldown`, `test_credit_fallback` and
    `test_claude_auth_failure_classification` (comment only).
  - `test_worker_lane_provider_cooldown`: its host is pinned key-less.
  - `test_provider_routing` (new class): `worker_ladder` and `worker_route` honour suspension;
    a read-only target never writes on zai.

### Not done here

- **Context compaction.** The Claude CLI compacts a long session; the loop does not. A vendor
  refusal of an over-long conversation ends the attempt by name (`vendor_refused`), and the
  request is released harness-class like any non-zero exit.
- **A transport failure in the middle of a loop** raises `ClaudeProviderUnreachable`, as a
  single completion does. That attempt's transcript is not written.
- **The worker room's git stays read-only,** as the Claude worker's is today. No commit
  containment is held for the worker lane.
- **The pre-claim gate still requires a logged-in `claude` CLI**
  (`ci_executor._pre_claim_environment_gate` calls `preflight_claude_auth`). A spent quota
  passes it. A host whose Claude login is gone holds every request PENDING, even one the
  admission would route to Z.ai. Reported to main for continuity (total outage); not changed
  here.
