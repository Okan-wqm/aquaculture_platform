# ARIA known-issue triage — 2026-10-16

The operator paused ARIA on 2026-10-16 until its known problems are fixed: the scheduled ARIA
workflows are disabled. Before a fix program, every OPEN ARIA finding in the registry (106) and the
repair session's 17 unregistered observations were validated against the code at 4535de11a
(origin/main 357ce623e plus PR #1978) and against production aria/state. Eleven read-only validator
agents did this, each giving a file:line or command for every verdict. main then spot-checked the
HIGH findings judged already fixed.

## Result

- 123 items: 91 real, 16 partially fixed, 11 already fixed (the registry still says OPEN), 2 not
  reproducible, and 3 that need an operator decision.
- **7 run-blockers**: running ARIA with one of these open causes concrete harm. Five are security,
  one is data loss and one is a runaway outage.
- The operator chose the scope: fix the run-blockers and every small or medium defect before ARIA
  restarts. The large capability gaps (L/XL) and the three operator decisions (ARIA-HIGH-272,
  ARIA-MEDIUM-139, ARIA-MEDIUM-273) stay tracked.

## Verdicts

| ID                | Verdict           | Run-blocker | Harm           | Size | Owner                                                        |
| ----------------- | ----------------- | ----------- | -------------- | ---- | ------------------------------------------------------------ |
| ARIA-HIGH-143     | real              | yes         | security       | L    | `aria-kernel/aria_kernel/implementation_safety.py`           |
| ARIA-HIGH-523     | real              | yes         | data_loss      | M    | `aria-kernel/aria_kernel/tool_runner.py`                     |
| ARIA-HIGH-527     | real              | yes         | security       | M    | `aria-kernel/aria_kernel/git_containment.py`                 |
| ARIA-HIGH-536     | real              | yes         | runaway_cost   | M    | `tools/aria-poc/claude_runtime.py`                           |
| ARIA-HIGH-540     | real              | yes         | security       | M    | `tools/aria-poc/ci_executor.py`                              |
| ARIA-MEDIUM-539   | real              | yes         | security       | M    | `aria-kernel/aria_kernel/implementation_delivery.py`         |
| ARIA-MEDIUM-546   | real              | yes         | security       | M    | `aria-kernel/aria_kernel/secret_scrub.py`                    |
| ARIA-CRITICAL-015 | real              |             | wrong_merge    | L    | `aria-kernel/aria_kernel/autonomy_unlock.py`                 |
| ARIA-HIGH-004     | real              |             | silent_failure | L    | `aria-kernel/aria_kernel/funnel_health.py`                   |
| ARIA-HIGH-011     | real              |             | none           | M    | `tools/aria-adapters/sql-migration-safety-adapter.ts`        |
| ARIA-HIGH-012     | real              |             | none           | L    | `tools/aria-adapters/infrastructure-policy-adapter.ts`       |
| ARIA-HIGH-014     | real              |             | silent_failure | XL   | `aria-kernel/aria_kernel/observation_coverage.py`            |
| ARIA-HIGH-016     | real              |             | none           | M    | `aria-kernel/aria_kernel/autonomy_closure.py`                |
| ARIA-HIGH-044     | real              |             | silent_failure | S    | `tools/gates/finding-registry.ts`                            |
| ARIA-HIGH-122     | real              |             | none           | L    | `aria-kernel/aria_kernel/self_improvement.py`                |
| ARIA-HIGH-125     | real              |             | silent_failure | L    | `aria-kernel/aria_kernel/goldset.py`                         |
| ARIA-HIGH-133     | real              |             | none           | XL   | `aria-kernel/pyproject.toml`                                 |
| ARIA-HIGH-138     | real              |             | silent_failure | L    | `aria-kernel/tests/invariants`                               |
| ARIA-HIGH-212     | real              |             | wasted_work    | L    | `tools/aria-adapters/doc-staleness-adapter.ts`               |
| ARIA-HIGH-238     | real              |             | security       | L    | `aria-kernel/aria_kernel/operator_approval.py`               |
| ARIA-HIGH-245     | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/mission.py`                         |
| ARIA-HIGH-247     | real              |             | silent_failure | M    | `scripts/aria/provision_runner.sh`                           |
| ARIA-HIGH-313     | real              |             | silent_failure | M    | `tools/gates/plan-coverage-witness.ts`                       |
| ARIA-HIGH-520     | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/autonomy_evidence.py`               |
| ARIA-HIGH-521     | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/merge_authority.py`                 |
| ARIA-HIGH-525     | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/architecture_spine_gate.py`         |
| ARIA-HIGH-528     | real              |             | security       | M    | `aria-kernel/aria_kernel/implementation_safety.py`           |
| ARIA-HIGH-529     | real              |             | wasted_work    | M    | `aria-kernel/aria_kernel/cross_review_bridge.py`             |
| ARIA-HIGH-530     | real              |             | wrong_merge    | M    | `.github/workflows/aria-kernel.yml`                          |
| ARIA-HIGH-531     | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/observation_coverage.py`            |
| ARIA-HIGH-534     | real              |             | silent_failure | S    | `tools/gates/finding-registry.ts`                            |
| ARIA-LOW-265      | real              |             | none           | S    | `aria-kernel/aria_kernel/operator_feedback_observation.py`   |
| ARIA-LOW-266      | real              |             | none           | S    | `aria-kernel/aria_kernel/operator_feedback_signature.py`     |
| ARIA-LOW-268      | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/operator_feedback_ingestion.py`     |
| ARIA-LOW-269      | real              |             | none           | M    | `aria-kernel/aria_kernel/main_anchor.py`                     |
| ARIA-LOW-405      | real              |             | none           | M    | `libs/backend-common/src/database/migration-helpers.ts`      |
| ARIA-LOW-445      | real              |             | wasted_work    | M    | `tools/aria-poc/ci_executor.py`                              |
| ARIA-LOW-503      | real              |             | none           | S    | `aria-kernel/tests/test_pr_cli.py`                           |
| ARIA-LOW-504      | real              |             | none           | S    | `aria-kernel/aria_kernel/circuit_breaker.py`                 |
| ARIA-LOW-506      | real              |             | none           | S    | `aria-kernel/tests/test_watchdog_freeze.py`                  |
| ARIA-LOW-509      | real              |             | wasted_work    | S    | `docs/runbooks/aria-v3-1-smoke.md`                           |
| ARIA-LOW-510      | real              |             | none           | S    | `.github/workflows/aria-kernel.yml`                          |
| ARIA-LOW-514      | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/reflection.py`                      |
| ARIA-LOW-518      | real              |             | none           | M    | `aria-kernel/aria_kernel/git_object_id.py`                   |
| ARIA-LOW-532      | real              |             | none           | M    | `tools/aria-adapters`                                        |
| ARIA-LOW-533      | real              |             | none           | S    | `aria-kernel/aria_kernel/calibration_dials.py`               |
| ARIA-LOW-541      | real              |             | none           | S    | `aria-kernel/aria_kernel/autonomy_evidence.py`               |
| ARIA-LOW-542      | real              |             | silent_failure | S    | `tools/aria-adapters/adapter-fs.ts`                          |
| ARIA-LOW-543      | real              |             | none           | S    | `tools/aria-adapters/adapter-fs.ts`                          |
| ARIA-LOW-544      | real              |             | none           | S    | `tools/gates/local-rumqttc-fork-hygiene.spec.ts`             |
| ARIA-LOW-545      | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/twin_test_surface.py`               |
| ARIA-LOW-547      | real              |             | security       | S    | `aria-kernel/aria_kernel/runtime_artifacts.py`               |
| ARIA-MEDIUM-029   | real              |             | none           | XL   | `aria-kernel/aria_kernel/execution_spine.py`                 |
| ARIA-MEDIUM-101   | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/mission_scheduler.py`               |
| ARIA-MEDIUM-110   | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/notify.py`                          |
| ARIA-MEDIUM-111   | real              |             | none           | S    | `aria-kernel/aria_kernel/ledger.py`                          |
| ARIA-MEDIUM-120   | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/integrity.py`                       |
| ARIA-MEDIUM-127   | real              |             | wasted_work    | M    | `aria-kernel/aria_kernel/human_required.py`                  |
| ARIA-MEDIUM-129   | real              |             | none           | M    | `aria-kernel/aria_kernel/knowledge_graph.py`                 |
| ARIA-MEDIUM-131   | real              |             | security       | M    | `aria-kernel/aria_kernel/hook_broker.py`                     |
| ARIA-MEDIUM-249   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/plan_synthesizer.py`                |
| ARIA-MEDIUM-254   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/ack_ledger.py`                      |
| ARIA-MEDIUM-264   | real              |             | wasted_work    | M    | `aria-kernel/aria_kernel/operator_feedback_observation.py`   |
| ARIA-MEDIUM-271   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/runtime_signal_bridge.py`           |
| ARIA-MEDIUM-276   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/label_queue.py`                     |
| ARIA-MEDIUM-277   | real              |             | silent_failure | L    | `.github/workflows/dataflow-integrity-watchdog.yml`          |
| ARIA-MEDIUM-314   | real              |             | silent_failure | M    | `tools/ripple-tracer/cli.ts`                                 |
| ARIA-MEDIUM-385   | real              |             | none           | M    | `aria-kernel/aria_kernel/agent_invocations.py`               |
| ARIA-MEDIUM-398   | real              |             | wasted_work    | M    | `aria-kernel/aria_kernel/cycle_rhythm.py`                    |
| ARIA-MEDIUM-400   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/fixture_runner.py`                  |
| ARIA-MEDIUM-438   | real              |             | wasted_work    | M    | `tools/aria-poc/ci_executor_drain.py`                        |
| ARIA-MEDIUM-507   | real              |             | silent_failure | M    | `aria-kernel/aria_kernel/dispatcher_factory.py`              |
| ARIA-MEDIUM-508   | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/tool_runner.py`                     |
| ARIA-MEDIUM-526   | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/architecture_spine_gate.py`         |
| ARIA-MEDIUM-535   | real              |             | none           | M    | `tools/gates/finding-registry.ts`                            |
| ARIA-MEDIUM-538   | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/command_policy.py`                  |
| NOTE-1            | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/autonomy_orchestrator.py`           |
| NOTE-10           | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/judge_fanout.py`                    |
| NOTE-11           | real              |             | wasted_work    | S    | `tools/gates/plan-coverage-witness.ts`                       |
| NOTE-12           | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/self_improvement.py`                |
| NOTE-15           | real              |             | security       | S    | `tools/aria-poc/genesis_adapter_launcher.py`                 |
| NOTE-16           | real              |             | wasted_work    | S    | `.claude/agents/_shared/aria-implementer-safety-contract.md` |
| NOTE-17           | real              |             | wasted_work    | M    | `aria-kernel/aria_kernel/agent_invocations.py`               |
| NOTE-2            | real              |             | silent_failure | S    | `aria-kernel/aria_kernel/autonomy_orchestrator.py`           |
| NOTE-3            | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/self_improvement.py`                |
| NOTE-4            | real              |             | wasted_work    | S    | `.github/workflows/aria-auto-cycle.yml`                      |
| NOTE-5            | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/converged_delivery.py`              |
| NOTE-6            | real              |             | none           | S    | `.github/workflows/aria-auto-cycle.yml`                      |
| NOTE-7            | real              |             | wasted_work    | S    | `aria-kernel/aria_kernel/github_adapters.py`                 |
| NOTE-8            | real              |             | security       | M    | `.github/workflows/aria-auto-cycle.yml`                      |
| NOTE-9            | real              |             | security       | S    | `aria-kernel/aria_kernel/notify.py`                          |
| ARIA-CRITICAL-009 | partially_fixed   |             | none           | M    | `aria-kernel/aria_kernel/merge_authority.py`                 |
| ARIA-HIGH-005     | already_fixed     |             | none           | S    | `aria-kernel/aria_kernel/autonomy_evidence.py`               |
| ARIA-HIGH-006     | partially_fixed   |             | wrong_merge    | M    | `aria-kernel/aria_kernel/agent_invocations.py`               |
| ARIA-HIGH-010     | partially_fixed   |             | none           | L    | `tools/aria-adapters/rust-runtime-safety-adapter.ts`         |
| ARIA-HIGH-013     | partially_fixed   |             | none           | M    | `tools/aria-adapters/workflow-shell-safety-adapter.ts`       |
| ARIA-HIGH-045     | partially_fixed   |             | silent_failure | M    | `aria-kernel/aria_kernel/architecture_spine_gate.py`         |
| ARIA-HIGH-137     | partially_fixed   |             | none           | M    | `aria-kernel/aria_kernel/implementation_delivery.py`         |
| ARIA-HIGH-206     | already_fixed     |             | none           | none | `.github/workflows/aria-merge-runner.yml`                    |
| ARIA-HIGH-213     | already_fixed     |             | none           | none | `docs/runbooks/aria-github-app-setup.md`                     |
| ARIA-HIGH-221     | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/merge_authority.py`                 |
| ARIA-HIGH-222     | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/state_store.py`                     |
| ARIA-HIGH-272     | operator_decision |             | security       | XL   | `aria-kernel/aria_kernel/state_manifest.py`                  |
| ARIA-HIGH-281     | partially_fixed   |             | silent_failure | S    | `scripts/aria/provision_runner.sh`                           |
| ARIA-HIGH-414     | partially_fixed   |             | security       | S    | `aria-kernel/aria_kernel/genesis_adapter_custody.py`         |
| ARIA-HIGH-441     | already_fixed     |             | none           | none | `tools/aria-poc/ci_executor.py`                              |
| ARIA-HIGH-448     | partially_fixed   |             | security       | M    | `aria-kernel/aria_kernel/artifact_safety.py`                 |
| ARIA-HIGH-524     | partially_fixed   |             | security       | S    | `aria-kernel/aria_kernel/agent_invocations.py`               |
| ARIA-LOW-252      | partially_fixed   |             | none           | M    | `aria-kernel/aria_kernel/semantic_memory.py`                 |
| ARIA-LOW-447      | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/git_containment.py`                 |
| ARIA-LOW-517      | partially_fixed   |             | none           | L    | `aria-kernel/aria_kernel/digest.py`                          |
| ARIA-MEDIUM-099   | already_fixed     |             | none           | none | `tools/aria-poc/ci_executor.py`                              |
| ARIA-MEDIUM-130   | partially_fixed   |             | none           | S    | `aria-kernel/tests/_helpers/suite_shards.py`                 |
| ARIA-MEDIUM-139   | operator_decision |             | security       | XL   | `.github/workflows/aria-agent-executor.yml`                  |
| ARIA-MEDIUM-168   | partially_fixed   |             | silent_failure | S    | `aria-kernel/aria_kernel/bridge_status_ledger.py`            |
| ARIA-MEDIUM-172   | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/bridge_status_ledger.py`            |
| ARIA-MEDIUM-226   | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/merge_authority.py`                 |
| ARIA-MEDIUM-232   | partially_fixed   |             | none           | S    | `docs/aria/CURRENT_STATE.md`                                 |
| ARIA-MEDIUM-273   | operator_decision |             | security       | XL   | `.github/manifests/aria-operator-signers`                    |
| ARIA-MEDIUM-512   | partially_fixed   |             | security       | M    | `aria-kernel/aria_kernel/operator_provenance.py`             |
| ARIA-MEDIUM-522   | not_reproducible  |             | none           | none | `aria-kernel/aria_kernel/worker_dispatch.py`                 |
| NOTE-13           | already_fixed     |             | none           | none | `aria-kernel/aria_kernel/self_improvement.py`                |
| NOTE-14           | not_reproducible  |             | none           | none | `aria-kernel/tests/test_request_admission.py`                |

## Unregistered observations (registered by this review)

Each section below is the account of one observation the repair session made but never registered.
Its registry row points here.

### ARIA-MEDIUM-548 (NOTE-1) — bridge_replay_required night gets inconsistent treatment (cycle…

Full title: bridge_replay_required night gets inconsistent treatment (cycle failure accounting vs
notify)

A bridge_replay_required night sends a cycle_failed notice and writes a failed phase. The same cycle
is still counted in cycles_completed, the run returns exits_clean=True, and the CLI exits 0. The
operator gets a failure issue while the workflow run is green and the run-level accounting says
clean. This is a new defect, not a duplicate of 420/415.

Evidence:

- aria-kernel/aria_kernel/autonomy_orchestrator.py:1889-1920 (4535de11a): bridge_replay_required
  transitions status=failed, appends a failed_phases row and calls
  \_notify_cycle_failed(exit_reason='bridge_replay_required'), then sets
  exit_reason='bridge_replay_required'
- autonomy_orchestrator.py:1789-1790: cycles_completed += 1 already ran for this cycle
  (cycle_completed ok happens before the bridge drain)
- autonomy_orchestrator.py:2997: "exits_clean": exit_reason not in {"cycle_failed"} ->
  bridge_replay_required exits clean
- aria-kernel/aria_kernel/cli.py:5067/5105/5132/7296: return 0 if result.get('exits_clean') else 1
  -> the lane step is green

### ARIA-LOW-549 (NOTE-2) — an aborted cycle is recorded as cycle:unrecorded in the doctor

An aborted cycle (pre-phase abort or state_integrity_gap) is written into the autonomy-state summary
with runtime_status='aborted' and no failed phase. The doctor therefore names its cause
'cycle:unrecorded', and the recorded abort reason never reaches the cause key or the
self-improvement mission identity. ARIA-MEDIUM-417 added the cause vocabulary but missed this path.

Evidence:

- aria-kernel/aria_kernel/cycle.py:694-701 and 747-755: an aborted cycle returns status='aborted'
  with no runtime_status (aborted_by_phase / state_integrity_gap only in event)
- aria-kernel/aria_kernel/autonomy_orchestrator.py:723 (\_bounded_cycle_summary): runtime_status
  defaults to cycle_result.get('status') -> 'aborted'; the closed summary carries no
  aborted_by_phase and failed_phases is []
- aria-kernel/aria_kernel/cycle_runtime_status.py:48-50: RUNTIME_STATUSES = (ok, degraded,
  integrity_failed, failed), so 'aborted' is not a member
- aria-kernel/aria_kernel/doctor.py:530-532: with no failed_phases, a verdict outside
  RUNTIME_STATUSES becomes CAUSE_UNRECORDED -> cause key 'cycle:unrecorded'

### ARIA-LOW-550 (NOTE-3) — host organs (infra-only signals) still mint self-change missions

Host-only organ failures still raise doctor_fail, which has the self_change remedy. A missing claude
binary, no provider credential, no bwrap backend or a dead gateway daemon therefore mints a
propose_self_change mission whose only real answer is an operator/host action, and each such mission
spends a mission slot and an agent turn for nothing. The mint is bounded by max_new, so this is
wasted work, not a runaway.

Evidence:

- aria-kernel/aria_kernel/self_improvement.py:75: DOCTOR_ORGAN_SIGNAL_KINDS = {'notifications':
  'config_missing', 'deadlines': 'deadline_due'}; every other failing organ maps to 'doctor_fail'
- self_improvement.py:53: 'doctor_fail': SELF_CHANGE_REMEDY; :223 kind =
  DOCTOR_ORGAN_SIGNAL_KINDS.get(check.name, 'doctor_fail')
- aria-kernel/aria_kernel/doctor.py:192-232: providers 'no_provider_available', sandbox_backend
  'no_sandbox_backend_write_capable_spawns_refused', claude_cli
  'claude_binary_missing'/'claude_below_floor' are host/infra facts; gateway_heartbeat_fresh (469+)
  is a dead host daemon
- No registry row covers host organs (ARIA-MEDIUM-417 routed only notifications/deadlines)

### ARIA-LOW-551 (NOTE-4) — auto-cycle job margin leaves ~16 min slack

Full title: auto-cycle job margin leaves ~16 min slack, never measured on real post-work durations

The close-out margin leaves 16 of 100 minutes of slack. The 57-minute close-out figure comes from
one #1371 measurement, not from nights that did real post-work, and the doctor runs twice (NOTE-12).
Today's store (626 MB) is smaller than the 842 MB measurement basis, so an overrun is unlikely. If
one happens, the job is cut before publish and the night's state is lost; it is not corrupted,
because publish is an atomic push and the lease TTL outlives the job.

Evidence:

- .github/workflows/aria-auto-cycle.yml:942-963: ARIA_JOB_DEADLINE_EPOCH = launch + 360 min - 6000
  s; comment: close-out measured at most 57 min on 842 MB (#1371) + doctor 10 + self_improve 12 +
  deliver 5 = 84 of 100 minutes
- aria-auto-cycle.yml:1081-1129: doctor/self_improve/deliver timeout-minutes 10/12/5;
  handoff/integrity/mint/publish steps have no timeout-minutes
- git ls-tree -r -l origin/aria/state: total 625,558,311 bytes today (below the 842 MB measurement
  basis)
- aria-auto-cycle.yml:446-455: writer lease TTL 440 min > 360 min job cap, so a timeout does not
  strand the lease

### ARIA-MEDIUM-552 (NOTE-5) — legacy plans with no content_hash leave attempt_unrecorded rows…

Full title: legacy plans with no content_hash leave attempt_unrecorded rows that never stop

A CONVERGED plan whose latest revision has no content_hash fails body proof inside the attempt
claim. The failure is recorded as an uncounted attempt_unrecorded withhold that never reaches
MAX_DELIVERY_ATTEMPTS or the operator, so the plan is re-offered and re-refused every cycle forever.
No such rows are on aria/state today. The cost is one governance row per cycle per legacy plan, with
no spawn.

Evidence:

- aria-kernel/aria_kernel/converged_delivery.py (\_mint_scope_refusal): 'A body the ledger cannot
  prove is not a scope verdict: its error reaches the caller' -> plan_body_from_state(state)
- aria-kernel/aria_kernel/plan_convergence.py plan_body_from_state: raises GovernanceError when
  latest_revision.content_hash is missing ('no body can be proven')
- converged_delivery.py:550-567: the GovernanceError from \_claim_attempt is caught, writes
  governance 'converged_delivery_attempt_unrecorded' and returns withheld 'attempt_unrecorded' with
  no attempt counted, no escalation and no parking
- converged_delivery.py:337-339: the exhaustion bound counts only recorded attempts, so the plan
  stays CONVERGED and redeliver_stranded_converged_plans (autonomy_orchestrator.py ~1932) offers it
  every cycle

### ARIA-LOW-553 (NOTE-6) — if channel_check fails

Full title: if channel_check fails, the workflow steps after it are skipped (dispatch only)

On an operator dispatch with channel_check=true, a failed notification check skips the whole night
(provisioning and the cycle), while the always() close-out steps still run and publish. Scheduled
runs never take this path, and nothing is corrupted or lost; the operator simply gets no cycle from
that dispatch. Whether a broken channel should block the cycle is a design choice.

Evidence:

- .github/workflows/aria-auto-cycle.yml:110-117: channel_check is a workflow_dispatch input, default
  'false'
- .github/workflows/aria-auto-cycle.yml:532-558: the 'Notification channel check (dispatch-gated)'
  step exits non-zero (SystemExit) unless sent+sent with the second commented
- aria-auto-cycle.yml:561-859: every later provisioning and cycle step has a plain if: (no
  always()), so all of them, including 'Run the nightly cycle', are skipped after a failed check
- aria-auto-cycle.yml:1081-1316: doctor/self_improve/deliver/integrity/publish/lease release run
  under always(), so state is still verified and published

### ARIA-LOW-554 (NOTE-7) — GhCliIssueWriter.\_find_open uses --limit 100

Full title: GhCliIssueWriter.\_find_open uses --limit 100: with >100 open aria issues a fixed-title
issue is missed and duplicated

The lookup sees only the 100 newest open 'aria'-labelled issues. With more than 100 open, an older
fixed-title issue (cycle_failed, breaker, daily report) is missed and a duplicate is opened. The
duplicate is then the newest and is found next time, so this produces one extra issue per crossing,
not a runaway.

Evidence:

- aria-kernel/aria_kernel/github_adapters.py:295-310: \_find_open runs 'gh issue list --state open
  --limit 100 --label \<labels>' and matches the exact title client-side
- aria-kernel/aria_kernel/notify.py:54: NOTIFY_ISSUE_LABELS = ('aria',), the only label filter;
  notify.py:140-161: identity is the exact FIXED title, comment_or_create
- github_adapters.py:331/350/374: upsert/comment paths create a new issue when \_find_open returns
  None

### ARIA-MEDIUM-555 (NOTE-8) — aria-auto-cycle job-level contents:write permission broader than…

Full title: aria-auto-cycle job-level contents:write permission broader than needed

The job token that the whole nightly-cycle process carries has contents:write on the repository, but
only the final publish step needs it. agent_env strips GH_TOKEN from agent children and the
aria/state ruleset blocks force-push, so this is least-privilege hardening, not an open leak. The
fix needs a separate publish credential or job split, because publish uses the same job token today.

Evidence:

- .github/workflows/aria-auto-cycle.yml:125-150: top-level permissions include contents: write (also
  issues: write, id-token: write); the long cycle job (timeout 360) does not narrow them
- .github/workflows/aria-auto-cycle.yml:865: GH_TOKEN: ${{ github.token }} is exported to the whole
  nightly-cycle step (adapters, spawns); :1220 PUBLISH_TOKEN uses the same job token for the
  aria/state push
- aria-kernel/aria_kernel/agent_env.py:67: GH_TOKEN is in the agent env deny set, so spawned agents
  do not inherit it
- No registry row (grep 'contents: write' over findings.jsonl found none)

### ARIA-MEDIUM-556 (NOTE-9) — cost-breaker amounts and CRITICAL human-required reasons appear in…

Full title: cost-breaker amounts and CRITICAL human-required reasons appear in public GitHub issue
bodies

Cost-breaker dollar amounts and the free-text reasons of CRITICAL human-required records are posted
verbatim into public GitHub issue bodies. Credential shapes are scrubbed, and much of the same data
is already on the public aria/state branch. Still, a CRITICAL reason can describe an unfixed
weakness, and an issue makes it far more discoverable. The code fix is to post ids and pointers
only; making the repository private would be an operator decision.

Evidence:

- aria-kernel/aria_kernel/cost_budget.py:263-267: notify_best_effort(kind='breaker_tripped',
  body=f'amount_usd: {amount} cap_usd: {cap}')
- aria-kernel/aria_kernel/human_required.py:216-221: CRITICAL records notify with body 'reason:
  published_text(reason, limit=1000)' plus sla_deadline and request id
- aria-kernel/aria_kernel/notify.py:140-161: the github_issue channel posts title/body as an
  issue/comment on ARIA_NOTIFY_GITHUB_REPO (the public repository per autonomy_orchestrator.py:625
  comment)
- published_text scrubs credential shapes only; dollar amounts and free-text CRITICAL reasons pass

### ARIA-LOW-557 (NOTE-10) — judge-backlog count uses a 4-day wall-clock window

Full title: judge-backlog count uses a 4-day wall-clock window, under-counting after a long provider
outage

The judge-backlog gate counts live judge envelopes only within 4 wall-clock days. Requests now age
on provider-available time and stay live through a long outage, so after an outage longer than 4
days the backlog is under-counted and the gate mints judge pairs beyond the per-role cap. This is
the same wall-clock-versus-provider-clock class as 436/439, at a site those fixes did not touch.

Evidence:

- aria-kernel/aria_kernel/judge_fanout.py:221: horizon = datetime.now(timezone.utc) -
  timedelta(days=4); rows created before it are skipped from the pending count (226-232)
- judge_fanout.py:268-272: the per-role max_pending gate reads pending_judge_counts to decide
  whether to mint more judge envelopes
- Registry ARIA-MEDIUM-436 / ARIA-LOW-439 / ARIA-HIGH-440 (RESOLVED) moved request/plan aging to
  provider-available time, but this counter was not moved

### ARIA-LOW-558 (NOTE-11) — tests leak plan-coverage\* temp dirs into /tmp (23k dirs observed)

Both the witness itself (an nx-graph.json temp dir on every call without --graph) and its spec leak
temp dirs into /tmp with no cleanup. This host currently holds 4,162 of them (39 MB). The cost is
disk only, but it adds to the self-hosted runner's disk-budget pressure.

Evidence:

- tools/gates/plan-coverage-witness.ts:297: loadGraph mkdtempSync('plan-coverage-') writes
  nx-graph.json and never removes it (production path)
- tools/gates/plan-coverage-witness.spec.ts:116,123,503: mkdtempSync
  'plan-coverage-yaml-'/'plan-coverage-spec-' with no rmSync/afterEach/afterAll in the file
- ls -d /tmp/plan-coverage\* on this host: 4162 dirs (3402 spec-, 648 yaml-, 112 plain), 39 MB total

### ARIA-LOW-559 (NOTE-12) — the doctor runs twice per night (~7.5 min); one shared report would do

self_improve runs the whole doctor again instead of reading the report the doctor step has just
written. That adds about 4 minutes of runner time every night and eats into the 16-minute close-out
slack (NOTE-4).

Evidence:

- .github/workflows/aria-auto-cycle.yml:1081-1092: 'schedule run --action doctor' step; :1110-1117:
  'schedule run --action self_improve' step
- aria-kernel/aria_kernel/self_improvement.py:275-277: scan_signals imports run_doctor and runs the
  full doctor again
- aria-auto-cycle.yml:950-953 comment: doctor 229 s and self_improve 245 s measured on the
  2026-10-10 store

### NOTE-13 — first CI self_improve opens doctor_fail:deadlines as a SELF_CHANGE mission driven by…

Full title: first CI self_improve opens doctor_fail:deadlines as a SELF_CHANGE mission driven by
lapsed HR SLAs (ARIA-MEDIUM-128 pin)

At 4535de11a the deadlines organ is routed to deadline_due (announce only), so a lapsed HR SLA no
longer mints a SELF_CHANGE mission. A test pins this, and production mission-events holds no such
mission.

Evidence:

- aria-kernel/aria_kernel/self_improvement.py:66-75: DOCTOR_ORGAN_SIGNAL_KINDS maps 'deadlines' ->
  'deadline_due' (ANNOUNCE_REMEDY), citing the f5c5c86a1 dry run with 228 lapsed HUMAN_REQUIRED SLAs
- git log -S: commit 0b88b2ccb 'fix(aria): the deadlines organ is announced and a blocked capability
  gap mints no mission' (2026-10-10) is an ancestor of 4535de11a
- aria-kernel/tests/test_self_improvement_remedy.py:16,93 pins that deadline_due is announced, never
  minted
- origin/aria/state:tools/missions/mission-events.jsonl: 0 rows mentioning deadlines (no stale
  mission minted)

### NOTE-14 — test_request_admission…

Full title: test_request_admission
AThrottledPanelReMintIsDeferredNotResolved::test_deferred_this_sweep_reminted_the_next was red on a
pre-fix snapshot

The test passes at the fixed commit 4535de11a: the class alone once, and the whole file twice in a
row. The red result belonged to the pre-fix snapshot and does not reproduce on the code under
review.

Evidence:

- pytest tests/test_request_admission.py::AThrottledPanelReMintIsDeferredNotResolved at 4535de11a
  (read-only checkout, no cache/bytecode): 1 passed in 25.93s
- pytest tests/test_request_admission.py (whole file) twice: 30 passed, 4 subtests passed (193 s,
  202 s)
- aria-kernel/tests/test_request_admission.py:441-444 is the test class/method in question

### ARIA-MEDIUM-560 (NOTE-15) — genesis launcher

Full title: genesis launcher: a drafted adapter may reach a capability through an already-loaded
allowlisted module

Confirmed by repro: a drafted adapter can import preloaded modules such as os and use audited but
unrefused calls (os.remove/rename/rmdir/mkdir/chmod/symlink/truncate) that the launcher hook lets
through. Two things contain it today: the adapter room mounts the workspace read-only, and genesis
currently never reaches a run (ARIA-MEDIUM-507). So this is a defence-in-depth gap, not a live
escape, and it should be closed before genesis is repaired.

Evidence:

- tools/aria-poc/genesis_adapter_launcher.py:66-79 (\_audit): refuses import, **code** set,
  code.**new**/marshal, open-for-write, os.system/exec/spawn/fork/kill, subprocess., ctypes.,
  socket., threads, tracing; nothing else
- Repro (scratch dir, launcher from 4535de11a, ALLOWED_ADAPTER_IMPORTS header): adapter source
  'import os; os.rename(victim, moved); os.remove(moved)' exited 0 and deleted the file;
  'pathlib.os' is a module. 'import os' raises no import event because os is preloaded
- aria-kernel/aria_kernel/genesis_adapter_custody.py:190-193: drafted bytes run only through
  prepare_adapter_spawn (adapter room, workspace bound read-only per adapter_room.py:26-41)
- Registry ARIA-MEDIUM-507 (OPEN): skill genesis has no working path today; ARIA-HIGH-414 (OPEN) is
  the dynamic-import half, a different bypass

### ARIA-LOW-561 (NOTE-16) — implementers that append '2>&1 | tail' to validation commands now get…

Full title: implementers that append '2>&1 | tail' to validation commands now get refused turns by
the Bash gate

The refusal is the correct security behaviour, but the implementer contract never tells the agent
that pipes and redirects are refused. Habitual '2>&1 | tail' validation commands therefore burn
turns out of a 10-12-turn budget. Production already shows 34% of Bash decisions denied, including 6
control-operator refusals.

Evidence:

- aria-kernel/aria_kernel/command_policy.py:132: CONTROL_OPERATOR_CHARS = frozenset('|&;()<>\n'), so
  '2>&1 | tail' is refused as a shell control operator (correctly, after ARIA-CRITICAL-446/HIGH-505)
- grep of .claude/agents/aria-implementer.md and \_shared/aria-implementer-safety-contract.md: no
  mention of pipes, redirects or the gate grammar
- origin/aria/state:tools/hooks/decisions.jsonl: 137 decisions, 47 denied, 6
  'BashDenylistHit:shell_control_operator', plus many BashAllowlistMiss for grep/sed/cat/wc; stored
  rows carry no command text, so the '2>&1|tail' form itself is not countable

### ARIA-LOW-562 (NOTE-17) — each lease reap with an expired claim parses the full 25.7 MB…

Full title: each lease reap with an expired claim parses the full 25.7 MB governance.jsonl

Each reap sweep that finds an expired claim parses and verifies the whole 25.8 MB governance ledger
(once per sweep, not per claim) just to find each claim's attempt route. That is avoidable CPU and
memory on the shared runner, in the same OOM-churn class as ORPHAN-HIGH-794, but it is bounded and
causes no incorrect behaviour.

Evidence:

- aria-kernel/aria_kernel/agent_invocations.py:7081-7091 (reap_stale_claims): on the first expired
  claim of a sweep, load_declared_jsonl(root/'governance.jsonl',
  expected_surface='tools_governance') is parsed and verified in full for
  attempt_providers_by_claim, plus provider_clock(root)
- aria-kernel/aria_kernel/provider_outage_ledger.py:154-157: outage_intervals also loads the whole
  governance.jsonl
- git show origin/aria/state:tools/governance.jsonl | wc -c -> 25,773,671 bytes

## Wave A — the run-blockers, fixed (2026-10-16)

Six clusters, each fixed red-first in its own worktree and merged on `fix/aria-known-issues-wave-a`.
Each commit body carries the full account and the proof.

| Finding                      | Commit      | What changed                                                                                                                                                                                                                |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARIA-MEDIUM-546              | `28a84c83b` | Root cause fixed in the one table, secret_scrub.CREDENTIAL_SHAPES                                                                                                                                                           |
| ARIA-HIGH-448                | `fe616a6cc` | Closes the remaining code gap of 448 in the same table, so every scrubber inherits it                                                                                                                                       |
| ARIA-LOW-547                 | `5e58252e3` | artifact_safety.sanitized_json_text is now the one encoding step of a published JSON writer                                                                                                                                 |
| ARIA-MEDIUM-556              | `f90d5e82d` | notify.py (owner): for the kinds in POINTER_ONLY_SUMMARIES (breaker_tripped, human_required_opened, human_required_sla_breached), a public channel (PUBLIC_CHANNELS = github_issue) gets a body the notifier renders itself |
| ARIA-HIGH-540                | `2e61f180b` | A delivery refusal now carries the verdict's codes                                                                                                                                                                          |
| ARIA-MEDIUM-539              | `f6206c9df` | The fix is at the one log writer, before any byte reaches the surface                                                                                                                                                       |
| ARIA-HIGH-524                | `587a20d85` | Kernel half only; the executor half was already fixed at base by 4535de11a                                                                                                                                                  |
| ARIA-HIGH-527                | `5054fbcce` | publish_quarantine now reaches the agent-writable replica only through a new no-follow reader, aria-kernel/aria_kernel/untrusted_tree.py (UntrustedTree)                                                                    |
| ARIA-HIGH-536                | `4d543688d` | Claude and Codex vendor facts are now read only from text the CLI wrote itself                                                                                                                                              |
| ARIA-MEDIUM-438              | `825596860` | Two producers never fed the drain's standing-outage key; both are fixed                                                                                                                                                     |
| ARIA-LOW-557                 | `8a942f3c5` | judge_fanout.pending_judge_counts no longer uses a hard-coded 4-wall-day horizon                                                                                                                                            |
| ARIA-LOW-562                 | `fb102f6d0` | A new helper, agent_invocations.\_lease_routes_and_clock, does one verified parse of governance.jsonl                                                                                                                       |
| ARIA-LOW-445                 | `ce0c3fb8f` | The spawn lane now writes a lane-neutral route record                                                                                                                                                                       |
| ARIA-HIGH-523                | `2f66f8923` | A run row no longer inlines its read set                                                                                                                                                                                    |
| ARIA-MEDIUM-508              | `c1d6edfa6` | A runner now declares its repo-local dependencies, and the registry is the one owner of the rule                                                                                                                            |
| ARIA-HIGH-143, ARIA-HIGH-528 | `fe1c4ef6b` | Every bwrap room now gets its own network namespace (--unshare-net) and only loopback name files                                                                                                                            |

Residual of ARIA-HIGH-448: transcripts sealed on aria/state before the scrubbing writer existed stay
as they are. Rescanning them, rotating any credential found, and rewriting or purging history is an
operator action. It is registered as ARIA-HIGH-572.

## Findings raised while fixing wave A

### ARIA-HIGH-572 — Agent transcripts sealed on aria/state before 4535de11a stay unredacted

Full title: Agent transcripts sealed on aria/state before 4535de11a stay unredacted: the scrubbing
writer only covers new runs, and no purge or credential-rotation step exists for the 607
content-addressed transcripts already published

Remaining half of ARIA-HIGH-448 that a code fix cannot close: it needs an operator-run scan of every
sealed transcript with the current redact view (secret_scrub.scrub_text over each JSON line),
rotation of any credential found, and a governed rewrite or purge of aria/state history (the
transcripts are content-addressed, so a rewritten transcript changes its hash and the sealing
envelope's recorded hash). Implementers may not write aria/state. Owner: operator (Okan). Suggested
deadline: 2026-10-31 (the SECRETPUB family date).

Evidence:

- git -C /var/aqua-saas ls-tree -r --name-only origin/aria/state | grep -c
  content-addressed/transcripts/ -> 607 (2026-10-16, aria/state 8e39b2eeb)
- docs/reviews/claude/2026-10-11-aria-total-outage-continuity.md (ARIA-HIGH-448 section): 31 of 40
  sampled stored transcripts were raw stream-json with tool_use inputs and 0 redaction markers
- aria-kernel/aria_kernel/artifact_safety.py:114-120 write_sanitized_transcript scrubs only at write
  time; nothing re-reads sealed transcripts

### ARIA-LOW-573 — A failed cycle's public GitHub issue still carries its crash reason text…

Full title: A failed cycle's public GitHub issue still carries its crash reason text (cycle_failed
notices are not pointer-only)

published_text strips credentials and host paths, so this is a discoverability concern, not a
credential leak. Fix: add cycle_failed to notify.POINTER_ONLY_SUMMARIES and pass the cycle record
pointer as record=, if the operator agrees the crash text should live only on aria/state. Discovered
while fixing ARIA-MEDIUM-556 (cluster secret-scrub).

Evidence:

- aria-kernel/aria_kernel/autonomy_orchestrator.py:182-186: notify_best_effort(kind='cycle_failed',
  body=f'...reason: {published_text(reason, ..., limit=\_CYCLE_FAILURE_REASON_MAX_CHARS)}')
- .github/workflows/aria-auto-cycle.yml:909-910: ARIA_NOTIFY_CHANNELS=github_issue on the public
  repository

### ARIA-MEDIUM-574 — A credential refusal the kernel withheld turns the executor job red

Full title: A credential refusal the kernel withheld turns the executor job red: the 'Upload
response envelope' step uploads exactly the two files the withholding deleted, with
if-no-files-found: error

Found while fixing ARIA-HIGH-540 (cluster withhold-refused); not fixed, not registered. Reasoned
from the workflow text, not reproduced in Actions: on a targeted run whose request is refused as a
credential leak (submit path since 47d1831e2, delivery path since the ARIA-HIGH-540 fix) neither
published path exists when the step runs, and upload-artifact errors when no path matches. In drain
mode the step reads the last child's paths (GITHUB_OUTPUT, last write wins), so it fails only when
that child was withheld. The opposite direction is correct today: a withheld file is not uploaded.
Fix direction for the owner: the executor publishes the artifact paths after the terminal, from what
the kernel kept (none for a withheld row), and the step treats an empty list as nothing to upload;
keep if-no-files-found: error for a published path that is missing.

Evidence:

- .github/workflows/aria-agent-executor.yml:777-801 (upload step: path =
  steps.executor.outputs.envelope_path and transcript_path, if-no-files-found: error, retention 7
  days)
- tools/aria-poc/ci_executor.py:997 \_publish_artifact_paths and :5103 (both paths published to
  GITHUB_OUTPUT at claim time, before the result exists)
- aria-kernel/aria_kernel/agent_invocations.py:6735 \_withhold_submission_sources (ARIA-HIGH-515: a
  credential refusal deletes the raw envelope and transcript before its journal; ARIA-HIGH-540 now
  reaches it from the delivery path too)

### ARIA-LOW-575 — A delivery refused for a secret-shaped diff never asks the result's verdict

Full title: A delivery refused for a secret-shaped diff never asks the result's verdict, so an
envelope or transcript that carries a credential at the same time is not withheld

Found while fixing ARIA-HIGH-540 and ARIA-HIGH-524 (cluster withhold-refused); not fixed, not
registered. Reasoned from the code order, not reproduced. A diff carrying a secret refuses at 1a by
name with no verdict, so the executor releases without a submit; if the agent also echoed the
credential into its envelope or transcript (in a form the lane's scrubber let through), those bytes
stay under outputs/ with no withheld row. Narrow: the lanes write both files through the sanitized
writers. Fix direction for the owner: decide 1b before 1a (both precede the suite, the push and the
PR), or have the 1a refusal carry the verdict's codes when the verdict also refuses as a credential
leak.

Evidence:

- aria-kernel/aria_kernel/implementation_delivery.py:895-898 (stage 1a: verify_no_secret_in_diff
  over base..tip raises result_admissible:diff_secret_shaped with no rejection_codes)
- aria-kernel/aria_kernel/implementation_delivery.py:900 (stage 1b, judge_claim_submission, runs
  only after 1a passed)
- tools/aria-poc/ci_executor.py \_close_refused_delivery (submits for withholding only when
  exc.withholds_output, i.e. when the refusal carries the verdict's credential codes)

### ARIA-LOW-569 — Quarantine publication reads every agent-written ref file and the replica HEAD…

Full title: Quarantine publication reads every agent-written ref file and the replica HEAD whole
into executor memory, with no size bound

Found while fixing ARIA-HIGH-527 and deliberately not fixed there. That commit made every one of
these reads no-follow and regular-file only, which already rules out a FIFO, a /dev/zero link and
any other unbounded source. A regular ref file or HEAD the agent pads inside its own replica
(bounded only by the disk quota) is still read whole into the executor's memory. A ref holds at most
64 hex characters plus a newline, and an implementation-branch HEAD holds 'ref:
refs/heads/aria-impl-\<hex>'. Fix shape: one small bound (for example 4 KiB) passed as
UntrustedTree.read(limit=...) for refs and HEAD, and a ref file over the bound discarded by name (a
new reason in \_ref_name_refusal's vocabulary, e.g. ref_file_too_large) rather than truncated, since
truncation could turn an over-long file into a valid object id. This was left out of the
ARIA-HIGH-527 commit because it adds a discard reason the delivery's receipts and tests name.

Evidence:

- aria-kernel/aria_kernel/git_containment.py:945 (fix/aria-ka-quarantine-symlink: content =
  replica.read(ref_file) — no limit; at ad18a822b the same read was ref_file.read_text() at :881)
- aria-kernel/aria_kernel/git_containment.py:995 (fix/aria-ka-quarantine-symlink: head =
  replica.read("HEAD") — no limit; at ad18a822b (replica / "HEAD").read_text() at :927)
- aria-kernel/aria_kernel/git_containment.py:269 (\_MAX_LOOSE_OBJECT_BYTES bounds loose objects
  only; refs and HEAD have no bound)

### ARIA-LOW-566 — Every governance append re-verifies and re-reads the whole governance chain

Full title: Every governance append re-verifies and re-reads the whole governance chain, so the
lease reaper pays two full parses of the 25.9 MB ledger per expired claim on top of its one lookup
parse

Found while fixing ARIA-LOW-562 (provider-classifier cluster, branch
fix/aria-ka-provider-classifier). _append_rows_locked_body runs
\_verify_existing_declared_chain_before_append (verify_jsonl over the whole file) and then
\_read_jsonl_stored (a second full read) for every append_tools_governance call. reap_stale_claims
appends one agent_claim_\<kind> row per expired claim, each outside its claims lock, so a sweep of N
expired claims parses governance 1 + 2N times. Possibly accepted by ARIA-HIGH-237's design; needs a
decision (verified tail checkpoint, or batching the reaper's governance rows into one
append_declared_jsonl_rows call).

Evidence:

- aria-kernel/aria_kernel/ledger.py:1364
- aria-kernel/aria_kernel/ledger.py:1369
- aria-kernel/aria_kernel/agent_invocations.py:7171
- measured 2026-10-16 on a copy of origin/aria/state tools/governance.jsonl (25,898,936 bytes,
  29,056 rows): load_jsonl_verified 1.1-1.5 s per parse on the droplet

### ARIA-LOW-567 — A spawn-lane child's dispatch summary names the declared ladder head as its…

Full title: A spawn-lane child's dispatch summary names the declared ladder head as its provider,
not the rung that failed, so the drain's standing-outage check can excuse a new outage of the
failover rung as a re-probe of the head's

Found while fixing ARIA-MEDIUM-438. invoke_claude_cli writes every summary with \_dispatch_route =
\_dispatch_route_for(request), i.e. resolve_dispatch_route without the cooled set: the ladder head.
On the spawn lane with Anthropic cooled, routed_models runs the Z.ai rung first; if Z.ai then fails
with the same failure class as Anthropic's standing outage (say credit_exhausted while an Anthropic
quota outage stands), the summary says provider=anthropic and the drain lists it as a
standing-outage re-probe, so Z.ai's own new outage transition is never counted red. The native lane
is not affected (its summaries use \_native_route_for_summary; the provider-fact arms now write the
native pair, commit 825596860). Production runs the native lane; this needs adaptive_runtime off.
Fix shape: the spawn lane's terminal summary names the rung's pair (the
ClaudeProviderUnreachable/ClaudeCreditExhausted/ClaudeAuthFailure exceptions carry provider and
model).

Evidence:

- tools/aria-poc/ci_executor.py:2022
- tools/aria-poc/ci_executor.py:2038
- tools/aria-poc/ci_executor.py:597-600
- tools/aria-poc/ci_executor_drain.py:971
- tools/aria-poc/ci_executor_drain.py:998

### ARIA-LOW-568 — reap_stale_claims parses the governance ledger

Full title: reap_stale_claims parses the governance ledger while holding the claims and results
ledger lock

Found while fixing ARIA-LOW-562, which reduced the reaper's lookup to one governance parse per sweep
but left it where it was: on the first expired claim, inside
`with state_transaction([claims_path, results_path])`. The routes and outage intervals do not need
that lock; a pre-read when candidate claims look expired (re-checked under the lock as today) would
take the parse out of the critical section.

Evidence:

- aria-kernel/aria_kernel/agent_invocations.py:7063
- aria-kernel/aria_kernel/agent_invocations.py:7104

### ARIA-MEDIUM-570 — fixture_runner prices a workspace without a runner's repo-local dependency…

Full title: fixture_runner prices a workspace without a runner's repo-local dependency as a failed
fixture case ('crash') instead of refusing the suite by name

Found while fixing ARIA-MEDIUM-508 on fix/aria-ka-run-ledger-size. The fixture lane spawns the same
adapter in the same room but never asks the registry predicate, so in a checkout without
node_modules every banned-phrase-adapter (and every npx ts-node adapter) fixture case is a 'crash'
verdict on the tool rather than a blocked refresh. Fix shape: run_fixture_case raises
GovernanceError('runner_dependency_missing:\<paths>') from missing_repo_local_dependencies before
prepare_adapter_spawn, exactly as it does for SandboxUnavailable, so refresh_fixture_suites records
a blocked refresh. Not fixed here: fixture_runner.py is outside this cluster's files.

Evidence:

- aria-kernel/aria_kernel/fixture_runner.py:787-796 (only SandboxUnavailable becomes a named
  refusal, adapter_sandbox_unavailable)
- aria-kernel/aria_kernel/fixture_runner.py:815-816 (any non-zero exit, including
  banned-phrase-adapter's 127 'unavailable' without node_modules/.bin/ts-node, is case status
  'crash')
- aria-kernel/aria_kernel/tool_runner.py run_tool (after ARIA-MEDIUM-508: a run whose
  runner.repo_local_dependencies are absent is environment_unavailable before anything spawns;
  fixture_runner does not consult tool_registry.missing_repo_local_dependencies)
- aria-kernel/aria_kernel/promotion.py:35 (CALIBRATE -> SHADOW needs a passing fixture suite, so a
  suite verdict written in a workspace without node_modules blocks the way back)

### ARIA-LOW-571 — state_compact.\_compact_runs persists a read_paths slim only

Full title: state_compact.\_compact_runs persists a read_paths slim only when the same pass also
stripped evidence envelopes, and its count omits read_paths-only rows

Found while fixing ARIA-HIGH-523 on fix/aria-ka-run-ledger-size. Latent in production: every ok row
carries evidence_envelopes, so a pass that slims read_paths also strips envelopes. After
ARIA-HIGH-523, new artifact-backed rows carry read_paths_ref instead of the list, so the branch only
ever sees legacy rows. Fix shape: count a row as stripped when either field is slimmed (one
will_strip flag drives both the archive and the count).

Evidence:

- aria-kernel/aria_kernel/state_compact.py:743-759 (a row older than the cutoff with read_paths > 20
  is slimmed in memory and archived)
- aria-kernel/aria_kernel/state_compact.py:756 (stripped is incremented only for evidence_envelopes)
- aria-kernel/aria_kernel/state_compact.py:761 (if stripped == 0 the pass returns without
  rewrite_declared_jsonl, so the in-memory slim is dropped and the archive is never written)

### ARIA-MEDIUM-563 — The egress allowlist admits provider hosts by host:port only

Full title: The egress allowlist admits provider hosts by host:port only, so an injected agent can
still exfiltrate through an allowlisted provider under a credential it chooses (its own login file
is readable in the room)

Residual of the netns+allowlist-proxy fix, not a regression: before it the room had the whole
network. Closing it needs the provider traffic bound to the kernel's credential (e.g. the proxy
terminating TLS for provider hosts and injecting/validating the auth header, or the kernel holding
the credential and the room never seeing it). Not attempted in the implementer-network cluster;
recorded for the owner of implementation_safety/egress_proxy.

Evidence:

- aria-kernel/aria_kernel/egress_proxy.py:54 PROVIDER_ENDPOINTS admits api.anthropic.com:443,
  api.openai.com:443, chatgpt.com:443, platform.claude.com:443, api.z.ai:443, auth.openai.com:443 by
  host:port
- aria-kernel/aria_kernel/egress_proxy.py:157 handle() decides on the CONNECT target alone; the
  tunnel is opaque TLS, so the request's credential and path are not seen
- aria-kernel/aria_kernel/implementation_safety.py:1603-1604 the managed login's .credentials.json
  is bound writable into the room (ARIA-HIGH-157), so the agent can read it
- measured 2026-10-16 on fix/aria-ka-implementer-network 684c63955: the real CLI 2.1.278 in the
  managed room tunnelled to api.anthropic.com:443 with an arbitrary (bogus) API key and the provider
  answered 401, i.e. any key the agent supplies reaches the provider

### ARIA-MEDIUM-564 — The pre-claim environment gate is skipped whenever the adaptive native…

Full title: The pre-claim environment gate is skipped whenever the adaptive native runtime admits a
route, so production never runs the egress, git-availability or node_modules checks before a claim

After ARIA-HIGH-143 (684c63955) the egress boundary is structural (every room unshares the network;
sandbox_backend()'s git containment probe builds the egress room argv), so the missing egress probe
on the native path is a lost detectability layer, not an open boundary. The git and node_modules
checks may be intentionally covered elsewhere on the native path; that was not established. Needs
the owner of ci_executor's admission to confirm intent and either run the gate's host checks on both
paths or record why the native path does not need them.

Evidence:

- tools/aria-poc/ci_executor.py:4738-4739 gate_kind = (\_pre_claim_environment_gate(...) if
  native_runtime is None else None) — the gate runs only on the legacy (no adaptive policy) path
- tools/aria-poc/ci_executor.py:4393 egress_boundary_probe, :4405 \_git_availability_gap and :4408
  \_node_modules_resolvable_from live only inside that gate
- tools/aria-poc/ci_executor.py:4047 the native Claude route checks sandbox_backend() itself, but
  none of the other three
- git show origin/aria/state:tools/governance.jsonl: 29056 rows, zero egress_boundary_unavailable /
  git_unavailable rows ever, and only 2 env_deps_missing (last 2026-08-11) although the adaptive
  policy (B8) has been declared since 2026-09-12

### ARIA-LOW-565 — The killed-holder socket-directory sweep is copied verbatim into four modules…

Full title: The killed-holder socket-directory sweep is copied verbatim into four modules (hook
broker, MCP broker, signing agent, egress proxy) instead of one helper the orchestrator calls with
each holder's prefix

Each copy differs only in (prefix, regex, socket name, answer probe). One helper, e.g.
prune_stale_socket_dirs(prefix_re, socket_name), with each holder declaring its pattern and the
orchestrator iterating the declarations, would make a new holder's registration automatic. The
egress proxy's copy was added deliberately to follow the existing per-holder shape rather than leave
a new holder unswept; it should fold into the helper with the other three.

Evidence:

- aria-kernel/aria_kernel/hook_broker.py:202 prune_stale_hook_brokers
- aria-kernel/aria_kernel/mcp_broker.py:192 prune_stale_mcp_brokers
- aria-kernel/aria_kernel/signing_agent.py:272 prune_stale_signing_agents
- aria-kernel/aria_kernel/egress_proxy.py:311 prune_stale_egress_proxies (added on
  fix/aria-ka-implementer-network to register the per-process proxy with the existing sweep; same
  body, prefix aria-ep-)
- aria-kernel/aria_kernel/autonomy_orchestrator.py:1559-1578 the startup sweep calls each copy by
  name

## Operator decisions (2026-10-17)

Okan gave both decisions on 2026-10-17 in Turkish. The learning agent relayed them to the main
session.

- ARIA-HIGH-272: raw LLM prompts and responses may stay on the public aria/state branch and in its
  Actions artifacts while ARIA is being tested ("we are testing anyway"). The repository is not made
  private. The 2026-10-02 plan to make it private is superseded. The credential scrub stays: the one
  table in `secret_scrub.CREDENTIAL_SHAPES` and the scrubbing transcript writer. The decision says
  nothing about tenant or personal data, so that constraint is not lifted.
- ARIA-HIGH-425 (RESOLVED on 2026-10-15 by `79b82c8d3`: a spent Claude window cools anthropic until
  its reset and the read seats run on Z.ai): capacity is paced by pausing and resuming, not by
  buying more. When the quota runs out, ARIA holds where it is and starts no cycle over. When the
  quota returns, it continues from where it stopped. The cycle-level part is new and is tracked as
  ARIA-HIGH-579.

## ARIA-HIGH-572 — resolved by evidence (2026-10-17)

The finding asked for three steps: scan every sealed transcript with the current redaction table,
rotate any credential found, and purge aria/state history. The scan found no credential, so nothing
was rotated and nothing was purged.

Scan:

- Coverage: every blob ever reachable from `origin/aria/state` at tip `8e39b2eeb`, not only the tip
  tree: 286 commits and 11,848 unique blobs (18.9 GB). Each blob was streamed once; JSONL and gzip
  files were read per line, other text whole, and each unit also in its JSON-unescaped form.
- Detection: every credential row of every view of `secret_scrub.CREDENTIAL_SHAPES`, plus an
  independent loose-shape pass and base64-encoded prefixes of every token family at all three
  alignments.
- Values were never printed or stored. Each match was recorded as the sha256 of the matched value,
  in a 0600 file outside the repository.

Result:

- No real credential in any blob. Every token family had zero hits: GitHub
  `ghs_`/`ghp_`/`gho_`/`ghu_`/`ghr_`/`github_pat_`, Anthropic API and OAuth (`sk-ant-`), PEM private
  keys, Z.ai, AWS, JWT, Stripe, Slack, npm, GitLab and Google. The names `CLAUDE_CODE_OAUTH_TOKEN`
  and `ZAI_API_KEY` occur tens of thousands of times, never with a value.
- The 331 kept matches are of three kinds. 304 are `sk-` inside a word (task, risk and disk ids;
  that defect is ARIA-MEDIUM-576 below). 22 are code or prose words after `Bearer`, `password:` and
  similar. 5 are values already public on main (spec fixtures, an example bearer in
  `.env.production.example`, and the throwaway CI Postgres password in
  `.github/workflows/db-migration-check.yml`).
- The publication boundary fired before publication: `<secret-redacted>` occurs 7,029 times in 274
  blobs.

Cross-check against live credentials: the sha256 of every value in the production `.env`, the runner
`.env` and the runner's key files (120 values) matches none of the 331 fingerprints. No live
credential, the CI database password included, appears on aria/state. No rotation is needed.

Why history is not purged:

- No credential was ever published.
- Under the ARIA-HIGH-272 decision above, the raw prompt and response text may stay public while
  ARIA is tested.
- A purge is a large change with its own risk. Every host holds the old lineage. Memory surfaces are
  append-only. The commit verifier and the evidence checkpoints bind every ledger prefix. A governed
  purge would need a kernel-owned redaction ledger, an epoch reset with a pinned lineage, and
  lifting the `aria-state-protection` ruleset for one force push. That design is recorded in the
  session's investigation, but it buys nothing once no credential is exposed.
- The ruleset is active today: it blocks non-fast-forward pushes and deletion on aria/state,
  aria/state-lease and aria/state-cold.

Two lineage defects the investigation found are tracked below as ARIA-LOW-577 and ARIA-LOW-578.

## Findings raised by the ARIA-HIGH-572 investigation and the 2026-10-17 decisions

### ARIA-MEDIUM-576 — The sk- credential rows had no left boundary

Full title: The sk- credential rows had no left boundary, so the publication boundary redacted
task-, risk- and disk- ids as keys and the refuse view could refuse a diff that only names such an
id.

- Evidence: `aria-kernel/aria_kernel/secret_scrub.py:300-309` (anthropic_api_key, openai_api_key and
  generic_sk_key matched `sk-` inside a word).
  `scrub_text('follow-up for task-0123456789abcdefghij0123 done')` returned
  `'follow-up for ta<secret-redacted> done'`.
- Effect: openai_api_key is also in the refuse view, so an implementer diff naming such an id would
  have been refused as a secret.
- Fixed on `fix/aria-572-closeout`:
  - The three rows start with `_KEY_START`, a left boundary, so a key prefix must start a token.
  - REFERENCE_SHAPES gains a task id and a risk id, so the import-time proof refuses any later row
    that rewrites them.
  - Red first: the new tests fail on the previous table, and adding the reference shapes alone
    raised `CredentialTableError redact_view_rewrites_reference:23:openai_api_key`.

### ARIA-LOW-577 — A checkout lineage refusal is reported as a transport failure

Full title: A checkout whose remote aria/state tip does not descend from the host's tracking ref
raises StateStoreError, not StateStoreRefusal, so the restore action reports a lineage refusal as a
failure to reach the remote.

- Evidence: `aria-kernel/aria_kernel/state_store.py:1506` and `:1511` raise StateStoreError.
  `aria-kernel/aria_kernel/cli.py:661` maps only StateStoreRefusal to exit 3.
  `.github/actions/restore-aria-state/action.yml:343` and `:370` then print "failed to reach the
  remote" and "wrote no verdict".
- Lab-proven by the purge investigation with a replacement tip that has a new root.
- Fix: raise StateStoreRefusal with the named reason, and pin both the exit code and the action's
  message.

### ARIA-LOW-578 — A host with no tracking ref adopts any replacement aria/state tip

Full title: A host without a tracking ref for aria/state adopts any replacement tip, including a new
root, because nothing pins the store's lineage outside the host's own refs.

- Evidence: `aria-kernel/aria_kernel/state_store.py:1484-1527` compares only against the host's own
  `refs/remotes/origin/aria/state`. `.github/workflows/aria-state-maintenance.yml:99` runs on a
  fresh GitHub-hosted clone with no such ref. In the lab, a new-root tip was adopted with exit 0.
- Mitigation today: the `aria-state-protection` ruleset blocks force pushes and deletion.
- Fix: a pinned lineage on main, either the GENESIS root sha or a signed lineage record, so that a
  replaced lineage is refused on every host.

### ARIA-HIGH-579 — The cycle holds in place when every provider is out of quota

Full title: when every provider a night needs is out of quota, ARIA holds where it is, starts no new
cycle work, and resumes from where it stopped at the reset. This is the operator's 2026-10-17
decision (pacing by pause and resume). Today the nightly auto-cycle still fires unconditionally, and
no test proves that a night with every provider cooled mints, claims and spends nothing and leaves
the next night to continue.

- Evidence:
  - `.github/workflows/aria-auto-cycle.yml:76`: the cron fires whatever the quota state.
  - `aria-kernel/aria_kernel/provider_outage.py:1-17`: a request whose every provider is cooled
    waits. This works per request, not per cycle.
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:1947-1952`: a prolonged outage is escalated,
    but the cycle still runs its phases.
- Steps:
  1. Prove today's behaviour with a production-shaped test of a night with anthropic and zai both
     cooled.
  2. Gate every phase that mints, claims or rebuilds model work on `provider_outage`, its one owner,
     so that the night records a hold and the next night continues.
  3. Pin that behaviour with a test.
- Owner claude. Deadline 2026-10-24, before ARIA is re-enabled.

## Wave B — small and medium defects, fixed (2026-10-17)

Eleven clusters, each fixed red-first in its own worktree (`fix/aria-kb-*`, base `606169730`), were
merged on `fix/aria-known-issues-wave-b` (integrated head `dc6376f13`). The integration branch
started at origin/main `cb16483db` and has origin/main merged up to `84168ef3a`. The clusters' 78
commits close 77 findings. Nine integration commits repair what the merges broke; seven of them
carry a `Closes:` line for a finding the clusters also close, and the table lists both commits for
it. Each commit body carries the full account and the proof.

| Finding                                       | Commit                                              | What changed                                                                                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARIA-MEDIUM-110                               | `7d161315d`                                         | notify dedups per signature and channel, so each configured channel has its own window and a failed channel is retried                                                                                                                 |
| ARIA-MEDIUM-111                               | `8a987aeb3`                                         | The ENOSPC to `environment_failure:disk_full` translation moved into `ledger.state_transaction`, so every transaction append names a full disk                                                                                         |
| ARIA-LOW-554                                  | `c616faba6`                                         | GhCliIssueWriter finds a fixed-title issue in the whole open set (paginated REST list), not among the 100 newest                                                                                                                       |
| ARIA-LOW-553                                  | `cb8364900`                                         | A failed channel check reaches a verdict without failing its step; the night runs and the run turns red after the publish                                                                                                              |
| ARIA-LOW-551                                  | `33d47e64b`                                         | The close-out margin and its measured basis live in the job env, and every night measures its unbounded close-out against the basis                                                                                                    |
| ARIA-HIGH-247                                 | `973072057`                                         | `provision_runner.sh apply` installs only the habitat the host can run: no user-.slice memory cap; gateway and telemetry units move to `provision_gateway.sh`                                                                          |
| ARIA-MEDIUM-232                               | `4660d3f3b`                                         | CURRENT_STATE.md names the merge lane, its grant, the two freezes and self-revert; BEHAVIOUR.md says main has no squash merge queue                                                                                                    |
| ARIA-LOW-503                                  | `ea869ac16`                                         | A test pins that a refused `pr create` records no `pr_create` intent                                                                                                                                                                   |
| ARIA-LOW-506                                  | `aa24fb84d`                                         | Each watchdog freeze layer is pinned on its own; the source-text test became a behavioural one                                                                                                                                         |
| ARIA-LOW-561                                  | `60d640a42`                                         | The implementer safety contract gains a Bash Command Shape section stating what the hook admits                                                                                                                                        |
| ARIA-LOW-509                                  | `32346ae23`                                         | One spelling for the Claude mock switch (`CLAUDE_CLI_MOCK`) and a pin that it is read                                                                                                                                                  |
| ARIA-MEDIUM-130                               | `6bf55ed2a`, `ad771e488` (integration)              | `tests/_helpers/sandbox_pins` is the one skip path for real-sandbox pins and shard verify refuses a run in which one skipped; the integration commit sends three leftover skips through it                                             |
| ARIA-HIGH-011                                 | `c0d7224a5`, `b8ba245d0` (integration)              | New SHADOW sql-migration-safety-adapter observes migration safety through the gates that own each rule; the integration commit removes its spec fixture through fixture-tree                                                           |
| ARIA-HIGH-013                                 | `8bd39a5aa`, `e65af0636`, `1f3048cc6` (integration) | New SHADOW workflow-shell-safety-adapter reports the workflow and shell claims through their owners; `e65af0636` narrows its declared_scope to the 12 roots it walks; the integration commit gives tools/gates the js-yaml declaration |
| ARIA-LOW-542                                  | `ee53bc957`                                         | collectFiles walks only what the adapter room shows, and a crashed fixture case records a sanitized stderr tail                                                                                                                        |
| ARIA-LOW-543                                  | `12849ca3d`                                         | The adapter-fs read helpers go through containedWorkspace (lstat walk, O_NOFOLLOW), so a symlinked path is refused                                                                                                                     |
| ARIA-HIGH-521                                 | `577741a4d`                                         | The pre-merge perimeter takes a PR's change binding from the pr-lifecycle row that carries a change_id                                                                                                                                 |
| ARIA-HIGH-520                                 | `02e4c0dc6`                                         | The closure-policy check separates unresolved refs from a broken structure and shows every operator blocker; owed proofs are listed in PENDING_CLOSURE_REGRESSION_REFS                                                                 |
| ARIA-LOW-541                                  | `aa5c98a34`                                         | `state_store_lifecycle_arcs.py` joins `_COMMON_AUTHORITY_PATHS`, with a test that derives ledger's import-time closure                                                                                                                 |
| ARIA-CRITICAL-009                             | `8cb35a5cf`                                         | `auto_merge.read_required_status_checks` is the one branch-protection reader of the merge lane and the CI observer (code half; the live half is not fixed)                                                                             |
| ARIA-HIGH-006                                 | `e8a198845`                                         | An implementation claim holds its file scope while its change has an open PR                                                                                                                                                           |
| ARIA-HIGH-016                                 | `7e3ef797f`                                         | `derive_autonomy_closure_verdict` derives the closure verdict from two explicit SHAs (Task 20 PR A only)                                                                                                                               |
| ARIA-MEDIUM-512                               | `1e28b38e7`                                         | Every operator authorization is bound to its subject: a refused write no longer spends an ack, and an unscoped approval promotes nothing                                                                                               |
| ARIA-LOW-268                                  | `5996a0feb`                                         | Spent operator requests skip ssh-keygen, and scan rows stop copying the full spent list                                                                                                                                                |
| ARIA-LOW-265                                  | `fa3ebb0cb`                                         | Check 12 compares the signed finding_id and grounding_digest with the plan it merges                                                                                                                                                   |
| ARIA-MEDIUM-264                               | `06c2f93ed`                                         | Check 12 proves merged-once from main's history (the `Aria-Operator-Request` line), which a rollback of aria/state cannot erase                                                                                                        |
| ARIA-LOW-266                                  | `3f03873dc`                                         | The request recorder shows what a request authorizes, and a root signer refuses a checkout, cwd or kernel tree another account can write                                                                                               |
| ARIA-MEDIUM-127                               | `e02c8a1f7`                                         | New operator inbox (CLI verb and MCP read tool) lists every decision ARIA waits on with the command that answers it                                                                                                                    |
| ARIA-MEDIUM-254                               | `b9b77d107`                                         | An operator ack is signed with the operator's key and verifies in any later job; HMAC operator acks are refused                                                                                                                        |
| ARIA-MEDIUM-564                               | `f55fa8a2f`                                         | The executor asks the pre-claim environment gate on the adaptive native lane too                                                                                                                                                       |
| ARIA-MEDIUM-570                               | `89bb19dc2`                                         | run_fixture_case refuses a suite whose runner lacks its repo-local dependency, through the registry predicate tool_runner asks                                                                                                         |
| ARIA-LOW-569                                  | `03de13392`                                         | Quarantine publication bounds the replica's ref and HEAD reads                                                                                                                                                                         |
| ARIA-LOW-571                                  | `a6cd6b382`                                         | A read_paths-only slim counts as stripped, so compaction persists and archives it                                                                                                                                                      |
| ARIA-LOW-567                                  | `ff4c499a2`                                         | A spawn-lane child's dispatch summary names the rung that ran, not the ladder head                                                                                                                                                     |
| ARIA-MEDIUM-574                               | `ebd59bd6f`                                         | The executor publishes the result files the kernel kept, after the terminal, so a withheld refusal no longer turns the job red                                                                                                         |
| ARIA-LOW-568                                  | `580187ca4`                                         | reap_stale_claims parses the lease rule's governance context outside the claims lock                                                                                                                                                   |
| ARIA-LOW-575                                  | `606d38c93`                                         | Delivery decides the envelope before refusing a secret-shaped diff, so the refusal carries the verdict's codes                                                                                                                         |
| ARIA-LOW-565                                  | `3e1176b24`                                         | One socket_holders declaration drives the orchestrator's startup sweep; the four copies are removed                                                                                                                                    |
| ARIA-LOW-566                                  | `cc5348b25`                                         | The lease reaper appends its governance rows as one batch per sweep                                                                                                                                                                    |
| ARIA-HIGH-045, ARIA-HIGH-525, ARIA-MEDIUM-526 | `baee15383`                                         | The spine gate measures each owner adapter's violation set from the refreshed run; an unmeasured comparison goes to HUMAN_REQUIRED                                                                                                     |
| ARIA-HIGH-531                                 | `a6498a1ff`                                         | Only typed declared_scope globs of dispatchable registry adapters observe the tree (`tool_registry.observing_globs`)                                                                                                                   |
| ARIA-LOW-533                                  | `667cb4694`, `414fc6efe` (integration)              | Each adapter manifest declares security_class and the raise-only dial set derives from it; the integration commit declares it on the two adapters ts-adapters added                                                                    |
| ARIA-LOW-545                                  | `0a012f8b9`                                         | The repository map's Rust test files are the Rust reader's answer (rust-source.ts)                                                                                                                                                     |
| ARIA-MEDIUM-560                               | `c76d2f49b`                                         | The genesis launcher's audit hook refuses every filesystem-mutating call by event name                                                                                                                                                 |
| ARIA-HIGH-414                                 | `d35590127`, `2fcb27b1b`                            | A drafted adapter reaches ACTIVE only on a verified panel token or a resolved operator act, never on a token's presence or a bare ref                                                                                                  |
| ARIA-MEDIUM-507                               | `7b7ab5c7d`                                         | The genesis dispatchers are bound to their store at the producer (store half only; the rest is ARIA-MEDIUM-612)                                                                                                                        |
| ARIA-HIGH-529                                 | `4800b3ed5`                                         | A plan the merge gate can never pass (no synthesis binding) is parked before staging                                                                                                                                                   |
| ARIA-MEDIUM-552                               | `2e9bb9ac6`                                         | A converged plan whose body the ledger cannot prove is parked HUMAN_REQUIRED instead of re-offered every cycle                                                                                                                         |
| ARIA-MEDIUM-400                               | `04195b888`                                         | A fixture verdict row (v2) names the commit and the digest of the argv scripts it measured                                                                                                                                             |
| ARIA-MEDIUM-385                               | `49ad67ce6`                                         | The mint refuses, for every role, a ref the submit law refuses; kernel pointers move to their own fields                                                                                                                               |
| ARIA-MEDIUM-101                               | `0f33ec48b`                                         | The mission scheduler absorbs only the reader's declared faults, raises a ranker defect and records its ordering                                                                                                                       |
| ARIA-MEDIUM-120                               | `fdfb5120c`                                         | The integrity verdict carries issue_count and issue_codes, and the doctor reads those                                                                                                                                                  |
| ARIA-LOW-514                                  | `a2f40d5ae`                                         | The plan-016 reflection section names an unreadable store and raises any other error                                                                                                                                                   |
| ARIA-MEDIUM-548                               | `969b57388`                                         | A bridge_replay_required night exits 1 and is not counted as a completed cycle                                                                                                                                                         |
| ARIA-LOW-549                                  | `cd987af1b`                                         | An aborted cycle carries failed_phases, so the doctor names `<phase>:phase_failed`, not `cycle:unrecorded`                                                                                                                             |
| ARIA-LOW-550                                  | `0bc6e56c3`                                         | A failing host organ is host_fault with the announce remedy and mints no self-change mission                                                                                                                                           |
| ARIA-LOW-559                                  | `63c4a557d`                                         | The self-improve step reads the doctor step's report instead of running the doctor again                                                                                                                                               |
| ARIA-HIGH-245                                 | `7da9b18eb`                                         | open_mission requires evidence_refs, the producers record theirs, and the scheduler skips an unevidenced mission (issue missions still open with none: ARIA-MEDIUM-606)                                                                |
| ARIA-LOW-504                                  | `7fa9becd2`                                         | circuit_breaker exports only names it defines, and a kernel-wide test star-imports every module                                                                                                                                        |
| ARIA-MEDIUM-538                               | `615fb7655`                                         | `command_policy.shell_words` lexes a command line in one linear pass, replacing shlex.split                                                                                                                                            |
| ARIA-MEDIUM-249                               | `4267fd5fa`                                         | The ORPHAN, issue and F plan sources produce and rank candidates as documented                                                                                                                                                         |
| ARIA-MEDIUM-276                               | `6362ffc16`                                         | The label queue samples blind and records each item's inclusion probability                                                                                                                                                            |
| ARIA-LOW-518                                  | `82a850052`, `7dfe85ff9` (integration)              | git_object_id is the one owner of what a git object id is; the integration commit routes the other clusters' new checks through it                                                                                                     |
| ARIA-MEDIUM-131                               | `dc782ac23`, `2ec2554a0` (integration)              | The hook broker serves a bounded number of callers, and test_hook_broker_adversarial.py is the adversarial review; the integration commit marks its AF_UNIX sockets as no-network                                                      |
| ARIA-MEDIUM-271                               | `a28c85374`                                         | Runtime signals are append-only events on a declared ledger, each its own pressure                                                                                                                                                     |
| ARIA-HIGH-534                                 | `0a8f4887f`                                         | debt-plan-truth counts BLOCKED and STALE CRITICALs as unresolved, through the one isUnresolvedFindingState predicate                                                                                                                   |
| ARIA-HIGH-044                                 | `7a6817d9d`                                         | Every registry write refuses an unresolved CRITICAL without owner and deadline (`$defs/accountable`, write sink); new verb `assign`                                                                                                    |
| ARIA-HIGH-530                                 | `b041805df`                                         | One kernel PR surface manifest (`.github/manifests/aria-kernel-surface.json`) feeds the required check and the pre-push selector                                                                                                       |
| ARIA-MEDIUM-314                               | `19f1658e1`                                         | `tools/gates/nats-services.ts` is the one services.yaml reader for the witness, ripple-tracer and the ACL smoke                                                                                                                        |
| ARIA-HIGH-313                                 | `7680ae7ca`, `a24e6aa1f` (integration)              | Event consumers come from a code scan (`tools/gates/event-consumer-index.ts`), not from NATS ACL grants; the integration commit builds its fixture on @nats-io                                                                         |
| ARIA-MEDIUM-535                               | `b0312e25a`                                         | owner_user is stored as its CODEOWNERS handle and any other identity is refused; new verb `canonicalize-owner`                                                                                                                         |
| ARIA-LOW-544                                  | `d817e9b73`                                         | The fork gate and the Rust reader share one sha256 manifest parser                                                                                                                                                                     |
| ARIA-LOW-558                                  | `886e58e46`                                         | The plan-coverage witness and its spec remove the temp dirs they make                                                                                                                                                                  |
| ARIA-LOW-510                                  | `9d9ceaa1d`                                         | aria-kernel.yml declares the retain_days input its state step reads, and a test compares read and declared inputs                                                                                                                      |
| ARIA-LOW-405                                  | `c1ac0822b`                                         | addColumnWithIndex refuses what it used to pass, and its pair invariant reads the code up() runs (the debt OVERDUE residual is ARIA-LOW-605)                                                                                           |

Three commits close nothing: `d3b0f8545` (the gate specs' fixture teardown goes through
`removeFixtureTree`), `255823c88` (the two closure proofs ts-adapters landed leave the pending
record) and `67977ea4e` (doc lines wrapped at 100 columns).

## Wave B — closed findings with no section in their review file

Six findings closed above are only mentioned in their own review file, in a residual list or a plan
table, with no section. Their section is here.

### ARIA-MEDIUM-110 — notify deduped one channel by another channel's send

Full title: `notify()` evaluates its per-signature dedup across channels inside one call: with two
configured channels the second is recorded deduped by the first channel's sent row of the same call,
so a multi-channel operator gets one delivery per signature instead of one per channel

`docs/reviews/claude/2026-09-11-aria-suite-env-hermeticity.md` lists it as a tracked residual.
Closed by `7d161315d`: the channel is part of notify's dedup key (`_recent_sent` takes the channel),
so each configured channel's window runs from its own last sent row, and a channel whose send failed
is retried while another channel has sent.

### ARIA-MEDIUM-111 — direct transaction appends bypassed the full-disk translation

Full title: About thirty governed append sites (notify, tool_registry, agent_invocations,
worker_dispatch, ...) write through transaction.append_declared_jsonl directly and bypass
ledger.append_declared_jsonl's ENOSPC-to-environment_failure translation, so a full disk surfaces as
a raw OSError instead of the named environment refusal promised for every governed append

The same review file lists it as a tracked residual. Closed by `8a987aeb3`: the translation to
`environment_failure:disk_full` moved from the three module-level wrappers into
`ledger.state_transaction`, so every append made through a transaction names a full disk. The
registry note also named the executor's model-refusal append; what is left there, a swallowed
exception, is ARIA-LOW-584.

### ARIA-MEDIUM-101 — the mission scheduler laundered a ranker defect

Full title: mission_scheduler.\_thompson_source_draws still wraps rank_pressure_sources +
thompson_rank in except (OSError, ValueError, KeyError, TypeError) — the laundering class removed
from the orchestrator's memory-hook seam and the pressure/cycle readers — so a programming error in
the ranker silently yields no draws

`docs/reviews/claude/2026-09-12-aria-live-chain-blockers.md` lists it as a tracked residual. Closed
by `0f33ec48b`: `_source_ranking` absorbs only `knowledge_graph.effectiveness_reader_faults()` and
only around `rank_pressure_sources`; a ranker defect raises into `record_and_continue`, and the
`mission_schedule_decided` event records the ranking and its fault.

### ARIA-MEDIUM-127 — no single surface for the decisions ARIA waits on

Full title: Every human decision ARIA asks for (HUMAN_REQUIRED records, waiver renewals, mission
opening, adjudication outcomes) lives in ledgers and CLI flags; the operator is the throughput
bottleneck (73 adjudications, 215 folded rows on the live store) with no single surface to see and
answer them

`docs/reviews/claude/2026-09-14-aria-post-chain-plan.md` lists it as row 2 of its plan table. Closed
by `e02c8a1f7`: `aria_kernel/operator_inbox.py` reads HUMAN_REQUIRED records, waivers that lapsed or
are about to, and missions parked in an operator-held state, each through its own reader, and lists
every item with the command that answers it, as a CLI verb and an MCP read tool. It undercounts
HUMAN_REQUIRED records that `list_human_required` cannot read (ARIA-LOW-597).

### ARIA-MEDIUM-130 — CI did not refuse a run in which a sandbox pin skipped

Full title: The containment contract (ARIA-HIGH-123) is proven only on this host: GitHub-hosted
runners cannot run the real-bwrap pins (no provisioning step; 24.04 AppArmor restricts unprivileged
userns), so CI skips every sandbox pin and the containment probe alone is the canary

The same plan table lists it as row 12. The kernel lane already provisions and proves a confining
bwrap before its suite. Closed by `6bf55ed2a` and `ad771e488` (integration):
`tests/_helpers/sandbox_pins.py` is the one way a test asks for the real sandbox, each skip carries
`SANDBOX_SKIP_MARKER`, and `suite_shards verify` refuses a shard report with such a skip or with no
account of them. The integration commit moved three leftover skips onto the helper. The
pytest-native half of the suite has no such account yet (ARIA-LOW-599).

### ARIA-MEDIUM-131 — the hook broker had no adversarial review

Full title: The hook broker (ARIA-HIGH-123) is the one privileged interface from the sandbox to the
kernel; it was verified inside its own lane but has had no independent adversarial review as an
attack surface (verb vocabulary, request forgery, socket ownership, denial of service by a hostile
agent)

The same plan table lists it as row 4. Closed by `dc782ac23` and `2ec2554a0` (integration):
`tests/test_hook_broker_adversarial.py` is the review, one surface per test against a real socket
and real threads. It found an unbounded handler-thread pool; the broker now serves at most 16
requests at once and raises the listen backlog to 64. The integration commit marks the test's
AF_UNIX sockets for the suite's no-network guard. The review also found that PostToolUse requests
are agent-attested and can quarantine the kernel's own MCP server; that is ARIA-MEDIUM-609.

## Wave B — not fixed, with reasons

Each bullet is one `not_fixed` entry of a cluster report. These findings stay OPEN.

- **ARIA-CRITICAL-009, live half** (`seven_pre_merge_checks_live_proven`, closure mode
  `task_commit_and_live`). The code half is fixed (`8cb35a5cf`). Production still cannot bring a
  merge decision to the perimeter: merge authority is not granted, main's branch protection lists no
  required checks (an empty list blocks the merge), and no production night has shown a decision
  reaching `pre_merge_perimeter`. The pinned proof `test_pre_merge_consensus_and_coverage.py` (Task
  12 Step 5) is not written; it needs a native expert-panel and operator-feedback synthesis fixture
  that no fixture builds yet. Proved on aria/state: `tools/runtime-profile.json` has
  `active_profile=standard` and `merge_lane_grant=null`; `tools/pr-lifecycle.jsonl` holds no
  `observed` row; all 352 rows of `tools/auto-merge-decisions.jsonl` are the CI observer's
  (`cyc-*-auto` cycle ids), the last at 2026-10-15T09:39, before ARIA-MEDIUM-423 reached main.
- **ARIA-HIGH-137.** Needs a live run, and ARIA is paused. No code change was needed: the executor,
  delivery and merge-perimeter fixtures already carry an `apps/**` change
  (`apps/farm-service/src/sample-interval.ts`) through the real executor child, the delivery and the
  pre-merge perimeter. Not done: an `apps/**` task end to end in production, and the merge
  predicates on it. Under the risk policy `apps/**/src/**` is lane L2, a human merge under the
  current profile, so exercising the predicates on L2 also needs an operator merge-lane grant
  covering L2. Only one aria-impl PR has ever merged (#1906, `web/`, merged by a human).
- **ARIA-HIGH-006, closure-policy proof refs.** The defect is fixed (`e8a198845`). The closure
  policy still names the Task 9 proof files `test_file_claim_atomic_acquire.py` and
  `test_pre_merge_file_claims.py`; the proofs were written in the owner files
  `test_file_lock_and_claim_idempotency.py` and `test_merge_authority_pre_merge_perimeter.py`.
  Re-pointing the policy changes closure semantics, so it is the operator's decision; the owed refs
  stay in `PENDING_CLOSURE_REGRESSION_REFS`.
- **ARIA-HIGH-016, Task 20 PRs B and C.** Only the verifier (PR A, `7e3ef797f`) is done. The
  `closure preclose` and `closure render` subcommands, the registry reconciliation (PR B) and the
  closure report (PR C) run after PR A merges, against origin/main, and the report needs every
  capability `live_proven` (closure plan Task 20 Steps 4-9).
- **ARIA-MEDIUM-555.** The job's `contents: write` cannot be narrowed to the publish step:
  `GITHUB_TOKEN` is scoped per job, and three steps of the one cycle job need write (the
  writer-lease acquire inside `restore-aria-state`, the publish and the lease release). The only
  other credential, the ARIA App, cannot replace the job token on the reading steps: its tokens
  expire after 3600 s while the cycle step runs about 4.5 h, and its documented grant is Issues
  read-only where notify needs issues write. Moving lease, publish and release to App-minted tokens
  would add a mint that can fail to every `always()` close-out step, cannot be proven without a live
  run, and still leaves repository write in the cycle process, which holds the App key all night.
  That root cause is ARIA-MEDIUM-583. No commit was made, because a `Closes:` without the narrowing
  would be a false close.
- **ARIA-LOW-532.** Two things this cluster may not provide are missing: a pinned helm binary on the
  ARIA runner that the adapter room can reach (`command -v helm` finds nothing;
  `.github/actions/setup-helm` serves CI jobs only, and `adapter_room.py` refuses a toolchain bind
  under `RUNNER_TEMP`), and an infrastructure-policy adapter that reads rendered manifests, which is
  ARIA-HIGH-012 (OPEN, plan Task 15).
- **ARIA-LOW-269.** Two halves. Half (b), proving the anchor against main as GitHub serves it
  instead of the runner-writable `refs/remotes/origin/main`, needs a trust decision per lane
  (operator recorder, T2 probe, self-hosted auto-cycle, merge lane, kernel suite) that cannot be
  verified without live runs. Half (a), re-deriving the commit and tree objects, is self-contained
  and was reproduced with git 2.43.0 on `b9b77d107`: with the root tree's loose object rewritten
  under its genuine id, `resolve_main_anchor` returns the anchor and
  `committed_blob(commit, 'signers')` returns `b'attacker key\n'`. Git refuses the object in
  `rev-parse <id>^{commit}`, `merge-base` and `ls-tree`, not in `rev-parse <commit>:<path>` or
  `cat-file`. Reach: signers, registry and enrolments are chain-verified to the pinned genesis, so a
  forged tree can present at most an older enrolled pair; the operators policy read at the anchor is
  not chained. The stub for half (a) was dropped as covered by ARIA-LOW-269 (see the next section).
- **ARIA-HIGH-281.** The repository side is in the base. The finding closes only after the
  operator's one-time host act (`docs/runbooks/monitoring/aria-t2-boundary.md`: refresh
  `/var/lib/aria/code`, run `provision_runner.sh apply`, start the probe) and one journal line from
  the host with `"held": true`. ARIA-HIGH-247 (`973072057`) makes that act safe: before it, apply
  also installed the 3G per-session memory cap and enabled the gateway and telemetry units. Proved
  read-only on 2026-10-17: `aria-t2-probe.timer` is disabled and inactive, the service last exited
  on 2026-10-03 with status 3, the installed unit predates the root-owned trust fix, no
  `aria_t2_boundary.prom` exists, and `/var/lib/aria/code` is at `c1d183969`.
- **ARIA-LOW-405, debt OVERDUE residual.** `c1ac0822b` closes 405 for its other five residuals and
  names this one as not done. It needs a design decision first: which store is the debt SSoT (the
  committed `aria-debts/*.json`, changed by commits with no ledger, or the hash-chained
  `debt-events.jsonl`, empty in production); a transition model for every status after OPEN with one
  unresolved-debt predicate for its readers; and a lane that writes the ARIA store while ARIA is
  paused, against `CONTRACTS.md`'s "no state change without operator action or fix-shipped event".
  Registered as ARIA-LOW-605.
- **ARIA-MEDIUM-129.** The review file and the registry give two designs (an A/B test, or an
  observational per-convention lift with outcome-driven decay), the same review records the
  operator's brake on over-engineering, and there is no data to calibrate either. On aria/state
  `8e39b2eeb`, `requests.jsonl` has 1,614 rows, 817 with `established_knowledge` and none with a
  non-empty conventions list; `change-ledger/outcome.jsonl` has one row. Part of the triage premise
  was wrong: convention presence is already recorded on each request; nothing joins it to an
  outcome.
- **ARIA-LOW-252.** The Phase-7 half was built before the base (`system_one.py`, `jev_runtime.py`,
  `aria-config/system-one-questions.json` enabled). The embedder half needs the operator to supply a
  model (ORPHAN-MEDIUM-639); nothing sets `ARIA_EMBEDDER_CMD`.
- **ARIA-LOW-573.** The finding's own fix is conditional on the operator agreeing that the crash
  text should live only on aria/state. `github_issue` is the only notify channel the auto-cycle
  configures, so pointer-only `cycle_failed` notices would take the crash reason out of the
  operator's only inbox without reducing exposure: the same sanitized text is already published in
  `autonomy_state.jsonl` on aria/state. If the operator agrees, the fix is to add `cycle_failed` to
  `notify.POINTER_ONLY_SUMMARIES` and pass the record path from `_notify_cycle_failed`.
- **ARIA-MEDIUM-168.** No code defect is left on the base; all three causes were closed upstream.
  What remains is historical data that only an aria/state write could repair (the 27 August results
  the publish dropped) and a field that is a write-time marker by design. Stopping retries by name
  belongs to ARIA-MEDIUM-172 (OPEN). Proved on aria/state `8e39b2eeb`:
  `agent-result-bridge-status.jsonl` final transitions are ok 477, not_required 276, permanent_fail
  13, none pending; the last `agent_bridge_warning` is from 2026-09-18T21:40:05Z.
- **ARIA-MEDIUM-398.** A drain-to-drain chain edge is a scheduling decision (which edge wins, how
  many drain hops are allowed before a cycle must run). Both workflows share the concurrency group
  `aria-selfhosted-workspace`, and GitHub keeps one pending run per group, so a drain dispatch would
  compete with `chain-next-cycle` and the daily cron cycle for that slot. Only a live run can prove
  the edge, and the scheduled workflows are disabled.
- **ARIA-MEDIUM-507, second half.** `7b7ab5c7d` fixes the store binding. The learning router's
  `skill_gap` and `unobserved_surface` requests are non-convergent, nothing consumes them
  automatically, and `existing_genesis_request_keys` stops them from being re-emitted; every fix
  changes ARIA's spend or its operator surface. Registered as ARIA-MEDIUM-612 (aria/state holds 20
  such rows, all `requested`).

