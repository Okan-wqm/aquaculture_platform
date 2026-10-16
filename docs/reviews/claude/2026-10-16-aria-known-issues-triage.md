# ARIA known-issue triage — 2026-10-16

The operator paused ARIA on 2026-10-16 until its known problems are fixed: the scheduled ARIA workflows are disabled. Before a fix program, every OPEN ARIA finding in the registry (106) and the repair session's 17 unregistered observations were validated against the code at 4535de11a (origin/main 357ce623e plus PR #1978) and against production aria/state. Eleven read-only validator agents did this, each giving a file:line or command for every verdict. main then spot-checked the HIGH findings judged already fixed.

## Result

- 123 items: 91 real, 16 partially fixed, 11 already fixed (the registry still says OPEN), 2 not reproducible, and 3 that need an operator decision.
- **7 run-blockers**: running ARIA with one of these open causes concrete harm. Five are security, one is data loss and one is a runaway outage.
- The operator chose the scope: fix the run-blockers and every small or medium defect before ARIA restarts. The large capability gaps (L/XL) and the three operator decisions (ARIA-HIGH-272, ARIA-MEDIUM-139, ARIA-MEDIUM-273) stay tracked.

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

Each section below is the account of one observation the repair session made but never registered. Its registry row points here.

### ARIA-MEDIUM-548 (NOTE-1) — bridge_replay_required night gets inconsistent treatment (cycle failure accounting vs notify)

A bridge_replay_required night sends a cycle_failed notice and writes a failed phase. The same cycle is still counted in cycles_completed, the run returns exits_clean=True, and the CLI exits 0. The operator gets a failure issue while the workflow run is green and the run-level accounting says clean. This is a new defect, not a duplicate of 420/415.

Evidence:

- aria-kernel/aria_kernel/autonomy_orchestrator.py:1889-1920 (4535de11a): bridge_replay_required transitions status=failed, appends a failed_phases row and calls \_notify_cycle_failed(exit_reason='bridge_replay_required'), then sets exit_reason='bridge_replay_required'
- autonomy_orchestrator.py:1789-1790: cycles_completed += 1 already ran for this cycle (cycle_completed ok happens before the bridge drain)
- autonomy_orchestrator.py:2997: "exits_clean": exit_reason not in {"cycle_failed"} -> bridge_replay_required exits clean
- aria-kernel/aria_kernel/cli.py:5067/5105/5132/7296: return 0 if result.get('exits_clean') else 1 -> the lane step is green

### ARIA-LOW-549 (NOTE-2) — an aborted cycle is recorded as cycle:unrecorded in the doctor

An aborted cycle (pre-phase abort or state_integrity_gap) is written into the autonomy-state summary with runtime_status='aborted' and no failed phase. The doctor therefore names its cause 'cycle:unrecorded', and the recorded abort reason never reaches the cause key or the self-improvement mission identity. ARIA-MEDIUM-417 added the cause vocabulary but missed this path.

Evidence:

- aria-kernel/aria_kernel/cycle.py:694-701 and 747-755: an aborted cycle returns status='aborted' with no runtime_status (aborted_by_phase / state_integrity_gap only in event)
- aria-kernel/aria_kernel/autonomy_orchestrator.py:723 (\_bounded_cycle_summary): runtime_status defaults to cycle_result.get('status') -> 'aborted'; the closed summary carries no aborted_by_phase and failed_phases is []
- aria-kernel/aria_kernel/cycle_runtime_status.py:48-50: RUNTIME_STATUSES = (ok, degraded, integrity_failed, failed), so 'aborted' is not a member
- aria-kernel/aria_kernel/doctor.py:530-532: with no failed_phases, a verdict outside RUNTIME_STATUSES becomes CAUSE_UNRECORDED -> cause key 'cycle:unrecorded'

### ARIA-LOW-550 (NOTE-3) — host organs (infra-only signals) still mint self-change missions

