# ARIA — the live chain's blockers, verified and closed (2026-09-12)

Context: the Codex→Claude ARIA takeover (`docs/reviews/claude/2026-09-11-*.md`)
reached the first native CONVERGED plan on 2026-09-12 11:18Z (trial ten, plan
`flow-85199a4b5051d7b27f16`: Codex challenger → Claude cross-review → Claude
primary revision → Claude challenger → Claude cross-review → `converged`, two
rounds). An external LLM audit of the live store (items B1–B8) was verified
against the candidate and `origin/aria/state` by eight independent agents
(workflow `wf_171bf59b-f6a`); what survived became this document's findings,
implemented in isolated worktrees, each adversarially verified by a second
agent, fixed to the verifier's must-fix list and re-verified before
integration. Verification summary:

| Item                                        | Verdict                                                                           | Where it lives now                   |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| B1 memory hook kwarg                        | fixed on the candidate (4f4918c88); main still carries it                         | caller/callee AST pin, this doc      |
| B2 `.lock` blobs block `aria/state` publish | confirmed live                                                                    | ARIA-HIGH-090                        |
| B3 challenger never returns → 0 CONVERGED   | mechanism refuted (CL-1 #1281 fixed it 08-19); live silence has an upstream cause | this doc (mission candidate section) |
| B4 doctor false-green                       | refuted (documented design); adjacent funnel-organ blindness confirmed            | this doc (funnel section)            |
| B5 twin history dead (fetch-depth 1)        | confirmed live                                                                    | this doc (full-history section)      |
| B6 self-improvement disconnected            | confirmed live (daemon dead, no schedule, no dispatcher)                          | this doc                             |
| B7 conventions.jsonl never created          | confirmed live (no CONVERGED + signer bound to pr_create)                         | this doc                             |
| B8 results stopped 08-25                    | confirmed live; the date is a red herring (cost gate refused 100% of 09-04)       | this doc                             |

## ARIA-HIGH-090 — one publisher for `aria/state`; publish heals what a bypass admitted

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence:** `git -C /var/aqua-saas ls-tree -r -l origin/aria/state | grep '\.lock'`
  → 16 zero-byte side-cars on tip `84032eda1`; the candidate's tree contract
  (`autonomy_evidence`, refuse-unclaimed-entry) run against that tip refuses
  `state_snapshot_unclaimed_tree_entry:tools/cycles.jsonl.lock`; no
  `chore(aria-state)` publish since `00d97a0a9` (2026-09-04); all eight later
  commits are `chore(state): automated compaction` from
  `.github/workflows/aria-state-maintenance.yml`, which committed with an
  unbounded `git add -A`; the full verifier also refuses the tip with
  `state_snapshot_surface_mismatch:memory_beliefs` because compaction rewrote
  ledgers without rebuilding `snapshot.json`.
- **Root cause:** two publish paths with different staging contracts wrote the
  same branch. The kernel's publish stages a bounded pathspec ("deliberately
  NOT the subtree prefixes") and proves the committed tree carries only
  attested entries; the maintenance lane ran `state compact` (which takes
  per-surface `file_lock`s, leaving POSIX side-cars on disk by design) and
  then `git add -A`, admitting the side-cars and a stale attestation. Every
  kernel publish after that inherited the entries, could not remove them, and
  was refused by its own gate — the gate was right; the lane bypassing the
  primitive was the defect.
- **What is now true:**
  - `aria-state-maintenance.yml` publishes through `aria_kernel state publish`
    (shell add/commit/push deleted); `tests/invariants/aria-single-publish-path.spec.ts`
    forbids any workflow that pushes `aria/state` with git or adds the whole
    tree (fails 4/4 against the pre-fix workflow).
  - Publish is self-healing: `state_tree_contract.classify_inherited_tree`
    classifies every parent-tree blob against the manifest (contract file /
    declared surface / unclaimable, lock side-cars decoded through
    `file_lock.lock_sidecar_target` — the exact inverse of
    `lock_sidecar_path`, no second `.lock` literal; group lock files
    recognised through `state_manifest.state_group_lock_group`);
    `state_store.prepare_publishable_snapshot` — the one preamble both the CLI
    and the contention-replay orchestrator run, under the lifecycle lock —
    records `state_publish_inherited_entries_dropped` (parent sha, path, blob
    id, reason) BEFORE touching the index, drops the unclaimable entries
    index-only (`git rm --cached`, blobs stay in the parent), and builds the
    snapshot; `publish_state` refuses by name
    (`state_publish_inherited_unclaimed_entries_unhealed`) if a caller skipped
    it. A governance chain the append refuses is the named
    `state_publish_governance_ledger_unreadable`; oversized inline lists are
    spilled through `ledger_inline.spill_oversized_inline` so the row can
    never exceed the ledger's own cap.
  - Compaction attests its prune: `state_compacted` rows carry `pruned_paths`;
    `state_continuity_gate.vouched_continuity` refuses `chain_broken` by name
    regardless of ack, accepts `surfaces_lost` only for losses a compaction row
    appended since the published tip names (never a write-driving ledger), and
    an ack-accepted unattested loss leaves `state_publish_losses_accepted_by_ack`
    with the ack validated against the repo identity. The maintenance lane
    therefore publishes without the bootstrap ack; a `workflow_dispatch`
    input `state_reduction_ack` is the operator's one-run lever, exported to
    the publish step only.
  - The committed `snapshot.json` follows from publishing through the kernel;
    `test_state_publish_maintenance` checks the committed claim against the
    committed compacted blob.
- **Live repair:** automatic. The first kernel publish from any lane whose
  restore exports `ARIA_STATE_BOOTSTRAP_ACK` drops the 18 unclaimable inherited
  entries (16 side-cars, `tools/repo_identity.json`, `tools/integrity_index.json`),
  records the row naming parent `84032eda1`, accepts the 9 phantom hot-artifact
  paths the stale manifest claims as `surfaces_lost` under the standing ack,
  claims the 5 compaction archives, builds a fresh `snapshot.json`, verifies and
  fast-forwards. No hand edit of the state branch — a second publish path is
  the defect this closes.
- **Proof (candidate, 2026-09-12):** `test_state_tree_contract`,
  `test_state_publish_maintenance`, `test_state_continuity_gate`,
  `test_state_compact` (20, see ARIA-MEDIUM-089), `test_state_store`,
  `test_file_lock_and_claim_idempotency`, `test_state_manifest_transaction`,
  `test_workflow_kernel_cli_contract`, `test_ci_workflow_invariants`,
  `test_state_writer_attestations`, `test_executor_state_publish_gate`,
  `test_cli_state_subcommand_routing`, `ReadOnlyStateAdmissionTests`,
  `test_ledger_roster_invariant`: 253 passed; jest
  `aria-single-publish-path` + `aria-single-restore-path`: 10 passed. Pre-fix
  reproduction on `bd74c801c`: a whole-tree-added lock side-car makes the next
  publish die with exactly the live refusal and soft-reset; a `chain_broken`
  snapshot with no losses was published by the first draft of the gate and is
  refused by the shipped one (the verifier's falsification probe).
- **Independent verification:** verifier `wf_00c868e8-647` (integrate after
  fixes: chain_broken refusal, ledger-error mapping, group-lock decode,
  ack row, lock ordering) → fixer + re-verifier `wf_9fc9fb30-840` (integrate;
  its own probe shows both chain_broken tests fail on the loss-list-gated
  shape and pass on the status-gated gate).

## ARIA-MEDIUM-089 — three declared tests were never collected

`tests/test_state_compact.py` carried its `if __name__ == "__main__"` guard
mid-file; the three ORPHAN-CRITICAL-805 artifact-index tests below it were
declared and never collected (14 collected on `bd74c801c`, 20 now), and their
fixtures were date-bombed (fixed 2026-09-04/08-10 cycle stamps the 7-day sweep
removes; a hash without the `sha256:` prefix `verify_artifacts` compares). The
guard is last, the fixtures are clock-relative and writer-shaped, and all three
are green. Closed by the same commit as ARIA-HIGH-090.

## ARIA-HIGH-092 — the self-improvement lane is connected

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, 2026-09-12):** no `gateway/schedules.jsonl` and 0
  `gateway_schedule_changed` rows on `origin/aria/state`; `aria-gateway.service`
  last beat 2026-09-08T09:41Z, unit disabled/inactive, no doctor organ reading
  it; `open_self_improvement_missions` reachable only from the scheduler's
  `self_improve` action and the operator CLI; `propose_self_change` had no
  kernel caller — the orchestrator's mission branch forwarded a mission's
  `next_action` as `recommended_action` prompt prose to `aria-autonomy-planner`.
  The I-V12-SELF invariants proved the module in isolation and that the action
  word exists in the vocabulary — the ORPHAN-694 false-close class.
- **What is now true:**
  - Schedules exist by construction: `gateway/default_schedules.py` holds
    `DEFAULT_SCHEDULES` (doctor every 30 min; self_improve 05:45Z and economy
    05:50Z before the 06:00Z daily report reads the store; deliver 06:30Z, a
    notification) and `OPERATOR_ONLY_ACTIONS` (cycle, drain, daily_report,
    telemetry_export, inbox_drain, experiment_night — each with the cadence
    owner that would double-fire). `run_gateway_daemon` ensures the defaults
    once per start under the host lease, seeding only names the ledger has never
    seen (operator remove/pause/re-add honoured; code-vs-ledger drift reported
    on `gateway_daemon_started.schedules_drift`, never rewritten); an invariant
    asserts every `SCHEDULE_ACTIONS` member is in exactly one partition.
  - A real dispatcher: `mission_dispatch.NEXT_ACTION_CONTRACTS` (builders only)
    and `GENERIC_PROJECTION_POINTERS` (a mandatory reason, the source kind and
    a named consumer — `plan_synthesizer.scan_github_issue_missions` for issue
    triage) partition every `*_NEXT_ACTION` pointer; an AST invariant asserts
    each contract pointer is compared against somewhere outside the CLI and
    the table itself. A self_improvement mission with
    `next_action == propose_self_change` mints `aria/self-change-request/v1`
    (`self_change_bridge`: must_satisfy evidence_paths / problem /
    proposed_change, kernel-scope allowed_scope); on acceptance the bridge calls
    `propose_self_change`, which refuses at the authority boundary before any
    write — `self_change_mission_terminal`, `_operator_held`, `_moved_on`
    (pointer no longer propose_self_change), `self_change_adjudication_already_open`
    — so a stale second answer cannot re-park a mission the operator moved on
    or open a second adjudication; the drain de-duplicates per mission
    (`in_flight_mission_request`), not per queue item; `self_improvement` joins
    `mission_scheduler.SOURCE_RANK` below finding and above pressure.
  - Doctor organ `gateway_heartbeat_fresh` FAILS when the heartbeat is older
    than five beats of the cadence it declares, or absent while a schedule
    table exists; a dead daemon is now a `doctor_fail` self-improvement signal.
- **Operator action (parked):** `aria-gateway.service` on the runner host stays
  disabled; nothing in this change starts it. Re-enabling is
  `docs/runbooks/aria-gateway.md`'s procedure (refresh the unit's code root,
  confirm the env, `systemctl enable --now`, then `aria-kernel schedule list`
  shows four `kernel:default_schedules` rows and `aria-kernel doctor` reports
  `gateway_heartbeat_fresh` ok). Until then `aria-kernel doctor` on the live
  store exits 3 on that organ — the intended readout.
