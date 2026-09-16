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

## ARIA-HIGH-096 — mission admission: no starvation, owners named, a dead orchestrator is a fault

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

- **What is now true (integrated from `lane/aria-high-098`, four verify
  rounds):** `aria_kernel/cycle_runtime_status.py` is the one verdict rule
  — `integrity_failed` only for the store (an invalid artifact index, or a
  run whose own artifact is missing / mismatched / never written),
  `degraded` for any other non-ok run under a valid index, read by
  `cycle._runtime_status`, the metrics row,
  `runtime_artifacts._cycle_result_status` / `autonomy_output_summary` and
  the orchestrator, which continues on `degraded` and fails closed only on
  `failed` / `integrity_failed`. A degraded cycle seals `completed` with
  `degraded_tools[]`; the `tool_degradation` phase appends one
  `tool_run_degraded` row per tool with its consecutive streak and opens a
  HIGH HUMAN_REQUIRED record at `TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK`
  (3); a QUARANTINED tool's sat-out cycles ARE its streak
  (`tool_sit_out`, dated and reasoned from one anchor that survives the
  nightly manifest re-sync, the ledger row stamped with the transition's
  own `at`); an operator release ends a streak; an ARCHIVED tool has no
  standing (`DEGRADATION_STANDING_STATUSES`), so the doctor's `tools` organ
  clears while the record stays with the operator; exit-history no longer
  lists degraded cycles as causes of a failed exit. Both kernel PR lanes
  fire on `tools/aria-adapters/**` and the suite selector maps it
  (CONTRACTS.md §12.18).
- **Proof (candidate):** `test_cycle_runtime_status_degraded` (13; five
  real nights for both the crashing and the quarantined class),
  `test_tool_sit_out` (8), `test_doctor::ToolsOrgan`,
  `test_ci_workflow_invariants`, `aria-doc-runtime-ssot.spec.ts`; each pin
  fails under its mutation (verified by `wf_21487a46-bd7` rounds 1–2 and
  `wf_4a4fb60b-126` round 3).

## ARIA-HIGH-118 — an adapter could be registered without a fixture-backed evidence contract

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence (live, trial eleven `cyc-20260912T221237Z-auto`):**
  `agent-harness-security-adapter` emitted findings whose evidence the
  validator could not read (`evidence_error`) and was quarantined on the
  spot; nothing at registration had ever required the adapter to prove,
  against a fixture, that the validator accepts its output. Its
  `read_paths` were capped at 200 entries, contradicting findings past the
  200th file, and its evidence carried a `ref` the contract does not know.
- **What is now true:** `aria_kernel/adapter_fixture_contract.py` refuses,
  at the manifest-sync door (`cycle._phase_tool_manifest_sync`, the one
  production path from `tools/aria-adapters/*.tool.json` into the
  registry), any manifest whose `fixture_set` has no case expecting an
  `ok` run (`fixture_cases_missing`, `fixture_case_expects_non_ok_run`,
  `fixture_case_malformed`, by name); the adapter emits per-finding
  `evidence: [{path, line?}]`, `id`, `message`, its full `read_paths` and
  plain-path `evidence_sources`, and ships
  `tools/aria-adapters/fixtures/agent-harness-security-adapter/cases/real-repo-baseline.json`;
  the PR-time pin runs every shipped manifest's suite through the real
  fixture runner and requires each case's status to be `ok`, reporting a
  `budget_exceeded` case as unverified by name.
- **Proof (candidate):** `test_adapter_fixture_evidence_contract` (6 + 19
  subtests when node deps are present; named skips otherwise),
  `test_agent_harness_security`, `test_tool_manifest_sync_phase`,
  `test_manifest_sync_lifecycle`.

## ARIA-HIGH-119 — a workspace that is itself a linked worktree was judged outside the repo

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence (live, trial eleven):** the fixture path guard walked up from
  the tools root accepting only a `.git` DIRECTORY, stepped past the
  checkout's own `gitdir:` file, fell back to `tools_root.parent` (the
  state store) and judged every registry fixture path an escape
  (`fixture_path_escape_outside_repo` for nine of ten tools). The
  executor's per-request worktrees have the same shape.
- **What is now true:** `aria_kernel/checkout_root.py` is the one parser
  for every walker that asks where a checkout begins — a checkout root is
  the directory holding `.git` whether a directory or a `gitdir:` pointer
  file; the state store is skipped by its `GENESIS` record, not by the
  shape of its `.git`; `fixture_runner._discover_git_root` delegates to
  it, the path guard consults the store's declared `bound_repo_root`
  before discovery, `latest_fixture_status` takes `workspace_root`;
  `agent_invocations` and `gh_token_factory` (ARIA-HIGH-114) read the same
  parser.
- **Proof (candidate):** `test_fixture_guard_linked_worktree` (real linked
  worktrees), `test_fixture_dir_state_store_layout`,
  `test_phase_v31_p_linked_worktree_signing`.

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
- **What is now true:** `SigningCheckout` reads the checkout through
  `checkout_root` (the one parser every kernel walker uses); the allowed-signers
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
- **What is now true (lane `wf_85686100-726`, two verify rounds,
  accepted):** `aria_kernel/implementation_identity.py` — the executor
  child holds the identity for a claimed `implementation` request as the
  last step before the spawn: it mints the key inside the request
  worktree (worktree scope, ARIA-HIGH-114), refuses by name when the
  receipt is not `configured` or the lane is a shared checkout
  (`shared_checkout_scope:--local`, before a single config write) —
  releasing the claim harness-class as `implementation_signing_unavailable`
  (rostered in `release_reason` and the release-site scan), request
  REQUEUED with no turn spent — registers the public half in `kg_signers`
  before the agent's first command and revokes on every exit. The kernel
  stamps `details.implementation.signer_key_fp` from the held key
  (`stamp_implementation_signer`; an agent value that differs is
  overwritten and recorded `implementation_signer_fp_overridden`).
  `plan_convergence_bridge.verify_implementation_commit` resolves the
  fingerprint in `kg_signers`, requires the registered key's cycle to be
  this request's cycle, builds an allowed-signers file from that one key
  and runs `git verify-commit --raw` in the checkout the submission names
  (or the bound workspace on replay) — never the process cwd; the cost row
  takes the fingerprint from that one holder. The V9 runner's dead mint and
  its token bracket are gone (nothing in that window committed or called
  GitHub). The implementer prompt and the shared safety contract no longer
  ask the agent for a fingerprint.
