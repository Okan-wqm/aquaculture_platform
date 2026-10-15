# ARIA — notices reach a person, once per fact (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-415 — the notification backbone reached nobody

### Symptom

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z), `notifications/outbox.jsonl`
holds 268 rows and every one is `unconfigured`:

| Kind                    | Rows | Status       |
| ----------------------- | ---- | ------------ |
| `human_required_opened` | 266  | unconfigured |
| `breaker_tripped`       | 1    | unconfigured |
| `cycle_failed`          | 1    | unconfigured |

The five failed cycles from `cyc-20261009T104405Z` to `cyc-20261010T025128Z` returned `failed`
(pr_lifecycle) and none of them wrote a `cycle_failed` row. The doctor reads
`notifications ok — no_channel_configured`, and no `self_improvement` mission has ever opened.

### Evidence

- `notify.py:89-101`: `github_issue` is configured only when `ARIA_NOTIFY_GITHUB_REPO` is set,
  and no lane sets it (`aria-auto-cycle.yml:782-903`).
- `autonomy_orchestrator.py:1744-1746`: the cycle-failed notice is sent only in the except
  branch. A cycle that RETURNED `failed` breaks at `:1780-1785` without one, and the
  `bridge_replay_required` exit (`:1873-1898`) has none either.
- `gateway/scheduler.py:201-228`: `doctor`, `self_improve` and `deliver` exist only as gateway
  actions. The gateway daemon is not deployed on production, so they never ran.

Turning the channel on as written would have caused new harm:

- `human_required.py:171-176` notifies every record, at every severity, under a title that
  names the record. That is one GitHub issue per record, and the live store opens 4 to 41 records
  a day (41 on 2026-10-07).
- The titles carried counts, ids and organ lists (`anchor_stale.py:196`, `scheduler.py:211`,
  the orchestrator's `ARIA cycle failed: <cycle_id>`). The issue identity is the title, so each
  distinct value would have opened another issue.
- `notify.py:118-122` found the open issue through the search index (`--search '"<marker>"
in:body'`). The index lags a just-created issue, so a second notice seconds later opens a
  second issue: gate (f) fails by construction.
- `notify.py:139` created issues with `--label aria`, and nothing in notify created the label.
- The doctor's failing organs reached only a variable title (`scheduler.py:211`), and the
  `gateway_action_ran` row (`:266`) carried none, so gate g1 could not be measured.

### Root cause

The notifier was built and its producers wired, but no lane named a channel. The one
cycle-failure producer sat in the branch that production failures do not take. The GitHub
channel was a second issue writer next to the kernel's own (`GhCliIssueWriter`,
ARIA-MEDIUM-227), and it found issues by a weaker lookup and shaped its titles for a channel that
had never been switched on.

### Fix

- **One issue writer.** `GhCliIssueWriter.comment_or_create` comments on the open issue with
  the exact title, or opens it. It finds the issue through the label-filtered issue LIST, never
  the search index, and creates a missing label. The notifier's GitHub sender is now a thin call
  into it with `--repo` set to `ARIA_NOTIFY_GITHUB_REPO`, and the marker/search code is deleted.
  The freeze notice passes no repo and keeps the 60 s call bound, and a test pins its argv as
  unchanged.
- **Same wall clock.** The longest sequence is four calls (list, label list, label create,
  create), so the per-call bound goes from 60 s to 30 s. `SENDER_WALL_CLOCK_SECONDS` stays
  4 × 30 = 120 s, `NOTIFY_WORST_CASE_SECONDS` stays 1380 s, and the executor's 2280 s record wait
  does not move.
- **Fixed titles; what varies rides the body:** `ARIA cycle failing`, `ARIA doctor unhealthy`,
  `ARIA daily delivery summary`, `ARIA: expired requests need an operator`.
- **One failed cycle is one notice.** `_notify_cycle_failed(root, *, cycle_id, exit_reason,
reason)` is called once after the `cycle_completed` transition, whether the cycle returned
  `failed` or raised, and once on the `bridge_replay_required` exit. The except-branch call is
  gone. The reason comes from the summary both outcomes write (`error`, or `failed_phases[].error`
  from ARIA-MEDIUM-413), is scrubbed of secrets and is bounded. The notice goes out before the
  failed-exit reflection (ARIA-HIGH-420), as agreed with that change.