- **Proof (candidate):** `test_self_change_bridge`, `test_gateway_default_schedules`,
  `test_phase_v12_i_self_improvement`, `test_doctor`, `test_requeue_fault_ownership`,
  `test_safety_control_reachability` and the gateway/scheduler/synthesizer
  modules — see the commit; the daemon-wiring tests discriminate (2 failed on
  the module-present/daemon-unwired shape), the two-in-flight tests fail with
  the guards removed. Verified by `wf_284f4dbe-940`; fixed and re-verified
  (integrate) by `wf_f4cb3a2b-f0a`.

## ARIA-MEDIUM-093 — the release-reason invariant read the wrong seam

`tests/test_requeue_fault_ownership.py::test_every_executor_release_reason_is_classified`
scanned `ci_executor.py` with a text regex for any `reason="..."` literal.
When the native fleet landed, its admission observations
(`control_reason="native_readonly_runtime_prepared"`, `"sandbox_unavailable"`,
`"supported_auth_status_unavailable"`, …) matched the regex, and the
invariant has been red on the candidate ever since — four independent
verifiers reported the identical six-entry list. The scan now walks the AST
for `_release_claim(..., reason=...)` calls and collects the literal (or each
branch of a conditional): twelve release reasons, all classified;
parameterised f-string reasons stay owned by the prefix tables.

## ARIA-HIGH-094 — opus is a leaf; credit exhaustion cools the provider and requeues

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Operator decision (2026-09-12, delegated):** ARIA never downgrades a
  decision or an implementation to sonnet. Credit exhaustion is a
  provider-level fact: read-only roles are re-admitted on the next vendor
  after a cooldown; write-scope roles (implementer, worker), which only the
  managed Claude route can run, requeue under the cooldown and are retried
  when opus is back.
- **What was wrong:** `MODEL_FALLBACK_TIER = {fable→opus, opus→sonnet,
sonnet→glm-5.3, glm-5.3→opus}` retried an exhausted opus on sonnet at
  `CREDIT_FALLBACK_EFFORT` for every role — the verifier's real executor child
  spawned `['opus', 'sonnet']` on the base; `provider_cooldown_seconds`
  (genesis policy, 900 s) had no reader anywhere and `claude auth status`
  reports quota as unknown, so nothing ever cooled a provider; the worker
  lane re-claimed and re-spawned an exhausted opus every iteration with no
  back-off.
