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
