# ARIA — a staging's plan, not its action, owns its next step (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-412 — pr_lifecycle read a machine staging's frozen action status

### Symptom (ARIA-HIGH-412)

PR #1930 stopped the pr_lifecycle phase from re-opening PR 1906, and the first cycle after it
(`cyc-20261010T080114Z`) completed. The candidate loop still answered "who owns this
proposal's next step" from the apply action's status. Nothing advances that status after the
gate (`merge_record.py:164-166`).

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z), 9 apply actions sit in
`staged_for_implementation`. 8 of their plans are already finished:

| Plan               | Stagings | Plan state              | How it finished                             |
| ------------------ | -------- | ----------------------- | ------------------------------------------- |
| `20261008T120143Z` | 3        | HUMAN_REQUIRED          | `implementation_delivery_exhausted`         |
| `20261008T151306Z` | 3        | HUMAN_REQUIRED          | `implementation_delivery_exhausted`         |
| `20261008T043925Z` | 1        | HUMAN_REQUIRED          | `operator_withdrawn`                        |
| `20261007T225133Z` | 1        | IMPLEMENTATION_REJECTED | `orchestrator_restart_reaped_orphan`, no PR |

The phase listed all 8 as in-flight forever.

Four shapes would also have failed the night the way ARIA-HIGH-408 did. In each, the phase
previews `open_pr_for_action(dry_run=True)` on a runner that does not have the executor's
branch:

- an action the gate marked `blocked` (`apply_engine.py:266-270`), which is not in
  `IN_FLIGHT_APPLY_STATUSES`;
- a `ready_for_pr` action whose executor delivery was refused at a host stage, which leaves the
  plan IMPLEMENTATION_REQUESTED (the refusal comes back as `open_pr_head_sha_unresolvable`,
  pinned in `tests/test_cycle_pr_lifecycle_phase.py`);
- an approved proposal with no apply action yet (the refusal is "no apply action exists");
- any of the 8 above once its action left `staged_for_implementation`.

### Root cause (ARIA-HIGH-412)

This phase never opens a PR: its call is `dry_run=True` (`cycle.py:3155-3160`). A
machine-lane staging's PR is opened by the executor (`implementation_delivery.py:945/1011`).
The executor also writes its own delivery refusals onto the plan (`settle_delivery_refusal`,
`tools/aria-poc/ci_executor.py:5708-5766`). So a machine staging's next step is owned by its
plan (the `plan_convergence` fold), not by the action's status. The phase read the action
anyway.

### Fix (tier 1: the wrong candidacy cannot be computed)

`aria_kernel/pr_lifecycle_items.classify_pr_lifecycle_items` reads each fact from its one
owner and appends no ledger row. Each approved proposal is classified once, even when it was
approved more than once, and lands in exactly one bucket:

- **delivered:** pr-lifecycle shows a PR for the change. This check runs first, as in #1930.
- **machine approval** (`proposal.approval_source_of`, the one reader of who approved) is
  never a candidate. The plan named by the staging decides:
  - **settled:** the plan state is in `TERMINAL_STATES - {CONVERGED}`;
  - **in_flight:** the plan state is CONVERGED or one of `IMPLEMENTATION_PHASE_STATES`
    (made public for this);
  - **unowned:** no `plan_id`, or a plan state no staging can produce.
- **operator approval:**
  - **awaiting_apply:** no action yet;
  - **in_flight:** the action is still being built;
  - **gate_blocked:** the gate marked the action `blocked`;
  - **candidate:** `ready_for_pr` with no PR. This is the only case that is previewed.
  - **unowned:** any other action status.
- **unowned:** an approval whose source nobody can attribute. `open_pr_for_action` would refuse
  it as `open_pr_approval_source_unknown` and fail the night.

The plan-state sets are derived from `plan_convergence`'s constants.
`tests/test_pr_lifecycle_plan_ownership.py` reads the reducer's own state assignments and pins
that every state is pre-convergence, settled or executor-owned, and that the sets do not
overlap. A state added later fails the test instead of landing silently in `unowned`. The tests
drive plans through the real transitions (`production_converged_plan`,
`force_plan_human_required`, `request_implementation`).