- **What is now true:** the ladder is data that states the decision —
  `AUTH_FAILOVER_TIER = {opus: glm-5.3, glm-5.3: opus}`, consulted only for
  AUTH failures, and `run_with_model_fallback` takes the profile's
  `write_capable` fact so a rung whose provider does not admit writes
  (`model_fleet.Provider.admits_writes`: anthropic True, zai/openai False) is
  never taken for a writer; `MODEL_FALLBACK_TIER`, `CREDIT_FALLBACK_EFFORT`,
  the refusal retry and the fable rung are deleted. Exhaustion raises
  `ClaudeCreditExhausted` with provider/model/detail; `ci_executor` records
  `provider_quota_cooldown` (new `aria_kernel/provider_cooldown.py`, the
  first reader of `provider_cooldown_seconds`; a malformed row is refused by
  name, never re-admits) and releases the claim REQUEUED under
  `provider_quota_unavailable:<provider>` (a harness fault, budget intact);
  `_native_runtime_admission` refuses a cooled provider without a probe and
  refuses read-only runtimes for write-capable profiles
  (`provider_readonly_runtime`). The worker lane records the same cooldown
  under `--claim-id`, honours `active_provider_cooldowns` before claiming
  (`provider_cooldown` status, no claim, one governance row) and the
  scheduler backs off one poll interval. Prose follows code in the runtime
  modules, `docs/aria/CURRENT_STATE.md` and `ARCHITECTURE.md`; the
  maintenance-agent invariant that still expected fable for a planner is
  opus.
- **Consequence to know:** on the legacy (non-adaptive) lane every opus
  exhaustion now lands as an `executor_environment_failure` breaker row
  (threshold 3 / 96 h); the declared `executor.adaptive_runtime` policy
  (ARIA-HIGH-095) makes the native lane the live path.
- **Proof (candidate):** credit-fallback, runtime-contract, fable-selected-by-
  nothing, maintenance-agent, runtime-profile, failure-classification,
  fleet/codex, admission-budget, auth-classification, requeue-ownership,
  glm-admission, state-guard, worker-lane/cooldown suites — see the commit;
  `test_ci_executor_native_claude` 5 passed (the native lane end-to-end: opus
  spawned once, REQUEUED under `provider_quota_unavailable:anthropic`,
  cooldown row 900 s, the second run refuses anthropic by name without
  claiming). Verified by `wf_284f4dbe-940`; fixed and re-verified (integrate)
  by `wf_5be8bcb2-3ca`.

## ARIA-HIGH-096 — mission candidate admission: no starvation, owners named, a dead orchestrator is a fault

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **What the audit said (B3) and what the store shows:** the 71
  `mission_candidate_refused reason=candidate_blocked` rows (2026-08-13 →
  09-04; joined to `tasks/task-candidates.jsonl`: 43 `genesis_adjudication_required`,
  15 `operator_feedback_required`, 13 unverifiable) did NOT kill the cycles —
  every run went on to `mission_schedule_decided outcome=selected`. The four
  `cycle_failed` exits (08-21, 08-22, 09-04 ×2) had their own recorded causes
  in `autonomy_state.jsonl` (a `product_fitness` `NameError`, a declared-
  surface rejection, `integrity_failed` from 158 `run_artifact_missing` rows
  plus one `test-gap-adapter budget_exceeded`), all fixed on the candidate.
  The mechanism was still wrong: `generate_task_candidates` cut the ranked
  list to ten BEFORE the adopter saw `blocked_by`, so permanently
  panel-blocked candidates held 5–7 of 10 slots nightly while admissible
  findings (60) and `unknown:*` gaps (70) below the cut were never offered;
  `_candidate_from_shadow_summary` minted the panel token as a constant with
  no route (100 % refused, six contract-less missions nothing could heal);
  the refusal named no owner; and the doctor had no organ for an
  orchestrator whose last runs all died the same way.
- **What is now true:** `task.generate_task_candidates` partitions three
  ways — `tasks` (admissible top-N), `routed_to_panel` (every block token
  owned by the agent panel; disclosed, never offered, so no refusal row can
  exist for it) and `blocked` (operator-owned or unregistered tokens);
  `mission.adopt_task_candidates` discloses a refusal once per claim
  (`append_tools_governance_once` keyed on reason/source/source_id/blocked_by/owner);
  payload and row carry schema v2 because their meaning changed.
  `candidate_blocks` maps every producer token to owner + operator action
  from a closed vocabulary, pinned by an AST invariant over the producers.
  The shadow-summary producer is retired (`mission.RETIRED_SOURCE_KINDS`) with
  `mission_retired_sources.supersede_retired_source_missions` closing only
  pre-WIP, contract-less missions and declining every other shape by a total
  verdict table (operator_held / work_in_progress / wake_pending /
  outcome_observing / contracted), so a live branch is never abandoned.
  `orchestrator_exit_history` joins the last N exits to their recorded
  causes and the refusal histogram; doctor organ `orchestrator` FAILS an
  all-`cycle_failed` window (the live store reads
  `orchestrator_exits_all_cycle_failed:3`, naming the causes).
- **First live cycle after this lands:** one
  `mission_superseded_producer_retired` row closing the six shadow-summary
  missions (closure violations 14 → 8); four v2 refusal rows for the
  operator-owned `fitness:*` gaps the v1 cut used to drop silently, none on
  later nights; the panel-owned `shadow_run:*` gaps routed, not refused.
- **Not done here, tracked:** ARIA-HIGH-097 (the adjudication panels'
  verdicts are dropped at the executor bridge, so the genesis block never
  clears) and ARIA-HIGH-098 (one adapter timeout fails the night) — both
  found by this lane, both their own findings.
- **Proof (candidate):** retired-sources, exit-history, adopt-blocked-guard,
  candidate-blocks, doctor, mission-ingest, genesis-foundation, autopr-
  foundation, ledger-first-readers, unobserved-surface, evidence-normalization,
  service-dimension, wip-gate and mission suites — see the commit; on the
  pre-fix kernel the new tests fail with `7 != 8` (starvation),
  `KeyError: 'blocked_by'` / `'owner'` and a missing organ. Verified by
  `wf_00c868e8-647`; fixed and re-verified by `wf_81bc51a5-8a0`.

## ARIA-HIGH-097 — adjudication panels answer, and nothing can read the answer

Found by the B3 lane on `origin/aria/state 84032eda`: 73 human-required
adjudications opened (52 escalations), 159 panel requests, 92 results (80
accepted) — and 215/215 `human_required_adjudication_folded` rows are
`still_escalated` with `insufficient_dispatched_roles:0<2`. The panels ARE
dispatched and accepted; `_build_envelope_from_claude_output`
(`tools/aria-poc/ci_executor.py`) passes through only `evidence_refs`,
`details`, `notes` and `plan_content`, so the adjudicator's top-level
`verdict`/`disposition` is dropped and `human_required_adjudication._load_opinion`
reads `None`: 0 of 102 live envelopes carry a loadable verdict (the
adjudicator wrote the diagnosis into its own output). Twelve more results
were rejected because the `human-required:<id>` evidence refs the kernel
mints fail the acceptance gate's ref check. Fix shape: an envelope contract
for the adjudication role carried by the bridge and validated pre-submit
like the judge verdict block, a round-trip test from agent JSON to
`fold_adjudication`, and the Z2 ref spelling admitted. Owner claude; open.