Host-only organ failures still raise doctor_fail, which has the self_change remedy. A missing claude binary, no provider credential, no bwrap backend or a dead gateway daemon therefore mints a propose_self_change mission whose only real answer is an operator/host action, and each such mission spends a mission slot and an agent turn for nothing. The mint is bounded by max_new, so this is wasted work, not a runaway.

Evidence:

- aria-kernel/aria_kernel/self_improvement.py:75: DOCTOR_ORGAN_SIGNAL_KINDS = {'notifications': 'config_missing', 'deadlines': 'deadline_due'}; every other failing organ maps to 'doctor_fail'
- self_improvement.py:53: 'doctor_fail': SELF_CHANGE_REMEDY; :223 kind = DOCTOR_ORGAN_SIGNAL_KINDS.get(check.name, 'doctor_fail')
- aria-kernel/aria_kernel/doctor.py:192-232: providers 'no_provider_available', sandbox_backend 'no_sandbox_backend_write_capable_spawns_refused', claude_cli 'claude_binary_missing'/'claude_below_floor' are host/infra facts; gateway_heartbeat_fresh (469+) is a dead host daemon
- No registry row covers host organs (ARIA-MEDIUM-417 routed only notifications/deadlines)

### ARIA-LOW-551 (NOTE-4) — auto-cycle job margin leaves ~16 min slack, never measured on real post-work durations

The close-out margin leaves 16 of 100 minutes of slack. The 57-minute close-out figure comes from one #1371 measurement, not from nights that did real post-work, and the doctor runs twice (NOTE-12). Today's store (626 MB) is smaller than the 842 MB measurement basis, so an overrun is unlikely. If one happens, the job is cut before publish and the night's state is lost; it is not corrupted, because publish is an atomic push and the lease TTL outlives the job.

Evidence:

- .github/workflows/aria-auto-cycle.yml:942-963: ARIA_JOB_DEADLINE_EPOCH = launch + 360 min - 6000 s; comment: close-out measured at most 57 min on 842 MB (#1371) + doctor 10 + self_improve 12 + deliver 5 = 84 of 100 minutes
- aria-auto-cycle.yml:1081-1129: doctor/self_improve/deliver timeout-minutes 10/12/5; handoff/integrity/mint/publish steps have no timeout-minutes
- git ls-tree -r -l origin/aria/state: total 625,558,311 bytes today (below the 842 MB measurement basis)
- aria-auto-cycle.yml:446-455: writer lease TTL 440 min > 360 min job cap, so a timeout does not strand the lease

### ARIA-MEDIUM-552 (NOTE-5) — legacy plans with no content_hash leave attempt_unrecorded rows that never stop

A CONVERGED plan whose latest revision has no content_hash fails body proof inside the attempt claim. The failure is recorded as an uncounted attempt_unrecorded withhold that never reaches MAX_DELIVERY_ATTEMPTS or the operator, so the plan is re-offered and re-refused every cycle forever. No such rows are on aria/state today. The cost is one governance row per cycle per legacy plan, with no spawn.

Evidence:

- aria-kernel/aria_kernel/converged_delivery.py (\_mint_scope_refusal): 'A body the ledger cannot prove is not a scope verdict: its error reaches the caller' -> plan_body_from_state(state)
- aria-kernel/aria_kernel/plan_convergence.py plan_body_from_state: raises GovernanceError when latest_revision.content_hash is missing ('no body can be proven')
- converged_delivery.py:550-567: the GovernanceError from \_claim_attempt is caught, writes governance 'converged_delivery_attempt_unrecorded' and returns withheld 'attempt_unrecorded' with no attempt counted, no escalation and no parking
- converged_delivery.py:337-339: the exhaustion bound counts only recorded attempts, so the plan stays CONVERGED and redeliver_stranded_converged_plans (autonomy_orchestrator.py ~1932) offers it every cycle

### ARIA-LOW-553 (NOTE-6) — if channel_check fails, the workflow steps after it are skipped (dispatch only)

On an operator dispatch with channel_check=true, a failed notification check skips the whole night (provisioning and the cycle), while the always() close-out steps still run and publish. Scheduled runs never take this path, and nothing is corrupted or lost; the operator simply gets no cycle from that dispatch. Whether a broken channel should block the cycle is a design choice.

Evidence:

- .github/workflows/aria-auto-cycle.yml:110-117: channel_check is a workflow_dispatch input, default 'false'
- .github/workflows/aria-auto-cycle.yml:532-558: the 'Notification channel check (dispatch-gated)' step exits non-zero (SystemExit) unless sent+sent with the second commented
- aria-auto-cycle.yml:561-859: every later provisioning and cycle step has a plain if: (no always()), so all of them, including 'Run the nightly cycle', are skipped after a failed check
- aria-auto-cycle.yml:1081-1316: doctor/self_improve/deliver/integrity/publish/lease release run under always(), so state is still verified and published

### ARIA-LOW-554 (NOTE-7) — GhCliIssueWriter.\_find_open uses --limit 100: with >100 open aria issues a fixed-title issue is missed and duplicated

The lookup sees only the 100 newest open 'aria'-labelled issues. With more than 100 open, an older fixed-title issue (cycle_failed, breaker, daily report) is missed and a duplicate is opened. The duplicate is then the newest and is found next time, so this produces one extra issue per crossing, not a runaway.

Evidence:

- aria-kernel/aria_kernel/github_adapters.py:295-310: \_find_open runs 'gh issue list --state open --limit 100 --label <labels>' and matches the exact title client-side
- aria-kernel/aria_kernel/notify.py:54: NOTIFY_ISSUE_LABELS = ('aria',), the only label filter; notify.py:140-161: identity is the exact FIXED title, comment_or_create
- github_adapters.py:331/350/374: upsert/comment paths create a new issue when \_find_open returns None

### ARIA-MEDIUM-555 (NOTE-8) — aria-auto-cycle job-level contents:write permission broader than needed

The job token that the whole nightly-cycle process carries has contents:write on the repository, but only the final publish step needs it. agent_env strips GH_TOKEN from agent children and the aria/state ruleset blocks force-push, so this is least-privilege hardening, not an open leak. The fix needs a separate publish credential or job split, because publish uses the same job token today.

Evidence:

- .github/workflows/aria-auto-cycle.yml:125-150: top-level permissions include contents: write (also issues: write, id-token: write); the long cycle job (timeout 360) does not narrow them
- .github/workflows/aria-auto-cycle.yml:865: GH_TOKEN: ${{ github.token }} is exported to the whole nightly-cycle step (adapters, spawns); :1220 PUBLISH_TOKEN uses the same job token for the aria/state push
- aria-kernel/aria_kernel/agent_env.py:67: GH_TOKEN is in the agent env deny set, so spawned agents do not inherit it
- No registry row (grep 'contents: write' over findings.jsonl found none)

### ARIA-MEDIUM-556 (NOTE-9) — cost-breaker amounts and CRITICAL human-required reasons appear in public GitHub issue bodies

Cost-breaker dollar amounts and the free-text reasons of CRITICAL human-required records are posted verbatim into public GitHub issue bodies. Credential shapes are scrubbed, and much of the same data is already on the public aria/state branch. Still, a CRITICAL reason can describe an unfixed weakness, and an issue makes it far more discoverable. The code fix is to post ids and pointers only; making the repository private would be an operator decision.

Evidence:

- aria-kernel/aria_kernel/cost_budget.py:263-267: notify_best_effort(kind='breaker_tripped', body=f'amount_usd: {amount} cap_usd: {cap}')
- aria-kernel/aria_kernel/human_required.py:216-221: CRITICAL records notify with body 'reason: published_text(reason, limit=1000)' plus sla_deadline and request id
- aria-kernel/aria_kernel/notify.py:140-161: the github_issue channel posts title/body as an issue/comment on ARIA_NOTIFY_GITHUB_REPO (the public repository per autonomy_orchestrator.py:625 comment)
- published_text scrubs credential shapes only; dollar amounts and free-text CRITICAL reasons pass

### ARIA-LOW-557 (NOTE-10) — judge-backlog count uses a 4-day wall-clock window, under-counting after a long provider outage

The judge-backlog gate counts live judge envelopes only within 4 wall-clock days. Requests now age on provider-available time and stay live through a long outage, so after an outage longer than 4 days the backlog is under-counted and the gate mints judge pairs beyond the per-role cap. This is the same wall-clock-versus-provider-clock class as 436/439, at a site those fixes did not touch.

Evidence:

- aria-kernel/aria_kernel/judge_fanout.py:221: horizon = datetime.now(timezone.utc) - timedelta(days=4); rows created before it are skipped from the pending count (226-232)
- judge_fanout.py:268-272: the per-role max_pending gate reads pending_judge_counts to decide whether to mint more judge envelopes
- Registry ARIA-MEDIUM-436 / ARIA-LOW-439 / ARIA-HIGH-440 (RESOLVED) moved request/plan aging to provider-available time, but this counter was not moved

### ARIA-LOW-558 (NOTE-11) — tests leak plan-coverage\* temp dirs into /tmp (23k dirs observed)

Both the witness itself (an nx-graph.json temp dir on every call without --graph) and its spec leak temp dirs into /tmp with no cleanup. This host currently holds 4,162 of them (39 MB). The cost is disk only, but it adds to the self-hosted runner's disk-budget pressure.

Evidence:

- tools/gates/plan-coverage-witness.ts:297: loadGraph mkdtempSync('plan-coverage-') writes nx-graph.json and never removes it (production path)
- tools/gates/plan-coverage-witness.spec.ts:116,123,503: mkdtempSync 'plan-coverage-yaml-'/'plan-coverage-spec-' with no rmSync/afterEach/afterAll in the file
- ls -d /tmp/plan-coverage\* on this host: 4162 dirs (3402 spec-, 648 yaml-, 112 plain), 39 MB total

### ARIA-LOW-559 (NOTE-12) — the doctor runs twice per night (~7.5 min); one shared report would do

self_improve runs the whole doctor again instead of reading the report the doctor step has just written. That adds about 4 minutes of runner time every night and eats into the 16-minute close-out slack (NOTE-4).

Evidence:

- .github/workflows/aria-auto-cycle.yml:1081-1092: 'schedule run --action doctor' step; :1110-1117: 'schedule run --action self_improve' step
- aria-kernel/aria_kernel/self_improvement.py:275-277: scan_signals imports run_doctor and runs the full doctor again
- aria-auto-cycle.yml:950-953 comment: doctor 229 s and self_improve 245 s measured on the 2026-10-10 store

### NOTE-13 — first CI self_improve opens doctor_fail:deadlines as a SELF_CHANGE mission driven by lapsed HR SLAs (ARIA-MEDIUM-128 pin)

At 4535de11a the deadlines organ is routed to deadline_due (announce only), so a lapsed HR SLA no longer mints a SELF_CHANGE mission. A test pins this, and production mission-events holds no such mission.

Evidence:

- aria-kernel/aria_kernel/self_improvement.py:66-75: DOCTOR_ORGAN_SIGNAL_KINDS maps 'deadlines' -> 'deadline_due' (ANNOUNCE_REMEDY), citing the f5c5c86a1 dry run with 228 lapsed HUMAN_REQUIRED SLAs
- git log -S: commit 0b88b2ccb 'fix(aria): the deadlines organ is announced and a blocked capability gap mints no mission' (2026-10-10) is an ancestor of 4535de11a
- aria-kernel/tests/test_self_improvement_remedy.py:16,93 pins that deadline_due is announced, never minted
- origin/aria/state:tools/missions/mission-events.jsonl: 0 rows mentioning deadlines (no stale mission minted)

### NOTE-14 — test_request_admission AThrottledPanelReMintIsDeferredNotResolved::test_deferred_this_sweep_reminted_the_next was red on a pre-fix snapshot

The test passes at the fixed commit 4535de11a: the class alone once, and the whole file twice in a row. The red result belonged to the pre-fix snapshot and does not reproduce on the code under review.

Evidence:

- pytest tests/test_request_admission.py::AThrottledPanelReMintIsDeferredNotResolved at 4535de11a (read-only checkout, no cache/bytecode): 1 passed in 25.93s
- pytest tests/test_request_admission.py (whole file) twice: 30 passed, 4 subtests passed (193 s, 202 s)
- aria-kernel/tests/test_request_admission.py:441-444 is the test class/method in question

### ARIA-MEDIUM-560 (NOTE-15) — genesis launcher: a drafted adapter may reach a capability through an already-loaded allowlisted module

Confirmed by repro: a drafted adapter can import preloaded modules such as os and use audited but unrefused calls (os.remove/rename/rmdir/mkdir/chmod/symlink/truncate) that the launcher hook lets through. Two things contain it today: the adapter room mounts the workspace read-only, and genesis currently never reaches a run (ARIA-MEDIUM-507). So this is a defence-in-depth gap, not a live escape, and it should be closed before genesis is repaired.

Evidence:

- tools/aria-poc/genesis_adapter_launcher.py:66-79 (\_audit): refuses import, **code** set, code.**new**/marshal, open-for-write, os.system/exec/spawn/fork/kill, subprocess., ctypes., socket., threads, tracing; nothing else
- Repro (scratch dir, launcher from 4535de11a, ALLOWED_ADAPTER_IMPORTS header): adapter source 'import os; os.rename(victim, moved); os.remove(moved)' exited 0 and deleted the file; 'pathlib.os' is a module. 'import os' raises no import event because os is preloaded
- aria-kernel/aria_kernel/genesis_adapter_custody.py:190-193: drafted bytes run only through prepare_adapter_spawn (adapter room, workspace bound read-only per adapter_room.py:26-41)
- Registry ARIA-MEDIUM-507 (OPEN): skill genesis has no working path today; ARIA-HIGH-414 (OPEN) is the dynamic-import half, a different bypass

### ARIA-LOW-561 (NOTE-16) — implementers that append '2>&1 | tail' to validation commands now get refused turns by the Bash gate

The refusal is the correct security behaviour, but the implementer contract never tells the agent that pipes and redirects are refused. Habitual '2>&1 | tail' validation commands therefore burn turns out of a 10-12-turn budget. Production already shows 34% of Bash decisions denied, including 6 control-operator refusals.

Evidence:

- aria-kernel/aria_kernel/command_policy.py:132: CONTROL_OPERATOR_CHARS = frozenset('|&;()<>\n'), so '2>&1 | tail' is refused as a shell control operator (correctly, after ARIA-CRITICAL-446/HIGH-505)
- grep of .claude/agents/aria-implementer.md and \_shared/aria-implementer-safety-contract.md: no mention of pipes, redirects or the gate grammar
- origin/aria/state:tools/hooks/decisions.jsonl: 137 decisions, 47 denied, 6 'BashDenylistHit:shell_control_operator', plus many BashAllowlistMiss for grep/sed/cat/wc; stored rows carry no command text, so the '2>&1|tail' form itself is not countable

### ARIA-LOW-562 (NOTE-17) — each lease reap with an expired claim parses the full 25.7 MB governance.jsonl

Each reap sweep that finds an expired claim parses and verifies the whole 25.8 MB governance ledger (once per sweep, not per claim) just to find each claim's attempt route. That is avoidable CPU and memory on the shared runner, in the same OOM-churn class as ORPHAN-HIGH-794, but it is bounded and causes no incorrect behaviour.

Evidence:

- aria-kernel/aria_kernel/agent_invocations.py:7081-7091 (reap_stale_claims): on the first expired claim of a sweep, load_declared_jsonl(root/'governance.jsonl', expected_surface='tools_governance') is parsed and verified in full for attempt_providers_by_claim, plus provider_clock(root)
- aria-kernel/aria_kernel/provider_outage_ledger.py:154-157: outage_intervals also loads the whole governance.jsonl
- git show origin/aria/state:tools/governance.jsonl | wc -c -> 25,773,671 bytes