Measured on the archive above with the store bound: candidates 0, delivered 1 (#1906),
settled 8 (all machine approvals; 7 HUMAN_REQUIRED, 1 IMPLEMENTATION_REJECTED), in_flight 1
(`20261009T075229Z`, IMPLEMENTATION_REQUESTED), unowned 0.

### Not done here

No terminal status is written onto proposals or actions. That would be a second copy of the
plan's and the PR's facts; #1930 rejects it, and the apply-actions writer pin
(`test_the_apply_actions_surface_keeps_its_declared_writers`) forbids it. No refusal was added
to `open_pr_for_action`: the operator may still open a PR for a REJECTED orphan-reaped plan
(`plan_convergence.py:1679-1690`).

## ARIA-MEDIUM-413 — a payload-failed phase sealed FAILED with no reason and an `ok` verdict

### Symptom (ARIA-MEDIUM-413)

The five FAILED cycles from `cyc-20261009T104405Z` to `cyc-20261010T025128Z` each show:

- `failed_phases: [{phase: pr_lifecycle, status: failed}]`, with no `error`;
- `runtime_status: ok`;
- a metrics row with status `ok`.

`orchestrator_exit_history.py:181` reads `error`, so the reason for those nights was never
recorded.

### Root cause (ARIA-MEDIUM-413)

Three phases report failure through their payload rather than by raising: pr_lifecycle,
validation_matrix and architecture_postcheck. The seal listed them by name only
(`cycle.py:783-790`). `_runtime_status` saw only outcomes of `failed`, never a payload `fail`,
even though `cycle_runtime_status` defines `failed` as "a phase raised or declared itself
failed". The metrics phase also ran before the three verdict phases.

### Fix

- `cycle._payload_failed_phases` is now the one reader of payload failures, and both the seal
  and `_runtime_status` use it. Each verdict phase states its own `error` (for example, "1 of 1
  PR previews refused: …"). The row is published on aria/state, so the error is scrubbed of
  secrets (`artifact_safety.scrub_text`) and capped at 300 characters.
- The three verdict phases now run before `artifact_integrity` and `metrics`:
  - the close-out set is unchanged (`test_night_closes_at_deadline`);
  - the dashboard still follows metrics;
  - integrity verification walks the run-artifact index, so order does not affect it.
- The metrics row carries a `pr_lifecycle` phase digest with the bucket counts. A digest is
  taken only from a phase whose outcome is `ran` (`_ran_result`). A skipped or raising phase
  stores `{}`, and a digest of that read "ran empty", which is the X3 distinction. This also
  fixes the three existing digests (experiment_night, watchdog_sweep, experiment_author).
- A raised phase failure (`_first_phase_failure`) is scrubbed and bounded the same way, so
  every `failed_phases` row published on aria/state goes through `_published_error`.
- A refusal the validation gate returns rather than raises keeps its reason
  (`gate_result.reason`, for example `regression_anchor_required`).

### Behaviour change, deliberate

Before this change, a payload failure on a night with a degraded tool projected `degraded`.
The orchestrator then ran planner, bridge, convergence and redelivery on a cycle whose terminal
row said FAILED. With every tool ok, the same failure stopped the night. Now both stop it the
same way, as `cycle_runtime_status` defines (`failed` outranks `degraded`).

A payload failure next to an invalid integrity index now reads `failed` instead of
`integrity_failed`. Both are fail-closed, and the integrity verdict stays on the cycle row's
`artifact_integrity`. Pinned in `test_a_payload_failure_outranks_a_degraded_tool` and in
`test_autonomy_orchestrator` (native postcheck failure: `runtime_status: failed`, and the
summary row carries its `error`).

The reorder also brings the run artifacts that architecture_postcheck's spine adapters write
inside the same cycle's integrity verification, which is a strengthening. In production that
phase does not run yet (`PLAN_ID_PRESENT`; ORPHAN-MEDIUM-511).