- **Proof (candidate):** `tests/test_executor_implementation_identity.py`
  (the real executor child in a drain-provisioned worktree with a scripted
  agent: plain commit lands the IMPL row with the fingerprint on the
  result and the cost row, registry before the agent, verification from
  the shared checkout, revocation and no leakage; unsigned / other-key /
  fabricated / unregistered / other-cycle fingerprints refused by name
  before any plan-state mutation), `tests/test_implementation_signature_boundary.py`;
  eleven mutations each killed by a pin. The reverifier reproduced the
  adjacent ARIA-HIGH-123 (the production sandbox cannot run git in a linked
  worktree); the end-to-end pin proves the chain through a pass-through
  sandbox and says so.

## ARIA-LOW-116 — the suite left its scratch directories in RAM

- **Severity:** LOW · **Owner:** claude · **Deadline:** 2026-09-20
- **Evidence (2026-09-13 17:00Z, the droplet):** `/dev/shm` held 2173
  entries, 1110 of them `aria-*` test directories older than 12 h
  (`aria-test-tools-` / `aria-test-workspaces-` 319 each — one pair per
  pytest process from `tests/__init__.py`; `aria-codex-bin*` /
  `aria-codex-home*` ~45; `aria-fleet-empty-path-` 28; `signer-registry-`
  39), 1.5 GB of tmpfs on a host that runs the nightly lane.
- **What is now true:** `tests/__init__.py` mints the two process-lifetime
  roots through `_process_scratch_dir` (removed at interpreter exit);
  `test_model_fleet_and_codex` uses one module-level empty `PATH`
  directory removed at exit and `addCleanup` for the codex home/bin dirs;
  `SignerRegistryTests` cleans its root. A run of the three modules adds
  no `/dev/shm` entries.