## ARIA-HIGH-098 — one adapter timeout fails the night

`cycle._runtime_status` returns `integrity_failed` for any non-ok tool run
OR an invalid artifact index; the orchestrator fails closed on it. On
2026-09-04 09:41 `test-gap-adapter` exceeded its 180 s budget
(`budget_exceeded`, 180 651 ms; the same tool ran in 91 s that evening) and
the morning cycle was `cycle_failed` — planning never ran while the store's
integrity was untouched. A tool SLA miss needs its own status the
orchestrator does not fail closed on when the index is valid, and a first
`budget_exceeded` should be a calibration/pressure signal (retry or
re-budget), not a dropped night. Owner claude; open.

## ARIA-HIGH-095 — the executor admission chain admits, prices, releases and fails loudly

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, B8):** the 82 requests minted on 2026-09-04 got 0
  results — the ARIA-AUDIT-021 spawn cost-reservation gate refused every
  dispatch before the CLI ran: neither `aria-config/genesis_policy.json` nor
  the kernel default declared `executor.adaptive_runtime`, so
  `_adaptive_runtime_policy()` returned None on the live lanes (the native
  fleet never engaged) and the metered gate priced the profiles' raw aliases
  (`opus`, `fable`) as unknown = deny and `glm-5.3` (0.8416) against the 0.5
  `per_run` cap; each refusal then crashed in the summary writer before the
  lease was released, leaking 7 claims (`ci-executor:gha-33920896040`); the
  self-hosted runner has been offline since 2026-09-08 09:48Z and every
  scheduled run has queued with 0 jobs and been cancelled by the next
  schedule's concurrency group — green by absence.
- **What is now true:**
  - One pricing road: `budget.price_spawn_reservation` prices the alias
    through the same `ALIAS_PRICING_PREFIX → price_tokens` map the ledger
    uses; the gate and the fleet's admission row both call it and an AST pin
    over `aria_kernel/` and `tools/aria-poc/` refuses any other multiplication
    of the reservation ceiling; `opus` reserves at the claude-opus row, an
    unknown model still denies by name.
  - A lease is released on any exit: `ci_executor_lease.HeldClaim` is entered
    on the runtime ExitStack the moment a lease exists and hands the claim
    back on any unwind under the kernel-owned harness reason
    `executor_uncaught_exit:<class>` (a ci-stage line names it).
  - The operator's stated policy is declared where the kernel reads it:
    `aria-config/genesis_policy.json` carries `executor.adaptive_runtime`
    (`monetary_admission: managed_subscription`) and `executor.worktree_per_request: true`
    with `max_concurrent: 1` (one-way door 16 is about concurrency, not
    per-request worktrees): under the declared policy the native admission
    binds `request.target_sha == checkout HEAD`, so each request is drained
    in a worktree at its own target_sha inside the checkout
    (`aria-worktrees/`, git-ignored; node resolution walks up to the parent's
    `node_modules`; the nx cache lands under the worktree; leftovers pruned
    before `add`); the child reads the operator policy from the store's bound
    workspace root, never from the worktree's tree. An invariant fails when a
    metered cap admits no dispatchable profile model.
  - A task-binding refusal is a typed `_NativeAdmissionRefusal` that writes a
    named `refused` summary; the drain counts only a `succeeded` summary as
    drained and names silence as `child_without_summary`; every by-design
    exit-0 terminal of `_main` names itself.
  - Runner absence is red, not silent: `.github/actions/require-self-hosted-runner`
    (`aria_kernel.runner_availability`, App token with `administration:read`
    only) runs as a hosted preflight job the executor, auto-cycle,
    daily-report and dataflow-watchdog lanes `need`; it exits by name
    (`required_runner_offline`, `no_runner_registered`,
    `required_labels_unmatched`, `runner_status_unreadable`) — the live probe
    reproduces `required_runner_offline (offline=['suderra-droplet-claude'])`.
- **Known residual (tracked as ARIA-MEDIUM-099):** a child whose CLI ran to
  completion but whose SUBMIT then fails still carries the `succeeded`
  summary and is counted as drained.
- **Operator:** bring `suderra-droplet-claude` back online when the PRs land;
  until then every scheduled self-hosted run fails RED at `runner-preflight`
  with `required_runner_offline` — the intended signal. Confirm the ARIA
  GitHub App holds `Administration: read-only` (an ungranted App fails the
  preflight with `runner_status_unreadable: http_403`, never a silent pass).
- **Proof (candidate):** pricing, spawn-budget-gate, claim-lifecycle-leak,
  runner-availability, token-permissions, request-worktree, drain
  breaker/mode/refusal, artifact-path, v12 queue-and-release and state-guard,
  requeue-ownership, environment-contract, genesis-policy, workflow
  invariants and the live-path/native-claude smoke — see the commit; on the
  pre-fix kernel 14 of the new tests fail with the stated messages. Verified
  by `wf_00c868e8-647`; fixed and re-verified by `wf_5e9b9dbd-471`.

## ARIA-HIGH-100 — the memory-hook seam is pinned to its callee; the funnel can count a stall

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **B1 (memory hook):** the external audit was right that
  `MemoryHookImpl.record` required a kwonly `converged_plan` the orchestrator
  never passed; `4f4918c88` removed the parameter, but nothing pinned caller
  to callee and the call sat under `except Exception`, which turned a
  signature-drift `TypeError` into a `memory_hook_failed` governance row.
  Now `memory.memory_hook_runtime_faults()` is the closed set the seam
  catches (`GovernanceError`, ledger integrity/limit errors, knowledge-graph
  tamper/schema errors, `OSError`) and invariants I-V31-C2-07/08/09
  AST-extract the orchestrator's `memory_hook.record(...)` and
  `.complete_pending_observations(...)` keyword sets, assert equality with
  the protocol's, the NoOp's and the Impl's keyword-only parameters, pin the
  except clause to the declared set and exclude `TypeError`/`KeyError`/
  `AttributeError` — re-adding `converged_plan` turns I-V31-C2-07 red naming
  the drift; a `TypeError` now propagates out of `run_autonomy_orchestrator`.
