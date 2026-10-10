# ARIA — a plan the envelope mint must refuse is parked before staging (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-HIGH-416 — `implementation_envelope_no_writable_scope` was learned after staging, three times

### Symptom

On an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z), two plans ended
HUMAN_REQUIRED with `implementation_delivery_exhausted`. Each declared exactly one surface, under
`.github/workflows/`:

| Plan               | Declared surface                                    | Counted offers (cycle)                                                   | Ended        |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `20261008T120143Z` | `.github/workflows/deploy-capacity-maintenance.yml` | `executor-37785407758-1`, `cyc-20261008T151306Z`, `cyc-20261008T175911Z` | 10-08 19:06Z |
| `20261008T151306Z` | `.github/workflows/ci-affected.yml`                 | `executor-37811678748-1`, `cyc-20261009T075229Z`, `cyc-20261010T080114Z` | 10-10 09:21Z |

`plans/events.jsonl` lines 109/110/126 and 125/144/150 are the six `implementation_delivery_attempted`
rows; lines 127 and 151 are the exhaustions. `governance.jsonl` holds six
`implementation_envelope_bridge_violation` rows, each followed by `v9_implementation_phase_failed`, and
every one reads `implementation_envelope_no_writable_scope: every declared surface ... is refused
(['readonly_surface_declared:.github/workflows/...'])`.

Each offer paid for a full staging first:

- 6 proposals recorded and machine-approved (`proposals/proposals.jsonl`);
- 6 apply actions left in `staged_for_implementation` (`apply/actions.jsonl`). These are 6 of the 8
  stagings ARIA-HIGH-412 found listed as in-flight forever;
- 24 baseline validation runs, 4 per staging, 45.6 minutes in total, about 6 to 12 minutes of
  `npm run type-check` each (`validation/validation-runs.jsonl`, change chains `chg_4c64dd13e775dc7c`
  and `chg_53ec193feff29429`);
- two operator items per plan: `converged-delivery-exhausted-<plan>` and the parked-plan item
  `plan-human-required-<plan>` that `reconcile_parked_plans` wrote next to it.

### Root cause

The refusal depends on the plan body alone. `cross_review_bridge.issue_implementation_envelope`
derives the envelope's scope from the CONVERGED body's surfaces, held to the plan's admission bound,
minus `READONLY_PATHS` (`implementation_safety.implementation_allowed_scope`,
`implementation_safety.py:2596-2637`), and refuses an empty scope (`cross_review_bridge.py:872-892`).
The mint is step 2 of the runner. Step 1, `apply_engine.stage_converged_plan_for_pr`, records the
change chain, runs the baseline suite and records the proposal and the apply action
(`apply_engine.py:726-809`; `cycle_phases/implementer.py:262-314`). The delivery door
(`converged_delivery._claim_attempt`) had already counted the attempt before the runner ran. So a
refusal that no later cycle could change was learned only after staging, as a counted attempt, and
it was learned again on each of the plan's three offers.

### Fix (tier 1 for the waste, tier 2 for the escalation)

`converged_delivery._claim_attempt` judges the scope the way the mint does before it claims an
attempt. `_mint_scope_refusals` takes the hash-verified CONVERGED body (`plan_body_from_state`),
reads its surfaces with `affected_surface_paths`, reads the bound with `admission_scope_for_plan`,
and passes both to the existing `implementation_allowed_scope`. No second classifier was written.
Every input comes from the folded plan state, so this check gives the mint's own verdict before any
staging is paid for. Three outcomes are refusals:

- every surface is refused (readonly, glob, traversal);
- a surface lies outside the admission bound (`AdmissionScopeExceeded`). This also writes the
  plan-keyed `revision_scope_exceeds_admission_closure` row through the existing
  `record_admission_scope_refusal`, with `stage: converged_delivery`;
- the plan started from a finding without its admission record (`admission_scope_missing`). The
  mint raises this for the same fold, and only an operator restart can record a bound.

When the scope is refused, `_withhold_unwritable_scope` does what the ARIA-HIGH-375 move does:

- `force_plan_human_required(from_states={"CONVERGED"}, forced_by="kernel:converged_delivery",
reason_codes=["implementation_envelope_no_writable_scope"])`, under the plan lock;
- one `converged_delivery_no_writable_scope` governance row that names every refused surface;
- the plan's one operator item through `record_parked_plan` (`plan-human-required-<plan>`,
  origin `converged_delivery`, verdict `no_writable_scope`).

The offer then returns the new uncounted `WITHHELD_NO_WRITABLE_SCOPE`. Nothing is staged, no
baseline suite runs, and `counted_delivery_attempts` does not change. In the sweep, a parked plan
does not use up the cycle's single re-offer, so the next stranded plan is still offered.

The check runs after the live-request check and before the dirty-tree check:

- **After the live-request check.** A live implementation request is the plan's delivery and is
  never parked over (review M3 of ARIA-HIGH-362, the same rule `escalate_exhausted_plan` keeps).
- **Before the dirty-tree check.** The verdict does not depend on the tree, so a dirty lane does
  not delay it by a cycle.

A plan that left CONVERGED under the lock is reported `not_converged` and is not parked again.
The mint keeps its own check as a second line.

Tests (`tests/test_converged_delivery_scope_precheck.py`) run the real runner, the real staging
and the real mint, using production's plan shape (`production_converged_plan` with one
`.github/workflows/` surface). Only the validation child processes are faked. The tests replay
120143Z's three offers and assert:

- no proposal, no apply action and no validation run;
- the plan is HUMAN_REQUIRED on the first offer, with 0 attempts;
- the forced row names the reason code and the kernel forcer;
- there is one governance row and one operator item, and a later sweep's reconcile adds none;
- a plan with a writable surface (and a partly readonly one, which the mint narrows) is staged and
  dispatched as before.

Run against the unfixed module, the file goes 8 failed, 4 passed. The 4 that pass are the
controls: a writable plan, a partly readonly plan, the mint's own refusal, and a live request.
The replay counts `(proposals, apply actions, baseline runs, counted attempts)` and reads
`(3, 3, 12, 3)` where it now reads `(0, 0, 0, 0)`. That is production's per-plan shape: three
stagings of four baseline commands each. After the fix the file passes 12 of 12.

Two existing fixtures in `tests/test_converged_delivery.py`, `SweepBoundTests` and
`OrchestratorWiringTests`, offered a dispatching runner a plan whose only surface was the shared
fixture's default, `aria-kernel/aria_kernel/plan_convergence.py`. That path is readonly, so the
real mint refuses such a plan. They now declare a writable surface through
`deliverable_plan_content`.

### Not done here

- **No staging reuse or idempotency across offers.** That is an optimisation for plans the mint
  accepts, and it is outside this plan by design (plan v4 §PR-4). The six stale actions are
  classified `settled` by ARIA-HIGH-412.
- **A body the ledger cannot prove is not judged here.** If `plan_body_from_state` raises
  (`plan_body_unavailable_for_revision`), the error reaches `deliver_converged_plan`'s existing
  `converged_delivery_attempt_unrecorded` row, and the offer is withheld without being counted.
  Only a ledger edit outside the plan lock could produce that state, because the kernel records
  each revision's content with its hash, and `fold_plan_state` already refuses a ledger whose
  hash chain breaks. Before this change, staging hit the same error first and counted it.
- **The exhaustion path still writes a second operator item.** `_record_exhaustion` writes
  `converged-delivery-exhausted-<plan>`, and `reconcile_parked_plans` adds
  `plan-human-required-<plan>` for the same parking. Both are open in production for both plans.
  This is reported to `main` for the HR-hygiene lane and is not changed here.
- **The two production plans stay as they are.** They are HUMAN_REQUIRED already, and their items
  are the operator's.
- **No attribution change.** The new reason code is not in `failure_attribution.KERNEL_FORCED_CODES`,
  so the forced row is never attributed to the drafter. That is the intended outcome: the plan is
  sound, and only the lane's authority boundary keeps it from being delivered. The outcome is the
  same as it would be with the code listed, because `attribute_evaluation` attributes only
  `ATTRIBUTABLE_GATE_CODES` and `convergence_envelope_dead`.