## ARIA-HIGH-117 — compaction strips the artifacts the raw findings still point at

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence (live, main):** the executor lane has refused to publish
  `aria/state` since 2026-09-12 (`aria-agent-executor` runs 34745606502
  and 34762798856, "the store was restored but failed integrity
  verification"; tree preserved as `quarantine-evidence-34762798856`).
  In that tree all 93 ledgers are valid and `runtime_artifacts` fails
  with 3898 issues: 3825 `raw_pointer_corrupt` — every `raw-findings.jsonl`
  row, all thin (`json_pointer` into the run artifact, no inline
  finding), from the two 2026-09-04 cycles — plus 36
  `artifact_ref_missing`, 36 `artifact_index_ref_missing` and
  `artifact_index_empty_with_run_refs`. `artifact-index.jsonl` has 0
  rows, `run-artifacts/hot` and `.archive/runtime` are empty, no
  `retention/events.jsonl` exists (retention never ran on the live
  store), and the three `archives/artifact_index-compact-*.jsonl.gz`
  files (2026-09-05, 09-11, 09-12) are there: `aria-state-maintenance.yml` runs
  `state compact --retain-days 7` daily and publishes the result green
  (its publish verifies the snapshot, not the runtime pointers). Seven
  days after the last cycle, the hot artifacts were stripped and their
  index rows dropped (ORPHAN-CRITICAL-805), while the raw-finding rows
  and the `runs.jsonl` refs that name them stayed. Both the main
  (`43f0aa3bf6`) and candidate (`88f64f7e6e`) verifiers refuse the tree
  identically.
- **What is now true (lane `wf_a4e68c08-436`, two verify rounds,
  accepted):** compaction attests POLICY, not absence, on the declared
  ledger `run-artifacts/compacted.jsonl` (`runtime_artifact_compactions`),
  written inside the same transaction as the index rewrite: a stripped
  artifact is attested only if its cycle was older than the window in
  force when its archive was written — read from that run's
  `state_compacted` governance row, never from this run's `retain_days` —
  or this run pruned its hot directory; a within-window loss is archived
  but never attested. Every compaction backfills the ledger from the
  archives it already holds, idempotently, so the live store heals on its
  next maintenance run with no manual repair. `verify_runtime_artifacts`
  consults the ledger for an absent artifact before the retention tier:
  attested refs are `compacted` (valid, `compacted_artifact_count` per
  reference), raw pointers into them are verified structurally
  (`finding_summary`, hashes), a mismatched sha256 does not apply, and a
  lost artifact no row vouches for is still `artifact_ref_missing` /
  `raw_pointer_corrupt`. The one publish path
  (`state_store._publish_state_locked`) refuses
  `state_publish_runtime_artifacts_unverified`, and
  `aria-state-maintenance.yml` runs the executor's own integrity verdict
  before it mints a credential (CONTRACTS.md §12.5).
- **Proof:** on a copy of the quarantined live tree the pre-change kernel
  refuses with the exact 3,898-issue verdict; the new kernel alone
  launders nothing; one `state compact --retain-days 7` attests 176 rows
  (158/9/9 across the three archives) and `integrity verify` answers
  valid; a second pass attests 0; a hand-removed attestation is refused
  by name. `tests/test_compaction_attestation.py` (22 + 6 subtests; 24
  fail on the pre-change tree); twenty mutations each killed by a named
  pin.

## ARIA-MEDIUM-120 — the doctor counted zero issues in a verdict that had 3,898

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-09-20
- **Evidence:** `integrity.verify_integrity` computes the runtime-artifact
  issues but returns only the tools-ledger list, so `doctor._check_integrity`
  reports `integrity_drift:0_issues` on the quarantined live store whose
  runtime pointers fail with 3,898 issues — observed independently by the
  ARIA-HIGH-117 implementer and verifier (`wf_a4e68c08-436`).
- **Fix shape (open):** return the full issue list (tools + workspace +
  runtime artifacts) and have the doctor read the same count the executor's
  integrity step prints; pin with the quarantined-store shape.

## ARIA-LOW-121 — two source-marker assertions the Plan 026R invariant refuses

- **Severity:** LOW · **Owner:** claude · **Deadline:** 2026-09-16
- **Evidence:** the ARIA-HIGH-104 integration pinned two producer facts in
  `tests/test_must_satisfy_shape.py` (lines 323, 359) by `assertIn` of a
  call-site substring in kernel source the test had read; the
  `tests/test_source_marker_invariant.py` gate was red on the candidate.
- **What is now true:** both pins parse the module AST — a producer that
  hands a variable to `must_satisfy_item(description=…)` is refused by
  shape, the producers call `key_change_obligation`, and the re-mint's
  `must_satisfy` keyword must be the `upcast_sealed_items(…)` assignment;
  a verbatim copy of the sealed row fails the pin (mutation-checked).

## ARIA-HIGH-122 — the adaptation loop: a condition the kernel can name becomes a plan

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-30 · **Operator direction
  (2026-09-14):** "ARIA koşulların değişmesine de kendini adapte edebilmeli."
- **Evidence:** the kernel COPES with a changed condition (provider failover on a decided
  unavailable, bounded retry, requeue on harness faults, store backfill, tool quarantine and
  sat-out streaks, orphan-key pruning) and NAMES what it refused (`provider_undecided`,
  `state_publish_runtime_artifacts_unverified`, `native_task_binding` refusals,
  `tool-degraded` escalations, lapsed dormant-surface waivers) — but those refusals and the
  HUMAN_REQUIRED records they open are not a mission source. `self_improvement.scan_signals`
  feeds missions from capability gaps, funnel stalls, delivery gaps, MCP quarantine and doctor
  FAIL only; a kernel-path change is refused for self-merge (`implementation_safety`, Plan 009
  operator lane) with no path from a refusal to a drafted kernel PR. Every environment change
  of the last three days (CLI probe timeout, compaction ↔ verify, lapsed waivers) therefore
  waited for an operator or for this session.
- **Design:**
  1. Every named refusal / escalation class is a `Signal` carrying its evidence rows
     (governance kind, request id, refusal reason, HUMAN_REQUIRED id); the mission it opens
     names the surface it expects to change.
  2. The adaptation surface is split: **self-merge** for `tools/aria-adapters/**`, adapter
     fixtures, policy JSON under `aria-kernel/aria_kernel/data/` and dormant-surface waiver
     re-dating — each with measured before/after evidence; **operator-approved PR drafted by
     ARIA** for `aria-kernel/**` core, identity and security surfaces (the Plan 009 lane, now
     entered automatically from the signal); **notify-only** for credentials, subscriptions
     and production infrastructure. The operator sets the exact self-merge set.
  3. Every adaptation carries the lane discipline as a kernel contract: a pin that fails on the
     pre-change tree, an adversarial verification row, and the refusal it answers named in the
     commit trailer.
- **Sequence:** after ARIA-HIGH-115 (executor signing identity), ARIA-HIGH-097 (adjudication
  readers) and the first live end-to-end merge — the loop has nothing to merge before the
  chain it adapts is alive.

## ARIA-HIGH-123 — the implementer's sandbox cannot run git where the implementer commits

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-17
- **Evidence (reverifier of ARIA-HIGH-115, reproduced 2026-09-14 with the
  real wrapper and bwrap 0.9.0 on a throwaway repo under `/dev/shm`):** the
  write-capable implementer spawn is bwrap-contained with only the workspace
  bound and `.git/` read-only, so inside a linked per-request worktree git
  fails `fatal: not a git repository: <checkout>/.git/worktrees/<name>` and in
  a main checkout `git add` cannot create `.git/index.lock` (`Read-only file
system`) — the agent's `git commit` the identity contract relies on cannot
  run in the real sandbox in either lane. The same measurement showed the
  private signing key readable inside (`aria-debts/` ro-bound — read-only is
  readable), bwrap's root tmpfs writable (an unbound store is a phantom the
  hooks journal into and lose), a host `TMPDIR` the sandbox does not mount
  (`git commit` died `could not create temporary file`), and `/bin/true`
  reporting the sandbox usable on every such host.
- **Round 1 (refused by the adversarial verifier):** the first cut bound the
  shared common dir's `objects/`, `refs/heads/`, `logs/refs/heads/`, the
  worktree's private git dir and the WHOLE state store writable, committed
  unsigned in the probe, and left the ssh-agent to outlive a killed holder.
  Reproduced with the real wrapper: for the runner's uid the signed commit
  died with `No user exists for uid 1000?` (no `/etc/passwd` inside; the
  probe passed unsigned); `rm objects/pack/*.pack`, `git repack -adq`,
  `objects/info/alternates`, `refs/heads/main.lock`,
  `objects/maintenance.lock` and `<private>/locked` all persisted on the
  host; every kernel ledger (requests, claims, governance, signers,
  control, adjudications, cost) was appendable from inside; a SIGKILLed
  holder left a live agent holding the cycle key; a raw AF_UNIX listener in
  a pin made the no-network invariant red.