- **B4-adjacent (funnel):** the effectiveness ledger
  (`knowledge-graph/pressure-source-effectiveness.jsonl`) never existed on
  `aria/state` — not stripped by compaction (its git log is empty) but never
  written: the only writer sat on the converged path after `auto_merge`, and
  no live cycle converged; and it would have landed in
  `<checkout>/aria-tools` (the writer resolved the workspace, the readers
  three different paths, none the store's tools root). The writer now sits
  at the funnel's entry (`_record_funnel_counter`: `minted` before the
  `cycle_runner_synthesized_plan` transition, `rejected` on the two
  non-converged exits, `converged` at the arbiter verdict, `merged` after
  `auto_merge`) so a store that mints and converges none has a countable
  convergence-stage stall; every reader and writer resolves the ledger
  through the bound tools root with `base_dir` required; the doctor's
  `funnel` organ moved to the store checks and judges an absent ledger
  against the orchestrator's own mint rows — only rows stamped
  `FUNNEL_RECORDED_DETAIL` (written after their effectiveness row) count, so
  the twenty pre-ledger rows on the live store are bootstrap, not loss,
  and the first doctor run after deploy does not open a `doctor_fail`
  mission nothing can clear; the `pressure`/`cycle` reader guards are
  narrowed to `effectiveness_reader_faults()` with a
  `pressure_source_effectiveness_unreadable` disclosure.
- **Tracked residual:** ARIA-MEDIUM-101 (`mission_scheduler._thompson_source_draws`
  keeps the wide guard).
- **Proof (candidate):** v3.1-C2 memory-hook invariants, doctor (incl. the
  pre-ledger-row case), effectiveness writer/durability, change-outcome,
  funnel self-diagnosis, learned-context, compaction, cycle-phases scaffold,
  convention-observation, pressure and scheduler suites, and the
  orchestrator's funnel/memory-seam subset — see the commit; on the pre-fix
  kernel the new tests fail (`'Exception' unexpectedly found`, `TypeError not
raised`, the row written to the checkout, `KnowledgeGraphTamper`
  escaping, doctor `ok` with sources=0, counters `{}`). Verified by
  `wf_00c868e8-647`; fixed and re-verified by `wf_06256544-bfc`.

## ARIA-MEDIUM-102 — two candidate-only tests contradicted their contracts

Both arrived with the Codex integration (`4f4918c88`) and were reported as
pre-existing reds by four independent verifiers. (1) The memory hook's
replay test demanded a `LedgerIntegrityError` on a torn trailing governance
record; the ledger's contract (ORPHAN-CRITICAL-561) is that a torn tail was
never acknowledged to any caller, is tolerated on read and healed by the
next append — refusing would strand every pending observation behind one
interrupted write. The test now pins that contract (the verified prefix is
left byte-identical, the first append heals the tail, the observation is
completed). (2) The convention-history test demanded that
`_has_recorded_convention` refuse a row under an unknown `schema_version`,
but `_observation_rows` verified both chains and no row schema, so a row the
current schema cannot read could hide a conflicting observation.
`_pattern_from_row` is now the one projection every reader uses (chain
verification, then schema per row), shared with the promotion reader; and
because the ledger stamps a silent row with its own format version (2), the
conventions writer states `KNOWLEDGE_GRAPH_SCHEMA_VERSION` on every Pattern
row before the ledger sees it — the mixed native/declared history the
historical-defaults test exercises stays readable, an explicit unknown
schema is refused.

## ARIA-HIGH-103 — the plan contract: what staging will demand, the planners are told and the gate enforces

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Proven 2026-09-12:** the first native CONVERGED plan
  (`flow-85199a4b5051d7b27f16`) could not be staged. Running
  `apply_engine.stage_converged_plan_for_pr` on a copy of trial ten's store
  under the strict profile refused `stage_validation_command_not_declared`
  (`npx nx run shell:test` — a plan-authored command the lane runs outside
  the implementer sandbox, so the set is operator-declared) and, behind it,
  `stage_requires_architectural_tier` (the body carried no tier). No
  planning contract, envelope or validator stated either rule — the
  ARIA-HIGH-078 class — and by the time staging fired the plan was CONVERGED
  and immutable.