- **Volume.** `record_human_required` notifies on its own only for CRITICAL records (0 of the 695
  on the store). The backlog reaches the operator as counts in the daily `deliver` comment: open,
  breaching_sla and tiers, read through the daily report's own `reflection._human_required_summary`.
- **Gate g1.** The doctor action's result carries `failing: [{name, reason≤300}]`, and its
  `gateway_action_ran` row carries the names. The notice body has one `name: reason` line per
  organ and never an organ's `detail`, which holds host paths, while the repository is public.
- **`ARIA_NOTIFY_CHANNELS=none`** is the operator's explicit "nobody" (`notifications_disabled`).
  It never enters `NOTIFY_CHANNELS`. `none,<channel>` raises `ChannelSelectorInvalid`, which
  `notify()` records as one `failed` outbox row instead of letting `notify_best_effort` swallow
  it.
- **Workflow.** In `aria-auto-cycle`, the cycle step and three new steps (doctor, self_improve,
  deliver) carry `ARIA_NOTIFY_CHANNELS=github_issue`, `ARIA_NOTIFY_GITHUB_REPO=${{
github.repository }}` and the job token. `issues: write` was already granted, and the executor
  lane gets nothing. The new steps:
  - run after the cycle and the burn-in, and before the snapshot, the integrity verify and the
    publish;
  - use `if: always() && steps.lease_check.outputs.blocked != 'true' &&
steps.lease_check.outputs.blocked == 'false' && (github.event.inputs.mode || 'cycle') ==
'cycle'`. The inner `||` sits inside parentheses, so the abort-gate contract sees one
    guarded disjunct, and a test shows that bare `always()` is caught;
  - have `timeout-minutes` of 10, 12 and 5;
  - are contracted in `workflow_contract_registry` (required steps plus ordering through the
    verify and the publish).

  A `channel_check` dispatch input sends two notices before the cycle and fails the step unless
  the second COMMENTED on the first issue (gate f). The doctor step writes the job summary and an
  `::error` naming the failing organs, with lines from PR-5. The sandbox-backend step loses its
  mock clause at PR-2's request (adapters run only inside the bwrap room).

- **Kill inventory.** The observation steps carry no ARIA_STOP guard. The file header records why
  and where ARIA_STOP is written: by the orchestrator itself on a deadline overrun.
- **Margin.** The 100-minute close-out margin (`- 6000`) is unchanged and its comment is
  corrected (it said 10 minutes). The unbounded close-out steps measured at most 57 minutes in
  #1371. Adding the observation timeouts (10 + 12 + 5) gives 84 of 100. A test pins the sum
  against the literal.

### Measured

On a `cp -a` of the store above, on this host:

| `schedule run --action` | Wall time | Store content changed                                                         |
| ----------------------- | --------- | ----------------------------------------------------------------------------- |
| `doctor`                | 229 s     | governance, integrity index                                                   |
| `self_improve`          | 245 s     | missions (3 opened: `doctor_fail:deadlines` + 2 `capability_gap`), governance |
| `deliver`               | 4.6 s     | outbox (`unconfigured` without a channel), governance                         |

Every changed path is a published surface: `state_manifest.surface_for_relative_path` covers
them, and `state_store` handles the integrity index separately.

### Not done here

- Doctor organ semantics (`_check_notifications` FAILing in CI without a channel, `config_missing`
  routing, `max_new`, mission titles) belong to ARIA-MEDIUM-417 (PR-5). This change provides the
  `notifications_disabled` and `ChannelSelectorInvalid` API that organ reads.
- No notice is sent when PR-6 stamps an exhausted escalation CRITICAL
  (`_stamp_escalated_to_operator`). That matches the plan: those 28 records appear in the daily
  backlog counts.
- Reason texts in a notice body are scrubbed of secret patterns, not of host paths. The notified
  reasons are reason codes and kernel prose.
- Gate (f) is UNVERIFIED in production, because the PAT is 401: a `channel_check` dispatch after
  merge proves it.