- **What is now true:** the shared repository is never writable inside the
  sandbox. The agent's git runs against a kernel-made REPLICA of the
  worktree's private git dir bound over it (HEAD, index, logs/HEAD, control
  files overlaid read-only; a `locked` the agent writes lands in the
  replica) and a QUARANTINE — git's own receive-pack shape:
  `GIT_OBJECT_DIRECTORY` at the replica's `objects/` (alternates at the
  shared store for reads), the replica's `refs/heads/` and
  `logs/refs/heads/` bound AT the common paths, existing loose refs overlaid
  read-only on top (bounded: `loose_refs_exceed_overlay_bound:<n>`, remedy
  `git pack-refs --all`); the common dir read-only as a whole (packs,
  `objects/info`, `maintenance.lock`, `config`, `hooks`, `packed-refs`);
  sibling worktrees and the main working tree absent
  (`aria_kernel/git_containment.py`). After the spawn the KERNEL publishes
  the quarantine from outside (`publish_quarantine`): every loose object
  inflated and re-hashed (a file whose bytes do not hash to its name is
  refused by name — git reads loose objects before packed, so a crafted
  loose object would shadow a packed one), packs fed to
  `git unpack-objects --strict` (never copied), only `aria-impl-*` refs
  published with `git update-ref`, everything else (a planted `main.lock`,
  a shadow `main`, a branch of the agent's naming) discarded and named on the
  `implementation_quarantine_published` governance row; the worktree's HEAD
  then adopts the published branch so the executor's evidence check grades
  the agent's files against the agent's commit. A killed executor publishes
  nothing. `/etc/passwd` and `/etc/group` are system binds, and the probe
  runs the SIGNED route (a throwaway key minted into a throwaway linked
  worktree, the kernel-held agent, publication, `git verify-commit` from
  outside) with the managed route's network setting
  (`MANAGED_SPAWN_ALLOW_NETWORK`). The store is NOT mounted: the hooks
  compiled into the settings run a stdlib-only client by path
  (`aria_kernel/hook_client.py`, naming nothing but the verb) that ships the
  payload to a kernel-side broker on a bound unix socket
  (`aria_kernel/hook_broker.py`, served in the executor around the spawn
  with the store, workspace, request id and turn cap as ITS facts) — the
  decision ledger, the turn count, the work journal, the checkpoint and the
  handoff are written outside. The ssh-agent dies with its holder however
  it dies (`PR_SET_PDEATHSIG` under `PR_SET_NO_NEW_PRIVS` — the
  distribution's set-gid `ssh-agent` would otherwise drop the signal at
  exec, measured), its key lifetime is bounded by `ARIA_JOB_DEADLINE_EPOCH`
  (`-t`), it starts with PATH only and `-P '!*'` (no provider library can
  be loaded through the socket); the orchestrator's startup sweep removes
  `aria-sa-*` / `aria-hb-*` socket dirs whose listener is gone. The fixture
  listener lives in `tests/_helpers/unix_sockets.py` with the no-network
  invariant's own allowlist marker. Contract in `docs/aria/CONTRACTS.md`
  (next to the HIGH-115 paragraph); runbook R-3b.
- **Proof:** on the pre-change tip (`b97fb0af5f`) the HIGH-115 end-to-end
  under REAL bwrap fails `git switch -q rc=128: fatal: not a git repository`
  and the new modules do not import; on the round-1 tree the round-2 pins
  fail as the verifier reproduced (the passwd bind dropped with the network
  off → `No user exists for uid`; the store bound writable → every ledger
  forgeable; the shared `refs/heads` bound writable → `main.lock` on the
  host; a SIGKILLed holder → a live agent). After: the IMPL row lands
  through the real wrapper as the runner's uid AND as root, with the hook
  journal row shipped from inside reaching the real store, the store's
  ledgers absent inside, planted locks and `locked` never on the host, the
  shared packs/alternates/maintenance lock EROFS, a crafted loose object
  refused by name at publication, a pack unpacked never copied, the probe
  refusing by name without the account database, the agent gone within a
  second of the holder's SIGKILL — each mutation (store root bound, shared
  refs bound, `config.worktree` overlay dropped) caught by its pin.

## ARIA-HIGH-124 — the implementer's kernel commands and MCP server run where the store is not

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-21
- **Evidence (found while closing ARIA-HIGH-123 round 2, 2026-09-14):**
  the implementer's contract (`.claude/agents/aria-implementer.md`, steps
  8b and 9) has the AGENT run `python3 -m aria_kernel apply gate …` and
  `python3 -m aria_kernel pr create …` inside its own sandbox, and the
  `implementer` profile loads the `aria` MCP server
  (`python3 -m aria_kernel mcp serve`, `ARIA_TOOLS_DIR` passed through)
  inside the same sandbox.
  All three read AND write the durable state store (`apply gate` promotes
  the action, `pr create` records the PR, the MCP server bootstraps and
  journals `mcp/tool-calls.jsonl`). On `b97fb0af5f` the store was a phantom
  on bwrap's root tmpfs (each command bootstrapped an empty store and
  failed to find its proposal, or served an empty view); the HIGH-123
  first cut "fixed" this by binding the store writable, which the
  reverify refused; the HIGH-123 close leaves the store unmounted on
  purpose. None of the three has ever worked in the production sandbox,
  and the HIGH-115/123 end-to-end pins carry `pr_url` as a fixture
  constant. Running kernel-authority commands inside the agent's sandbox is
  unsound regardless of the mount: `python3 -m aria_kernel` resolves the
  package from the cwd first, so a package the agent writes into its
  worktree shadows the read-only kernel tree.