- **What is now true:** `plan_contract.py` is the one owner of both rules
  with a closed refusal vocabulary (`plan_architectural_tier_missing`,
  `plan_architectural_tier_invalid`, `plan_validation_command_not_declared`,
  `plan_validation_recipe_unknown`). AUTOMATIC: every planning envelope
  (challenger, cross-review, primary revision, the native controller's mints)
  carries a store-rendered `plan_contract` block — the tiers with their
  CLAUDE.md meanings, the canonical executable suite, THIS store's registered
  recipes — rendered as a `## Plan contract` section in the sealed prompt
  (legacy rows render byte-identically); `render_response_validator_contract`
  states the same rules; the three planner agent files, the layer-2 skeleton
  and CONTRACTS.md §12.15 mirror them, pinned by a test that every canonical
  spelling and reason appears in both mirrors. IMPOSSIBLE:
  `submit_claim_result` rejects a planner envelope that breaks the contract
  (claim released for retry, never accepted-then-dead); the executor's
  pre-submit gate reads the same check (an unnamed store is a named error);
  `submit_challenger_plan`/`record_revision` refuse in the command path only,
  so historical `plan_started` folds keep replaying; `evaluate_plan` records
  a `plan_contract_complete` gate row that turns CONVERGED into
  NEXT_ROUND_REQUIRED, and the drainer carries every refused entry into the
  primary revision as escaped data under one obligation per reason code
  (trial ten's seven undeclared commands all travel; angle brackets are
  escaped so plan-authored text can never spell a tag outside the untrusted
  block). Staging resolves declared commands through the same resolver.
- **Also closed on the seam:** `_validate_validation_command` now accepts
  `{recipe_id}` (staging resolved it but no plan could carry it);
  `record_implementation_outcome`'s `completed_at` is stamped by the bridge
  (no contract asked the implementer for it, so every result would have
  died); the implementation prompt and `aria-implementer.md` state the
  recorder's `details.implementation` shape and the real content-hash
  obligation.
- **Not done, tracked as ARIA-HIGH-104:** five more implementer→merge
  contract gaps the lane listed.
- **Consequence:** round-one convergence is unreachable for a kernel-
  synthesized seed (no tier) — every autonomous plan converges through the
  primary's round-two revision. Registering a recipe between two mints of the
  same round yields a new request id (the block is in the request fold).
- **Independent verification:** `wf_6dbb11ea-0ba` replayed the REAL trial-ten
  ledger through the new kernel: it folds (CONVERGED, round 2) and the gate
  names the eight violations that killed staging.

## ARIA-HIGH-104 — five implementer→merge seam gaps no contract states

Listed by the plan-contract lane while reading the implementation envelope
and the gates behind it: (1) `aria/agent-request/v1` lists
`validation_commands` as REQUIRED and the prompt prints a "Validation
commands" section, but `create_agent_invocation_request` never writes the
field; (2) `auto_merge._HYGIENE_DIMENSIONS` demands a verified exit-0 run
containing `format:check`, outside `CANONICAL_VALIDATION_COMMANDS` and named
by no obligation; (3) `aria-implementer.md` reads `key_changes[].file` while
the skeleton defines strings and the synthesizer emits `paths`; (4) the
`Closes:` trailer it mandates does not fit a plan-originated change keyed
`plan:<plan_id>`, and no gate checks it; (5) kernel-minted `must_satisfy`
items carry `{id, kind, description, source}` while
`agent_contract._ensure_must_satisfy` requires `{id, statement}`. Owner
claude.

- **What is now true (three verified rounds):** (1) the queue row IS the
  `aria/agent-request/v1` envelope — `create_agent_invocation_request` writes
  `$schema`, `forbidden_scope` and `validation_commands` (derived from the plan
  revision the row names: the CONVERGED body for the implementation role, the
  seed's for planners) and, for the implementation role, runs
  `validate_request` BEFORE the append, so a refused envelope never reaches
  the queue and the plan stays CONVERGED; the drainer refuses a seed whose
  commands the contract does not admit before opening the plan. (2) ONE
  validation suite: `CANONICAL_VALIDATION_COMMANDS` grew `npm run
format:check`, `auto_merge._HYGIENE_DIMENSIONS` IS that tuple,
  `canonical_command_satisfied_by` is the one matching rule shared by the
  pre-PR-open check and the hygiene battery, staging reads the suite through
  `plan_contract.plan_validation_suite`, and `command_policy` derives an allow
  rule per executable spelling so the implementer can run what it is told to
  run. (3) ONE `key_changes[]` shape — `plan_convergence.KEY_CHANGE_FIELDS =
(id, description, paths)` with a plan-contract reason; staging, the
  envelope, the orchestrator and both implementer prompts read `paths`, and
  the prompt invariant derives the citable fields from the tuple. (4)
  `plan_origin.py` derives the commit contract from the plan's origin (the
  exact `Closes:` line for an ORPHAN origin; trailer-free commit types for an
  origin the CI checkout cannot resolve or a plan with none), it rides on the
  envelope as `commit_contract`, the prompt prints it verbatim, and the 18th
  pre-PR-open hard-fail check `commit_contract_honoured` refuses a branch
  whose commits carry anything else; the mirrored gate regexes are pinned
  against `tools/gates/commit-msg-validator.ts`, and the kernel's
  `FINDING_ID_RE` is the one source for F-ids. (5) `must_satisfy.py` is the one
  obligation shape `{id, description, kind?, ...data}` — every producer moved
  (`statement` and the seven lanes' `criterion` are gone), sealed legacy rows
  are upcast at re-mint (`upcast_sealed_items`), and an obligation carries its
  kernel-authored statement in `description` and its quoted data (a node path,
  a critic's reason, a spine, a refused command) in typed data keys the
  banned-phrase scan never reads and the renderer prints delimited — the
  drainer's own carries had been refused by the scan and stuck the plan.
- **Proof (candidate):** `test_implementer_merge_seam` (a plan driven to
  CONVERGED, the real V9 runner under strict, the minted envelope validates,
  carries the suite and the trailer, the perimeter refuses an invented
  trailer), `test_must_satisfy_shape`, `test_request_contract_minter`,
  `test_validation_suite_ssot`, `test_plan_origin_commit_contract`,
  `test_convergence_drainer_carried_data`, `test_y7_self_adjudication`
  (legacy-row re-mint), the plan-contract, coverage, continuity, PR-manager,
  perimeter, merge-discipline and v9/v12 invariant suites — 841 tests on the
  candidate; every pin fails on `665213990`. Verified by `wf_b1186d0b-255`
  (verify → fix → reverify must_fix) and `wf_ab072ff3-aa2` (round 3, accept).

## ARIA-HIGH-105 — the kernel lanes check out a whole clone; a partial one is refused by name

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, B5):** `aria-auto-cycle.yml`'s single `actions/checkout`
  omitted `fetch-depth`, so the runner fetched `--depth=1` (the job log of
  the run that wrote the live map shows it); `twin._history_layers` runs
  `git log -n400` against that checkout, counted one commit and published
  `churn={}` `co_change=[]` as a healthy map; `_commit_known(prior
indexed_sha)` was false every run, so every refresh was a full rebuild
  (`refresh.reason=unknown_anchor`); and `agent_invocations._repo_is_shallow`
  had softened the anchor check ("neither ARIA lane overrides it") — one
  subsystem taught to tolerate a misconfiguration instead of the
  misconfiguration being fixed.
- **What is now true:** every lane that provisions the kernel declares
  `fetch-depth: 0` (auto-cycle, executor, eval, readiness-claim,
  capability-probe, kernel, kernel-fast; the state branch is the kernel's
  own depth-less fetch into a sibling worktree and needed nothing), pinned by
  `tests/invariants/test_kernel_lanes_check_out_full_history.py`, which
  derives the governed set from every `.github/workflows/*.yml` that uses
  `./…/setup-aria-kernel` or invokes `aria_kernel` (15 lanes; the external
  watchdog excluded by construction) and flags 7 violations on `bd74c801c`, 0
  now. `git_probe.is_shallow_checkout` is the one probe (only a literal
  `true` counts); the twin refuses a shallow checkout at the entry of both
  `build_twin_map` and `refresh_twin_map` (`twin_history_unavailable_shallow`)
  and a failed `git log` by name (`twin_history_unavailable`) — a dead layer
  is never publishable; the anchor gate raises
  `anchor_history_unavailable_shallow` BEFORE any claim event or
  `ANCHOR_STALE` row is written on a shallow clone, and on a full clone an
  absent anchor is `anchor_unreachable` again; the softening is deleted. The
  cycle fixtures are committed repositories through one helper.
- **First run after merge:** the persistent self-hosted workspace fetches
  `--unshallow` once (actions/checkout v7.0.1 does so when `.git/shallow`
  exists and `fetch-depth` is 0); the prior map's `indexed_sha` then
  satisfies `_commit_known`, so that run already refreshes incrementally
  with the history recomputed whole.
- **Proof (candidate):** anchor, twin-map, lanes-full-history, adjudication
  sweep, cycle-status invariant, workflow contract/hygiene, readiness-claim,
  runner-availability, v13-contracts, evidence-excerpts, enterprise-cycle and
  twin-cycle-wiring suites — see the commit; on the pre-fix kernel the new
  tests fail (`GovernanceError not raised`, the request returned on a
  shallow clone, 7 lane violations). Verified by `wf_00c868e8-647`; fixed
  and re-verified by `wf_5be8bcb2-3ca`.

## ARIA-HIGH-106 — the memory pillar never had a signer in the profile it runs under

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, B7):** the live store has no
  `knowledge-graph/conventions.jsonl`; every `memory_hook_recorded` row is
  `status=needs_signing`. The orchestrator handed `memory_hook.record(...)`
  a literal `signer_key_fp=None` on every profile, and the one knowledge
  signer lived inside the V9 implementation runner, behind `pr_create` —
  `on_signer_ready` was the only completion path and `standard` (every
  live cycle) never reached it. Separately, the cycle key's git signing
  config was snapshotted beside the key in the gitignored
  `aria-debts/keys/`, which the lane's `git clean -ffdx` wipes on every
  run: a cycle killed mid-window left `.git/config` naming a key that no
  longer existed, with nothing left to restore from, and a plain `git
commit` outside any mint window failed rc=128.
- **What is now true:** `cycle_phases.knowledge_signer` mints one
  ephemeral ed25519 identity per converged cycle for every profile
  holding the new `knowledge_record` cell of `ACTION_PERMISSIONS`
  (`standard`, `strict`, `autonomous`), registers the public half in
  `knowledge-graph/signers.jsonl` (`kg_signers`,
  `verify_convention_signer` re-derives the fingerprint after the key
  files are gone), signs the hypothesis row in the converging cycle,
  replays every earlier `needs_signing` disclosure (reasons
  `cycle_signer_unavailable` / `cycle_append_failed`) under the cycle
  signer, and revokes before the cycle proceeds; the V9 runner re-mints
  the same identity idempotently and no longer receives a callback. The
  memory hook's `except` stays the declared runtime-fault set (B1) and
  the funnel's `converged` counter (B4) is recorded before the seam. The
  mint/revoke pair is a transaction on the checkout's local signing
  config: the snapshot lives in `.git/aria-signing-config-snapshots/`,
  the startup prune unwinds every key-less snapshot with no age gate and
  a later mint inherits across crashed cycles, the workspace root is
  resolved once, and `_restore_git_commit_signing` returns a four-valued
  decision (`SigningConfigRestore`) — `undecided` (git timeout, unreadable
  snapshot) keeps the snapshot and the ownership marker for the next
  prune, which is sound because `user.signingkey` is released by the
  restore's last git call.
- **Found during integration:** the c2 memory-hook suite (19 tests) had
  been red on the candidate since ARIA-HIGH-103 — its private copy of
  the plan body no longer converged through the contract — and is now on
  the shared `converging_plan_content` fixture (with the memory pillar's
  `MIN_EVIDENCE_REF_CARDINALITY` stated by name); the 14 other suites
  that converge plans were run and are green.
- **Proof (candidate):** `test_knowledge_signer` (signer lifecycle,
  registry, revoke-before-proceed), `test_phase_v31_p_preconditions`
  I-B7-GIT-01…11 (transaction on the operator's config, pre-clean
  survival, inheritance across two crashes, relative/absolute root,
  undecided restore kept and finished, marker released last —
  I-B7-GIT-10/11 fail against both the unlink-on-False and the
  marker-first orderings), `test_phase_v31_c2_memory_hook_wire`
  I-B7-01…03 + I-V31-C2-07/08/09, `test_phase_v31_b3_orphan_reaper…`,
  `test_convention_observation`, `test_implementation_lifecycle_continuity`,
  `test_runtime_profile`, `test_ledger_roster_invariant`,
  `test_state_store`, `test_gh_token_factory_permissions`; 12 further
  plan-converging suites (182 tests). Verified by the B7 lane's
  before/edges/re-verify agents; the re-verifier's pass-2 residual is the
  `SigningConfigRestore` change.

## ARIA-HIGH-107 — a store's branch was assumed, not read; a never-restored store read as a broken chain

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, trial eleven, halka 3):** the kernel's own `autonomy run`
  against the converged trial store on a FULL checkout. Run 1 (21:23Z):
  no state-store worktree existed, so the committed daily anchors under
  `aria-tools/reports/daily/` became the continuity reference and the
  fresh probe was refused as `state_continuity_chain_broken:
expected_prev=<anchor root> got_prev=None` — a symptom, not the fact
  (the store was never restored). Trial ten's subset workspace carried no
  anchors, so it never saw this. Run 2 (21:49Z): a store bootstrapped with
  `state checkout --branch aria/state-trial-eleven-20260912` was opened by
  `resolve_continuity_reference` / `store_is_at_published_tip` through
  `open_state_store(repo_root)` with the DEFAULT branch, so
  `_publication_anchor` read `refs/remotes/origin/aria/state` and the
  verdict was `state_continuity_store_not_at_tip:head=<trial genesis>
tip=<production tip>` plus every production surface reported lost.
- **What is now true:** `store_lineage_branch` reads the branch from the
  `GENESIS` record at the lineage's single root commit — the worktree is
  detached by design (two stores must collide, not chain), so HEAD cannot
  say, and the genesis record is hash-chained under every publish since.
  `open_state_store` derives the branch from it, checks a caller-named
  branch against it (`state_store_branch_mismatch`) and refuses a lineage
  without a genesis record (`state_store_branch_unresolvable`); the CLI's
  `--branch` is the checkout target and an open-time check.
  `assess_memory_continuity` names a fresh probe against a committed anchor
  `state_continuity_store_not_restored:anchor=<root>` (run `state checkout`)
  and keeps `chain_broken` for a probe that names another predecessor.