Operator review before this branch merges:

- **Two operator decisions are embedded in the gates-registry commits.** `7a6817d9d` (ARIA-HIGH-044)
  sets deadline 2026-10-31 for ARIA-CRITICAL-009 and ARIA-CRITICAL-015 (the G020 OQ1 default), and
  `b0312e25a` (ARIA-MEDIUM-535) maps owner_user `okan` to `Okan-wqm` (the commit body carries the
  git authorship evidence). Their registry rewrites are not on this branch: `findings.jsonl` was
  resolved to origin/main byte for byte at the merge, and the verbs (five `assign`, three
  `canonicalize-owner`) wait for the operator. The merged tool refuses owner_user `okan`, and both
  verbs append a stamp to `notes` (1,435 rows in the integrator's dry run). Until they run,
  `finding-registry-integrity.spec` stays red on this branch. The rows registered below use
  `Okan-wqm`.
- **Two capability-semantic pins need the operator's review.** `04195b888` (ARIA-MEDIUM-400) adds
  two entries to `aria-kernel/tests/invariants/capability_semantic_equivalence/pins.json`: the
  authority pin `fixture_calibration@2:fold@3:upcasters@1` and the producer pin for
  `fixture_runner.suite` `aria/agent-eval-fixture-run/v1@2`. They sit beside the `@1` entries; none
  was edited, and `fold_mismatch` is None. The file says its entries are recorded by the operator.

Six commits close a finding whose own text also covers a part they leave. That part is now its own
row: ARIA-HIGH-245 (issue missions) is ARIA-MEDIUM-606, ARIA-MEDIUM-507 (non-convergent requests) is
ARIA-MEDIUM-612, ARIA-LOW-405 (debt OVERDUE) is ARIA-LOW-605, ARIA-MEDIUM-111 (the executor's
model-refusal append) is ARIA-LOW-584, ARIA-HIGH-529 (planning still spends before the park) is
ARIA-LOW-613, and ARIA-HIGH-530 (runtime reads and whole-checkout steps) is ARIA-HIGH-602.
ARIA-HIGH-530's own registry note says the tracer bucket, not the surface manifest, closes it.
Whether each `Closes:` line stands is the merger's call.

## Findings raised while fixing wave B

The fixers wrote 39 stubs. Each was re-checked on the integrated head `dc6376f13`, compared with the
other stubs and with the registry's rows for the same file or function. Three were dropped:

- `b-operator-provenance-4` (`main_anchor.committed_blob` does not re-derive the tree objects):
  covered by ARIA-LOW-269, which is OPEN and whose title names the defect ("re-hashes only the
  allowed-signers blob, not the commit or tree"). The reproduction is in the ARIA-LOW-269 bullet
  above.
- `b-kernel-misc-5` (ORPHAN-MEDIUM-639 has no registry row): covered by ARIA-LOW-252, which is OPEN,
  owned by Okan with deadline 2026-11-01, and whose title names the missing embedder.
- `b-kernel-misc-7` (the redact view's `secret_assignment` rewrote `"GH_TOKEN": false`): fixed on
  main by `fbe1a1020` ("an assignment's redaction replaces the value alone and leaves JSON booleans
  and nulls"), which is in the branch base `cb16483db`. On the integrated head, `scrub_text` returns
  the stub's `ENV_PROBE` line unchanged.

No two stubs describe the same defect. ARIA-LOW-586 and ARIA-LOW-587 share a rule but are different
code (ten reflection sections, and `scan_signals`). Cluster kernel-misc deleted its own stub 3
(unbounded broker threads) because `dc782ac23` fixes it.

The 36 survivors are registered with `finding-registry add`: 35 ARIA rows (ARIA-MEDIUM-580 to
ARIA-HIGH-614) and SENSOR-MEDIUM-189. The sensor-service subject defect is filed under SENSOR
because its code is in sensor-service, gateway-api and `services.yaml`; ARIA's consumer index only
reports it. Every row is OPEN, owner Okan-wqm, agent claude, cycle `2026-10-17-aria-wave-b`, with
deadline 2026-10-31 for HIGH and 2026-11-14 for MEDIUM and LOW. The registry notes also keep each
fixer's original evidence text, with line numbers from the cluster branch.

### ARIA-MEDIUM-580 — ORPHAN-HIGH-779 is RESOLVED but its policy proof file never existed

Full title: ORPHAN-HIGH-779 is RESOLVED in the registry while the closure policy still binds it to a
task-7 regression test that has never existed

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A closed finding's pinned proof
must exist; the policy entry and the registry row must describe the same closure (single owner of
the closure fact)

Evidence:

- `docs/aria/policy/autonomy-closure-findings.json:66-79`
- `docs/reviews/_registry/findings.jsonl:1393`
- `aria-kernel/tests/test_autonomy_evidence_status.py:6371`

Found while recording the closure policy's absent regression refs for ARIA-HIGH-520
(aria-kernel/tests/test_autonomy_evidence_status.py PENDING_CLOSURE_REGRESSION_REFS lists it among
the owed proofs). Either the registry closure of ORPHAN-HIGH-779 covered only the fixture path guard
and the task-7 live predicate needs its own finding, or the policy entry needs the closing fix's
test. A closure verifier (ARIA-HIGH-016) would refuse closure on this mismatch.

Re-checked on the integrated head `dc6376f13`: the policy entry still lists
aria-kernel/tests/test_learning_funnel_scheduled_path.py, the file does not exist, and git log --all
names no commit that ever added it.

### ARIA-MEDIUM-581 — The merge lane drops why a PR diff could not be read

Full title: The merge lane discards why a PR's diff could not be read, so a refused or oversized
diff blocks as a bare 'diff_text missing' with no cause

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A fail-closed gate names its cause
(the same rule read_required_status_checks follows with its lookup_error codes); no defensive catch
hides why an input is unavailable

Evidence:

- `aria-kernel/aria_kernel/auto_merge.py:1303-1321`
- `aria-kernel/aria_kernel/auto_merge.py:801-805`
- `aria-kernel/aria_kernel/merge_authority.py:239-243`
- `aria-kernel/aria_kernel/auto_merge.py:293-297`

Found while tracing ARIA-CRITICAL-009's 'diff_text missing' rows (branch
fix/aria-kb-merge-autonomy). Those 352 production rows were the CI observer's (fixed by
ARIA-MEDIUM-423, fbd8b0b3b), not this path, so nothing is mis-merged; but once the merge lane runs
live, a large `apps/**` change (ARIA-HIGH-137) would block here with no way for the operator to tell
a token refusal from an oversized diff. Fix direction: get_pr_diff returns (diff, lookup_error) like
read_required_status_checks, and evaluate_auto_merge names the code.

Re-checked on the integrated head `dc6376f13`: GhCliGitHubAdapter.get_pr_diff still returns a bare
None on a non-zero exit, and both callers still catch Exception into None.

### ARIA-MEDIUM-582 — The merge lane's freeze reads see only the 50 newest open issues

Full title: The merge lane's freeze reads (self-merge freeze notice, watchdog incident) see only the
50 newest open issues carrying the labels, so with more than 50 such issues an open freeze or
incident is missed and the merge proceeds

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A safety gate's read must be
complete or report itself unreadable: a capped window reported as readable fails open (an unreadable
freeze is not an absent freeze, per the gates' own docstrings)

Evidence:

- `aria-kernel/aria_kernel/auto_merge.py:1091-1110`
- `aria-kernel/aria_kernel/self_merge_freeze.py:339-362`
- `aria-kernel/aria_kernel/watchdog_freeze.py:81-109`
- `aria-kernel/aria_kernel/self_merge_freeze.py:72`
- `.github/manifests/aria-state-watchdog.json:33`
- `aria-kernel/aria_kernel/github_adapters.py:300-330`

Same defect class as ARIA-LOW-554 (capped issue list treated as the whole open set) in a different
owner (auto_merge.GhCliGitHubAdapter), on a fail-open path: the freeze/incident filter is applied
client-side to the 50 newest. Requires more than 50 open issues carrying both labels, so unlikely
today; the consequence is a merge during a freeze. Not fixed in the workflow-notify-ledger cluster
because auto_merge.py is outside its owner modules; the one-owner shape is the merge adapter reading
through the issue writer's paginated REST lookup.

Re-checked on the integrated head `dc6376f13`: GhCliGitHubAdapter.get_open_issues still runs gh
issue list --limit 50 and reports `readable=True`.

### ARIA-MEDIUM-583 — The nightly-cycle process holds the GitHub App key all night

Full title: The nightly-cycle process holds the ARIA GitHub App private key for the whole night and
mints contents:write installation tokens in-process, so narrowing the job token (ARIA-MEDIUM-555)
cannot take repository write away from it; least privilege needs the mint outside the cycle process

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Least privilege: a long-lived
credential that can mint repository-write tokens should not be readable by the long-running process
that runs discovery, planning and agent orchestration; the mint belongs to a broker that issues only
the narrowed, per-delivery token

Evidence:

- `.github/workflows/aria-auto-cycle.yml:939`
- `.github/workflows/aria-auto-cycle.yml:994-999`
- `aria-kernel/aria_kernel/gh_token_factory.py:314-318`
- `aria-kernel/aria_kernel/gh_token_factory.py:1171-1174`
- `aria-kernel/aria_kernel/delivery_credentials.py:305-307`
- `docs/runbooks/aria-state-branch-bootstrap.md:39`

Found while working ARIA-MEDIUM-555 (job-level contents:write). The job token's write is needed by
three steps in one job (writer-lease acquire inside restore-aria-state, publish, lease release) and
GitHub scopes GITHUB_TOKEN per job; even with a step-scoped publish credential, the cycle process
keeps repository write through the App key. agent_env and the adapter room already keep both
credentials out of agent and adapter children (agent_env.py SECRET_SHAPED_ENV_NAME;
adapter_room.py). Design decision for the operator: a mint broker (the signing_agent pattern) that
hands the cycle process only per-PR, per-branch tokens.

Re-checked on the integrated head `dc6376f13`: the cycle step still writes the App key to
RUNNER_TEMP and exports ARIA_GH_APP_PRIVATE_KEY_PATH to autonomy run; the default mint set still
holds contents: write. Related: ARIA-MEDIUM-555 (OPEN, job-token scope) cannot remove repository
write from the cycle process while this holds.

### ARIA-LOW-584 — The executor swallows a failed model-refusal governance append

Full title: The executor's model-refusal exit swallows every exception from its
model_refusal_unresolved governance append (`except Exception: pass`), so a failed append, a full
disk named environment_failure:disk_full included, leaves no trace

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: No defensive swallow that hides a
failure: a governance row that could not be written is reported, not dropped

Evidence:

- `tools/aria-poc/ci_executor.py:2490-2498`
- `aria-kernel/aria_kernel/ledger.py:742`

The second clause of ARIA-MEDIUM-111's registry note (the in-process append before the record)
re-checked on 606169730 + this branch: the HUMAN_REQUIRED record is now in-process too
(ci_executor.py:2465-2479, 'One recorder (round 3)'), so the 'priced record child' half no longer
exists; what remains is the silent swallow of the governance append. Not fixed in this cluster
(executor module, outside the ledger owner).

Re-checked on the integrated head `dc6376f13`: the model_refusal_unresolved append is still inside
try/except Exception: pass. ARIA-MEDIUM-111 (closed on this branch by 8a987aeb3) named this site in
its notes; this row carries the part 8a987aeb3 did not change.

### ARIA-LOW-585 — The two ARIA lanes price the same aria/state publish two ways

Full title: The two ARIA lanes price the same aria/state publish two ways: aria-auto-cycle's whole
close-out margin (6000 s, from one measurement) is below the kernel's own priced worst case for the
publish arc alone (7200 s), which aria-agent-executor prices its post-drain reserve from

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Single center: one publish, one
pricing. A lane's close-out budget is derived from the kernel's bounds for the steps it runs, not
from a separate measured literal that disagrees with them

Evidence:

- `.github/workflows/aria-auto-cycle.yml:229-230`
- `aria-kernel/aria_kernel/state_store_lifecycle_arcs.py:366`
- `aria-kernel/aria_kernel/state_writer_lease.py:125`
- `tools/aria-poc/ci_executor_drain.py:342`
- `tools/aria-poc/ci_executor_drain.py:362-366`
- `.github/workflows/aria-agent-executor.yml:737-739`
- `aria-kernel/tests/test_state_lock_liveness_bound.py:792`
- `.github/workflows/aria-auto-cycle.yml:206-212`

Found while fixing ARIA-LOW-551, which kept the measured basis, gave margin and basis one owner (the
job env) and made every night measure the unbounded stretch against it. Pricing the producer's
margin from the kernel bounds instead would shrink the cycle's spawn window by more than an hour at
the 360-minute cap, or needs the cap raised (self-hosted jobs may run past 360 minutes, as the
executor does), which is an operator budget decision. Separately, the executor's 900 s steps
allowance looks under-priced against the producer's measured integrity verify; worth re-measuring on
the current 626 MB store before either lane's number moves.

Re-checked on the integrated head `dc6376f13`: imported the constants:
STATE_STORE_LIFECYCLE_LIVENESS_SECONDS 2700.0 + PUBLISH_PREAMBLE_SECONDS 4500 `=` 7200.0,
JOB_RESERVE_AFTER_DRAIN_SECONDS 8100; the auto-cycle job env still sets the margin to 6000.

### ARIA-LOW-586 — Ten more reflection sections swallow every Exception from their reader

Full title: Ten more reflection report sections swallow every Exception from their reader
(ARIA-LOW-514's class, sibling sites)

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A programming error must raise; only
a reader's declared fault set may be absorbed and it must be reported by name (B1 2026-09-12,
knowledge_graph.effectiveness_reader_faults; ARIA-LOW-514 fix in
plan_016_metrics.plan_016_metric_reader_faults)

Evidence:

- `aria-kernel/aria_kernel/reflection.py:833`
- `aria-kernel/aria_kernel/reflection.py:845`
- `aria-kernel/aria_kernel/reflection.py:1148`
- `aria-kernel/aria_kernel/reflection.py:1187`
- `aria-kernel/aria_kernel/reflection.py:1218`
- `aria-kernel/aria_kernel/reflection.py:1254`
- `aria-kernel/aria_kernel/reflection.py:1300`
- `aria-kernel/aria_kernel/reflection.py:1360`
- `aria-kernel/aria_kernel/reflection.py:1394`
- `aria-kernel/aria_kernel/reflection.py:1420`

Found while fixing ARIA-LOW-514 on branch fix/aria-kb-orchestrator-doctor (commit a2f40d5ae fixes
only `_render_plan016_section`). Each of these sections returns [] (or a default) on any Exception,
so an unreadable ledger and a defect in the section's reader both read as a reflection report
without that section. Each reader's fault set must be studied before narrowing (a different
ledger/reader per section), so they were not changed in the LOW-514 commit. Fix shape: per reader, a
declared `*_reader_faults()` tuple next to the reader, the section renders '- unreadable: `<class>`'
for those, anything else raises.

Re-checked on the integrated head `dc6376f13`: the ten except Exception sites are at :833 and :845
(`_compute_dataflow_health`), :1148 and :1187 (`_render_observability_section`), :1218
(`_render_learning_events_section`), :1254 (`_render_mission_section`), :1300
(`_render_quarantine_section`), :1360 (`_render_rule_health_section`), :1394
(`_render_duel_ratings_section`) and :1420 (`_render_own_pr_ci_section`).

### ARIA-LOW-587 — scan_signals swallows every Exception from its six signal readers

Full title: self_improvement.scan_signals swallows every Exception from each of its six signal
readers, so a reader defect or a crashed doctor run silently removes that signal family from
self-improvement

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A programming error must raise; only
a reader's declared fault set may be absorbed and it must be reported by name (B1 2026-09-12,
knowledge_graph.effectiveness_reader_faults; ARIA-MEDIUM-101 and ARIA-LOW-514 fixes on
fix/aria-kb-orchestrator-doctor)

Evidence:

- `aria-kernel/aria_kernel/self_improvement.py:249-334`
- `aria-kernel/aria_kernel/self_improvement.py:280`
- `aria-kernel/aria_kernel/self_improvement.py:290`
- `aria-kernel/aria_kernel/self_improvement.py:300`
- `aria-kernel/aria_kernel/self_improvement.py:307`
- `aria-kernel/aria_kernel/self_improvement.py:316`
- `aria-kernel/aria_kernel/self_improvement.py:332`

Found while fixing ARIA-LOW-559 on fix/aria-kb-orchestrator-doctor (63c4a557d), which only changed
where the doctor report comes from. Each try block returns no signals of its family on ANY
exception, so a TypeError in a reader, an unreadable ledger and a crashed doctor run all read as
'nothing to improve', and the self_improve action still reports `status=ran`. Since 63c4a557d the
live lane reads the doctor step's report, so a doctor crash there now fails the self-improve step
loudly (load_doctor_report on a partial file), but a gateway schedule running the self_improve
action (scheduler.py SCHEDULE_ACTIONS) and the self-improve CLI still run the doctor inside this
guard. Fix shape: per reader, a declared `*_reader_faults()` tuple next to the reader; scan_signals
absorbs only those and records which families were unreadable on its result (and the self_improve
action's detail); anything else raises.

Re-checked on the integrated head `dc6376f13`: scan_signals still has six except Exception blocks
(capability gaps :280, funnel stalls :290, delivery closure SLO :300, MCP quarantine :307, doctor
organs :316, deadlines :332).

### ARIA-MEDIUM-588 — The adapters' MODULE_SCHEMAS reader drops spread entries

Full title: The adapters' MODULE_SCHEMAS reader drops spread entries, so
typeorm-entity-schema-adapter misses tenant_erasure_target_proofs as infrastructure and no adapter
can reuse the tenant-aware qualified-DDL guard

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Single source of truth: the
adapter-side reader of MODULE_SCHEMAS must yield the same registry as the runtime value the gates
import; tools/aria-adapters/sql-migration-safety-adapter.ts (ARIA-HIGH-011) therefore cannot observe
the tenant-aware qualified-DDL guard without reporting tables the guard accepts.

Evidence:

- `tools/aria-adapters/typeorm-entity-schema-adapter.ts:1165-1180`
- `libs/backend-common/src/database/schema-manager.service.ts:251`
- `libs/backend-common/src/database/schema-manager.service.ts:287`
- `tools/aria-adapters/typeorm-entity-schema-adapter.ts:391-397`
- `tests/invariants/tenant-aware-migration-ddl-guard.spec.ts:49`

Found while landing ARIA-HIGH-011 (sql-migration-safety-adapter). Reusing the guard's classifier
with the AST reader would mark tenant_erasure_target_proofs (cross-tenant infrastructure at runtime)
as unclassified. Fix direction: one MODULE_SCHEMAS reader for adapters that resolves spread and
imported string constants (or a generated JSON projection of MODULE_SCHEMAS checked against the
runtime value by an invariant), then extract the guard into tools/gates with the registry passed in
and the directory map derived from the platform catalog, and add it to sql-migration-safety-adapter.
Same reader defect may make typeorm-entity-schema-adapter treat the erasure-proof ledger as a
non-infrastructure table.

Re-checked on the integrated head `dc6376f13`: readStringArrayProperty still keeps only
string-literal elements, and every module entry still spreads
TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES.

### ARIA-HIGH-589 — The workflow contract verifier accepts a job with permissions: write-all

Full title: The workflow contract verifier accepts a governed job that declares
`permissions: write-all`: a non-mapping job permission falls back to the workflow-level map, so the
job's least-privilege contract is never checked

HIGH, owner Okan-wqm (agent claude), deadline 2026-10-31. Rule: ADR-036 per-job least privilege: a
governed job's token must not write a scope its contract does not grant
(workflow_uncontracted_write_permission). write-all grants every scope.

Evidence:

- `aria-kernel/aria_kernel/workflow_contracts.py:397`
- `aria-kernel/aria_kernel/workflow_contracts.py:749-760`
- `.github/workflows/rule-health-report.yml:43-44`

Found while landing ARIA-HIGH-013 (workflow-shell-safety-adapter), which reports any job-level
write-all as overbroad_write_token itself, so ARIA's observation is not blind to it; the CI-gated
kernel verifier is. Fix direction: treat write-all as every scope `write` (and `read-all/{}` as no
write) when computing the job's effective permissions, then let uncontracted_write_scopes
(workflow_contract_registry.py) decide; add a red test with a governed job declaring write-all.

Re-checked on the integrated head `dc6376f13`: a copy of `rule-health-report.yml` with
`permissions: write-all` on job `generate` gives
`verify_workflow_contract(workflow_id='rule-health-report')` `valid=True` with no reasons; the
unmodified file is also `valid=True`.

### ARIA-MEDIUM-590 — Two copies of the action-pin rule disagree

Full title: Two copies of the action-pin rule disagree: tools/gates/gha-sha-pin.ts and
tests/invariants/aria-workflow-sha-pin.spec.ts differ on docker:// references, `uses:` without @ref,
and an operator allowlist

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Single source of truth: one rule,
one owner. The pre-commit/quality gate (npm run gates:gha-sha-pin) and the invariant spec are both
CI gates for the same rule and would give different verdicts on `uses: docker://img:tag`,
`uses: owner/repo`, and `uses: dtolnay/rust-toolchain@nightly`.

Evidence:

- `tools/gates/gha-sha-pin.ts:95-122`
- `tests/invariants/aria-workflow-sha-pin.spec.ts:68-79`
- `tests/invariants/aria-workflow-sha-pin.spec.ts:131-133`

Found while landing ARIA-HIGH-013: workflow-shell-safety-adapter reads the gate
(tools/gates/gha-sha-pin.ts inspectUsesText), as the plan's Task 16 says. Both copies are green on
the current tree (no such reference exists), so the divergence is latent. Fix direction: decide the
policy once (allowlist + docker digest rule) in tools/gates/gha-sha-pin.ts and make the spec import
inspectUsesText.

Re-checked on the integrated head `dc6376f13`: inspectUsesText still flags a ref with no @ and has
no docker:// exemption or allowlist; the spec still exempts both and allows
dtolnay/rust-toolchain@nightly.

### ARIA-LOW-591 — The force-push refusal does not see past git's global options

Full title: governance_bypass_refusal does not see past git's global options, so
`git -C dir push -f` and `git -c k=v push --force` are not refused as force pushes

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: CLAUDE.md: force push is forbidden;
the perimeter's force-push definition should hold for every spelling of a push.

Evidence:

- `aria-kernel/aria_kernel/implementation_safety.py:2866-2896`
- `aria-kernel/aria_kernel/implementation_safety.py:2883`
- `aria-kernel/aria_kernel/implementation_safety.py:2928-2957`
- `aria-kernel/aria_kernel/implementation_safety.py:2960-2981`

Agents cannot run the escaping forms (the argv allowlist refuses them before the perimeter check),
so this is defence in depth for the sandbox. The workflow-shell-safety adapter (ARIA-HIGH-013) asks
the same function about repository scripts and would miss `git -C "$dir" push --force`; no tracked
script or workflow uses that form today (grep). Fix direction: strip git's global options (-C, -c,
`--git-dir=`, `--work-tree=`, --no-pager, --no-replace-objects, ...) before reading the subcommand,
in `_argv_forces_a_push` and `_argv_bypasses_hooks`'s commit check.

Re-checked on the integrated head `dc6376f13`:
`governance_bypass_refusal(['git', '-C', 'd', 'push', '-f'])` and
`governance_bypass_refusal(['git', '-c', 'a=b', 'push', '--force'])` return `None`;
`governance_bypass_refusal(['git', 'push', '--force'])` returns
`('no_force_push', 'force_flag_in_bash_argv:--force')`.

### ARIA-LOW-592 — Two adapters report a workflow permissions: write-all

Full title: Two adapters report a workflow `permissions: write-all`:
agent-harness-security-adapter's broad_shell_permission and workflow-shell-safety-adapter's
overbroad_write_token

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: One owner per verdict: the same line
can be raised by two SHADOW adapters under two rule names.

Evidence:

- `tools/aria-poc/agent_harness_security_adapter.py:229-244`
- `tools/aria-adapters/workflow-shell-safety-adapter.ts:704-716`

Found while landing ARIA-HIGH-013. No workflow declares write-all today (measured: 0 of 169 jobs),
so no duplicate is produced on the current tree. The harness rule is a line regex with a 'reason'
comment escape; the new rule reads each job's effective permissions and the workflow contract
registry. Fix direction: retire the workflow half of broad_shell_permission (or make it a projection
of overbroad_write_token) so workflow token scope has one observer.

Re-checked on the integrated head `dc6376f13`: both rules are present; no workflow declares
write-all today, so no duplicate is produced yet.

### ARIA-LOW-593 — TypeScript adapters still reach the filesystem outside adapter-fs

Full title: TypeScript adapters still reach the filesystem outside adapter-fs containment: the
ts.Program compiler host and direct node:fs calls, with no lint rule confining node:fs to
adapter-fs.ts

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: One containment owner for adapter
filesystem access (adapter-fs.ts containedWorkspace); a second path to the filesystem is a second,
unchecked rule.

Evidence:

- `tools/aria-adapters/tenant-scoping-adapter.ts:606`
- `tools/aria-adapters/event-contracts-adapter.ts:390`
- `tools/aria-adapters/rust-cargo.ts:81`
- `tools/aria-adapters/workflow-shell-safety-adapter.ts:360`
- `tools/aria-adapters/workflow-shell-safety-adapter.ts:570`
- `eslint.config.mjs:415-417`

Found while fixing ARIA-LOW-543, which routes readWorkspaceFile, readWorkspaceJson,
workspacePathExists and the collectFiles root through containedWorkspace. The listed readers are
outside that finding's named helpers. Impact is defence in depth only: in the adapter room the
workspace is the read-only tracked view (adapter_room.py), and no tracked symlink exists in this
repository (git ls-files -s `|` awk '`$1==120000`' is empty). Fix direction: give the ts.Program a
compiler host whose readFile/fileExists go through containedWorkspace for workspace paths
(dependency trees are bound read-only by the room), add the executable bit and a contained exists to
adapter-fs, and add an eslint no-restricted-imports rule for node:fs/fs in
`tools/aria-adapters/*.ts` except adapter-fs.ts and `*.test.ts` so a new bypass fails lint.

Re-checked on the integrated head `dc6376f13`: the two ts.createProgram calls, rust-cargo existsSync
and the two lstatSync calls are unchanged; the eslint override for `tools/aria-adapters/*.ts`
restricts no node:fs import. ARIA-LOW-543 (closed on this branch by 12849ca3d) covered only the
named adapter-fs helpers.

### ARIA-LOW-594 — No check ties an adapter's declared_scope to the roots it walks

Full title: No kernel check ties an adapter's declared_scope to what its production input walks;
bundle-budget-adapter claims 318 web/shared-ui files it never reads

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: observation_coverage.py:30-34: a path
counts as observed only when an adapter both declares it AND could actually parse it; a declaration
wider than the walked roots is coverage theatre the map cannot see.

Evidence:

- `aria-kernel/aria_kernel/tool_registry.py:1251-1267`
- `aria-kernel/aria_kernel/tool_registry.py:927-928`
- `tools/aria-adapters/bundle-budget-adapter.tool.json:7`
- `tools/aria-adapters/bundle-budget-adapter.tool.json:17`
- `aria-kernel/aria_kernel/observation_coverage.py:32-36`

Found while finishing ARIA-HIGH-013: workflow-shell-safety-adapter declared `**/*.{sh,bash}` while
its default_input.roots walk 12 roots; that manifest is corrected and pinned by an adapter-local
test (workflow-shell-safety-adapter.test.ts). The general rule has no owner: a registry-time
(validate_tool_definition) or observation-coverage check that every declared_scope glob's literal
prefix lies under default_input.roots or default_input.coverageRoots (test-gap-adapter declares
`e2e/**` and `tests/**` through coverageRoots, which is legitimate). Adding it today would fail
bundle-budget-adapter, so its manifest (or its roots) must be corrected in the same change.

Re-checked on the integrated head `dc6376f13`: ARIA-HIGH-531 (a6498a1ff) moved the observation rule
to tool_registry.observing_globs, which reads only declared_scope (typed alternatives) and never
default_input.roots, so the gap stands. git ls-files web/shared-ui matching
`web/**/*.{ts,tsx,js,json}` `=` 318 files on the integrated head (239 when the fixer measured).

### ARIA-LOW-595 — Eleven adapter TS tests and test_published_text leak temp dirs

Full title: Eleven aria-adapters TS tests and test_published_text leave their temp workspaces in
/tmp on every run

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A test removes what it creates; one
`nx test aria-adapters` run left 20 directories under /tmp (measured 2026-10-17:
`aria-bundle-budget-*`, `aria-doc-staleness-*` x3, `aria-rust-*` x6, `aria-test-gap-*` x2,
`aria-typeorm-adapter-*` x2, ...), and the kernel test 5 `aria-published-*` directories.

Evidence:

- `tools/aria-adapters/rust-source.test.ts:1073`
- `tools/aria-adapters/bundle-budget-adapter.test.ts:8`
- `tools/aria-adapters/doc-staleness-adapter.test.ts:8`
- `tools/aria-adapters/event-contracts-adapter.test.ts:8`
- `tools/aria-adapters/fe-dto-parity-adapter.test.ts:8`
- `tools/aria-adapters/kernel-dead-wire-adapter.test.ts:11`
- `tools/aria-adapters/lint-rules-adapter.test.ts:9`
- `tools/aria-adapters/security-boundary-adapter.test.ts:8`
- `tools/aria-adapters/tenant-scoping-adapter.test.ts:8`
- `tools/aria-adapters/test-gap-adapter.test.ts:8`
- `tools/aria-adapters/typeorm-entity-schema-adapter.test.ts:8`
- `aria-kernel/tests/test_published_text.py:17`

Found while running the aria-adapters test target for the ts-adapters cluster.
workflow-shell-safety-adapter.test.ts, sql-migration-safety-adapter.test.ts and adapter-fs.test.ts
already remove theirs on process exit. Fix direction: one shared temp-workspace helper for the
adapter tests that registers removal on exit (the three files above show the pattern), and
`addCleanup(shutil.rmtree)` in the kernel test; a lint rule or invariant that refuses mkdtempSync in
`tools/aria-adapters/*.test.ts` outside that helper makes it detectable.

Re-checked on the integrated head `dc6376f13`: each listed TS test calls mkdtempSync and has no
rmSync; test_published_text.py:17 makes `aria-published-*` with no cleanup. workflow-shell-safety,
sql-migration-safety and adapter-fs tests remove theirs.

### ARIA-MEDIUM-596 — Readiness never measures the squash commit message setting

Full title: The readiness branch-protection proof never measures the repository's squash commit
message setting, so a squash default of 'Pull request title' would drop the Aria-Operator-Request
line check 12's merged-once proof reads from main

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A signed operator request
authorizes one merged change; the single-use proof comes from a record a rollback of aria/state
cannot erase (main's merged history) — and the precondition that main receives that record must be
measured, not assumed.

Evidence:

- `aria-kernel/aria_kernel/operator_request_spend.py:81-87`
- `aria-kernel/aria_kernel/auto_merge.py:1340`
- `aria-kernel/aria_kernel/enterprise_readiness.py:576-643`
- `aria-kernel/aria_kernel/enterprise_readiness.py:632`
- `docs/runbooks/aria-github-app-setup.md:100-131`

Residual of ARIA-MEDIUM-264 (cluster operator-provenance, branch fix/aria-kb-operator-provenance).
The fix makes check 12 refuse a request main's history carries; the line reaches main through the
commit messages and the PR body, which covers GitHub's COMMIT_MESSAGES and PR_BODY squash defaults
but not BLANK. Fix direction: the branch-protection proof records GET `/repos/{owner}/{repo}`
squash_merge_commit_message and the policy refuses BLANK
(branch_protection_squash_message_must_carry_commits_or_body); the runbook names the setting. Needs
a proof schema bump and the measurement in the probe, outside this cluster's owner modules.

Re-checked on the integrated head `dc6376f13`: branch_protection_policy_reasons still measures
merge_queue_merge_method only; squash_merge_commit_message occurs nowhere in aria-kernel, tools or
docs/runbooks.

### ARIA-LOW-597 — list_human_required skips a record file it cannot read

Full title: human_required.list_human_required silently skips a HUMAN_REQUIRED record file it cannot
read or parse, so the operator inbox, the daily report and the CLI list undercount open records
instead of naming the unreadable one

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: HIGH-108 doctrine as
deadlines.read_deadlines applies it: an unreadable source is named undecided, never reported as
empty or smaller.

Evidence:

- `aria-kernel/aria_kernel/human_required.py:229-249`
- `aria-kernel/aria_kernel/human_required.py:243-244`
- `aria-kernel/aria_kernel/operator_inbox.py:45-49`

Found while fixing ARIA-MEDIUM-127 (cluster operator-provenance). Fix direction: list_human_required
returns the unreadable record ids beside the rows (or raises a named error) and every reader
surfaces them; the inbox names them in undecided.

Re-checked on the integrated head `dc6376f13`: list_human_required still continues past OSError and
JSONDecodeError; the operator inbox reads it directly.

### ARIA-LOW-598 — The ack key runbook names a revoke-key verb the CLI does not have

Full title: The ack key runbook's emergency procedure names an `aria-kernel ack revoke-key` verb the
CLI does not have, so the compromised-key quarantine step it prescribes cannot be run

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A runbook names only verbs that
exist; an operator following the emergency procedure must be able to run every step.

Evidence:

- `docs/runbooks/aria-ack-key-rotation.md:95`
- `docs/runbooks/aria-ack-key-rotation.md:107`
- `docs/runbooks/aria-ack-key-rotation.md:170`
- `aria-kernel/aria_kernel/cli.py:3125`
- `aria-kernel/aria_kernel/cli.py:3128-3191`

Found while documenting ARIA-MEDIUM-254 (cluster operator-provenance). Since that fix the HMAC key
signs only autonomous acks (no live lane), so the blast radius is small. Fix direction: either
implement revoke-key in ack_ledger/hmac_keyring with its governance row, or remove the step and the
quick-reference row and point at rotate-key --emergency; pin the runbook's verbs against the parser
in test_phase_a0_preflight.

Re-checked on the integrated head `dc6376f13`: the ack subparser registers init, scope, mint,
rotate-key, verify and list-keys only; the runbook still prescribes ack revoke-key.

### ARIA-LOW-599 — A skipped real-sandbox pin in the pytest-native half is not counted

Full title: A pytest-native test that skips as a real-sandbox pin is not counted: the sandbox-skip
accounting that refuses a skipped pin covers only the unittest half run by suite_shards, not the
pytest half the lane job runs whole

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: ARIA-MEDIUM-130's rule: a run on the
kernel lane in which a real-sandbox pin skipped is refused, not green.

Evidence:

- `scripts/ci/aria-suite-run.sh:41-43`
- `aria-kernel/tests/_helpers/suite_shards.py:63`
- `aria-kernel/tests/_helpers/suite_shards.py:210`
- `aria-kernel/aria_kernel/pytest_native_only.py:18-27`
- `aria-kernel/tests/_helpers/sandbox_pins.py:29`

Found while fixing ARIA-MEDIUM-130 on fix/aria-kb-tests-docs-runner. No pytest-native module calls a
sandbox skip today (git grep for pytest.skip with bwrap/sandbox: none), so nothing is uncounted now.
Fix direction: the lane job's pytest half fails a run whose skip reason carries SANDBOX_SKIP_MARKER
(a pytest_runtest_logreport hook enabled by an option the lane passes), or
tests/test_suite_shards.py refuses a call to tests.\_helpers.sandbox_pins outside a
unittest.TestCase subclass.

Re-checked on the integrated head `dc6376f13`: `pytest_native()` still runs python3 -m pytest -q -p
aria_kernel.pytest_native_only aria-kernel with no skip accounting; the integrator fix ad771e488
routed three unittest skips through sandbox_pins and did not touch the pytest half.

### ARIA-LOW-600 — test_watchdog_freeze.py defines a test class after its main guard

Full title: test_watchdog_freeze.py defines TheFreezeMustNotStopTheRun after its
`if __name__ == "__main__": unittest.main()` guard, so running the file as a script exits before the
run-level freeze tests exist

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A test module runs the same tests
however it is invoked; `python3 aria-kernel/tests/test_watchdog_freeze.py` silently drops 6 of 20
tests.

Evidence:

- `aria-kernel/tests/test_watchdog_freeze.py:254`
- `aria-kernel/tests/test_watchdog_freeze.py:258`

Found while fixing ARIA-LOW-506. Discovery and `python3 -m unittest tests.test_watchdog_freeze`
import the module under its own name and load every class, so the kernel lane is not affected. Fix:
move the main guard to the end of the file; a suite-wide check (AST: no top-level statement after
the `__main__` guard) would make the class detectable.

Re-checked on the integrated head `dc6376f13`: the `__main__` guard is still at :254 and class
TheFreezeMustNotStopTheRun at :258.

### ARIA-MEDIUM-601 — The BLOCKED schema rule accepts a null owner_user

Full title: The schema's BLOCKED rule checks only that owner_user and deadline keys exist, so the
daily sweep writes BLOCKED rows with owner_user null (82 rows at the next run) that no one can sign
an override for

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: CLAUDE.md Review Finding
Traceability (tracked debt carries owner + deadline); README:185 BLOCKED override signed by
owner_user

Evidence:

- `docs/reviews/_registry/findings.jsonl.schema.json:179-191`
- `tools/gates/finding-registry.ts:1414-1424`
- `docs/reviews/_registry/README.md:210`

Found while fixing ARIA-HIGH-044 (cluster gates-registry). The BLOCKED branch of the schema's allOf
uses `required: [owner_user, deadline]`, which a null value satisfies. planSweep moves every lapsed
unresolved row to BLOCKED regardless of owner_user; replaying it against the registry at
2026-10-18T07:00Z gives 82 lapsed rows with a null or blank owner_user (e.g. INFRA-MEDIUM-004,
MT-HIGH-054). The G020 design (wave2/design/G020.md step 6 and C3) proposes: the BLOCKED branch
references $defs/accountable, and the sweep reports a lapsed ownerless row as UNOWNED instead of
blocking it. That changes the sweep's output for 82 rows and the finding-state-sweep workflow, so it
needs its own decision. $defs/accountable now exists (ARIA-HIGH-044) and the write sink in
finding-registry-rows.ts would enforce the tightened rule on every mutator.

Re-checked on the integrated head `dc6376f13`: the BLOCKED branch still has only required:
[owner_user, deadline]; planSweep moves every lapsed unresolved row to BLOCKED. A plain count on the
integrated registry (deadline before 2026-10-18, unresolved, owner_user null or blank) gives 85
rows; the fixer's sweep replay at 2026-10-18T07:00Z gave 82.

### ARIA-HIGH-602 — The aria-kernel check passes PRs that change what its jobs read

Full title: The required aria-kernel check still passes on PRs that change what its jobs read at run
time: suite tests read product code and other files outside the kernel surface, and the
whole-checkout lane steps (discovery run, acceptance harness, tools/aria-poc drift bound) sit in
jobs the surface decision skips

HIGH, owner Okan-wqm (agent claude), deadline 2026-10-31. Rule: A required check that may skip its
jobs must run them on every PR that changes their inputs (ARIA-HIGH-530 rule, residual)

Evidence:

- `aria-kernel/tests/test_typeorm_adapter_integration.py:31-72`
- `tools/aria-poc/invariants/test_find_drifts_real_repo_bounded.py:36-53`
- `.github/workflows/aria-kernel.yml:222-224`
- `.github/workflows/aria-kernel.yml:264-266`
- `.github/workflows/aria-kernel.yml:293-295`
- `.github/manifests/aria-kernel-surface.json`
- `aria-kernel/tests/test_kernel_surface.py:29`

Residual of ARIA-HIGH-530 (cluster gates-registry). The fix there made the kernel PR surface one
manifest that every reader uses (workflow, pre-push selector, kernel helper, jest spec), widened it
to the workflow-level inputs (agents, acceptance, actions, workflows, npm manifests, ARIA config),
removed the kernel test that read the finding registry, and added
aria-kernel/tests/test_kernel_surface.py, which fails when a gated job reads a workflow-level input
outside the surface. Not done, per the G001 design
(/var/aqua-kampanya-ciktilari/aria-zai-takeover-2026-10-14/wave2/design/G001.md S3 and S5): (S3) a
Python read tracer installed in the suite/lane/state jobs whose verify step fails on a tracked read
outside the surface; its acceptance is the first traced CI run, which needs a pushed PR; (S5) an
always-run `workspace` job that takes the whole-checkout checks (discovery run, acceptance harness,
tools/aria-poc invariants, a declared READS_LIVE_CHECKOUT partition of the suite) out of the
skippable jobs, plus `workspace` in main-required-status-checks.json requires_jobs. Both change CI
topology and can only be validated by a CI run.

Re-checked on the integrated head `dc6376f13`: `apps/**` is still absent from the surface manifest,
and the lane job (discovery run, integrity, acceptance harness) is still gated on
needs.changes.outputs.kernel.

### ARIA-LOW-603 — Six specs and one script still parse services.yaml privately

Full title: Six invariant specs and one smoke script still read infrastructure/nats/services.yaml
with private parsers, and request-reply-contract-acl keeps a private NATS matcher, beside the shared
reader tools/gates/nats-services.ts

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: One shared reader of services.yaml,
not per-tool copies, so a format change cannot leave one consumer behind (ARIA-MEDIUM-314 rule)

Evidence:

- `tests/invariants/request-reply-contract-acl.spec.ts:53`
- `tests/invariants/request-reply-contract-acl.spec.ts:78`
- `tests/invariants/error-capture-ingress.spec.ts:67`
- `tests/invariants/farm-ai-query-contract-ssot.spec.ts:68`
- `tests/invariants/admin-billing-runtime-contract.spec.ts:83`
- `tests/invariants/tenant-provisioning-ssot.spec.ts:378`
- `tests/invariants/platform-capability-coverage.spec.ts:154`
- `scripts/nats/messaging-acl-smoke.mjs:71`
- `tools/gates/nats-services.spec.ts`

Found while fixing ARIA-MEDIUM-314 (cluster gates-registry). The fix created
tools/gates/nats-services.ts (schema-validated read, NATS matcher, event subject rule, ACL ripple)
and moved the plan-coverage witness, ripple-tracer and tools/scripts/nats-boot-path-acl-smoke.ts
onto it; its spec pins that no file under tools/ other than the module names the services.yaml path.
The invariant specs above and scripts/nats/messaging-acl-smoke.mjs (an .mjs that cannot import the
.ts module without a loader) were not migrated: G044 design M3/X11/X12
(/var/aqua-kampanya-ciktilari/aria-zai-takeover-2026-10-14/wave2/design/G044.md) lists them, widens
the pin to tests/invariants, and deliberately tightens platform-capability-coverage to
admin_api_service's own grants. The e2e oracles (nats-invariants.spec.ts,
nats-subject-contract.spec.ts) keep their matcher by design.

Re-checked on the integrated head `dc6376f13`: each listed file still reads
infrastructure/nats/services.yaml itself; none imports tools/gates/nats-services.ts.

### SENSOR-MEDIUM-189 — Automation events publish on type-first subjects outside their grant

Full title: sensor-service publishes its four automation events on type-first subjects
(`events.<Type>.<tenant>`) while services.yaml grants `events.*.<Type>` and gateway-api subscribes
`events.<Type>.>`, so the publishes fall outside the grant and the gateway's filters overlap every
`events.*.<T>` subject

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: One event subject grammar
(`events.<tenant>.<Type>`, built by the event bus) for every publisher and subscriber; services.yaml
grants must admit the subjects actually published (ADR-015)

Evidence:

- `apps/sensor-service/src/automation/compiler/compiler.constants.ts:106-128`
- `apps/sensor-service/src/automation/events/automation-events.publisher.ts:56-60`
- `apps/sensor-service/src/automation/events/automation-events.publisher.ts:98`
- `apps/sensor-service/src/automation/events/automation-events.publisher.ts:133`
- `apps/sensor-service/src/automation/events/automation-events.publisher.ts:164`
- `infrastructure/nats/services.yaml:208-211`
- `apps/gateway-api/src/websocket/st-language-bridge.service.ts:172-195`
- `platform/libs/event-bus/src/nats/event-route-registry.ts`

Found while fixing ARIA-HIGH-313 (cluster gates-registry). The code-derived event-consumer closure
(tools/gates/event-consumer-index.ts) reads the gateway's four subscriptions as subjects; under NATS
rules `events.AutomationProgramSaved.>` overlaps `events.*.<T>` for every event type T (tenant token
`=` AutomationProgramSaved), so the plan-coverage witness and ripple-tracer list gateway-api as a
consumer of every event (live: --event UserInvited gives notification-service and gateway-api). That
is broker-true but caused by the type-first grammar. Not verified at runtime: whether
NatsEventBus.publishTo rewrites the subject (normalizeSubject) before publishing, and whether the
broker currently refuses these publishes. Fix direction: publish through the bus's event-type API
(createBaseEvent + publish) and subscribe with buildWildcardEventSubject in the gateway, so both
sides use `events.<tenant>.<Type>`; then the gateway's sites fold to event types and the over-match
disappears.

Re-checked on the integrated head `dc6376f13`: buildEventSubject still appends the tenant after
`events.<Type>`, services.yaml still grants `events.*.<Type>`, and the gateway still subscribes
`events.<Type>.>`. Registered under SENSOR, not ARIA: the defect is in sensor-service, gateway-api
and services.yaml; ARIA's consumer index only reports it.

### ARIA-LOW-604 — 17 registry rows name an owner no CODEOWNERS handle resolves

Full title: 17 registry rows still name an owner_user no CODEOWNERS handle resolves (an email on 15
rows incl. open ADMIN-CRITICAL-087, two role names); mapping them to a person is the operator's
identity decision

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: owner_user is the CODEOWNERS handle
accountable for the finding (registry README Owner identity, ARIA-MEDIUM-535); tracked debt carries
an accountable owner

Evidence:

- `tools/gates/finding-registry-owners.ts:40-43`
- `docs/reviews/_registry/findings.jsonl:1783`
- `docs/reviews/_registry/findings.jsonl:300`
- `docs/reviews/_registry/findings.jsonl:2109`
- `tests/invariants/finding-registry-integrity.spec.ts:164-173`

Residual of ARIA-MEDIUM-535 (cluster gates-registry). The fix made canonicalOwner the one identity
rule, made add/assign/the write sink store or refuse by it, and rewrote the provable spellings
(okan, @okan-wqm, Okan-Wqm: 1359 rows) to Okan-wqm with `finding-registry canonicalize-owner`. Not
rewritten: `by-okan@live.com` (no git authorship links that address to the Okan-wqm account; the
rows came in through ee92a9e9e and ac1774154) and the role names claude-session and farm-module
maintainer (no person). The operator states the identity per spelling:

```sh
npx ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry.ts canonicalize-owner 'by-okan@live.com' --to=<handle> --reason=<why>
```

(same for the two role names, or `assign`-style clearing if no person owns them, which needs a verb
that clears an owner), then removes the spelling from LEGACY_OWNER_SPELLINGS in the same change; the
invariant fails if a removed spelling still occurs or a listed one no longer does.

Re-checked on the integrated head `dc6376f13`: the integrated registry holds owner_user
`by-okan@live.com` on 15 rows (7 OPEN, ADMIN-CRITICAL-087 among them), claude-session on
AUDIT-CRITICAL-006 and farm-module maintainer on FARM-LOW-330. The canonicalize-owner run for okan,
@okan-wqm and Okan-Wqm is not committed on this branch yet (integrator stop condition).

### ARIA-LOW-605 — No kernel path moves an ARIA debt to OVERDUE

Full title: No kernel path transitions an ARIA debt to OVERDUE, and the debt store has no transition
model at all: every status after OPEN is a hand edit of a committed `aria-debts/*.json` that the
kernel's event ledger never sees

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: CONTRACTS.md debt lifecycle: a debt
past its deadline grows louder, never quieter; the kernel enforces the state machine

Evidence:

- `docs/aria/CONTRACTS.md:1132-1144`
- `aria-kernel/aria_kernel/debt.py:48`
- `aria-kernel/aria_kernel/debt.py:307`
- `aria-kernel/aria_kernel/debt.py:354-358`
- `aria-kernel/aria_kernel/debt.py:176-178`
- `aria-debts/DEBT-2026-05-07-001.json:30`
- `aria-kernel/aria_kernel/reflection.py:458`
- `aria-kernel/aria_kernel/cycle_guard.py:279`

Split out of ARIA-LOW-405 (cluster gates-registry), whose other five residuals (migration helper
schema/enum/vocabulary/INVALID-index and the pair invariant's blind spots) were fixed. Not fixed
here because it needs a design decision, not a writer: (1) which store is the debt SSoT — the
committed `aria-debts/*.json` (git, edited by commits, no ledger) or the hash-chained
debt-events.jsonl under repo_state_root (the ARIA state store in production, which holds zero
debts); (2) a transition event and replay for every status (none exists for IN_PROGRESS, RESOLVED,
WITHDRAWN either), with one unresolved-debt predicate (OPEN, IN_PROGRESS, OVERDUE) for
reflection.py, cycle_guard.py and surface_manifest_validator.py so an OVERDUE row does not leave the
open count; (3) which lane runs the date-driven transition (it writes the ARIA store; ARIA is
paused), and whether it conflicts with CONTRACTS' 'no state change without operator action or
fix-shipped event'. A writer added before (1) would either bypass the ledger by editing committed
JSON or act on an empty production store.

Re-checked on the integrated head `dc6376f13`: debt.py still has debt_emitted as its only event and
replay; DEBT-2026-05-07-001 is IN_PROGRESS past its 2026-07-06 due date. This is the residual
c1ac0822b (ARIA-LOW-405) names as not done.

### ARIA-MEDIUM-606 — A GitHub issue mission can carry no citable evidence

Full title: A GitHub issue mission can carry no citable evidence: the gateway keeps only the issue
body's digest and opens the mission with no refs, so the scheduler skips it as unevidenced and the
plan synthesizer refuses it plan_evidence_inadmissible; the aria-labelled issue lane plans nothing

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Every source the synthesizer scans
can produce a plan (ARIA-MEDIUM-249); a mission carries the evidence its opening contract names
(ARIA-HIGH-245)

Evidence:

- `aria-kernel/aria_kernel/gateway/normalize.py:69`
- `aria-kernel/aria_kernel/gateway/router.py:113-125`
- `aria-kernel/aria_kernel/mission_dispatch.py:114-137`
- `aria-kernel/aria_kernel/plan_synthesizer.py:1538-1545`
- `aria-kernel/aria_kernel/plan_synthesizer.py:1578-1579`

Found while fixing ARIA-MEDIUM-249 part 2 in cluster kernel-misc. The conversion side is fixed (an
issue mission holding citable refs converts); what is missing is the producer side, and it needs a
decision: which issue text may become evidence (repo paths cited in the untrusted body, validated by
the agent law and existence at the checkout) given one-way door 14 keeps only the body digest. Until
then the issue lane is disclosed (scheduler skip row, conversion skip row) but never planned.

Re-checked on the integrated head `dc6376f13`: router.py still opens every issue mission with
`evidence_refs=()` (the 7da9b18eb comment says so). ARIA-HIGH-245, closed on this branch by
7da9b18eb, named github-issue missions in its title; this row carries the issue-mission part.

### ARIA-LOW-607 — ORPHAN rows filed against other review files reach no plan source

Full title: ORPHAN findings registered against a review file other than orphan-findings.md are
scanned by no plan source (31 OPEN rows on the integrated head)

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Every OPEN finding has a plan source
that can reach it, and a plan's Closes: trailer names the finding's own review file

Evidence:

- `aria-kernel/aria_kernel/plan_synthesizer.py:563-634`
- `aria-kernel/aria_kernel/plan_synthesizer.py:613`
- `aria-kernel/aria_kernel/plan_origin.py:87`
- `aria-kernel/aria_kernel/plan_origin.py:156`

Found while fixing ARIA-MEDIUM-249 in cluster kernel-misc. Fix direction: plan_origin derives the
trailer from the registry row's review_file (one owner), and scan_orphan_findings drops the
review_file filter.

Re-checked on the integrated head `dc6376f13`: scan_orphan_findings still skips rows whose
review_file is not docs/reviews/orphan-findings.md; the integrated registry holds 49 OPEN ORPHAN
rows, 18 against orphan-findings.md and 31 against other review files.

### ARIA-LOW-608 — Judge calibration ignores the labels' inclusion probability

Full title: Judge calibration does not weight human labels by the inclusion probability the label
queue now records, so precision across strata stays unweighted

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: An estimate built from a stratified
sample weights each label by the inverse of its inclusion probability (Horvitz-Thompson), or it is
biased toward the over-sampled strata

Evidence:

- `aria-kernel/aria_kernel/label_queue.py:163`
- `aria-kernel/aria_kernel/feedback_store.py:799`
- `aria-kernel/aria_kernel/judge_calibration.py:96-125`

Found while fixing ARIA-MEDIUM-276 in cluster kernel-misc; the finding's rule (labels collected
blind with the probability recorded) is met, the consumer that would use the weight is not changed.

Re-checked on the integrated head `dc6376f13`: judge_calibration reads label_provenance.stratum
only; nothing reads inclusion_probability.

### ARIA-MEDIUM-609 — A sandbox process can forge PostToolUse requests to the hook broker

Full title: Any process in the agent's sandbox can forge PostToolUse requests to the hook broker:
ten forged MCP failures quarantine the kernel's own MCP server store-wide until an operator releases
it, and forged post-tool and session requests add work-journal, MCP-call and handoff rows without
bound

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A privileged interface from the
sandbox lets the agent affect only its own request (hook_broker.py module docstring); a decision
that outlives the spawn (an MCP quarantine) is taken only from outcomes the kernel witnessed

Evidence:

- `aria-kernel/aria_kernel/hooks.py:436-447`
- `aria-kernel/aria_kernel/mcp_client.py:268-293`
- `aria-kernel/aria_kernel/mcp_client.py:296-317`
- `aria-kernel/aria_kernel/mcp_client.py:46-48`
- `aria-kernel/aria_kernel/mcp_client.py:320-330`
- `aria-kernel/aria_kernel/data/mcp_registry.json:6`
- `aria-kernel/aria_kernel/mcp_server.py:345-355`

Found by the adversarial review of the hook broker (ARIA-MEDIUM-131, cluster kernel-misc). The hook
client and an agent's Bash run as the same user in the same sandbox, so no secret can tell them
apart: the post-tool payload is agent-attested. Fix direction: quarantine a kernel_socket server
from the kernel's own `side=server` outcomes only, and decide what witness (if any) may quarantine a
server the kernel does not serve (none is registered today); bound unblockable verbs per broker
(e.g. post-tool requests by the decisions the broker made plus the read-only tools' calls). Needs a
design decision on the 032g quarantine semantics, so it was filed, not fixed.

Re-checked on the integrated head `dc6376f13`: hooks.py and mcp_client.py are unchanged since
fix/aria-kb-kernel-misc (git diff empty); the post-tool verb still records MCP outcomes from the
agent-attested payload.

### ARIA-LOW-610 — The judge-batch lane claims without the pre-claim environment gate

Full title: The judge-batch lane claims K requests after its native admission without asking the
pre-claim environment gate, so a workspace whose git cannot answer burns K claims and rejects every
result as verification_unavailable

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Root CLAUDE.md single-owner rule /
FAZ 5b: environment faults must be refused before the claim, not priced on the request

Evidence:

- `tools/aria-poc/ci_executor_judge_batch.py:254`
- `tools/aria-poc/ci_executor_judge_batch.py:274`
- `tools/aria-poc/ci_executor.py:4595`
- `tools/aria-poc/ci_executor.py:4494`

Found while fixing ARIA-MEDIUM-564 (cluster wave-a-followups). The batch lane runs HTTP-only Z.ai
judges, so of the gate's host checks only git availability is load-bearing for it; the room and
node_modules checks are not. Fix shape for the owner: the batch asks the same gate (one owner)
before its first claim and settles every member by name when it refuses, or the gate grows a
lane-aware entry the batch calls. Not reproduced; reasoned from the code order on
fix/aria-kb-wave-a-followups (base 606169730).

Re-checked on the integrated head `dc6376f13`: ci_executor_judge_batch.py still goes from
`_admit_native_route` to `_claim_request_via_cli` with no `_pre_claim_environment_gate` call.

### ARIA-LOW-611 — Every declared-ledger append parses the whole file twice

Full title: Every declared-ledger append reads and parses the whole file twice under its lock (once
to verify the chain, once more only for the tail hash), plus a third raw read to look for a torn
tail

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: ARIA-HIGH-237's own stated cost model
(one full-chain verification per batch); the tail hash is a by-product of the verification that
already ran on the same bytes under the same lock

Evidence:

- `aria-kernel/aria_kernel/ledger.py:1375`
- `aria-kernel/aria_kernel/ledger.py:1379`
- `aria-kernel/aria_kernel/ledger.py:1380`
- `aria-kernel/aria_kernel/ledger.py:1311`
- `aria-kernel/aria_kernel/ledger.py:1754`
- `aria-kernel/aria_kernel/ledger.py:1906`

Found while fixing ARIA-LOW-566 (cluster wave-a-followups, branch fix/aria-kb-wave-a-followups).
ARIA-LOW-566 batched the lease reaper's governance rows into one append per sweep
(append_tools_governance_rows), which removes the per-claim multiplication; it deliberately did not
change the append body, a hot path of every declared ledger. On governance.jsonl (25.9 MB, 29,056
rows on aria/state) the second json parse is roughly a third of each append's cost. Fix shape for
the ledger owner: read the file once under the lock, verify that text (strict surfaces), take the
torn-tail length and the tail hash from the same text, truncate the torn tail, and keep the
non-strict surfaces' full parse (it is their only malformed-row check); preserve the io_error `->`
declared_jsonl_refuses_append_to_corrupt_chain mapping. The 'verified tail checkpoint' alternative
named in ARIA-LOW-566 (skipping the full verification per append) changes ARIA-HIGH-237's trust
model and needs an operator/arbiter decision; it is not this stub.

Re-checked on the integrated head `dc6376f13`: the append body still verifies (:1375), heals the
torn tail (:1379) and re-reads every row for the tail hash (:1380).

### ARIA-MEDIUM-612 — Router-emitted skill-genesis requests are never consumed

Full title: Router-emitted skill-genesis requests are non-convergent and no automatic consumer reads
them, while existing_genesis_request_keys blocks a second request for the same gap, so a skill gap
the learning router names never closes

MEDIUM, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: A request a kernel producer emits
has a consumer that can move it to a terminal status; a gap the router names is either worked or
surfaced, never parked silently.

Evidence:

- `aria-kernel/aria_kernel/learning.py:439-443`
- `aria-kernel/aria_kernel/skill_genesis.py:70-75`
- `aria-kernel/aria_kernel/skill_genesis_drainer.py:199-202`
- `aria-kernel/aria_kernel/agent_genesis.py:1094`
- `aria-kernel/aria_kernel/learning.py:365`

Split from ARIA-MEDIUM-507 (b-invocations-genesis, 2026-10-17). 507's other half, the convergent
dispatchers reading the store from an evidence_pack key nothing writes, is fixed on
fix/aria-kb-invocations-genesis (store bound at the producer). This half needs a design decision the
finding listed as alternatives: (1) give non-convergent rows an automatic consumer, (2) route
skill_gap/unobserved_surface to a convergent request with a derived seed (the router has no
calibration corpus for a new gap, and `convergent=True` requires one), or (3) stop emitting them and
surface the gap to the operator instead. Each changes ARIA's spend or its operator surface; G010-B
(design) treats these rows as costing nothing and owns no consumer. Only the operator's manual
`skill-genesis draft --request-id` reads them today.

Re-checked on the integrated head `dc6376f13`: learning.py still calls request_skill_genesis with no
convergent flag; the drainer still skips non-convergent rows. ARIA-MEDIUM-507, closed on this branch
by 7b7ab5c7d for the store binding, named both halves; this row carries the second.

### ARIA-LOW-613 — An unbound plan spends its whole convergence before it is parked

Full title: Under merge-class authority a plan started outside the provider still spends its whole
convergence (planner, challenger, cross-review rounds) before the delivery door parks it as unbound

LOW, owner Okan-wqm (agent claude), deadline 2026-11-14. Rule: Refuse work by name before it spends
anything when the refusal is already decidable (ARIA-HIGH-529's planned fix: 'refuses an unbound
plan by name before it spends anything').

Evidence:

- `aria-kernel/aria_kernel/cli.py:5334`
- `aria-kernel/aria_kernel/cross_review_bridge.py:805`
- `aria-kernel/aria_kernel/converged_delivery.py:368-375`
- `aria-kernel/aria_kernel/operator_feedback_observation.py:149-163`

Residual of ARIA-HIGH-529 (fixed on fix/aria-kb-invocations-genesis at the implementation mint,
which is what the registry row's bucket names). The binding answer is fixed at plan start, so under
a profile holding pr_merge the convergence drainer could refuse to drive an unbound plan (or
start_plan could record the refusal) instead of planning it to CONVERGED and parking it. Needs a
decision: an operator's `plan start` under autonomous is an explicit act, and refusing it at start
changes the operator surface. V7-fallback plans do not arise under merge-class profiles
(plan_source.py:348-360 raises instead), so the live cases are CLI plan start and skill authoring.

Re-checked on the integrated head `dc6376f13`: plan start still calls start_plan with no synthesis
binding; the binding refusal is asked only at the implementation mint and the delivery door.

### ARIA-HIGH-614 — Five kernel envelopes have an allowed_scope no repository ref matches

Full title: Kernel envelopes whose allowed_scope no repository ref can match: the verification
(decision questioning), post-implementation adversarial review, specialist fallback and genesis
drafter/judge envelopes can only be answered with refs the submit law refuses

HIGH, owner Okan-wqm (agent claude), deadline 2026-10-31. Rule: What the submit law refuses, the
mint refuses (ARIA-HIGH-384 / ARIA-MEDIUM-385): an envelope must leave its agent at least one ref it
can cite and have admitted, or it buys only a refused answer.

Evidence:

- `aria-kernel/aria_kernel/decision_questioning.py:287`
- `aria-kernel/aria_kernel/review_runner.py:300`
- `aria-kernel/aria_kernel/specialist_review_runner.py:526`
- `aria-kernel/aria_kernel/dispatcher_factory.py:174`
- `aria-kernel/aria_kernel/dispatcher_factory.py:246`
- `aria-kernel/aria_kernel/evidence_validator.py:787-932`
- `aria-kernel/aria_kernel/evidence_validator.py:921`

Found while fixing ARIA-MEDIUM-385 on fix/aria-kb-invocations-genesis, which moved the non-repo
pointers these envelopes carried (plan:, cycle:, seed:, round:, sandbox_result:) to their own fields
and made the mint refuse such refs for every role. That removes the pointer the agent used to cite,
but the scope of each envelope is a non-repository glob, so any repository file:line the agent cites
instead is outside_allowed_scope. The verification lane is live (3 paid runs rejected 2026-10-15/16;
cycle phase decision_questioning). Fix needs a decision per envelope on what the agent may cite: the
plan's own evidence_refs and affected surface (decision questioning, Gate B, specialist;
plan_round_contract / `_specialist_plan_context` already derive them for planning and specialist
review), and the evidence pack's observations for the genesis drafters. Not fixed in 385 because it
changes what each envelope asks, beyond moving its pointer.

Re-checked on the integrated head `dc6376f13`: the five envelopes still set a non-repository
allowed_scope (`plan-convergence/<id>`, `cycle/<id>`, `convergent/<seed>`), and
validate_agent_response_evidence still refuses a ref outside it.

### ARIA-LOW-615 — The changed-file type check drops declarations a tsconfig includes from elsewhere

Full title: The changed-file type check carries only the .d.ts files inside a project's directory,
so a declaration the project's tsconfig includes from elsewhere is dropped and the pre-push check
type-checks a different program than tsc -p.

- Evidence: `scripts/ci/type-check-changed-files.mjs` `declarationFilesFor` walked only the project
  directory, while `tools/aria-adapters/tsconfig.json:14` (and `tools/gates/tsconfig.json`) include
  `tests/invariants/js-yaml.d.ts`.
- Found when pushing the wave-B integration. `tsc -p tools/aria-adapters/tsconfig.json` passed. The
  pre-push check failed with TS7016 for `js-yaml` at
  `tools/aria-adapters/workflow-shell-safety-adapter.ts:68` and
  `tools/gates/workflow-input-injection.ts:40`.
- Fixed on `fix/aria-known-issues-wave-b`: `declarationFilesFor` also carries every `.d.ts` in the
  project's parsed file list (`ts.getParsedCommandLineOfConfigFile`). A tsconfig that cannot be read
  fails loudly.

### ARIA-MEDIUM-616 — Fixture git inherited the hook's GIT_DIR and wrote into the developer's repository

Full title: A spec that runs git in a fixture inherits the hook's GIT*DIR, so from a worktree's
pre-push it committed, branched and checked out in the developer's repository; eleven suites each
kept their own copy of the GIT*\* filter and the twelfth forgot it.

- Incident, 2026-10-18, pushing `fix/aria-known-issues-wave-b` from its worktree:
  - The pre-push hook ran `aria-doc-runtime-ssot.spec.ts`, whose kernel-surface test built its
    fixture git env as `{ ...process.env, ... }`.
  - git hands a linked worktree's pre-push hook an absolute `GIT_DIR`. This was measured in a
    scratch repository; a main checkout gets none.
  - The fixture's `git commit -m base` landed on the branch being pushed as `a2d8093ee`, whose tree
    was the fixture's two files. `checkout -b pr` created a branch, and `checkout main` moved the
    worktree.
  - Nothing reached the remote, because the next fixture commit failed inside the hook.
  - Recovered with the operator's approval: `update-ref` back to `a7b1f1c57`, `symbolic-ref HEAD`,
    `reset --mixed`, and `branch -D pr`.
- Root cause: no owner for "git against a fixture". Eleven suites dropped `GIT_*` with their own
  copy of the filter; the new one did not.
- Fix:
  - `tools/gates/hermetic-git.ts` (`hermeticGitEnv`) is the one place the filter is spelled. All
    eleven copies and the spec now use it.
  - `tests/invariants/hermetic-git-env-ssot.spec.ts` fails if the filter is spelled anywhere else.
  - `.husky/pre-push` unsets `GIT_DIR` and its siblings before it runs anything. The hook still
    resolves its own worktree and branch afterwards; this was measured.
  - The pre-commit hook keeps `GIT_INDEX_FILE` on purpose, because its staged-content checks read
    it.

## ARIA-MEDIUM-563 — fixed (provider gateway)

Branch `fix/aria-563-provider-gateway`, five commits on `5d886865a`, then merged with
`fix/aria-known-issues-wave-b` (`08da1a565`) in the merge commit `02ad81e36`, then with
`origin/main` (`ce65e1e34`, which carries wave B as `be662681f`) in `700333e92`. This closes 563 for
the Claude room (the anthropic gateway route). The Codex room keeps the same defect class and is
registered as ARIA-MEDIUM-621. Each commit body carries the full account and its proof.

What changed:

- `bd8f3d3f4`: a room reaches a provider only through a kernel gateway that holds the kernel's
  credential.
  - `aria_kernel/provider_routes.py` is the one table of how each provider is reached, and the only
    place a provider host is named. anthropic is a gateway route; openai is a tunnel route (the
    Codex room only, OpenAI hosts only); zai is a kernel transport that no room reaches.
    `egress_proxy.PROVIDER_ENDPOINTS` is deleted, and `platform.claude.com` and `api.z.ai` leave
    every room.
  - `aria_kernel/provider_gateway.py` (stdlib) serves the anthropic route on a unix socket. It pins
    `POST /v1/messages` and `/v1/messages/count_tokens` and refuses everything else by name. It also
    refuses provider-side fetches (`mcp_servers`, `container`, server tools, url/file sources, file
    ids). It drops every room credential and injects the kernel's.
  - `aria_kernel/provider_credentials.py` is the one reader of kernel-held provider credentials.
    Anthropic's credential is a `claude setup-token` token in `ARIA_CLAUDE_OAUTH_TOKEN_FILE`.
  - The managed Claude room gets the gateway socket and a placeholder credential. It gets no login
    file, no CONNECT socket and no relay, and keeps `--unshare-net`. `agent_env` passes no login and
    no token to any spawn.
  - The preflight, the native admission, both workflows and `provision_runner.sh` read the kernel's
    credential boundary (`claude_gateway_credential_absent`), not the host login.
- `a67330a81`: `provider_credentials.read_secret_file` is the one credential-file reader. It refuses
  a file under the checkout, under every host root a room binds (`room_host_roots()`, the room
  builder's own tuple), and under the caller's trees. It also refuses symlinks, foreign owners,
  group/other bits, oversize files and multi-line content. `jev_runtime` reads through it.
- `6b45b74c1`: the gateway forwards only bytes it validated.
  - It refuses C0 controls in the request line and in header names and values (tab allowed in
    values).
  - It refuses a body that is not UTF-8, that has a duplicate key or that has NaN, and forwards its
    own serialization of the checked document.
  - It answers a missing kernel token as 401 `authentication_error`, not 503.
- `ea2aa5002`: the API-key refusal message names `claude setup-token` in plain quotes, so the CI
  step no longer runs it. A hygiene invariant scans every workflow and action for an unescaped
  backtick inside double quotes.
- `756bb13c9`: the executor contract, CURRENT_STATE §Runtime, the ARCHITECTURE sequence and ADR-040
  describe the kernel token behind the gateway, and `aria-doc-runtime-ssot.spec.ts` pins it.

Landing round (takeover, 2026-10-18) — three commits on `700333e92`:

- `349f2d5b7` (`test(aria)`): the egress probe's `gateway` socket line carries its
  `# allowlist-external-network:<reason>` opt-out, the one probe line its four siblings' review
  comment was missing. The no-external-network scanner had failed the suite's shard 5 on the
  merged tree (measured in the live run: `banned token 'socket.socket('`, failures=1); the
  comment-only edit keeps every shard report's `suite_digest` valid, so only shard 5 re-ran.
- `49166f040` (`fix(aria)`, closes ARIA-MEDIUM-620): the `anthropic_api_key` row's detect regex
  admits `_` exactly as its redact regex always has, and the row's fixture becomes a setup-token
  body with an underscore inside the first 32 characters, so the table's constructor contract
  proves the widened class. Red first at the real entry (`SecretLeakDetected not raised` for
  `sk-ant-oat01-Ab3_Q…` in `verify_no_secret_in_diff`) and at the table contract
  (`detect_misses_fixture`).
- `9c4d1f251` (`chore(aria)`): the refusal view's PEM and bearer rows widen to their own redact
  shapes — any `[A-Z ]*PRIVATE KEY` armour label (ENCRYPTED and plain pkcs8 included) and the
  case-insensitive scheme with the standard-base64 alphabet. Red first at both real entries (four
  `SecretLeakDetected not raised` cases). This defect had no registered row and this lane may not
  run `findings:add`, so the commit carries no `Closes:` trailer (the PROC-LOW-053 interim form);
  the stub `s2-refuseview-pem-bearer-1.json` records it for the next registry-owning lane, and
  both secret-scrub widenings land strictly before any §8 token mint.

Proofs:

- Red at base `5d886865a`, measured with real bwrap:
  - The managed Claude room held `/tmp/aria-agent-home/.claude/.credentials.json`.
  - The handed `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` reached the room's env.
  - CONNECT to `api.anthropic.com`, `platform.claude.com`, `api.z.ai` and `api.openai.com` answered
    `200 Connection Established`.
  - The new tests failed on the base tree: ImportError for the gateway and credentials modules,
    seven stray host literals, the agent_env pins, the preflight pins and the `provider=` room pins.
- Offline real-CLI proof through the production gateway, as uid 1000, with only the gateway's
  credential (a fixture) and its upstream (a fake Messages API on loopback) swapped:
  - CLI 2.1.278 in the production managed room returned result `ok`.
  - The upstream saw one `POST /v1/messages?beta=true` with the kernel's credential and the oauth
    beta, and no `x-api-key`, room key or placeholder.
  - With no token configured, the CLI exits 1 after 2.6 s with
    `401 gateway_refused:provider_credential_unavailable:credential_not_configured`.
    `extract_auth_failure` names that `claude_auth_failure`, with the re-mint remedy.
  - On the production listeners with nothing swapped, the in-room probe is refused by name on
    CONNECT, `/v1/files`, `mcp_servers` and url sources. A direct connect is `ENETUNREACH`, and
    `egress_boundary_probe()` is `None`.
- Security review: one blocker and two majors, each reproduced before it was fixed.
  - Blocker: bare LF/CR in a header line, an LF after a header name, and a smuggled second request
    reached the upstream head next to the kernel's credential. Fixed in `6b45b74c1`; the reviewer's
    probe is now refused with `head_control_character`.
  - Major: the body was checked after a last-key-wins parse, but the original bytes were forwarded,
    so a duplicate `tools` key hid a server tool. Fixed in `6b45b74c1` with `body_duplicate_key`,
    `body_not_utf8` and forwarding of the checked document.
  - Major: the workflows ran `claude setup-token` through backticks in their error message,
    reproduced with a fake `claude` on PATH. Fixed in `ea2aa5002`.
  - Regression review majors: stale runtime docs were fixed in `756bb13c9`. `Closes:` landed while
    the Codex route stays open and the residuals had no ids; they are registered below
    (ARIA-MEDIUM-620 to ARIA-LOW-625).
  - Review minors fixed: the 503 now answers 401 (`6b45b74c1`); the system roots and jev's second
    reader are fixed in `a67330a81`.
- Merge onto wave B (`02ad81e36`):
  - Wave B's ARIA-LOW-565 (`3e1176b24`) made `socket_holders` the one owner of the killed-holder
    sweep. A `SocketHolder` now declares a fixed set of socket names. `EGRESS_PROXY`'s set is
    `provider_routes.ROOM_ROUTE_KEYS`, so the gateway's `anthropic` socket joins it, and there is no
    second sweep.
  - The updated `test_socket_holders` failed 7 cases against wave B's owner and passes on the merge.
  - `44f05589e` wraps the two over-long doc lines that 563 itself wrote (the changed-docs lint).
  - Merge with `origin/main` (`700333e92`): no conflicts. Main now runs the kernel suite as ten
    shards (`6149faad0`).
  - Checks on `700333e92` plus the registry rows below:
    - the full kernel suite as CI runs it, run once over the ten shards at `700333e92` and shard 5
      alone re-run at the final tree after `349f2d5b7` (a comment-only edit keeps every other
      shard's `suite_digest` — module names and counts — identical, re-measured before the re-run):
      shards 1-4 and 6-10 green at `700333e92` (71-242 modules, 742-1915 tests each); shard 5 red
      at `700333e92` on exactly the missing egress opt-out (failures=1), green at the final tree
      (918 tests, 26.8 min, 0 sandbox-pin skips, `suite_digest` unchanged); the pytest-native
      half: 76 passed, 9854 deselected (both trees);
      `suite_shards.py verify` at the final tree: ten shards, 893 modules, 9854 tests, exit 0;
    - under real bwrap, `test_sandbox_egress_boundary` and `test_egress_proxy` with no sandbox skip
      (in the shard-5 runs above);
    - the changed modules' owner runs at the final tree: the full v9 implementation-safety module,
      `test_credential_shapes_single_owner`, `test_secret_scrub_policy`,
      `test_scrub_credentials_not_counters`, `test_transcript_scrub`,
      `test_redact_view_covers_every_view`, the v8 prerequisite and safety/telemetry modules
      (181 tests), `test_provider_gateway`, `test_implementation_delivery`,
      `test_published_text`, `test_real_mode_env_guard` and `test_fixture_runner_crash_stderr`
      (64 tests), all green;
    - the 31 invariant jest specs that pin the workflows and docs (334 tests) at `700333e92`, and
      at the final tree, date-stamped: `aria-doc-runtime-ssot` 29 passed and the registry project
      587 passed (jest, the exact project configs; local TS runs are unverified — this worktree's
      `node_modules` symlinks to aria-repair-1's, CI is the authority),
      `type-check-changed-files` 1 project passed; `markdownlint-changed` 0 billed lines, logged in
      the PR body.

What is NOT done:

- The live model call through the real room waits on the operator. The kernel token file
  `/home/gharunner/.config/aria/claude_oauth_token` does not exist; minting it with
  `sudo -u gharunner -i claude setup-token` is an identity act. This is an operator action, not a
  code defect, so it has no finding id. The steps are in `docs/runbooks/aria-runner-rebuild.md`
  Step 4.
- The Codex route keeps the ChatGPT login and an opaque OpenAI tunnel: ARIA-MEDIUM-621.
- The refusal view's `sk-ant` underscore gap (ARIA-MEDIUM-620) is fixed in this PR by
  `49166f040`; the row is closed by finding-closure-reconcile from that commit's `Closes:`
  trailer. The refusal view's PEM/bearer widening (`9c4d1f251`) has no registered row yet: stub
  `s2-refuseview-pem-bearer-1.json`, for the next registry-owning lane.
- The gateway has no per-spawn request budget: ARIA-LOW-622.
- The body/beta policy is a denylist: ARIA-LOW-623.
- The runner attestation reads `CLAUDE_CODE_OAUTH_TOKEN`: ARIA-LOW-624.
- The capability probe runs on the host login: ARIA-LOW-625.

## Findings raised while fixing ARIA-MEDIUM-563

The 563 fixer wrote six stubs (`g563-1` to `g563-6`). Each was re-checked on the merge with wave B
(`02ad81e36`): wave B fixed none of them, and none matches an existing registry row. All six are
registered with `finding-registry add` as ARIA-MEDIUM-620 to ARIA-LOW-625, then replayed with
`finding-registry add-explicit` onto the registry after the `origin/main` merge, so their hash chain
continues main's tail. Each is OPEN, owner
Okan-wqm, agent claude, cycle `2026-10-17-aria-563`, deadline 2026-11-14 (none is HIGH).

### ARIA-MEDIUM-620 — The refusal view misses sk-ant tokens with an underscore in their body

Full title: The kernel's refusal view misses an Anthropic token whose first 32 characters after
sk-ant- contain an underscore (every setup-token / OAuth token is base64url)

Fixed in this PR by `49166f040` (the detect regex admits `_` like the redact one; the row's
fixture carries the setup-token shape). The row was registered OPEN before the fix landed and is
closed by finding-closure-reconcile from the fixing commit's `Closes:` trailer.

- `aria-kernel/aria_kernel/secret_scrub.py:306-307`: the `anthropic_api_key` row detects
  `sk-ant-[A-Za-z0-9-]{32,}` (no `_`) and redacts `sk-ant-[A-Za-z0-9_\-]{32,}`.
- `aria-kernel/aria_kernel/implementation_safety.py:277`: `SECRET_SCAN_PATTERNS` is built from the
  detect patterns.
- Measured on the merge: for `'sk-ant-' + 'oat01-' + 'Ab3_' + 'Q' * 60`, `SECRET_SCAN_PATTERNS`
  finds nothing. `secret_scrub.credential_shapes_in` names `anthropic_api_key` and `generic_sk_key`.
- 563 makes such a token ARIA's Anthropic credential. For a random base64url body, about a third of
  them would pass `verify_no_secret_in_diff` if pasted into a diff. No room holds the token, so the
  exposure is an operator paste.

### ARIA-MEDIUM-621 — The Codex room still holds the ChatGPT login and an opaque OpenAI tunnel

Full title: The Codex runtime room still holds the ChatGPT login (auth.json, ro-bound) and an opaque
CONNECT tunnel to the OpenAI hosts

- `aria-kernel/aria_kernel/implementation_safety.py:1583-1605`: `_wrap_runtime_state_in_sandbox`
  ro-binds `<auth>/auth.json` into the room and builds it with `provider="openai"`.
- `aria-kernel/aria_kernel/provider_routes.py:104-110`: the openai row is a tunnel to `chatgpt.com`,
  `auth.openai.com` and `api.openai.com`.
- `tools/aria-poc/codex_runtime.py:398-402`: the room has no code-running tool (shell_tool,
  unified_exec, apps and web_search are off), so the agent-run-code vector is absent there.
- This host has no `codex` binary, so whether Codex honours a base-URL or unix-socket redirect
  cannot be measured. The fix is a gateway row for openai (or a per-room CA) and dropping the
  auth.json bind.

### ARIA-LOW-622 — No per-spawn request or byte budget at the provider gateway

Full title: Any process in the Claude room can spend the operator's subscription quota through the
provider gateway; no per-spawn request or byte budget bounds it

- `aria-kernel/aria_kernel/provider_gateway.py:282-308`: `ProviderGateway.handle` forwards every
  pinned `POST /v1/messages` under the kernel credential and keeps no per-socket counter.
- `aria-kernel/aria_kernel/egress_proxy.py:280`: one gateway handler per route serves every room the
  process builds.
- This is quota spend, not exfiltration: only pinned Messages calls pass, with no server tools and
  no url/file sources. The hook broker's turn budget bounds the CLI's own turns, not raw requests to
  the socket.

### ARIA-LOW-623 — The provider gateway's body and beta policy is a denylist

Full title: The provider gateway's body and beta policy refuses known-bad items (denylist): an
unknown top-level Messages field, a file_id outside messages/system and any anthropic-beta member
reach the provider under the kernel credential

- `aria-kernel/aria_kernel/provider_gateway.py:86`: `REFUSED_BODY_FIELDS` is
  `('mcp_servers', 'container')`.
- `aria-kernel/aria_kernel/provider_gateway.py:129-145`: `refuse_body_reason` walks only `messages`
  and `system` for `file_id` and sources.
- `aria-kernel/aria_kernel/provider_gateway.py:256-267`: `_upstream_head` forwards every
  `anthropic-beta` member the room sent.
- The security review's probe cases `unknown_toplevel`, `file_id_in_tools` and `beta_passthrough`
  were still admitted after `6b45b74c1`.
- An allowlist needs the request vocabulary of each installed CLI version under each production
  argv. For CLI 2.1.278 that is 10 top-level keys and 11 beta members (in the registry notes).
  Otherwise every spawn is refused.

### ARIA-LOW-624 — The runner attestation reads CLAUDE_CODE_OAUTH_TOKEN, not the kernel's token

Full title: The runner attestation measures claude_auth from CLAUDE_CODE_OAUTH_TOKEN, a variable no
kernel path uses since ARIA-MEDIUM-563; a runner set up per the runbook attests 'absent'

- `aria-kernel/aria_kernel/runner_attestation.py:338`:
  `managed_auth_present = bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))`.
- `aria-kernel/aria_kernel/runner_attestation.py:523-524`: a `claude_auth` outside
  `APPROVED_CLAUDE_AUTH` raises `runner_attestation_claude_managed_auth_required`.
- `aria-kernel/aria_kernel/provider_credentials.py:170`: `read_provider_credential('anthropic')` is
  the kernel's boundary.
- No merge is blocked: an agent-lane refusal is only a `::warning::`, and since ARIA-HIGH-220 the
  merge gate reads only the merge lane's rows. On the base the agent-lane rows were already
  'absent'.

### ARIA-LOW-625 — The capability probe runs Claude on the host login, not through the gateway

Full title: The capability probe (hook_probe.py) still runs Claude unconfined on the host login; a
runner rebuilt per the ARIA-MEDIUM-563 runbook (no host login) reports a false 'PreToolUse hook was
never consulted' (exit 3)

- `tools/aria-poc/hook_probe.py:68`: the probe's env is `{**os.environ, ...}`, not the gateway
  route.
- `tools/aria-poc/hook_probe.py:81-83`: a failure maps to exit 2 only when stderr contains `auth`.
- `.github/workflows/aria-runner-capability-probe.yml:76`: exit 3 is a red job.
- `docs/runbooks/aria-runner-rebuild.md:269-272`: Step 4 item 2 mints the kernel token, and there is
  no host login on a rebuilt runner.
- Measured by the 563 regression review: with an empty HOME, CLI 2.1.278 exits 1 with an empty
  stderr and the result `Not logged in - Please run /login`, so the probe returns 3. Today's runner
  still has its old login, so it turns red on the first rebuild.

## ARIA-HIGH-579 — fixed (2026-10-18)

What the proof showed, on the code before this change:

- The nights were driven through `aria-kernel autonomy run --profile standard`, in process: the
  command the nightly cycle step runs, with the runners the CLI selects. The stores were
  production-shaped: a git workspace, a plan started through `plan_convergence`, the production
  routing table and the production cooldown writer. In the test, `claude` and `gh` are logging
  stubs, so no model is spawned and no network is reached.
- With Anthropic (`rate_limit_event`, reset in 3 days) and Z.ai (429) both cooled, the night ran
  every phase from `cycle_started` to `max_cycles_reached`. It exited `max_cycles` with
  `overall_status: ok` and `cycles_completed: 1`. No row and no notice said it was an outage night.
- It wrote cycle, discovery, pressure, reflection and memory rows. It booked the adopted plan in the
  funnel again as minted and rejected (`cycles_minted` and `cycles_rejected` 1 -> 2 for one plan).
  Ten such nights read as a stalled funnel to the doctor (`funnel_health`).
- Where the adopted plan had no request in flight, its convergence step minted the next round
  request (`challenger_plan`, `critical_path`), which no provider could serve.
- The planner daemon polled its whole iteration budget and claimed nothing. With the CLI defaults
  that is 10 iterations of 30 s.
- What it did not do: claim, spawn, mint discretionary work (admission refused
  `provider_unavailable`) or release anything as charged. The per-request waits held.
- With only Anthropic cooled, the whole night ran and read seats were admitted to Z.ai. That is
  expected and stays.

What violates the decision, and what does not:

- Violates: starting a cycle and recording it as a completed `ok` cycle, advancing a plan and
  minting its round request while no provider can serve it, and booking funnel and learning rows
  from a night on which nothing could run. There was no named hold.
- Does not: the deterministic steps after the cycle step (doctor, self_improve, deliver, integrity
  verify, publish) spawn no agent and write only their own ledgers. They keep running on a held
  night, so the doctor still reads the store. The orchestrator's startup housekeeping also stays:
  the orphan reaper already spares a request that waits on a provider, and key and socket pruning
  touch no model work.

What changed:

- `provider_outage.fleet_outage`: every routed role is in an outage on this host. It asks
  `provider_outage` once per role, so there is no second copy of the predicate.
- `provider_hold` (new):
  - `night_outage` reads the cooldowns and the host's providers. An unreadable ledger is not an
    outage, as in the planner hook.
  - `hold_if_every_provider_is_out` writes ONE `autonomy_state` row (`provider_outage_hold`, status
    `held`, with the checkpoint, the cooled providers and when the first returns) and ONE
    `cycle_held` notice.
  - It runs `escalate_prolonged_outages`, so the 30-day bound still reaches the operator on held
    nights. That bound ran only inside the cycle.
- `autonomy_orchestrator` asks at three checkpoints:
  - before a cycle starts, after the profile gate;
  - after the planner drain;
  - after the worker drain. These two drains are the night's only spawning lanes, and a spawn is the
    only writer of a cooldown. A held night exits `provider_outage_hold`.
- `orchestrator_exit_history.EXIT_PROVIDER_OUTAGE_HOLD` is a clean exit, not in
  `FAILED_EXIT_REASONS`: exit code 0, no `cycle_failed` notice, no breaker count, and the doctor's
  exit streak reads it as clean. `notify` gains the `cycle_held` kind and `AUTONOMY_PHASES` the
  phase.
- `tests/test_night_holds_while_every_provider_is_out.py` runs four nights on one store:
  - night 0: every provider serves; the plan's round request is minted;
  - night 1: all cooled; one hold row, no cycle started, the request, claim, admission, plan, queue,
    funnel, memory, cycle and reflection ledgers byte-identical, one notice, exit 0;
  - night 2: Z.ai back, Anthropic cooled; the same phases as night 0, the planner selects the
    request night 0 minted, nothing re-minted;
  - night 3: the planner's child spends Z.ai mid-night; the hold follows `planner_dispatch_drained`,
    no request is minted after the spend, and the interrupted request is `REQUEUED` with no fault
    requeue. Fast tests cover `fleet_outage` and the worker checkpoint (the review is not minted).
- Red first: on the previous code 12 of the 19 tests failed. Six were behavioural (night 1 ran a
  full cycle with exit `max_cycles`, no hold row and no notice; night 3 ran past the planner) and
  six were the missing owner symbols.

What is not done:

- The cron still fires every night; the workflow is unchanged. The hold is decided in the kernel at
  the cycle step, so the runner preflight, the state restore and the post-cycle steps still use
  their minutes of host time on a held night.
- The executor drain chained after the cycle still starts on a held night. Its per-request admission
  refuses cooled providers, as before.
- The scenario stands in for the planner hook's executor child, because the real hook makes a git
  worktree of the repository that holds the executor. It runs under `standard`; a CONVERGED plan's
  delivery under `strict` is not exercised on a held night. The hold at the cycle start skips that
  sweep with the rest of the cycle.
- The funnel counts an adopted plan once per cycle in which its convergence is stepped. This is not
  an outage defect, so it was not registered here; a hold now keeps outage nights out of it.
- The scenario test takes about 150 s. `suite_shard_weights.json` has no measured weight for it, so
  CI places it by test count until the weights are next refreshed.

### ARIA-HIGH-579 — review response (2026-10-18)

The review of `8c5fb1a65` found one major and four minors; the round-2 scan of the cut-off fix
found two more defects in the new carrier question. Each was reproduced first, and each fix is
its own commit.

- **Major: the night read the probe back-off, not the outage.** Reproduced with the reviewer's
  probe. Anthropic was spent with a 3-day reset, and Z.ai was re-cooled four times from 02:40.
  At 17:13 that day and the next, `night_outage` returned None while Z.ai's outage was still
  open. The scenario now runs night 1 at production timing: Z.ai refused 14 h 44 min before the
  run, with the policy 900 s back-off. On the previous code it ran the whole cycle and exited
  `max_cycles`; 8 of the module's tests failed, all 33 pass at this tree.
  - Fix (`10a7d9827`), at the one owner. `provider_outage.provider_outage`/`fleet_outage` take
    `awaiting_reprobe`: providers that are out for the night with no clock. `provider_hold`
    fills it with each provider that meets all three conditions:
    - its outage is open;
    - its back-off has lapsed, and that back-off was the policy's own. A reset the vendor
      stated, once passed, is the vendor's word that the quota is back;
    - a selectable request has it on its ladder (see the scan fix below for what selectable
      means).
  - Who releases the hold. The night carries no request, so it does not ask again. The drains'
    native admission asks, and the served spawn closes the outage (`record_provider_restored`).
  - Per-request callers (the planner hook and the discretionary mint admission) pass no
    awaiting providers and keep reading the back-off. A lapsed back-off is exactly when their
    request carries the re-probe (ARIA-HIGH-435).
  - `provider_cooldown.latest_provider_cooldowns` is the one newest-row reader, and
    `active_provider_cooldowns` filters it.
  - **Operator gate — the nothing-waiting deviation, recorded before landing.** With every
    provider out and NOTHING selectable to carry a re-probe, the night does not hold: it runs
    one deterministic cycle and mints the request the next drain re-probes with. This narrows
    the operator's 2026-10-17 hold rule ("when the quota runs out ARIA holds where it is") on
    the empty-queue edge: holding there would stand for ever (no lane asks again, nothing
    restores), which is a liveness loss the rule was never meant to buy. Relayed through the
    program's owner on 2026-10-19 and recorded here as an ACCEPTED DEVIATION, pending Okan's
    confirmation (surfaced to him as a to-confirm item with the reopen path). Verified at the
    real entry point on this tree (scratch probe, production-shaped store, both outages open,
    back-off lapsed, empty queue): exit 0 `max_cycles`, deterministic phases only, zero model
    spawns, and the cooldown ledger unchanged — no admission probe spent anything. Reopening
    conditions: if the operator reads the empty-queue night as work that must not even mint a
    re-probe request, the night must hold and an explicit operator-approved release lane (a
    scheduled admission re-probe) must replace the mint; if a provider-restoration or wake path
    that could re-evaluate a standing hold lands, the nothing-waiting mint is no longer the
    only release and the hold must return; and the first real all-out-and-idle night's doctor
    and Actions output must be checked — reopen ARIA-HIGH-579 on any of them.
- **Scan: the carrier question copied the state half of selection eligibility** (`e9a562216`).
  The cut-off fix's `_WAITING_STATES` counted every `PENDING`/`REQUEUED` row, dropping the
  owner's shadow, moot (ARIA-HIGH-360), undispatchable (ARIA-HIGH-388) and anchor
  (ORPHAN-MEDIUM-492) refusals: a waiter no drain would ever select was counted as a re-probe
  carrier, standing a hold nothing could end. The eligibility fold is now one function at the
  queue's owner, `agent_invocations.selection_skip`; `next_pending_request` and
  `provider_hold._reprobe_carried` both ask it (the night read-only). Red first: a store whose
  only waiter is a real `issue_implementation_envelope` request the delivery has no authority
  for held the night before the fix. The selection's own behaviour is unchanged (anchor, moot,
  undispatchable and undecided suites re-run green).
- **Scan: the fail-open over unreadable ledgers was silent — and the ledger's own RuntimeError
  taxonomy raised past it** (`98af39493`). Each read the night needs is guarded and named
  (`cooldown_ledger`, `outage_ledger`, `request_ledger`, `routing`) and records one
  `hold_indeterminate` notice per unreadable source before the night runs on. Writing the red
  found the second defect: a hash-broken governance ledger (`LedgerIntegrityError`) took the
  checkpoint and the whole night down at all three call sites; it now fails open, named.
- **Minor: the byte-identity pin was partly vacuous** (`6ad741435`). Reproduced: after night 0,
  `queues`, `dispatch` and `skill-genesis` do not exist.
  - A pinned path that is absent now fails the digest; a queued item is seeded through
    `next_cycle_queue.append_pending` before night 1.
  - `dispatch` and `skill-genesis` are dropped from the pin, since the fixture needs the triage
    pipeline to write them. The docstring no longer claims they are pinned.
- **Minor: nothing tested the night after a mid-night hold, and the held cycle skipped its
  reflection** (`0e5b17a96`). Decided: a cycle held after its cycle step reflects, as the
  failed exits do (`_reflect_on_failed_cycle`, ARIA-HIGH-420). The daily report is written and
  the cycle's pressures reach the next night's queue.
  - Red first: the worker-checkpoint test asserts the reflection row, and it failed on the
    previous orchestrator (re-verified this round against the pre-fix tree).
  - The scenario gains night 4. After night 3's hold, Z.ai is restored, and the night selects
    the handed-back request with no remint and no fault requeue.
- **Minor: the executor drain after a held night is unproven.** Not fixed; registered as
  ARIA-LOW-627. The reviewer's first fix option, stopping the drain at the fleet outage, is
  wrong after the major fix: the drain's native admission is the lane that re-probes the open
  outage and restores the provider, so a drain that stopped there would leave the hold standing
  for ever.
- **Minor: no shard weight for the module.** Not fixed; registered as ARIA-LOW-628. The weights
  file is generated from CI shard reports; a value typed by hand from this loaded host would be
  a second, unmeasured source. The module took 446.6 s under nice 10 on the loaded host at the
  review's round; 163-174 s in this round's runs.

## Wave C FAST — fixed (2026-10-19)

The six FAST lanes of the wave C takeover, one commit per finding, red first at the real entry
point in every case (each commit body carries the full account and its proof):

- `fix/aria-kc-merge-lane`: ARIA-HIGH-005, ARIA-HIGH-222, ARIA-MEDIUM-581, ARIA-MEDIUM-582,
  ARIA-LOW-584, ARIA-LOW-585, ARIA-LOW-610 (7 findings);
- `fix/aria-kc-gates-tests`: ARIA-HIGH-589, ARIA-MEDIUM-590, ARIA-MEDIUM-601, ARIA-LOW-595,
  ARIA-LOW-599, ARIA-LOW-600, ARIA-LOW-603 (7);
- `fix/aria-kc-invocations-fast`: ARIA-MEDIUM-168, ARIA-MEDIUM-172, ARIA-LOW-597, ARIA-LOW-607,
  ARIA-LOW-608 (5);
- `fix/aria-kc-adapters-fast`: ARIA-LOW-592, ARIA-LOW-593, ARIA-LOW-594 (3);
- `fix/aria-kc-security-fast`: ARIA-LOW-269, ARIA-LOW-591, ARIA-MEDIUM-609 (3 findings, 4
  commits — 609 carries its bounds follow-up as a second commit);
- `fix/aria-kc-misc-fast`: ARIA-HIGH-213, ARIA-MEDIUM-398 (2 findings, 3 commits — 213's pin
  needed its own strict-mode correction).

Twenty-seven findings across twenty-nine commits, plus the four triage-evidence closures below:
thirty-one registry rows move to RESOLVED with this integration.

### ARIA-MEDIUM-581 — the merge lane names why a PR's diff could not be read

Full title: The merge lane discards why a PR's diff could not be read, so a refused or oversized
diff blocks as a bare 'diff_text missing' with no cause

Closed by `72ac2e6ba`. `get_pr_diff` returns `(diff, lookup_error)` — the shape
`read_required_status_checks` already uses — with codes parsed from gh's stderr
(`pr_diff_too_large`, `pr_diff_refused_401/403`, `pr_diff_lookup_failed:http_<n>/exit_<n>`); the
blanket `except Exception` catches in `_merge_if_green_with_executor` and merge_authority's fresh
re-evaluation are gone, the lookup outcome is carried into `evaluate_auto_merge` as
`diff_lookup_error` and named after the blocking reason, and the claim-time expert review request
names an unreadable diff as `pr_diff_unavailable:<code>` instead of requesting a review of a diff
it never read. Red first: 13 failures in `test_auto_merge_diff_integrity.py` against the real
entry points with a fake gh on PATH serving GitHub's own refusal text.

### ARIA-MEDIUM-582 — the merge lane's freeze reads see the whole open-issue set

Full title: The merge lane's freeze reads (self-merge freeze notice, watchdog incident) see only
the 50 newest open issues carrying the labels, so with more than 50 such issues an open freeze or
incident is missed and the merge proceeds

Closed by `cf99c1556`. The complete read already existed as the issue writer's own lookup
(ARIA-LOW-554, `c616faba6`); it is now the single owner `github_issue_reads.read_open_issues` — a
leaf module, because a reader module-level in `github_adapters` would cycle
auto_merge → github_adapters → auto_merge. The capped `gh issue list` copy is deleted, the issues
collection joins the gh api allowlist anchored like the bare pulls collection, and an unreadable
or unparseable listing reports itself (`issue_list_failed`/`issue_list_unparseable`) so the freeze
gates refuse instead of reading a partial set as no freeze. Red first: 6 failures against the real
adapter with a fake gh serving 152 labelled issues — the freeze notice at row 151 was unseen.

### ARIA-LOW-584 — a governance row the executor could not write is named, not dropped

Full title: The executor's model-refusal exit swallows every exception from its
model_refusal_unresolved governance append (`except Exception: pass`), so a failed append, a full
disk named environment_failure:disk_full included, leaves no trace

Closed by `2d0d2f71b`. The registry named one swallowed site; the branch found six
(model_refusal_unresolved plus five siblings). All six now go through one reporter,
`_append_governance_reported`: the store's own GovernanceError refusal becomes a
`::error::aria executor could not record <kind> for request <id>: <cause>` stderr line while the
effect the row reported still proceeds; anything else raised while appending propagates. Red
first: the real `invoke_claude_cli` driven through a model refusal with
`append_tools_governance` raising `GovernanceError(environment_failure:disk_full)` — stderr
silent, no `::error::` line. The enclosing cost row inside the same `except Exception: return` is
the residual registered as ARIA-MEDIUM-631 below.

### ARIA-LOW-585 — one kernel owner prices both ARIA lanes' close-out

Full title: The two ARIA lanes price the same aria/state publish two ways: aria-auto-cycle's
whole close-out margin (6000 s, from one measurement) is below the kernel's own priced worst case
for the publish arc alone (7200 s), which aria-agent-executor prices its post-drain reserve from

Closed by `9e493f25f`. The steps allowance now has one kernel owner
(`STATE_CLOSE_OUT_STEPS_ALLOWANCE_SECONDS` beside `PUBLISH_PREAMBLE_SECONDS`, sized from #1371's
measured 47 minutes) and both lanes derive from it. The caps move WITH the numbers — the cycle
360→454, the executor 570→602, writer-lease TTLs 650→682 and 440→534 — so neither lane's spend
window changes (asserted by tests; the cycle keeps its 260-minute spawn window, the executor its
26100 s drain window). No live red is writable (proving the 7200 s publish worst case takes a >2 h
drain on the real store); the red is the static one the plan prescribed, at the real constants
imported from their owners, with the production half held at `2d0d2f71b`. The live-run residual
is under "not fixed" below.

### ARIA-HIGH-589 — the workflow contract verifier judges what a job's token is granted

Full title: The workflow contract verifier accepts a governed job that declares `permissions:
write-all`: a non-mapping job permission falls back to the workflow-level map, so the job's
least-privilege contract is never checked

Closed by `b332186ef`. One owner beside `uncontracted_write_scopes` in
`workflow_contract_registry.py`: `GITHUB_TOKEN_SCOPES`, `declared_token_permissions` (one reading
of a `permissions:` value at either level; write-all/read-all expand, anything else is refused as
`workflow_permissions_invalid`) and `job_token_permissions` (the job's own value replaces the
workflow's, as GitHub applies it). Reproduced on `62c9864ae`: rule-health-report.yml with a
job-level write-all gave `valid=True`. Red first: 4 of 6 behaviour tests of
`test_workflow_contract_permissions.py` failed against the old verifier.

### ARIA-MEDIUM-590 — tools/gates/gha-sha-pin.ts is the one owner of the action-pin rule

Full title: Two copies of the action-pin rule disagree: tools/gates/gha-sha-pin.ts and
tests/invariants/aria-workflow-sha-pin.spec.ts differ on docker:// references, `uses:` without
@ref, and an operator allowlist

Closed by `c814979e2`. The policy is decided once in the gate (a remote action pins a 40-hex SHA;
a docker:// image only by sha256 digest; no branch-ref exception — the spec's
dtolnay/rust-toolchain@nightly premise was refuted by the tree, which pins a SHA and selects the
channel through `with: toolchain:`). `PinViolation` carries a reason, and the invariant spec
walks the gate's own file set asking `inspectUsesText`; it holds no regex, SHA pattern or allowlist
of its own, and the gate spec fails on any TS source that restates the rule. The Python pin check
in `test_ci_workflow_invariants.py` cannot import the TS owner and stays a third copy — registered
as ARIA-LOW-632 below.

### ARIA-LOW-591 — the governance perimeter sees past git's global options to the subcommand

Full title: governance_bypass_refusal does not see past git's global options, so `git -C dir push
-f` and `git -c k=v push --force` are not refused as force pushes

Closed by `517de1235`. One private `_git_subcommand(argv)` skips git's global options (the closed
vocabulary verified against git 2.43.0's own parsing, separate-value and =-joined forms both) and
returns `(subcommand, rest)`; an option the vocabulary cannot price fails closed. Reproduced
pre-fix: all four escaping forms returned None. Red first: 8 new v9 invariant failures, recorded,
plus the adapter's fixture script gaining `git -C "$dir" push --force origin main` with its
expected no_force_push row.

### ARIA-LOW-592 — workflow token scope has one observer: overbroad_write_token

Full title: Two adapters report a workflow `permissions: write-all`:
agent-harness-security-adapter's broad_shell_permission and workflow-shell-safety-adapter's
overbroad_write_token

Closed by `e8e5987d2`. The harness half is retired (7 rules → 6, manifest and README follow) and
its one uniquely-covered case moved: `overbroad_write_token` gains the third sub-kind
`ungoverned-write-scope` — an UNGOVERNED job's contents:write with no registry contract and no
reason comment (the same two-line escape the harness rule gave). Measured on this tree: the 11
ungoverned jobs keep exactly one finding each under the one owner, the 9 governed ones stop being
flagged by a comment-less heuristic. Red first at both real entry points (the adapter spec and
`test_agent_harness_security.py`).

### ARIA-LOW-593 — adapters build programs and read the executable bit through the containment owner

Full title: TypeScript adapters still reach the filesystem outside adapter-fs containment: the
ts.Program compiler host and direct node:fs calls, with no lint rule confining node:fs to
adapter-fs.ts

Closed by `ea6a280f9`. `adapter-ts.ts` (the TypeScript binding of the one containment rule) gains
`createContainedProgram` on `containedCompilerHost` — readFile/fileExists/directoryExists/realpath
refuse every workspace symlink — and `adapter-fs` gains `workspaceIsExecutable` so no other module
stats or canonicalizes. The split is deliberate: the room walker runs adapter-fs ALONE in a
fixture repository with no node_modules, so the containment predicate must stay importable without
resolving typescript. The containment rule is enforced by the real eslint engine (overrides ban
node:fs imports outside adapter-fs.ts and host-less createProgram outside adapter-ts.ts), which
exits nonzero listing today's four violators before the fix and zero after. Red first: symlinked
content leaked into tenant-scoping and event-contracts verdicts, and a symlinked Cargo.toml made a
target/ directory vanish from rust-cargo's walk. The plan's lintFiles-to-lintText switch was
deliberately NOT taken: no red is writable at that entry.

### ARIA-LOW-594 — the registry gate refuses a declared scope the production input never walks

Full title: No kernel check ties an adapter's declared_scope to what its production input walks;
bundle-budget-adapter claims 318 web/shared-ui files it never reads

Closed by `9e8567d24`. The tie lives at the registry write gate
(`_validate_scope_walked_by_default_input`): when `default_input` declares roots, every
declared_scope glob's literal prefix must be one of those roots or lie under one, else
GovernanceError `declared_scope_outside_walked_roots:<glob>`. The one violating manifest
(bundle-budget-adapter, exactly as the triage measured) is corrected in the same change and its
version bumped; web/shared-ui now counts as UNOBSERVED — the honest result. Red first: two
synthetic over-root scopes failed to raise before the fix; a shipped-set test now runs every
`tools/aria-adapters/*.tool.json` through the gate.

### ARIA-LOW-595 — a test's temp fixture tree is removed by the one owner

Full title: Eleven aria-adapters TS tests and test_published_text leave their temp workspaces in
/tmp on every run

Closed by `cba523f9e`. `tools/gates/fixture-tree.ts` (already the owner of removal,
INFRA-HIGH-172) gains the creation half: `makeFixtureTree(prefix)` removes the tree through
`removeFixtureTree` when the process exits, normal end, `process.exit` and uncaught failure
alike. All fifteen adapter tests that make a tree use it, the two leaking invariant specs remove
theirs in a finally through the owner, `test_published_text.py` registers rmtree with addCleanup,
and `fixture-tree-removal-ssot.spec.ts` scans tools/aria-adapters as well and refuses a bare
mkdtemp that never removes. Red first: the widened invariant failed 3 of 4; the new owner spec
failed 4/4; the redirected-TMPDIR kernel check found 5 `aria-published-*` left. The ~21 kernel
test sites outside the adapters are registered as ARIA-LOW-633 below.

### ARIA-LOW-597 — an unreadable HUMAN_REQUIRED record is named everywhere, never skipped

Full title: human_required.list_human_required silently skips a HUMAN_REQUIRED record file it
cannot read or parse, so the operator inbox, the daily report and the CLI list undercount open
records instead of naming the unreadable one

Closed by `87fbe888f`. `list_human_required` returns a typed `HumanRequiredListing(rows,
unreadable)`; every record file that cannot be read (or parses to a non-object, which used to
CRASH the lister) is named by id with a deterministic reason. Every caller reads rows explicitly
— plan_016_metrics reads `.rows` precisely because `len()` on a bare 2-tuple would silently
report 2 — and each consumer surfaces the unreadable records at its own granularity: the inbox
lifts them into the undecided roll-up, the deadlines source raises
`PartiallyUnreadableSource`, telemetry exports `aria_human_required_unreadable`, the doctor's
queue check warns with the named records. Red first: 11 of the new
`test_human_required_unreadable.py` tests failed on the branch before the fix; the 21
grep-derived caller files (54 call sites) green after.

### ARIA-LOW-599 — the kernel lane's pytest half refuses a skipped real-sandbox pin

Full title: A pytest-native test that skips as a real-sandbox pin is not counted: the
sandbox-skip accounting that refuses a skipped pin covers only the unittest half run by
suite_shards, not the pytest half the lane job runs whole

Closed by `870a47b1d`. `aria_kernel/sandbox_pin_skip.py` holds the one predicate both halves use
(moved out of test code so the production plugin reads it without importing tests);
`pytest_native_only.py` gains `--refuse-sandbox-skips`: a ledger collects skipped reports whose
reason is a sandbox-pin skip, names them in the terminal summary, and turns an otherwise-green
session into exit 1. `aria-suite-run.sh --pytest-native` (the lane's only mode) passes the
option; the whole-suite run does not, matching the unittest half. Red first: the two lane-option
tests failed with "unrecognized arguments", and the doc-runtime pin failed on the missing ARG.

### ARIA-LOW-600 — every kernel test module ends with its **main** guard

Full title: test_watchdog_freeze.py defines TheFreezeMustNotStopTheRun after its
`if __name__ == "__main__": unittest.main()` guard, so running the file as a script exits before
the run-level freeze tests exist

Closed by `c3a81d2c8`. The class was wider than the one file: an AST scan found 22 modules with a
class or function after the guard. `tests/test_main_guard_is_last.py` parses every module under
aria-kernel/tests and fails, by path:line, on a guard that is not the last top-level statement;
the 22 guards moved to the end of their files, nothing else. Proved: the invariant failed listing
all 22; for each file the module AST is identical before and after once the guard is set aside;
`python3 tests/test_watchdog_freeze.py` ran 14 tests before and 20 after.

### ARIA-MEDIUM-601 — a BLOCKED finding names its owner; an ownerless lapsed row is UNOWNED

Full title: The schema's BLOCKED rule checks only that owner_user and deadline keys exist, so the
daily sweep writes BLOCKED rows with owner_user null (82 rows at the next run) that no one can
sign an override for

Closed by `1cecc17f7`. The BLOCKED branch of the schema is `$ref: #/$defs/accountable` at every
severity; the write sink refuses an ownerless BLOCKED row from any mutator; `planSweep` gives a
lapsed ownerless row no transition and `sweepReportLines` reports each as UNOWNED with the
`finding-registry assign` command beside it; `deadlines.read_registry_deadlines` names such a row
"unenforced ... UNOWNED" instead of promising a sweep. Red first: 3 new accountability tests
failed on the old code, and the kernel deadlines test failed at :374. Giving the ~82 lapsed rows
owners is a data act for the operator, not done here.

### ARIA-LOW-603 — the messaging ACL smoke reads the SSoT and the canonical NATS form

Full title: Six invariant specs and one smoke script still read infrastructure/nats/services.yaml
with private parsers, and request-reply-contract-acl keeps a private NATS matcher, beside the
shared reader tools/gates/nats-services.ts

Closed by `d819e5b7c` (the specs half: six specs move to `loadNatsServices()`, the fourth private
matcher is gone, the pin scans tests/invariants too — a mutation probe on services.yaml showed
the old capability and tenant-provisioning specs passing 44/44 on a tree the new ones fail) and
`5d1399085` (the smoke half): `scripts/nats/messaging-acl-smoke.{ts,test.ts}` replace the .mjs
pair, read services.yaml only through `tools/gates/nats-services.ts`, and render nothing — the
canonical block is derived from the Python owner via `generate-nats-conf.py
--print-generated-block`. The private renderer had drifted (the Python owner has emitted
allow_responses since `e25c768f8`; the .mjs never learned it, so the smoke failed a clean tree
AND accepted a config stripped of every allow_responses line), and scripts/package.json's
"type":"module" broke all three wired ts-node commands with ERR_MODULE_NOT_FOUND — both defects
are gone, `scripts/nats/package.json` declares commonjs, and the boot-path harness mints its
certificates through the smoke tool's `--print-identities` mode.

### ARIA-LOW-607 — an ORPHAN plan's trailer names the finding's own review file

Full title: ORPHAN findings registered against a review file other than orphan-findings.md are
scanned by no plan source (31 OPEN rows on the integrated head)

Closed by `79d5b07ee`. The registry row's review_file is the single owner of the binding, read
once at mint: the scanner drops the register filter and carries the row's review_file on the
candidate; the minted plan body records `finding_review_file` beside `finding_id` (a hash-covered
claim, so the trailer stays a pure function of the body); the commit-msg gate routes registry-held
ORPHAN ids through `commitMessageClosesFindingExactly`. Red first at the real scan→mint→contract
path over a committed fixture repo holding an OPEN ORPHAN row filed elsewhere, plus the gate
admitting the wrong-file trailer.

### ARIA-LOW-608 — judge calibration weights human labels by their inclusion probability

Full title: Judge calibration does not weight human labels by the inclusion probability the label
queue now records, so precision across strata stays unweighted

Closed by `26b809f72`. The escalated stratum is over-sampled relative to its population share, so
unweighted precision was biased toward exactly the stratum where judges look worst: in the red
fixture, unweighted precision read 8/18 ≈ 0.444 → "degraded" while the Horvitz-Thompson ratio
estimate over the same sample is 80/90 ≈ 0.889 → "ok". `score_judges` now reads
`inclusion_probability` beside the stratum at the one ground-truth read, reports
`precision_ht`/`recall_ht` with weighting "horvitz_thompson", and the degraded decision reads the
weighted precision; a stratified label whose π is missing or outside (0, 1] is refused by name
(`label_inclusion_probability_invalid`) instead of guessed at. Red first: the HT test died at
KeyError 'weighting' with status "degraded".

### ARIA-MEDIUM-609 — a forged hook request can neither quarantine the MCP server nor journal

Full title: Any process in the agent's sandbox can forge PostToolUse requests to the hook broker:
ten forged MCP failures quarantine the kernel's own MCP server store-wide until an operator
releases it, and forged post-tool and session requests add work-journal, MCP-call and handoff
rows without bound

Closed by `04e1000e4` (quarantine + bounds) and `fc18fb3da` (the unbudgeted-broker bound).
Quarantine is evaluated over the kernel's side=server rows only — `record_mcp_call(side="client")`
stays telemetry — and only over faults that are the server's own (argument rejection classes are
declared caller errors); the registry refuses a stdio/http server that declares no
`kernel_side_witness`. The bounds: a post-tool for a budgeted tool is recorded once per tool_use_id
this broker allowed in pre-tool; every other name is capped at `MAX_POST_TOOL_PER_TOOL_NAME` (240)
per broker, and the follow-up commit bounds the UNBUDGETED broker the first cap's rationale missed
(turn_budget None admits budgeted names without a turn cap). An over-cap request is answered
EXIT_ALLOW with an `unrecorded:over_bound` note and writes no row. Red first through the real
socket on the real store: ten forged PostToolUse failures quarantined 'aria' pre-fix; ten real
server faults through the real MCP broker and relay never quarantined pre-fix; the v12 invariant
module was amended in the SAME commit so it pins the new contract.

### ARIA-LOW-610 — the judge-batch lane asks the pre-claim gate before any claim

Full title: The judge-batch lane claims K requests after its native admission without asking the
pre-claim environment gate, so a workspace whose git cannot answer burns K claims and rejects
every result as verification_unavailable

Closed by `b63e6e7dd`. The gate keeps one owner and grows a lane parameter:
`PRE_CLAIM_LANE_JUDGE_BATCH` asks for git alone (the batch has no room and no validation
commands), `_run_judge_batch` asks it after the PENDING check and before the fleet probe, and a
refusal settles every member by name as harness_unavailable/retryable — the host, not the request
— with all states PENDING and zero claims. Red first: the real `--judge-batch` child (subprocess,
real store, fake vendor) through a workspace whose git wrapper answers rev-parse with exit 128
claimed all 3 members; stderr carried no gate refusal.

## Wave C FAST — closed findings with no section in their review file

Seven findings closed above are only mentioned in their own review file, in a residual list or a
plan table, with no section. Their section is here.

### ARIA-HIGH-005 — the pre-merge evidence snapshot is built only by the merge owner's capture

Full title: Pre-merge checks lack an immutable evidence snapshot

`docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md` carries it as task 8. Closed by
`0ae1566f1`: `_PreMergeEvidence` checks a module-private construction token in `__post_init__`
through the registry's own `_require_registry_token`, `merge_authority._pre_merge_evidence` is
the one constructor, and `test_pre_merge_evidence.py` (the proof file the closure policy pins,
which did not exist) pins every task-8 property at the real entry points — direct construction
raises ForgedVerdict, a row appended by a real concurrent writer between the capture's reads makes
the snapshot unavailable as `native_context_changed_during_capture`, a head that moves after the
green evaluation is refused before the perimeter, and the merge call carries expected_head_sha.
Red first: direct construction was not refused.

### ARIA-HIGH-222 — a claim run that yields on the writer lease is claimed by the backstop

Full title: aria/state publish is single-attempt in every lane, so a lane that loses the
fast-forward race drops its rows (a lost merged row blinds self-revert), and the global
readiness-claim concurrency group silently drops claims

`docs/reviews/claude/2026-09-26-aria-merge-lane-review.md` carries it. The publish-race and
per-head group halves were fixed earlier; the lease half is what this lane closes, by `6021d92a6`:
aria-readiness-claim.yml gains an hourly schedule (:23, off the merge lane's :47) whose
lease-gated "Bind the claim target" step asks `readiness sweep-claimless` for an open PR whose
live head no claim names, with a completed aria-merge-authority run and a published proof
artifact; the claim is bound to the swept run id, one target per run rotated by the hour, an
unreadable Actions listing raises `actions_listing_failed` (the step goes red), and the claimed
set has one reader (`readiness_proofs.recorded_claim_heads`). Red first on `62c9864ae`: 23
failures (verb missing, no schedule, claim steps on steps.pr).

### ARIA-MEDIUM-168 — the submit path writes the fold's verdict, the fold's status has one reader

Full title: 40 accepted judge results never folded, three causes

`docs/reviews/claude/2026-09-19-aria-typed-judgment-plan.md` carries it. Closed by `9df225997`:
the submit arm delegates to `bridge_transition` (the one decision owner introduced with 172), so
all-refused writes permanent_fail/"refused" at attempt 1 instead of `pending_retry@1`, and
`derive_request_state` lifts to the terminal state. A new AST invariant refuses any read of a
result row's `bridge_status` key outside the sanctioned files — the fold's status lives in the
ledger, derived by `bridge_status_ledger.derive_bridge_state`, and `bridge_status` on the result
row is a mint-time constant any module reading it as state would misread for ever. Red first: the
e2e transition tuple failed `('pending_retry', 1, None) != ('permanent_fail', 1, 'refused')`.

### ARIA-MEDIUM-172 — a deterministic bridge refusal ends the replay lane by name

Full title: the replay lane retries a claim whose fold is refused permanently

The same plan carries it. Closed by `a4ee2b601`: `BridgeContractRefused` (a SIBLING of
`BridgeContractViolation` — seven modules catch Violation and their semantics must not change)
marks the pure content refusals; the hub records each failure once through
`_record_bridge_failure`; `bridge_transition` is the ONE decision owner (all-refused →
permanent_fail/"refused"; budget spent → permanent_fail/"retry_budget_exhausted"); the selector's
budget filter is gone so a budget-spent row is terminalized instead of stranded; the replay reads
the envelope against the row's output_hash (sealed bytes). On aria/state each of the 13
permanent_fail@3 rows had cost two useless replays. Red first: 11 classification reds with the
raise sites reverted, and the replay suite failed at collection.

### ARIA-HIGH-213 — the GitHub App runbook states the five required checks the manifest enforces

Full title: The GitHub App runbook is stale (snowball branch, 1 approval, missing permissions, no
repository-secret step, no merge runner) and the runner rebuild runbook omits openssh-client

`docs/reviews/claude/2026-09-26-aria-chain-gaps.md` carries it. The registry title was stale at
this tree — `bd8d2c6f5` (#1676) already removed the snowball branch and wrote the permission
table, the repository-secret step and the merge runner. The residual the lane closed, by
`f3b628f64` (with `8e25b48d3`, the strict-mode correction to the same pin): section 6 still said
"the 4 required checks" while `9454d3a93`/`58e5a2fab` made aria-kernel the fifth context of
main-required-status-checks.json, and "both producing workflows run on merge_group" stopped
describing every producer when aria-kernel.yml joined (it runs unfiltered on every pull request
and declares no merge_group trigger). The SSoT assertion pins section 6's required-check bullet to
the manifest's contexts and names the three producing workflows with their merge_group truth. The
re-scope is recorded here per the work order: the permission-table and openssh-client pins were
left out because they pin content #1676 already fixed.

### ARIA-LOW-269 — the anchor's committed read verifies the object chain

Full title: The ingestion trust anchor rests on the runner-writable local refs/remotes/origin/main
and re-hashes only the allowed-signers blob, not the commit or tree that names it

`docs/reviews/claude/2026-10-02-aria-operator-channel.md` carries it. Closed by `69d800e65`: git
2.43.0 serves a rewritten loose object without checking its hash on the rev-parse/cat-file paths
(measured: with the root tree's loose file rewritten under its genuine id, rev-parse returns the
attacker's blob oid while ls-tree alone refuses), so `committed_blob` now walks a verified object
chain — one batched cat-file read re-hashes the commit, every tree on the path and the final
blobs; any mismatch, missing object or unclassifiable mode fails the read closed. `tracked_files_at`
additionally excludes a gitlink that ls-tree -r had listed as a tracked file. The red is a real
forgery in a hermetic temp repo: a tree under its genuine id and a commit with its tree line
swapped, driving the REAL committed_blob — pre-fix it returned `CommittedBlob(b'attacker-key\n')`.
The four private unverified readers elsewhere are registered as ARIA-LOW-636 below.

### ARIA-MEDIUM-398 — a drain that window-skips its own minted implementation chains one hop

Full title: An implementation request minted mid-drain is always window-skipped (worst case 20343
s of a 21000 s budget) and waits for a full cycle before an executor run can take it

`docs/reviews/claude/2026-10-09-aria-plan-feasibility.md` carries it. Closed by `593b9939e`:
`cycle_rhythm.evaluate_drain_rechain` is the pure decision (named refusals; the depth brake fires
first so no drain-to-drain loop can be written); the drain captures each window-skipped
IMPLEMENTATION request minted at or after its wall-clock start, appends one
executor_drain_rechain governance row per re-chained request, and hands
window_skipped_self_minted / rechain_dispatch to the stage line and GITHUB_OUTPUT; the workflow
declares the rechain_of input and a hosted chain-next-drain job (mutually exclusive with
chain-next-cycle so one run never queues two pending runs into aria-selfhosted-workspace). Red
first, three entries: the decider (ImportError), the wiring ('window_skipped_self_minted=1' not
found in a summary carrying the plain count only), and the edge pin ('rechain_of' not found in the
workflow_dispatch inputs).

## Wave C FAST — closed without code, on triage evidence

The 2026-10-16 triage (results/triage-result.json) re-examined these four rows against the tree
and found them already fixed or not reproducible. The registry rows were never closed. Their
section is here; the closing commit is the integration commit that carries this section.

### ARIA-MEDIUM-099 — every submit-failure terminal supersedes the CLI's succeeded summary

Full title: The executor drain counts a child as drained on the `succeeded` dispatch summary
`invoke_claude_cli` writes when the CLI ran to completion, so a child whose SUBMIT then fails
(`submit_rejected`, `submit_timeout_\<n\>s`,
`native_runtime_result_reconciliation_unavailable` — each `return 1` without superseding the
summary) is still reported as a drained success

Verdict `already_fixed` (triage group 6). Evidence: `_fail_submit_dispatch` — the ARIA-HIGH-124
round 5 writer — writes outcome=failed, phase=submit over the CLI's succeeded summary, and every
submit-failure terminal (`submit_timeout`, `evidence_verification_unavailable`,
`agent_result_rejected`, `submit_rejected`) calls it before return; on the native lane the success
summary is written only after reconciliation succeeds, so the drain sees no summary
(`child_without_summary`), not a success; the drain counts only `outcome=='succeeded'` as drained.
Verified at the triage tree `4535de11a`; owner module tools/aria-poc/ci_executor.py.

### ARIA-HIGH-206 — the merge runner also fires on CI - Affected, with an hourly backstop

Full title: The merge runner fires only after aria-readiness-claim; when the other required checks
(ci-affected) finish later it never retries, so an ARIA PR waits for an unrelated event

Verdict `already_fixed` (triage group 3). Fixed in `bd8d2c6f5` (#1676): the merge runner's
workflow_run trigger covers CI - Affected beside aria-readiness-claim, an hourly cron backstop
(:47) re-sweeps, and with no PR given it sweeps every PR that holds a readiness claim; the job
condition accepts a CI - Affected success on a pull_request event. Evidence anchors:
aria-merge-runner.yml:30-39 and :74-78, ci-affected.yml:1 (name match), `git log -S"'CI -
Affected'"` → bd8d2c6f5.

### ARIA-MEDIUM-226 — the merge-lane grant defects the closure plan carried

Full title: Merge-lane grant and merge runner defects: non-UTC expiry stored shifted, grant not
validated on read, runner/adapter selection disagree with merge_authority_available, merged result
unchecked, closed PRs evaluated, check runs not paginated, audit lacks grant fields

Verdict `already_fixed` (triage group 7). The code at `4535de11a` addresses all seven sub-defects,
each carrying an ARIA-MEDIUM-226 marker: expiry converted with `astimezone(timezone.utc)` before
strftime; `get_merge_lane_grant` re-validates lane, expiry, max days, approval ref and approval
object on read, fail-closed; runner/adapter selection aligned; `merge_outcome` checks
MERGED/enqueued at the expected head; a non-open PR is not a candidate; check runs paged
per_page=100 to total_count; the audit records the grant the decision ran under.

### ARIA-MEDIUM-522 — pr_for_assignment already reads through the verified loader

Full title: worker_dispatch.pr_for_assignment reads pr-lifecycle.jsonl with the unverified
load_jsonl

Verdict `not_reproducible` (triage group 1). Evidence: the module's load_jsonl delegates to
`load_declared_jsonl(path, expected_surface=...)` or raises (verified since 2026-06-08, blame
`42695736f5`), and load_declared_jsonl defaults verify=True through load_jsonl_verified — the
finding confused it with an unverified loader. The only caller cannot merge either: its merge
result is hard-coded to blocked. Invalid as stated.

## Wave C FAST — not fixed, with reasons

These findings stay OPEN. Each is one `not_fixed` entry of a lane report.

- **ARIA-LOW-585, live-run residual** (code complete in `9e493f25f`). The steps-allowance figure
  (2820 s) is #1371's measurement on the 842 MB store; re-measuring on the current store needs the
  nightly "Measure the unbounded close-out" step to run on a live night, which needs Okan to
  re-enable ARIA (paused). The cap raises are an operator budget decision to confirm — both spend
  windows are provably unchanged (asserted by tests), so spend does not change.
- **ARIA-MEDIUM-580** (ORPHAN-HIGH-779 bound to a never-existing task-7 test). Bound by the work
  order: run only after learning and merge-lane are integrated. Verified on the invocations-fast
  branch: neither fix/aria-kc-learning nor fix/aria-kc-merge-lane was merged into origin/main, and
  both hold edits to the same PENDING_CLOSURE_REGRESSION_REFS dict the fix must rewrite. The
  finding's allocation (through the registry allocator) is integration/main scope.
- **ARIA-MEDIUM-596** (branch_protection_policy_reasons must measure squash_merge_commit_message).
  Bound by the work order: 596 edits auto_merge.py + readiness_proofs.py + test_auto_merge.py that
  merge-lane holds; sequencing it now would collide with that lane on exactly its owner files.
  Fresh anchors were verified at origin/main `b6c604f5f` (enterprise_readiness.py:23, :576;
  readiness_proofs.py:58, :328; auto_merge.py:1340); the plan is affirmed, only sequencing
  changes. The operator-only residual also stands: the first live readiness probe must show the
  repository's real squash_merge_commit_message.

## Findings raised while closing the wave C FAST lanes

Sixteen stubs are registered with `finding-registry add` from the integration worktree
(`fix/aria-kc-integ-fast`, from origin/main `62beb2ef2`), all OPEN, owner Okan-wqm, agent claude,
cycle `2026-10-18-aria-wave-c`, review file this document, deadline 2026-11-09. Every evidence
anchor was re-verified at `62beb2ef2` before registering (the branch-written anchors that drifted
were re-pinned; state-branch measurements and prose moved into notes to keep the evidence
canonical). The work order's synthesis expected eleven c-\* stubs; thirteen existed by the time the
recorder ran — the extra two pairs come from the learning and state-store lanes, whose branches
land separately but whose stubs HANDOVER §5 registers as they appear.

The allocator continued at ARIA-MEDIUM-631: 626, 629 and 630 are already claimed by a live sibling
worktree (aria-order-chain), so the "only 626 is free" window the work order described has closed.

- **ARIA-MEDIUM-631** (c-merge-lane-1) — the executor's Claude-usage cost row is written inside
  `try/except Exception: return`, so a cost row the store refuses drops the USD attribution
  silently (tools/aria-poc/ci_executor.py:2687, :2763-2829). Found while fixing ARIA-LOW-584.
- **ARIA-LOW-632** (c-gates-tests-1) — test_ci_workflow_invariants.py keeps a third copy of the
  action-pin rule beside the owner gha-sha-pin.ts (:76, :161-183). Found while closing 590.
- **ARIA-LOW-633** (c-gates-tests-2) — about 21 kernel test sites mkdtemp a tree they never
  remove, the class 595 closed for test_published_text (20 anchors listed).
- **ARIA-LOW-634** (c-gates-tests-3) — three invariant specs run fixture git on the caller's
  environment instead of hermeticGitEnv, and the SSOT pin checks only where the filter is spelled.
- **ARIA-LOW-635** (c-invocations-fast-1) — render_dashboard_markdown's default repo resolution
  has never run: `_resolve_repo_root` is called without its required override argument
  (plan_016_metrics.py:285). Found while writing 597's red.
- **ARIA-LOW-636** (c-security-fast-1) — four modules still read committed git content through
  private readers that do not verify the object chain (autonomy_evidence.py:1740,
  finding_line_map.py:41, state_writer_lease.py:412, runtime_artifacts.py:829). The 269 follow-up.
- **ARIA-MEDIUM-637** (c-genesis-router-1) — router-emitted agent-genesis requests have no
  consumer and existing_genesis_request_keys parks each gap on its first night (agent half of
  ARIA-MEDIUM-612; existing_genesis_request_keys re-pinned at agent_genesis.py:1094).
- **ARIA-MEDIUM-638** (c-genesis-router-2) — an operator seed whose corpus fails the pre-flight is
  still authored on the evidence-pack proxy (skill_genesis_drainer.py:276).
- **ARIA-LOW-639** (c-genesis-router-3) — that proxy spends a drafting round on a run whose
  sandbox can only end sandbox_systematic_failure (skill_genesis_drainer.py:347).
- **ARIA-MEDIUM-640** (c-learning-1) — no agent request ever carries a learned convention, and
  the reader cannot tell a read fault from "none applies" (agent_invocations.py:259-276).
- **ARIA-LOW-641** (c-learning-2) — an agent request's target_sha is not validated at mint
  (agent_invocations.py:1301-1345; the two consuming anchors land with the learning branch).
- **ARIA-LOW-642** (c-state-store-1) — `aria-kernel ack verify` exits 0 when rows fail
  verification (cli.py:6440, runbook :78). Found while closing ARIA-LOW-598.
- **ARIA-LOW-643** (c-state-store-2) — the ack runbook names an --emergency throttle bypass,
  a webhook alert and an `aria-kernel autonomy stop` verb the kernel does not have.
- **ARIA-MEDIUM-644** (hr-sweep-1, re-verified before registering) — judge-fanout mints the
  backlog ceiling parks are disclosed only as an aggregate count; the per-decision skip rows are
  dropped at the cycle boundary and no notice kind or human-required record names them
  (judge_fanout.py:347-352, cycle.py:1968-1970, :2078, notify.py:31). The 10-10 anchor
  cycle.py:3493-3502 had drifted; the finding holds, narrowed to the count-only disclosure the Y2
  mint discipline added.
- **ARIA-MEDIUM-645** (hr-sweep-2, re-verified before registering) — the
  human_required_sla_breached notice kind exists (notify.py:32, :73) but nothing sends it;
  `_stamp_escalated_to_operator` (:808-825) writes the record and never notifies. Anchor exact.
- **ARIA-LOW-646** (main-shard-weights-1) — the kernel suite's shard weights go stale as modules
  are added and only a manual refresh rebalances them (suite_shards.py:1-40, aria-kernel.yml:139);
  the general class beside ARIA-LOW-628's single unweighed module.

## Wave C — state-store, learning and self-improve closures (2026-10-19)

The integration merges `fix/aria-kc-state-store`, `fix/aria-kc-learning` and the finished
commits of `fix/aria-kc-self-improve` (586, 587 and the ARIA-HIGH-122 design-step-1 commit
`5b24c84d9`; the staged step-3 `kernel_change_lane` work stays on the lane worktree, unmerged,
and 122 stays OPEN).

### ARIA-LOW-577 — a checkout lineage refusal reports as a refusal, not a transport failure

Closed by `db07329bb`. Red first: the ReCheckoutSafety rewind test tightened to
StateStoreRefusal failed with StateStoreError state_store_remote_history_rewind; the new-root
replacement test (the ARIA-HIGH-572 lab shape) failed with StateStoreError
state_store_remote_history_unrelated; the new test_restore_action_checkout_refusal ran the
action's restore step under GitHub's bash flags against a fixture remote whose tip became a new
root and failed "1 != 3" with "failed to reach the remote" on stderr. Both lineage branches now
raise StateStoreRefusal with the same reason codes and `state checkout` exits 3; the genuinely
unreadable "ancestry could not be verified" branch stays StateStoreError.

### ARIA-LOW-578 — the aria/state lineage is pinned on main so no host adopts a replaced lineage

Closed by `ef9042a5e`. Red first (test_state_store_lineage_pin.py + the restore-action test
against the unwired checkout): 11 failed / 7 passed — the CLI case failed "0 != 3" (the
ARIA-HIGH-572 lab's exit-0 adoption of a new root reproduced), the fresh-host new-root case
"StateStoreRefusal not raised", the action's fresh-host step exited 1 with "wrote no verdict",
and the two publish-path tests both failed "StateStoreRefusal not raised". Green after 17 + 3.
The pin is committed policy (docs/aria/policy/state-lineage.json, CODEOWNERS-protected, outside
every ARIA write scope) naming the one root each state branch's history must have; the owner
module aria_kernel/state_lineage.py proves it before anything adopts a tip, whether or not the
host tracks the branch, and state_store_lineage_history_truncated is read through the commit
object with replace refs disabled, so a `git replace --graft` cannot forge descent.

### ARIA-LOW-611 — a declared ledger is read once per append, not three times

Closed by `38018702a`. Red first (test_ledger_append_single_read.py on the old body): a strict
append read the ledger 3 times (3 != 1), a non-strict one twice (2 != 1); under cProfile on a
30,000-row (26 MB) strict ledger the removed \_read_jsonl_stored + heal_torn_tail passes spent
2.8 s of 20.6 s and made 180,039 json.loads calls against 90,036 after. The append body now
takes its tail hash from \_tail_hash_for_append: strict surfaces verify the whole chain and
refuse a corrupt one (declared_jsonl_refuses_append_to_corrupt_chain) before anything is healed
or written, the torn tail is truncated from that same text, and non-strict surfaces keep their
one full parse. The 26 test files that reach these internals pass.

### ARIA-HIGH-004 — the learning funnel is joined end to end and ACTIVE is bound to its evidence

Closed by `bbb4eaae3` (review file docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md).
Red first: ImportError active_transition_evidence / derive_learning_funnel_health and doctor
AttributeError \_check_learning_funnel on the pre-fix tree. funnel_health joins the funnel's
stages only on the identities the producers stamp (request/run ids, fingerprint, tool version,
fixture corpus, calibration report ids, target commit); a row lacking a key advances nothing,
legacy rows count as history only, and a stage holding at least 10 whose successor holds 0 is
named `learning_funnel_stalled:<up>-><down>`. The lane's ARIA-HIGH-125 (`993eb9cec`) and
ARIA-HIGH-129 (`71528eb52`) measure halves land with the merge and stay OPEN per their own
commit bodies, pending the operator decisions and the live corpus.

### ARIA-LOW-586 — reflection sections absorb only declared reader faults and name them

Closed by `347721d81`. Red first: tests/test_reflection_reader_faults.py failed 24 (14 tests +
10 subtests) on the pre-fix tree — every section returned [] for a corrupt ledger / non-JSON
registry, every injected TypeError was swallowed, `unreadable` was absent, and the AST pin
listed the ten handlers. After: 16 passed + 10 subtests, dependents green (384 passed, 314
subtests).

### ARIA-LOW-587 — scan_signals absorbs only declared reader faults and names them

Closed by `324dc096e`. Red first: tests/test_self_improvement_reader_faults.py failed 14 on the
pre-fix tree (TypeError not raised for all five readers, RuntimeError not raised for a crashed
doctor run, no `unreadable` on scan/opener/action/CLI), 10 + 5 subtests green after.
ledger.ledger_read_faults() is the one declaration of what a ledger reader may treat as a store
fault. BREAKING CHANGE carried in the lane commit: scan_signals returns SignalScan and
open_self_improvement_missions returns MissionOpening, every caller updated in that commit.

## WP-P provider continuity — recorded (2026-10-19; branch fix/aria-wp-p, not landed)

Wave C FAST is on main (#2031). The waves after it — WP-P, WP-J and the SLOW clusters — are
recorded here from their branches; **none has a PR, none has run the 10-shard suite plus the
five required CI gates, so per the landing-wave hardening (below) none counts as trusted**.
Per-finding truth for all of them is this registry plus git, never a session's claims.

WP-P is six commits on `fix/aria-wp-p` (head `5c812c794`, base origin/main), one capability
built red-first at the real night harness:

- `a0d0201fe` — `tests/_helpers/single_provider_host.py`: the one shared definition of a host
  that presents exactly one provider to the production lanes (the three lanes each carried a
  private PATH/credential copy before), probed by the model fleet.
- `65afbb7bf` — the role × provider matrix as a generated, pinned artifact
  (`test_role_provider_matrix_ssot.py` on the JUDGE-DIGEST pattern, pins under
  `tests/fixtures/role_provider_matrix_pins.json`).
- `dbddccec3` — an only-Claude night completes every phase and charges only Claude; the
  completed-night contract (the pinned ledgers a held night freezes must MOVE, a real runtime
  attempt names the surviving provider) — the check ARIA-HIGH-579 already proved insufficient.
- `792c2b776` — the operator's single-provider rule in the anchor law: the anchor gate counts
  distinct judge SEATS (`ANCHOR_MIN_JUDGE_COUNT`; one seat thrice is one observation), the
  enforce quorum asks two calibrated seats (`CALIBRATED_QUORUM_MIN_MODELS` removed), and every
  consensus row that can name its observers is stamped `provider_span` via
  `model_fleet.dispatching_provider_for_model`. Red first, four pins against `a488a36f2`:
  three distinct seats all dispatched glm-5.3 were refused at the old model gate, one seat
  voting thrice while naming three models passed it, and `provider_span` did not exist. After:
  `test_jj1_anchor_consensus` 30 passed; the feedback_store symbols 1051 passed, 0 failing.
- `d260825d1` — the only-Codex night (fake CLI; Codex is not installed on this host).
- `5c812c794` — the night's fake Claude reports the model id the real CLI reports, so the
  only-Claude night books a priced model instead of `cost_pricing_unknown_model`.

Registered here from WP-P: ARIA-HIGH-672 (the anchor gate itself — the fix/aria-wp-p branch
had allocated its own ARIA-HIGH-661 for the same finding in its off-main registry; the
cross-worktree id-allocation guard refused to re-issue 661, so this row takes a fresh id and
the WP-P landing must append at most one of the two and rechain), ARIA-HIGH-718/719 (the
j-b-method-anchor design pair: the model-only diversity legs and the missing mint-first method
stamp, both closed by this wave's implementation), and ARIA-MEDIUM-673 — the residual that the
three night classes (~4m14s for 28 tests measured 2026-10-19) landed without a
`suite_shard_weights.json` refresh, which must come from a green run's shard reports before
WP-P merges.

Not fixed by WP-P, on the record: the single-provider nights cannot be dispatched at all while
ARIA's workflows stay disabled (the WK-2 gate) — the nights are code-proven, not live-proven.

## WP-J expert panel — recorded (2026-10-19; branches fix/aria-wp-j and fix/aria-wp-j-fix2, not landed)

The panel program landed as 30 commits on `fix/aria-wp-j` (head `cbaad3b83`) plus a parallel
fix round as 28 commits on `fix/aria-wp-j-fix2` (head `3e559bf6b`); the two branches share
their lineage up to `3c5760048` and then carry their own implementations of the same nine
review fixes — the WP-J landing must pick one line, not merge both.

What was built (slice → commits; every fix red-first at the real entry point, the proof lines
quoted in each commit body):

- **A, evidence protocol + tier-0** — one verbatim-quote law for both judgment paths
  (`94c18b6ea`, `tests/test_quote_law.py` red on main); the rule contract's predicted
  `observable` or the named refusal `claim_not_falsifiable` (`32fba0b8e`); the closed
  evidence-class vocabulary R0..R4 with quotes on load-bearing rows and reproduction bound to
  `{recipe_id, expected}` (`5fbc01cf3`); and tier-0 itself — `aria_kernel/tier0.py`, zero LLM,
  refs resolve at the target SHA, quotes byte-match, fingerprint dedup, excerpt-skip named
  (`7f45f829b`; the law pinned by `3d465916c`, 11 red ways pre-fix).
- **C, the funnel** — `judgment_funnel.py` as the one routing owner at the `cycle.py:1950`
  seam (`b65e731da`); the per-night envelope budget sized to the measured drain, holding
  through the admission door, `assert_within_budget` banned on mint paths (`2f4406c1a`);
  severity-routed tiers, tier 2 one seat, tier 4 quota-bound (`5f91179ce`, five tier tests red
  pre-fix); the verdict cache keyed `(finding_fingerprint, code_hash)`, unknown blob state a
  miss (`8a22d5ddf`); per-decision cost joined on `judgment_group_id` (`946eca283`).
- **B, the panel** — four method seats (bug_hunt, reproduction_test, impact_assessment,
  architecture) join every E14 table and the panel mints whole or not at all (`0a87da08c`);
  the arbiter weighs evidence with a bounded rebuttal round and a panel diversity guard
  (`194d7faf3`); method diversity as the single-provider anchor/quorum leg (`0fab74f54`,
  shared with WP-P).
- **D, measurement** — the stability lane: one blind re-ask, one flip table, two consumers
  (the judge-weight temper and the promotion bar; `118bb215e` + `b22688550`); outcome truth:
  a judged defect's mechanical outcome becomes scoring feedback (`05d99ba06` +
  `9b904b3a1`); mutation canaries: labels by construction in a hermetic sandbox, scored only
  as calibration truth (`07cdaa6d0`).

The package's own review rounds (wpj-inceleme-1 probes, then the wpj-onarim fix rounds) found
and fixed defects inside the package; their rows are registered here so the record survives
the landing: ARIA-HIGH-685/686/687 and ARIA-MEDIUM-688 (zero-evidence anchors, the false
'evidence=quote-verified' label, shape-only R4 rows, the dropped admission producers — 12
tests red at `194d7faf3`), ARIA-MEDIUM-684 and ARIA-MEDIUM-691 (the expiry-ownership table
drops), ARIA-HIGH-689 (the uncertainty-vocabulary pin), ARIA-MEDIUM-690 (the scoring pin),
ARIA-HIGH-692 (the canary self-exam was not blind — the envelope named the plant), ARIA-HIGH-693
(the undeclared flip-table ledger), ARIA-LOW-694 (an unreadable drain silently swallowed the
routing). All nine were fixed on both branches (the `cbaad3b83`-line and the `3e559bf6b`-line);
none is reachable on origin/main, where the WP-J modules do not exist. The slice-C findings
ARIA-HIGH-678..683 and slice-A ARIA-HIGH-674..677 register the gaps as they stood on main.

Registered with the package: ARIA-HIGH-695/696/697 (the three §1.8-1.10 operator asks —
stability, outcome truth, canaries — as gaps on main), ARIA-MEDIUM-720 and ARIA-HIGH-721 (the
j-b panel design pair), and the s2-mimari scan set ARIA-HIGH-708/709 and ARIA-MEDIUM-710/711
(the role-registration contract, the test-execution owner, the independence-pair loader
invariant, and the intake-refusal owner — all answered by the slices above, kept as rows
because the scans measured the gaps on main).

Not fixed by WP-J, on the record: the full 10-shard suite plus the five gates has not run on
any PR (there is no PR); the nights and the canary cadence hold while the drain is dead and
ARIA is paused; the package commits' `Closes: stubs/<name>.json` trailers do not match the
registry's trailer law, so at landing the rows need a Closes-carrying closing commit or an
alias entry (finding-closure-reconcile will not match a stub path to an id).

## SLOW queue — recorded (2026-10-20; nine cluster branches, not landed)

Per cluster: branch, commits, what closed, what stays open. All branches are local, none has
a PR, and the same no-trust rule applies.

- **misc-slow** (`fix/aria-kc-misc-slow`, 3 commits) — ARIA-LOW-605: the debt lifecycle is a
  kernel-enforced state machine (`f2a438658`, red at the real debt entries; the handoff
  consumer's status/current_status defect registered as ARIA-LOW-701); ARIA-LOW-517: every
  sha256 producer, validator and token hasher goes through digest.py (`f00f52d4e`, the
  single-owner invariant red first; the ~20 prefix-only gates registered as ARIA-LOW-700);
  ARIA-HIGH-138: every kernel seam proved by a real process, not a mock of it (`b7ba78082`).
  Residual: seeding the 6 production debts needs an aria/state write after unpause.
- **genesis-router** (`fix/aria-kc-genesis-router`, 1 commit) — ARIA-MEDIUM-612: seed or
  refuse by name every skill-genesis request the router emits (`04e233c1f`, red at
  capability_gap.\_gap and the learning router branch). Residuals registered as ARIA-MEDIUM-704
  (agent_gap still parks unconsumed; legacy rows suppress panel re-asks) and ARIA-LOW-705 (a
  corpus-less convergent request still rides the proxy; operator CLI surface).
- **ci-topology** (`fix/aria-kc-ci-topology`, 4 commits) — ARIA-HIGH-602: traced kernel jobs
  fail on a tracked read outside the surface (`5ff665f96`, red at the real install refusal);
  ARIA-MEDIUM-277: one lane one group, a host workspace lock, cadence gaps reported
  (`3ad9716e6`, both halves red-first); plus the hermetic/live suite partition and the
  always-run workspace job (`56f7db560`, `ec575865d`). Residuals: 602's acceptance is the
  implementing PR's own CI first FULL traced run; 277's second self-hosted runner
  registration is an operator capacity action.
- **adapters-schema-slow** (`fix/aria-kc-adapters-schema-slow`, 2 commits) — ARIA-MEDIUM-588:
  MODULE_SCHEMAS spread entries resolved in the registry reader (`35f54c759`, the parity
  invariant red first) and the tenant-aware qualified-DDL guard projected through the
  migration-safety adapter (`7440952af`). Residual registered as ARIA-LOW-703: the kernel
  integration test still carries an inline copy of the manifest's read surface.
- **approvals-slow** (`fix/aria-kc-approvals-slow`, 2 commits) — ARIA-HIGH-238: every
  operator-approval ref proven at its raising surface (`1249cb8b0`, every ref class pinned
  red first by `8fc39237d`). Residual registered as ARIA-MEDIUM-699: the provenance mint
  itself still accepts any free-form ref.
- **identity-slow** (`fix/aria-kc-identity-slow`, 2 commits) — ARIA-MEDIUM-029: execution
  identity derived from the platform, the cycle produces the session ledger (`0182ff851`,
  ImportError red first); ARIA-MEDIUM-583: the GitHub App key mints in a lane-side broker,
  never the cycle process (`cfbe29804`, red on both lanes at base). Residuals: 029's
  provider_bound producer binds at the 563 gateway integration point; 583's first live night
  must prove broker persistence between Actions steps.
- **invocations-slow** (`fix/aria-kc-invocations-slow`, 1 commit) — ARIA-HIGH-614: every
  envelope gets a citable repository box or is refused by name (`a700d6207`, red at the mint).
- **learning** (`fix/aria-kc-learning`, 1 commit) — the night's convention lift surfaces in
  the operator inbox (`70cb9bd87`, KeyError red first). ARIA-HIGH-125 stays OPEN: the gold
  corpus (≥20 TP/≥10 FP real-ground-truth rows per tool, aria/state shows 0 TP/5 FP) and the
  operator-run promote_goldset_proposal; ARIA-MEDIUM-129 stays OPEN: negative-lift/decay
  coupling and the A/B design decision.
- **self-improve** (`fix/aria-kc-self-improve`, 1 commit) — the kernel-change lane carries an
  adjudicated self-change to an operator-opened PR (`5183c6cf7`,
  `self_change_validation_pin_refused` red first). ARIA-HIGH-122 stays OPEN: the operator
  self-merge-set decision plus the live end-to-end lane exercise.

## Landing-wave hardening (external review, 2026-10-20 — BINDING) and this lane's record

The external closure-confidence audit's four points are accepted and bind the landing wave and
the reopening (packages/INDEX.md, 'Landing-wave hardening'). What this lane did about each:

1. **Mechanised red-first gate** — registered as ARIA-HIGH-671 from the binding stub
   `verify-redfirst-ci-gate-1.json`: no CI step runs a fix PR's new/changed tests on the
   merge-base and requires them to fail there (re-verified on 9ba453af5: neither
   ci-full.yml nor aria-kernel.yml carries such a job). It is a new feature, so the full
   new-feature protocol (reading passes with gap-and-duplicate reconciliation, twice-refuted
   plan) applies before implementation, and it must be reconciled with WP-J slice A's
   kernel-side repro seam — wire both layers, own each once.
2. **No branch counts as trusted until the full 10-shard suite plus the five required CI
   gates pass on its PR.** Recorded above per wave: WP-P, WP-J (both lines) and the nine SLOW
   branches have no PRs and no such runs; their 65-85% figures are pre-landing estimates
   only. The landing wave additionally draws a random sample of 3-5 landed closures and
   re-proves them red on the merge-base, audited by an independent seat (the Claude session
   on this host, or the WP-X external red-team cadence) — never this program's own verifiers.
3. **Reopening precondition: one controlled SHADOW night.** ARIA stays PAUSED; its seven
   workflows stay disabled. It is re-enabled for exactly one shadow night first (existing
   machinery, `shadow_eval_bridge.py`); canary and calibration numbers are only spoken after
   that night, never before. This also gates the WK-2 single-provider nights.
4. **Per-finding truth comes from the registry plus git.** This lane re-verified every pending
   stub against origin/main `9ba453af5` before registering it:
   - Registered: 55 rows, ARIA-HIGH-671 through ARIA-LOW-725 (one per stub), via
     `finding-registry.ts add` only; the chain verifies and main's first 2962 rows are
     byte-identical to origin/main. Every row's title, evidence and notes carry the
     re-verification; the id-to-stub map:

   - **ARIA-HIGH-671** — stub `verify-redfirst-ci-gate-1`
   - **ARIA-HIGH-672** — stub `wpp-anchor-single-provider`
   - **ARIA-MEDIUM-673** — stub `wpp-2-night-shard-weights`
   - **ARIA-HIGH-674** — stub `wpj-a-1`
   - **ARIA-HIGH-675** — stub `wpj-a-2`
   - **ARIA-HIGH-676** — stub `wpj-a-3`
   - **ARIA-HIGH-677** — stub `wpj-a-4`
   - **ARIA-HIGH-678** — stub `wpj-c-1`
   - **ARIA-HIGH-679** — stub `wpj-c-2`
   - **ARIA-HIGH-680** — stub `wpj-c-3`
   - **ARIA-HIGH-681** — stub `wpj-c-4`
   - **ARIA-MEDIUM-682** — stub `wpj-c-5`
   - **ARIA-MEDIUM-683** — stub `wpj-c-6`
   - **ARIA-MEDIUM-684** — stub `wpj-onarim-1-role-ownership`
   - **ARIA-HIGH-685** — stub `wpj-r-1`
   - **ARIA-HIGH-686** — stub `wpj-r-2`
   - **ARIA-HIGH-687** — stub `wpj-r-3`
   - **ARIA-MEDIUM-688** — stub `wpj-r-4`
   - **ARIA-HIGH-689** — stub `wpj-r-5`
   - **ARIA-MEDIUM-690** — stub `wpj-r-6`
   - **ARIA-MEDIUM-691** — stub `wpj-r-7`
   - **ARIA-HIGH-692** — stub `wpj-r-8`
   - **ARIA-HIGH-693** — stub `wpj-r-9`
   - **ARIA-LOW-694** — stub `wpj-r-10`
   - **ARIA-HIGH-695** — stub `d-stability-lane-2`
   - **ARIA-HIGH-696** — stub `d-outcome-truth-1`
   - **ARIA-HIGH-697** — stub `d-mutation-canary-3`
   - **ARIA-LOW-698** — stub `slow-ARIA-HIGH-012-1`
   - **ARIA-MEDIUM-699** — stub `slow-ARIA-HIGH-238-1`
   - **ARIA-LOW-700** — stub `slow-ARIA-LOW-517-1`
   - **ARIA-LOW-701** — stub `slow-ARIA-LOW-605-1`
   - **ARIA-LOW-702** — stub `slow-ARIA-MEDIUM-277-1`
   - **ARIA-LOW-703** — stub `slow-ARIA-MEDIUM-588-1`
   - **ARIA-MEDIUM-704** — stub `slow-ARIA-MEDIUM-612-1`
   - **ARIA-LOW-705** — stub `slow-ARIA-MEDIUM-612-2`
   - **ARIA-MEDIUM-706** — stub `s2-refuseview-pem-bearer-1`
   - **ARIA-MEDIUM-707** — stub `scrub-refuse-view-pem-bearer-1`
   - **ARIA-HIGH-708** — stub `s2-mimari-role-registration-1`
   - **ARIA-HIGH-709** — stub `s2-mimari-test-execution-2`
   - **ARIA-MEDIUM-710** — stub `s2-mimari-independence-pairs-3`
   - **ARIA-MEDIUM-711** — stub `s2-mimari-intake-owner-4`
   - **ARIA-HIGH-712** — stub `main-fehigh374-orphan-row`
   - **ARIA-MEDIUM-713** — stub `goldset-replay-never-live`
   - **ARIA-HIGH-714** — stub `judge-calibration-starved`
   - **ARIA-HIGH-715** — stub `plan-refutation-1`
   - **ARIA-MEDIUM-716** — stub `plan-refutation-2`
   - **ARIA-LOW-717** — stub `plan-refutation-3`
   - **ARIA-HIGH-718** — stub `j-b-method-anchor-1`
   - **ARIA-HIGH-719** — stub `j-b-method-anchor-2`
   - **ARIA-MEDIUM-720** — stub `j-b-panel-debate-1`
   - **ARIA-HIGH-721** — stub `j-b-panel-seats-1`
   - **ARIA-LOW-722** — stub `b-kernel-misc-5`
   - **ARIA-HIGH-723** — stub `jevask-closes-secret-refusal-1`
   - **ARIA-MEDIUM-724** — stub `pr-create-ambient-gitdir-1`
   - **ARIA-HIGH-725** — stub `deploy-checkout-bare-resolve-1`

   - Dropped, defect no longer holds on main (each re-verified this session):
     `s2-messaging-smoke-canonical-1.json` — the ported smoke teaches the renderer
     `allow_responses`; `npx tsx scripts/nats/messaging-acl-smoke.ts --mode static` passes on
     9ba453af5 (OK, exit 0; see scripts/nats/messaging-acl-smoke.ts:19).
     `b-operator-provenance-4.json` — `main_anchor.committed_blob` now resolves through the
     verified object-chain walk (`_resolve_verified`/`_read_verified`), landed by `69d800e65`
     (security-fast, #2031). `b-kernel-misc-7.json` — the redact view leaves boolean values
     intact (`scrub_text` probe over the stub's exact fixture returns the JSON unchanged) and
     `SpawnEnvironmentTests` passes (1 passed); fixed by the wave-A/B scrub rewrites.
   - Registered re-scoped, with the fixed half recorded in the row's notes:
     `main-fehigh374-orphan-row.json` → ARIA-HIGH-712 (the anchor landed in #2034; the open
     half is that findings:add still accepts a review_file that anchors nothing);
     `scrub-refuse-view-pem-bearer-1.json` → ARIA-MEDIUM-707 (the PEM/bearer halves were
     fixed on main by `9c4d1f251` in #2019; the github-token underscore gap remains at
     secret_scrub.py:300-307). `s2-refuseview-pem-bearer-1.json` → ARIA-MEDIUM-706 registers
     the fixed PEM/bearer finding itself for traceability: its fixing commit carries no
     Closes trailer (PROC-LOW-053 interim form, its body names this stub), so the row stays
     OPEN until a trailer-carrying commit or alias reaches main.
   - The wpp anchor row (ARIA-HIGH-672) records the id collision with the unmerged branch's
     own ARIA-HIGH-661 and the resolution rule for the WP-P landing.

The operator items that code cannot close are unchanged: the Claude token mint and the one
live call in g563-results.json; the eleven open decisions (272 recorded as accepted, 273,
221, 133, 139, 252, 555, 573, 604, 606, 613); the live-run items CRITICAL-015, 014, 137, 212,
281; 532 helm (recommendation on record: accept the exclusion); and whether/when to re-enable
ARIA's seven paused workflows — which the shadow night precedes.

## WP-J landing (2026-10-22; PLAN-v2 F0.3, branch landing/aria-wp-j-l)

The WP-J expert panel lands from `fix/aria-wp-j` (`cbaad3b83`) onto main `e35ff9cac`. The funnel
lands OFF (`genesis_policy` `funnel_enabled: False`); nothing here switches it on.

What the landing carries beyond the package:

- **fix2 line** — one commit ported from `fix/aria-wp-j-fix2` (`d3a3be5b0` → `04be9aee4`, the
  scoring pin's outcome stratum) and fix2's fixture sweep for the evidence leg (`a88f48a86`); the
  six paired fixes keep wp-j's code (fix2's R4 resolver, flip-table write, drain hold, method-seat
  expiry and canary blindness were weaker or identical). The one axis on which fix2's R4 resolver
  was strictly more correct — its `{red: failed, green: ok}` status map — is ported into wp-j's
  binder by the landing's ARIA-MEDIUM-688 fix commit: a recorded `timeout` run backs neither
  colour (red-first pin `test_a_timeout_run_satisfies_neither_red_nor_green`).
- **N1, digest owner** — `tier0` no longer spells a second `finding:sha256:` identity, and the
  verdict cache's code hash (`evidence_trust.cited_blobs_code_hash`) composes through
  `digest.sha256_digest` / `sha256_digest_text` with byte-identical keys (ARIA-LOW-517's owner).
- **N2, no defensive fallback** — a fingerprint the one owner cannot compute is the named tier-0
  failure `tier0_fingerprint_uncomputable`; a crashing `tier0_gate` is `tier0_gate_crashed`, never
  `TIER0_PASS`. The funnel holds such an item by that name (routing row `tier0:<reason>`, the
  tier-0 governance row's `failed` list), dispatches nothing for it, and keeps it sampleable.
- **N3, one seat law** — main's `consensus_distinct_seats(row) >= ANCHOR_MIN_JUDGE_COUNT` is the
  only anchor diversity gate. WP-J's method receipt and evidence leg are legs of that function;
  `observation_span` is a recorded descriptor. The calibrated quorum counts seats.
  `ANCHOR_MIN_DISTINCT_METHODS` and the two `CALIBRATED_QUORUM_MIN_*` constants are gone; four
  method-floor pins were re-pinned to the seat law. `genesis_policy.effective_calibration_gate`
  is untouched (ARIA-HIGH-729, F0.8).
- **N4** — `test_judgment_subject_boundary` keeps both sides' assertions.
- **Method seats read the one digest** — `aria-bug-hunter`, `aria-impact-assessor` and
  `aria-test-writer` (the panel's method seats, `0a87da08c`) join the judge-digest agent set in
  `agent-prompt-contract.spec.ts` and the byte pin in `test_judge_digest_ssot.py`.

Closed by this landing (slug → id → implementing commit; tests per row in the landing's
closure map): wpj-a-1 and wpj-a-3 → ARIA-HIGH-674/676 (`94c18b6ea`, `5fbc01cf3`);
wpj-c-6 → ARIA-MEDIUM-683 (`946eca283`, the cost join runs live in `generate_ai_consensus`);
wpj-onarim-1 and wpj-r-7 → ARIA-MEDIUM-684/691 (`363df1edc`); wpj-r-1..6 → ARIA-HIGH-685/686/687,
ARIA-MEDIUM-688, ARIA-HIGH-689, ARIA-MEDIUM-690 (`25f6921ca`, `ce6a53541`, `ed656960d`,
`88824b73e` + the landing's status-map fix, `3c5760048`, `04be9aee4`); wpj-r-8/9/10 →
ARIA-HIGH-692/693, ARIA-LOW-694 (`9249e610d`, `e36e152d2`, `99d1330f2`; 694's defect lives inside
the funnel, so it closes with the funnel off); d-stability-lane-2 and d-outcome-truth-1
→ ARIA-HIGH-695/696 (`118bb215e`+`b22688550`, `05d99ba06`+`9b904b3a1`);
j-b-method-anchor-2 → ARIA-HIGH-719 (`0fab74f54`);
wpj-review-2-panel-diversity-dead-code → ARIA-HIGH-787 (`2401903ab`);
wpj-review-2-single-provider-panel → ARIA-HIGH-788 (`cbaad3b83`). ARIA-HIGH-787/788 were
registered by the landing (they had no registry row and no stub file).

ARIA-HIGH-718 (j-b-method-anchor-1) closes with this landing, but its fix is main's `792c2b776`
(WP-P: the anchor and the calibrated quorum count SEATS, not models), already an ancestor of
main. `0fab74f54`'s method gate was removed by N3 and is not credited. `792c2b776`'s trailer
names ARIA-HIGH-661, so no reconcile on main's lineage would ever close 718; the landing-notes
trailer records the closure and names `792c2b776` as the implementing commit.

Part of, not closed — the funnel ships OFF: wpj-a-4 → ARIA-HIGH-677 (`7f45f829b`+`3d465916c`,
N1/N2 `243ba01c1`); wpj-c-1..5 → ARIA-HIGH-678/679/680/681, ARIA-MEDIUM-682 (`b65e731da`,
`2f4406c1a`, `b65e731da`+`7f45f829b`, `5f91179ce`, `8a22d5ddf`). Their code and tests land, but
`judgment_funnel` returns the legacy plan before tier-0, the envelope budget, tiering or the cache
run while `funnel_enabled` is False, so production still mints the full judge pair with no tier-0
check — the defect these titles describe stays live. Closing them now would be the false-close
class (a mechanism added that never runs). They close when F5.1 turns the funnel on.

Also Part of, not closed (final review, 2026-10-23), each still live in production:

- ARIA-HIGH-675 (wpj-a-2, `32fba0b8e`): `CLAIM_NOT_FALSIFIABLE` is minted only when a contract
  is passed, and the only caller `judgment_funnel.py:218` passes `None` — the named refusal is
  unreachable even with the funnel on.
- ARIA-HIGH-697 (d-mutation-canary-3, `07cdaa6d0`): `mint_canary_judgments` holds
  `no_registered_corpus`; `register_canary_corpus` / `build_canary_corpus` have no production
  caller (F5.4 builds it).
- ARIA-MEDIUM-720 (j-b-panel-debate-1, `194d7faf3`): the whole-or-nothing rule applies to the
  panel only; the live default pair still mints one seat when the backlog cap skips the other.
- ARIA-HIGH-721 (j-b-panel-seats-1, `0a87da08c`): the method seats exist, but with the funnel
  off production mints only the two-method pair (same class as 678/681).

Re-proof (four closures sampled at random by the landing's re-proof seat): ARIA-HIGH-686 and
ARIA-HIGH-689 re-proven at their parents. For ARIA-HIGH-680 and ARIA-HIGH-719 the WP-J range
`b65e731da..5f91179ce` is not bisectable (it names `observation_span` / `EXPERT_METHODS`, defined
only in `0fab74f54`); the program lead accepted the defect put back at the landing tip, with the
named test failing for the defect's reason, as their proof.

Not closed here, on the record:

- ARIA-HIGH-708/709 and ARIA-MEDIUM-710/711: no WP-J commit names them; they stay OPEN.
- ARIA-HIGH-697's judge-scoring code lands; it closes with the real-module discovery half
  (ARIA-MEDIUM-760, F5.4), when the canary corpus has a production builder.
- `0fab74f54`, `194d7faf3` and `0a87da08c` carry no `Closes:` trailer in the validator's
  grammar. Their messages are not rewritten; the program lead allowlisted the three SHAs in
  `tools/gates/commit-msg-validator.ts` `PRE_PHASE6_SHAS`, and this commit closes their findings.

Registered by the red-CI repair (2026-10-23, appellate root R2, same rule as item 4 above):

- ARIA-MEDIUM-799: the canary corpus' hand-typed evidence refs named the wrong sandbox line
  (four of five 0-indexed, one at the def line). `0b164c319` derives each ref from its anchor
  line (`mutation_canary._anchor_ref`, 1-indexed) but carried no row and no proving test. The
  pin `test_mutation_canary.CorpusTests.test_every_item_ref_names_its_anchor_line_one_indexed`
  reads each item's line out of `_SANDBOX_FILES` and fails with `_anchor_ref` at `start=0`;
  its commit closes 799. The canary lane itself stays Part of ARIA-HIGH-697 (no production
  builder until F5.4).