- **Fix shape:** the same seam HIGH-123 gave the hooks — a kernel-side
  request broker: the in-sandbox `apply gate` / `pr create` become thin
  clients; the broker runs the store mutation and the PR opening OUTSIDE
  with the executor's authority (the validation half of the apply gate
  stays INSIDE, contained, and its evidence is what the broker records);
  the `aria` MCP server is served outside the sandbox over a bound socket
  (or its read view is compiled into the spawn), never spawned inside
  against the store. Until then an implementer result cannot carry a real
- **What is now true (rounds 1–6, 2026-09-14 → 09-15):** the kernel-authority commands never run
  inside the agent's sandbox. `apply gate` and `pr create` are the executor's, run OUTSIDE on the
  quarantine the sandbox produced (`implementation_delivery`): the validation half of the gate
  runs CONTAINED (`run_validation_commands(spawn_wrapper=)`, `wrap_validation_in_sandbox` over an
  empty `--tmpfs` where the keys dir was, round 5) and its evidence is what the delivery records;
  the `aria` MCP server is served outside over a bound socket (`mcp_broker`, `mcp_relay` inside
  as a thin client, `kernel_socket` transport). The branch is the kernel's
  (`stand_on_implementation_branch` seeds it; only the seeded branch is published, round 3);
  the delivery token is minted by the
  delivery where it is consumed and revoked in its own `finally` (round 6 — the token minted
  before the spawn had expired by the push); the signing key is in a private 0700 directory of
  the executor's outside the workspace and retired before the delivery (round 5); the executor's
  own git runs with hooks off (`KERNEL_GIT_NO_HOOKS_ARGS`, round 6); the executor's kernel resolves
  from the code root, never from the agent's tree (round 2). The implementation child is priced
  (`child_worst_case_seconds` with `IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS`, 13410 s; the
  lease is the child's own worst case), the drain window holds it with 657 s of start window
  (`ARIA_DRAIN_BUDGET_SECONDS` 21000, job 510 min — round 6 measured the first `next-pending`
  of a drain at over 40 s under load, so the 57 s the previous window left skipped the child by
  name every night), and the absolute deadline every spawn and delivery runs under is anchored
  at job launch. Every result the executor accepts carries a kernel-stamped `pr_url` or a refusal
  by name (`deadline_insufficient`, `implementation_signing_unavailable`, the admission
  refusals) — never a fixture constant. Pinned across `test_implementation_delivery`,
  `test_mcp_broker`, `test_executor_pr_via_kernel`, `test_executor_implementation_identity`,
  `test_git_containment`, `test_containment_probe`, `test_state_lock_liveness_bound` and the
  executor lanes; round 6's reverify under a real bwrap ran 20/20 on the droplet.
- **Named, not closed here:** the clients the sandbox runs are still resolved from the
  workspace (ARIA-HIGH-142), and the implementer's sandbox has no egress boundary
  (ARIA-HIGH-143); both are their own findings.

## ARIA-MEDIUM-134 — the kernel suite was green on one host only

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-09-21
- **Evidence (PR #1553, kernel job 104008882051, 2026-09-14 — the candidate's
  first run on a hosted runner):** fourteen failures the droplet passes. Four
  fixtures (`test_pr_manager_e2e._ordinary_scoped_stage`,
  `test_plan_coverage`, `test_merge_authority_pre_merge_perimeter`) symlinked
  `Path("/var/aqua-saas/node_modules")` — the operator host's main checkout,
  a Codex-era hardcode (`4f4918c88c`) — into their throwaway repositories
  while `npm ci` had installed the same packages under the checkout being
  tested. Eleven tests that spawn through `wrap_bash_in_sandbox` (the managed
  Codex bridge, the native Claude lane, the provider-undecided lane, the live
  path smoke) failed `SandboxUnavailable`: `aria-kernel.yml` never provisioned
  a sandbox backend because until this candidate no kernel test proved the
  real one, and the executor/nightly lanes provision theirs through
  `ensure-sandbox-backend` on the self-hosted runner.
- **What is now true:** `tests/_helpers/node_modules.installed_node_modules`
  resolves the checkout's own `node_modules` (through a worktree's symlink)
  and names a missing package; the three fixtures read it and nothing else.
  `test_suite_env_hermeticity.NoTestIsBoundToOneHost` walks every test
  module's AST and refuses a string literal under `/var/aqua-saas` or
  `/root/` (docstrings excluded — they name the class, they do not depend on
  the host). The kernel lane runs `ensure-sandbox-backend` after
  `setup-aria-kernel` — one definition with the executor and nightly lanes —
  and the action's refusal now names the host facts the two causes differ by
  (`detail=`, `bwrap=`, `apparmor_restrict_unprivileged_userns=`).
- **Named, not decided here:** whether the hosted Ubuntu 24.04 image can
  confine at all. Its kernel keeps unprivileged user namespaces under
  AppArmor, so bubblewrap may install cleanly and fail every invocation; the
  run decides, and lifting that restriction on the ephemeral VM (or moving
  the kernel lane to a runner that confines) is the operator's call, recorded
  on this finding when made.