- **Also in this commit:** the capability roster missed
  `mission_dispatch.py` as an observational reader of
  `agent_invocation_results`; `test_capability_specs_cover_discovered_
surface_writers_and_consumers` had been red since ARIA-HIGH-092's commit.
- **Proof (candidate):** `test_state_store` (TheStoreKnowsItsOwnBranch: a
  trial lineage is judged against its own tip, a named branch is checked,
  the branch survives a publish, a genesis-less lineage refuses),
  `test_memory_gap` (never-restored vs forked verdicts), the state-store
  and continuity suites (151 + 200), `test_autonomy_evidence_status` (135).

## ARIA-HIGH-108 — a probe that did not answer was admitted as a vendor refusal

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence (live, trial eleven, dispatch 3, 2026-09-12 20:42–20:51Z, load
  ~7):** the anthropic row observed `status_reason=status_timeout`
  (`claude auth status --json` past the 20 s `recheck_timeout_seconds`),
  `auth_observation=unknown`, controls unknown; `_native_runtime_admission`
  treated the row exactly like an auth refusal and admitted
  `openai/gpt-6-astra` for the primary plan, two dispatches after the same
  probe had answered `available`. The operator decision on record (opus
  is a leaf; a read-only role fails over cross-vendor on AUTH reasons
  only) forbids that. The inverse defect sat beside it: Claude Code
  2.1.269 prints `{"loggedIn": false, …}` AND exits 1, Codex prints `Not
logged in` and exits 1, and both probes tested the exit code before the
  document — a logged-out session would have read as a stall, been
  retried, and blocked the fail-over the decision allows.
