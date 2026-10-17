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

### ARIA-MEDIUM-548 (NOTE-1) — bridge_replay_required night gets inconsistent treatment (cycle failure accounting vs notify)

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

### ARIA-LOW-551 (NOTE-4) — auto-cycle job margin leaves ~16 min slack, never measured on real post-work durations

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

### ARIA-MEDIUM-552 (NOTE-5) — legacy plans with no content_hash leave attempt_unrecorded rows that never stop

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

### ARIA-LOW-553 (NOTE-6) — if channel_check fails, the workflow steps after it are skipped (dispatch only)

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

### ARIA-LOW-554 (NOTE-7) — GhCliIssueWriter.\_find_open uses --limit 100: with >100 open aria issues a fixed-title issue is missed and duplicated

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

### ARIA-MEDIUM-555 (NOTE-8) — aria-auto-cycle job-level contents:write permission broader than needed

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

### ARIA-MEDIUM-556 (NOTE-9) — cost-breaker amounts and CRITICAL human-required reasons appear in public GitHub issue bodies

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

### ARIA-LOW-557 (NOTE-10) — judge-backlog count uses a 4-day wall-clock window, under-counting after a long provider outage

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

### NOTE-13 — first CI self_improve opens doctor_fail:deadlines as a SELF_CHANGE mission driven by lapsed HR SLAs (ARIA-MEDIUM-128 pin)

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

### NOTE-14 — test_request_admission AThrottledPanelReMintIsDeferredNotResolved::test_deferred_this_sweep_reminted_the_next was red on a pre-fix snapshot

The test passes at the fixed commit 4535de11a: the class alone once, and the whole file twice in a
row. The red result belonged to the pre-fix snapshot and does not reproduce on the code under
review.

Evidence:

- pytest tests/test_request_admission.py::AThrottledPanelReMintIsDeferredNotResolved at 4535de11a
  (read-only checkout, no cache/bytecode): 1 passed in 25.93s
- pytest tests/test_request_admission.py (whole file) twice: 30 passed, 4 subtests passed (193 s,
  202 s)
- aria-kernel/tests/test_request_admission.py:441-444 is the test class/method in question

### ARIA-MEDIUM-560 (NOTE-15) — genesis launcher: a drafted adapter may reach a capability through an already-loaded allowlisted module

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

### ARIA-LOW-561 (NOTE-16) — implementers that append '2>&1 | tail' to validation commands now get refused turns by the Bash gate

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

### ARIA-LOW-562 (NOTE-17) — each lease reap with an expired claim parses the full 25.7 MB governance.jsonl

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

### ARIA-HIGH-572 — Agent transcripts sealed on aria/state before 4535de11a stay unredacted: the scrubbing writer only covers new runs, and no purge or credential-rotation step exists for the 607 content-addressed transcripts already published

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

### ARIA-LOW-573 — A failed cycle's public GitHub issue still carries its crash reason text (cycle_failed notices are not pointer-only)

published_text strips credentials and host paths, so this is a discoverability concern, not a
credential leak. Fix: add cycle_failed to notify.POINTER_ONLY_SUMMARIES and pass the cycle record
pointer as record=, if the operator agrees the crash text should live only on aria/state. Discovered
while fixing ARIA-MEDIUM-556 (cluster secret-scrub).

Evidence:

- aria-kernel/aria_kernel/autonomy_orchestrator.py:182-186: notify_best_effort(kind='cycle_failed',
  body=f'...reason: {published_text(reason, ..., limit=\_CYCLE_FAILURE_REASON_MAX_CHARS)}')
- .github/workflows/aria-auto-cycle.yml:909-910: ARIA_NOTIFY_CHANNELS=github_issue on the public
  repository

### ARIA-MEDIUM-574 — A credential refusal the kernel withheld turns the executor job red: the 'Upload response envelope' step uploads exactly the two files the withholding deleted, with if-no-files-found: error

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

### ARIA-LOW-575 — A delivery refused for a secret-shaped diff never asks the result's verdict, so an envelope or transcript that carries a credential at the same time is not withheld

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

### ARIA-LOW-569 — Quarantine publication reads every agent-written ref file and the replica HEAD whole into executor memory, with no size bound

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

### ARIA-LOW-566 — Every governance append re-verifies and re-reads the whole governance chain, so the lease reaper pays two full parses of the 25.9 MB ledger per expired claim on top of its one lookup parse

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

### ARIA-LOW-567 — A spawn-lane child's dispatch summary names the declared ladder head as its provider, not the rung that failed, so the drain's standing-outage check can excuse a new outage of the failover rung as a re-probe of the head's

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

### ARIA-LOW-568 — reap_stale_claims parses the governance ledger while holding the claims and results ledger lock

Found while fixing ARIA-LOW-562, which reduced the reaper's lookup to one governance parse per sweep
but left it where it was: on the first expired claim, inside
`with state_transaction([claims_path, results_path])`. The routes and outage intervals do not need
that lock; a pre-read when candidate claims look expired (re-checked under the lock as today) would
take the parse out of the critical section.

Evidence:

- aria-kernel/aria_kernel/agent_invocations.py:7063
- aria-kernel/aria_kernel/agent_invocations.py:7104

### ARIA-MEDIUM-570 — fixture_runner prices a workspace without a runner's repo-local dependency as a failed fixture case ('crash') instead of refusing the suite by name

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

### ARIA-LOW-571 — state_compact.\_compact_runs persists a read_paths slim only when the same pass also stripped evidence envelopes, and its count omits read_paths-only rows

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

### ARIA-MEDIUM-563 — The egress allowlist admits provider hosts by host:port only, so an injected agent can still exfiltrate through an allowlisted provider under a credential it chooses (its own login file is readable in the room)

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

### ARIA-MEDIUM-564 — The pre-claim environment gate is skipped whenever the adaptive native runtime admits a route, so production never runs the egress, git-availability or node_modules checks before a claim

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

### ARIA-LOW-565 — The killed-holder socket-directory sweep is copied verbatim into four modules (hook broker, MCP broker, signing agent, egress proxy) instead of one helper the orchestrator calls with each holder's prefix

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