## ARIA-MEDIUM-135 — the fast kernel lane was the full suite under a budget it could not meet

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-09-21
- **Evidence (PR #1553, run 34853938795, 2026-09-14):** `aria-kernel-fast.yml`'s
  `unittest` job was cancelled at 60m15s by its own `timeout-minutes: 60`
  while `aria-kernel` (run 34853938794) finished the same suite —
  `Ran 6484 tests in 2901 s` — inside its 75-minute budget.
  `scripts/ci/aria-suite-run.sh` takes no mode: both lanes invoked it
  without arguments, so "fast" had been the whole suite since 2026-08-27,
  when its 15-minute budget was raised to 60 rather than its scope narrowed
  (ARIA-MEDIUM-020); the invariant that pinned the two budgets described
  the fast lane as "the affected subset", which it never ran. It also
  provisioned less than the lane it duplicated (no `npm ci`, no sandbox
  backend), so on a hosted runner it could only end cancelled or red.
  ORPHAN-MEDIUM-769 had already deleted `aria-kernel-full.yml` for the same
  shape.
- **What is now true:** `aria-kernel-fast.yml` is deleted. `aria-kernel.yml`
  is the one kernel lane — on the PR (its paths now carry `docs/adr/**`,
  inherited from the fast lane, so a SPEC/ADR amendment fires it before
  merge — I-V3-31c) and unfiltered on every push to main. Every pin that
  named the fast lane now pins its absence: `test_ci_workflow_invariants`
  (`test_deleted_kernel_fast_stays_deleted`, the governed set, the PR-path
  pin), `test_workflow_enterprise_preflight` (no audited exclusion for a
  retired workflow — one would be a standing licence for its return),
  `workflow_contract_registry.AUDITED_WORKFLOW_EXCLUSIONS`, the V3 B3
  amendment pin, `aria-doc-runtime-ssot.spec.ts` (one budget, 75), the
  runner's consumer list, CONTRACTS §12.18.

## ARIA-HIGH-140 — a cycle cut by its deadline reported the store it never verified as broken

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-22
- **Evidence (ring 3 reruns on trial eleven, 2026-09-15):** `cyc-20260914T231106Z-auto`
  (5400 s) and `cyc-20260915T004952Z-auto` (10800 s) both ended at their deadline to the
  second, `runtime_status: integrity_failed`, `exit_reason: cycle_failed`. Under the host's
  load (the runner's nightly beside two lanes) the tool phase took 64 and 150 minutes — three
  to four adapters at their budgets, which ARIA-HIGH-098 already prices as `degraded` — and
  `fixture_refresh` then ran every adapter's fixture suite at ~3.5 minutes each until the
  alarm fired inside it. Every later phase was skipped by `job_deadline_reached`, including
  `artifact_integrity`; its empty result read as `integrity_valid=False`; the verdict became
  the one the orchestrator fails closed on, over a store whose index verified 9/9. No ledger
  carried which phase was cut: the `phases` outcome dict lived only in the cycle's memory.
- **What is now true:** `CyclePhase.closeout` — `artifact_integrity` and `metrics` run when
  the deadline has been reached and never under the alarm: they seal the cycle, which is what
  the deadline protects time for. `runtime_status` takes a tri-state integrity verdict
  (`None` when the phase did not run — not verified is not failed) and a `phase_interrupted`
  fact (the cycle is `failed` and names the phase). The orchestrator's bounded summary carries
  the phase ledger to `autonomy_state`. `fixture_refresh` asks the remaining wall-clock between
  suites and records the suites it did not start (`fixture_refresh_deadline_skipped`).
  Pinned, each red without the fix: `test_night_closes_at_deadline.CloseOutPhasesTests`
  (the close-out set is exactly `{artifact_integrity, metrics}`; past the deadline a work
  phase is `skipped:job_deadline_reached`, the close-out phase `ran` and the alarm was never
  armed for it; `_first_interrupted_phase`; an unverified store reads OK, a cut cycle reads
  `failed`, a store that failed verification still reads `integrity_failed`);
  `test_cycle_runtime_status_degraded.RuleTests` (the tri-state verdict and
  `phase_interrupted` at the rule); `test_judgment_pipeline_phases.FixtureRefreshPhaseTest`
  (the clock is asked between suites, the skip reaches governance, a night with time to
  spare grows no row); `test_autonomy_orchestrator.BoundedCycleSummary…` (`phases`
  survives the closed summary literal, and is `{}` — never absent — without one).
- **Named, not closed here:** the wall-clock itself. A cycle that needs 3+ hours on a host
  shared with production and two lanes is ARIA-HIGH-136's and ARIA-MEDIUM-139's subject; the
  next ring-3 run waits for a quiet host.

## ARIA-HIGH-141 — under a current git the replica containment cannot lock packed-refs

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-22
- **Evidence (hosted 22.04 lane, run 34910051620, git 2.55.0):**
  `test_git_containment.UnderRealBwrapTests` and `test_containment_probe` fail
  `Unable to create '<checkout>/.git/packed-refs.lock': Read-only file system` — a ref update
  inside the sandbox creates the lock beside `packed-refs`, in the shared common dir the
  containment binds read-only as a whole. The droplet's git 2.43 never takes that lock on a
  loose-ref update, so the design (ARIA-HIGH-123) was proven against one git and is refused by
  a newer one.
- **Correction (read from the same run, 2026-09-15):** the lock refusal is an `error:` line,
  not a `fatal:` one — the ref update goes on through the loose ref, and the signed commit
  LANDS — `UnderRealBwrapTests.test_the_implementers_git_operations_succeed_inside_and_land_only_when_the_kernel_publishes`
  and `ProbeTests.test_a_host_that_can_sign_a_commit_inside_the_sandbox_passes` passed on
  that git. The two reds are narrower than "cannot land a signed commit": the negative-path
  asserted OpenSSH 9.x's wording where 8.9 says `Load key …: No such file or directory`
  (ARIA-MEDIUM-134's E class, now a regex in both trees), and the probe's refusal detail is
  the first lines of stderr, which the lock errors fill, so the refusal-by-name
  (`No user exists for uid`) is masked rather than absent. What remains of this finding is
  the noise itself — an EROFS error on every branch creation under a current git, which a
  refusal-by-name check cannot see past — and its fix shape stands.
- **Fix shape (tier 1, after ARIA-HIGH-124 — same module):** the common dir becomes a tmpfs
  at its own path with every shared entry bound back read-only one by one (`config`, `hooks`,
  `info`, `objects`, `refs/tags`, `refs/remotes`, `packed-refs`, `worktrees`), so a lock
  sibling can exist while every entry stays EROFS; publication keeps reading the quarantine's
  loose `refs/heads` only (a branch git packs inside is unadvanced and discarded); the
  containment probe pins the property under the host's git and names a git below the proven
  floor. Until it lands the hosted kernel lane carries these three failures by name.
- **What is now true (2026-09-16):** `GitContainment.bwrap_flags` opens with `--tmpfs <common>`
  and binds back, read-only and one by one, the entries `_shared_common_dir_entries` enumerates
  at derivation (`GitContainment.common_entries`): every existing entry of the common dir that
  is repository content, with `refs` and `logs` descended one level so `refs/heads` and
  `logs/refs/heads` are left to the quarantine on a commit-capable spawn (a read-only spawn
  sees them read-only like any other entry) and `refs/tags`, `refs/remotes`, `logs/HEAD` are
  bound on their own. Not bound: `worktrees` (a tmpfs of its own, as before), every `*.lock`
  and the main checkout's in-progress state (`COMMON_DIR_UNSHARED_ENTRIES`: `ORIG_HEAD`,
  `MERGE_HEAD`, `COMMIT_EDITMSG`, a rebase or sequencer directory) — absent inside, so a stale
  host lock never wedges the agent's git and its `git status` reports no operation in
  progress. A lock sibling lands in the tmpfs and dies with the sandbox; the entry it guards is
  still EROFS, and a `packed-refs` git rewrites inside (`pack-refs`) fails at the rename over
  the mountpoint. The probe repository is packed (`git pack-refs --all`) before the derivation,
  the production shape; the script pins the property under the host's git — the lock sibling
  must be creatable (`EXIT_PACKED_REFS_LOCK_REFUSED`, 45) and `packed-refs` must not be
  writable (`EXIT_PACKED_REFS_WRITABLE`, 46) — and a `packed-refs.lock` on the host after the
  run is `sandbox_lock_reached_repository`; a git older than `GIT_PROVEN_FLOOR` (2.43) is
  `git_below_proven_floor:<version>` before any repository is made.
  Pinned by `test_git_containment` (the tmpfs first and the entries after it, `refs/heads`,
  `worktrees`, `ORIG_HEAD` and `index.lock` not among them; under bwrap the lock sibling is the
  one ALLOWED write of the control-surface probe and never reaches the host; a commit beside a
  PACKED `main` writes no `Read-only file system` line, `main` reads through `packed-refs`,
  `packed-refs` stays EROFS, nothing reaches the repository before publication and the branch
  publishes) and `test_containment_probe` (the pre-141 whole-dir read-only bind is refused as
  the lock it cannot create, a writable `packed-refs` is refused by name, a writable common dir
  is refused as the lock that reached the repository, a git below the floor is named before
  any repository is made). The derivation pins and the lock-sibling probe are red on the tree
  before the fix under git 2.43; the hosted lane's git 2.55 is where the EROFS line itself
  appeared, and that lane going from one failure to none is this finding's closing evidence.

## ARIA-HIGH-142 — the in-sandbox kernel clients were served from the workspace, not the kernel

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-22
- **Evidence (found preparing ring 4 on trial eleven, 2026-09-16):** `claude_runtime` derived
  `hook_context["kernel_root"]` as `<workspace>/aria-kernel` (`:948`, `:1044`) and the MCP relay
  followed it (`McpRelayContext.kernel_root`); the trial's task source (`6652139901`) predates
  `hook_client.py`, `mcp_relay.py`, `git_containment.py` and `hook_broker.py`, so the settings
  document named a hook line and a relay path that did not exist inside the sandbox. Nothing
  refused: a hook that cannot be executed is an `execvp` failure the CLI reports as a hook error,
  and the relay's server simply never came up. `ci_executor._REPO_ROOT` (`:455`) falls back to
  the module's own checkout when `ARIA_WORKSPACE_ROOT` is unset — the kernel's tree, not the
  request's — with no line in the log saying so. ARIA-HIGH-133's class: a live seam that had never
  seen a workspace other than the kernel's own checkout.
- **What is now true:** `claude_settings.kernel_code_root()` is the one root — the running
  kernel's `aria-kernel/`. `claude_runtime._hook_context` names it for any workspace and refuses
  `kernel_client_missing:<path>` before a settings document is written when either client is
  absent there. `implementation_safety.kernel_root_ro_binds` binds that root read-only, at its
  own path, on every sandbox route (`wrap_bash_in_sandbox` is the one builder) when it lies
  outside the workspace and under no system root — the kernel's own checkout adds nothing, since
  READONLY_PATHS already keeps `aria-kernel/aria_kernel/` read-only there. The executor writes
  `REPO_ROOT_FROM_MODULE_MARKER` at entry whenever its root came from its own module.
  Pinned by `test_kernel_clients_from_code_root` (the root holds both clients; the context points
  at the kernel for a workspace without `aria-kernel/`; a kernel tree missing a client is refused
  by name; the bind is present for a foreign workspace and absent for the checkout and under a
  system root; the executor's note and its silence), red on the tree before the fix.
- **Named, not closed here:** the executor's `_REPO_ROOT` stays a fallback rather than a
  refusal — the drain always exports the env, and a targeted operator run now says which tree
  it is about; making the env mandatory is a contract change for `ci_executor.py <request_id>`
  and is recorded on this finding when decided.

## ARIA-HIGH-143 — the implementer sandbox had no egress boundary

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-22
- **Evidence (Fable review, confirmed against `origin/main` and the candidate, 2026-09-16):** the
  managed spawn shares the host's network namespace on purpose — `MANAGED_SPAWN_ALLOW_NETWORK`
  is `True` so the Claude CLI can reach its provider — and `/etc/resolv.conf` is bound in. The
  command policy refuses `curl`/`wget`/`nc` by name, but `pytest` and `nx test` run whatever the
  agent committed, `.env` is a read-only but VISIBLE bind, and the sandbox already has
  `--unshare-pid`. So a prompt-injected agent needed one allowed runner and one test file it wrote
  to send a secret to any host it liked; the only brake was the model's judgement, which is
  precisely what an injection subverts. This sandbox has never run on a real implementation
  request, so the boundary is cheapest to add before the first live run (Blok 6), not after.
- **What is now true:** `aria_kernel/egress_proxy.py` is an allowlist CONNECT proxy — standard
  library, ~180 lines, one verb — run on the host by `infrastructure/aria/aria-egress-proxy.service`
  (loopback `:3128` and a unix socket), allowing only the provider endpoints and refusing every
  other target by name with one JSON line per decision. The spawn is handed it through
  `HTTPS_PROXY` (`agent_env.BASELINE_ENV_NAMES` already carries the proxy vars). The kernel adds
  the three free namespace flags to `MANAGED_SPAWN_ISOLATION_FLAGS` (`--unshare-ipc`,
  `--unshare-uts`, `--new-session` — so `/proc` shows only the spawn's own PIDs, System V IPC and
  the UTS names are the spawn's, and no TIOCSTI reaches the executor's terminal) and the bwrap
  probe mirrors them (ORPHAN-MEDIUM-452). `ci_executor._pre_claim_environment_gate` gains
  `egress_boundary_probe`: it asks the proxy for a tunnel to a TEST-NET address and accepts only a
  refusal by name, so a host with no proxy, a silent one or a permissive one is refused
  `egress_boundary_unavailable` and the request stays PENDING. The network namespace itself is
  deliberately NOT unshared — the CLI needs the provider — which is why the proxy, not
  `--unshare-net`, is the boundary. Pinned by `test_egress_proxy` (admit the allowlist end to
  end, refuse everything else by name, a permissive proxy is not a boundary) and the gate and
  isolation pins in `test_environment_contract`, `test_managed_claude_sandbox` and
  `test_sandbox_and_perimeter_hardening`.
- **Rejected as over-engineering (Fable concurred):** a seccomp profile, gVisor / a microVM, a
  separate worker VM (ARIA-MEDIUM-139 already records that path), and hiding `.env` behind
  `/dev/null` (the wrong layer). The boundary belongs at egress, enforced by the host.

## ARIA-HIGH-144 — the executor refused every implementation request as unanchored

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-22
- **Evidence (the first live ring-4 run, trial eleven, 2026-09-16 13:02Z):** the kernel's own
  mint (`request_implementation.py` → `AutonomousV9ImplementationRunner.run` →
  `stage_converged_plan_for_pr` + `issue_implementation_envelope`) staged the CONVERGED plan and
  wrote `AIR-aria-implementer-b7a519f5be58` (`implementation_dispatched`, branch
  `aria-impl-7bd7852c24dc…`, baseline recorded). The targeted executor
  (`ci_executor.py <request_id> aria-implementer`, the trial workspace at `6652139901`) wrote one
  governance row and left the request PENDING: `runtime_task_binding_unavailable`
  `reason=target_revision_unavailable target_sha=null observed_head_sha=6652139901…`.
  `issue_implementation_envelope` was one of the eleven mint paths that never passed
  `target_sha` (ORPHAN-CRITICAL-495 counted them), and `_native_task_binding_refusal` — which
  runs for every request once the operator's adaptive runtime policy is declared (B8,
  2026-09-12; the trial store carries it, `aria/state` carries it) — read `target_sha` alone.
  The drain had already learned the implementation request's tree: `request_worktree_target`
  adds the worktree at `implementation_ids.base_sha` (ARIA-HIGH-124), so in the scheduled lane
  the child would have stood in a tree at the staged base and refused it by the same name. The
  identity suite (`test_executor_implementation_identity`) runs its implementation requests
  under a fixture policy without the adaptive block, which is why 106 green tests never met
  the binding. ARIA-HIGH-133's class again: a seam that had never seen a live implementation
  request.
- **What is now true:** `agent_invocations.request_anchor_sha(request)` is the one derivation
  of the commit a request is about — `target_sha`, else the staged
  `implementation_ids.base_sha` (the baseline's commit, the branch's cut point), else `None`
  (a read-only role minted without an anchor; absence is not grounds for refusal,
  ORPHAN-CRITICAL-495). The executor's native task binding compares the tree's HEAD against
  it and names the anchor's source on its governance row (`anchor_source`); the drain's
  `request_worktree_target` and the anchor gate read the same function; and
  `issue_implementation_envelope` passes `target_sha=base_sha`, so a row minted from here on
  is self-describing to every reader that only knows `target_sha`. The request the trial
  minted before the fix is admitted through the fallback, unchanged (the ledger is
  hash-chained; the row is the fact). Pinned by `test_ci_executor_live_path_smoke` (a row
  minted by the kernel's own mint with `target_sha` withheld, under the B8 policy with
  `managed_subscription`, is bound at its staged base — no binding row, the fleet refuses next
  by its own name — red on the executor before the fix; the same row on a tree that moved past
  the base is `target_revision_mismatch` naming `implementation_ids.base_sha` as the source),
  `test_agent_request_anchor` (the derivation, edge by edge) and `test_must_satisfy_shape` (the
  minted envelope carries `target_sha == implementation_ids.base_sha`).
- **Named, not closed here:** the identity suite's fixture policy still lacks the adaptive
  block, so its 106 tests exercise the legacy admission path; a production-shaped variant of
  that fixture (the B8 block, `managed_subscription`) is the pin that would have caught this a
  week earlier and is the next thing that suite should carry.