- **What is now true:** `StatusDecision` (available / unavailable /
  undecided) is a required, contradiction-checked field of every status
  observation; `status_probe.observe_until_decided` retries only an
  undecided probe (3 attempts, 2/5 s backoff, one `AdmissionClock` per
  admission; `recheck_timeout_seconds` keeps its meaning as the per-attempt
  cap and the admission budget derives from it); `native_admission.py`
  owns the ladder — a provider is passed only on a DECIDED unavailable
  observation or a cooldown; the first provider in contention that stays
  undecided halts the admission as `provider_undecided` (no route, request
  PENDING, no attempt burned, harness-class release
  `native_runtime_provider_undecided`, the planner hook backs off one
  tick); a host that cannot bind its controls after a decided-available
  auth halts as `provider_control_unavailable` by name;
  `tools/aria-poc/status_answers.py` classifies the vendor's document or
  line before the exit code, so a logged-out session is DECIDED unavailable
  and fails over; every candidate row carries `decision` and `probe
{attempts, undecided_reasons, backoff_seconds}`.
- **Integration:** the two release-site invariants (v12 RELEASE_02 and
  `test_requeue_fault_ownership`) had two private AST walks of one
  property and disagreed on the refusal record's attribute; they now share
  one reading (`tests/_helpers/release_sites.py`). A Z.ai transport that
  does not answer is pinned through the ladder as `provider_undecided(zai)`.
- **Proof (candidate):** `test_native_admission_undecided` (21),
  `test_ci_executor_provider_undecided` (6, scripted claude/codex/closed
  port through the real executor), `test_native_admission_status_budget`,
  `test_provider_quota_cooldown`, `test_glm_model_admission`,
  `test_requeue_fault_ownership`, v12 queue/release, planner hook and
  dispatcher, `test_zai_runtime`, native-claude lane, cost pricing — 157
  tests; on 665213990 the executor cases fail with exactly the trial-eleven
  shape `[('openai', 'gpt-6-astra')]`. Verified by `wf_9eb2e54f-ec1`.

## ARIA-MEDIUM-113 — twenty-three inherited reds, each a defect in the tree

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence:** the candidate battery on `86360d76d0` carried 23 red tests
  that four independent verifiers reported as "pre-existing"; none was a
  stale expectation. (1) Prettier had rewritten byte-pinned capture
  fixtures at integration — the `prompt_render_legacy` inputs, the
  `prompt_render_issued_v4` request/fused JSON and five
  `runtime_archive_legacy` files — while their capture manifests and
  `SHA256SUMS` still named the captured bytes, so every hash pin refused.
  (2) `knowledge_graph.verify_convention_signer` had no production caller
  (`test_control_reachability`): a promotion never read the signature the
  B7 signer wrote. (3) `validation_matrix_gate` matched a required nx
  command by substring, so `nx test P` never satisfied
  `run-many --target=test --projects=P`. (4) Four suites loaded
  `ci_executor` by hand under divergent module names. (5) The v31 cost-hook
  pins read `ci_executor.main` after main split it into `_main`. (6) The
  kg public-API pin lacked the signer surface. (7) Two hermetic socket
  tests lacked the external-network allowlist marker. (8)
  `aria-primary-planner.md` / `aria-cross-reviewer.md` carried imperatives
  without their pedagogy pair or example.
- **What is now true:** the captured bytes are restored (the canonical
  `json.dumps` shapes reproduce every recorded sha256) and
  `aria-kernel/tests/fixtures/` is an `archive_immutable` formatter
  exclusion, so a capture can never be reformatted again;
  `reconcile_convention_promotion` verifies the hypothesis row's signer
  and answers `signer_unverified` (CONTRACTS.md B7);
  `required_test_cmd_satisfied_by` compares nx run identity (target +
  projects; `affected` only matches an `affected` requirement) and keeps
  substring for non-nx requirements; `tests/_helpers/executor_module.py`
  is the one executor loader; the pins follow `_main`; the prompts carry
  their pairs inside the tier-2 token budget.
- **Proof (candidate):** the 24-module battery named in the fix commit is
  green; `test_runtime_artifacts` (31 + 6 subtests),
  `test_prompt_render_versioning` (16), `test_control_reachability`,
  pedagogy lint + narrative shape, validation-matrix correlation (35 + 8).

## ARIA-HIGH-114 — signing was wired only where `.git` is a directory

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence:** trial eleven's task-source `.git` is a 50-byte `gitdir:`
  file — a linked worktree of the shared checkout — and so is every
  executor per-request worktree (`_add_request_worktree`).
  `gh_token_factory._configure_git_commit_signing` returned at
  `if not git_dir.is_dir()` and `_restore_git_commit_signing` answered
  `absent`: no allowed-signers file, no snapshot, no config, no word. Had
  the test been dropped, `git config --local` in a linked worktree writes
  the COMMON config every worktree shares — the operator's checkout and
  every other lane would have signed with the cycle key and lost it at
  the pre-clean.
- **What is now true:** `SigningCheckout` resolves the checkout from
  `git rev-parse --absolute-git-dir --git-common-dir`; the allowed-signers
  file and the snapshots live in the private git dir (`.git/` or
  `.git/worktrees/<name>/`); the config scope is `--local` on a main
  checkout and `--worktree` on a linked one, with
  `extensions.worktreeConfig` enabled once in the common config and a
  repository carrying `core.worktree` / a true `core.bare` refused by
  name; a git that does not answer is `undecided` in restore and prune,
  never `absent`; the mint returns `GitSigningWiring` on
  `SigningKey.git_signing` and the V9 runner refuses
  `git_signing_unconfigured` before an implementer turn is spent.
- **Proof (candidate):** `test_phase_v31_p_linked_worktree_signing.py`
  under `tests/invariants/v3_1/` (6 — a commit made in the worktree
  verifies against the cycle key with the worktree's own config, the
  sibling worktree signs with nothing, the common config carries only the
  extension flag; all six fail on the pre-change factory),
  `test_implementer_merge_seam` refusal test, the 46 B7 tests unchanged.

## ARIA-HIGH-115 — the implementer's signing identity does not reach the lane that commits

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-17
- **Evidence:** `AutonomousV9ImplementationRunner.run` mints the cycle
  key, stages, issues the envelope and revokes the key in `finally`. The
  implementer is claimed later by `tools/aria-poc/ci_executor.py` in a
  per-request worktree where no key, config or fingerprint exists; the
  prompt says "commit with the per-cycle signing key" and demands
  `details.implementation.signer_key_fp`;
  `plan_convergence.record_implementation_outcome` requires it non-empty
  and `plan_convergence_bridge` verifies `branch_tip_sha` against it with
  `git verify-commit --raw` in the process cwd. An executor-lane result
  is therefore refused with an empty fingerprint or refused
  `commit_signature_unverified` with a fabricated one; cost attribution
  reads `ARIA_CYCLE_SIGNER_KEY_FP`, which nothing exports.
- **Design (open):** for `role=implementation` the executor mints the
  cycle key INSIDE the request worktree at claim (worktree-scoped,
  ARIA-HIGH-114), registers the public half in `kg_signers`, stamps
  `signer_key_fp` on the submitted response itself (kernel-owned, never
  the agent's), exports the fingerprint to the cost record and revokes on
  release/submit; the bridge verifies against the registered public key
  (an allowed-signers file built from `kg_signers`, run in the request
  worktree) so verification does not depend on the process cwd. Pin: an
  executor-lane run whose commit is signed by the executor-minted key
  lands the IMPL row; the same run with the fingerprint removed or with
  another key is refused. Blocks halka 4→5 of the live chain.
