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
