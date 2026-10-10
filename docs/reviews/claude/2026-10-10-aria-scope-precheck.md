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

The mint's scope block is now one function, `cross_review_bridge.implementation_envelope_scope`.
It takes the CONVERGED body's surfaces (`affected_surface_paths`) and the plan's admission bound
(`admission_scope_for_plan`) and passes them to the existing `implementation_allowed_scope`. It
returns `(allowed_scope, refused_surfaces)`, or it raises the mint's `BridgeContractViolation`
with the same text as before.

Before `converged_delivery._claim_attempt` claims an attempt, it calls that same function on the
same fold and the same hash-verified body (`plan_body_from_state`). So the door and the mint
cannot disagree about what can be minted, and no second classifier exists. Three outcomes are
refusals:

- **The scope is empty.** Every declared surface is refused (readonly, glob, traversal), or no
  surface is declared at all.
- **A surface lies outside the admission bound** (`AdmissionScopeExceeded`). The gate also writes
  the plan-keyed `revision_scope_exceeds_admission_closure` row once, with the caller's stage
  (`stage: converged_delivery` here, `implementation_mint` in the mint).
- **The plan started from a finding without its admission record** (`admission_scope_missing`).
  The door reads this first: `admission_scope_for_plan` is a pure read, and this is its only
  refusal. The gate raises it unchanged, and only an operator restart can record a bound.

Any other error is not a scope verdict and is not parked. A body the ledger cannot prove, or a
ledger fault, still reaches the existing `converged_delivery_attempt_unrecorded` row, uncounted.

When the scope is refused, `_withhold_unwritable_scope` does what the ARIA-HIGH-375 move does:

- `force_plan_human_required(from_states={"CONVERGED"}, forced_by="kernel:converged_delivery",
reason_codes=["implementation_envelope_no_writable_scope"])`, under the plan lock;
- one `converged_delivery_no_writable_scope` governance row that carries the mint's refusal
  word for word (`refusal`);
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
stagings of four baseline commands each. After the fix the file passes 12 of 12 (15 of 15 with the review follow-up).

Two existing fixtures in `tests/test_converged_delivery.py`, `SweepBoundTests` and
`OrchestratorWiringTests`, offered a dispatching runner a plan whose only surface was the shared
fixture's default, `aria-kernel/aria_kernel/plan_convergence.py`. That path is readonly, so the
real mint refuses such a plan. They now declare a writable surface through
`deliverable_plan_content`.

### Review of ad6774791 (`security`): one confirmed defect, closed in the follow-up commit

`security` reproduced a body the plan validator accepts: `affected_surfaces: [{"paths": []}]`, with
the paths only in `key_changes`. It went through the first door:

- `implementation_allowed_scope([], …)` returns `([], [])`;
- the door's own copy of the condition, `[] if writable else refused`, read "nothing refused" as
  "mintable";
- the plan was staged at `(1, 1, 4)` and attempt 1 was counted, then the mint refused it with the
  HIGH-416 token.

The root cause was the second copy of the condition. It is closed by removing the copy: the door
now asks the mint's own gate (see Fix). The repro is
`test_a_plan_that_declares_no_surface_is_parked_too`. On the first door it read `(1, 1, 4, 1)`,
and it now reads `(0, 0, 0, 0)` with the plan HUMAN_REQUIRED.

The same follow-up also makes two small changes `main` approved, each red then green:

- **The ARIA-HIGH-375 move is stamped.** `withhold_ungated_self_agreement` now stamps
  `forced_by="kernel:converged_delivery"` like converged_delivery's other two moves. Before, it
  wrote `operator`.
- **`KERNEL_FORCED_CODES` lists the two codes converged_delivery forces.** These are
  `cross_review_self_agreement` and `implementation_envelope_no_writable_scope`. Without them,
  its docstring ("any other code was written by the operator") stays true only on paper. Listing a
  code does not make it attributable: `attribute_evaluation` attributes only
  `convergence_envelope_dead` and the gate codes. The tests pin both stamped rows as unattributed.

### Not done here

- **No staging reuse or idempotency across offers.** That is an optimisation for plans the mint
  accepts, and it is outside this plan by design (plan v4 §PR-4). The six stale actions are
  classified `settled` by ARIA-HIGH-412.
- **A body the ledger cannot prove is not judged here.** If `plan_body_from_state` raises
  (`plan_body_unavailable_for_revision`), the error reaches `deliver_converged_plan`'s existing
  `converged_delivery_attempt_unrecorded` row, and the offer is withheld without being counted
  (pinned in `test_a_body_the_ledger_cannot_prove_is_not_a_scope_verdict`). Only a ledger edit
  outside the plan lock could produce that state, because the kernel records each revision's
  content with its hash, and `fold_plan_state` already refuses a ledger whose hash chain breaks.
  Before this change, staging hit the same error first and counted it.
- **The exhaustion path still writes a second operator item.** `_record_exhaustion` writes
  `converged-delivery-exhausted-<plan>`, and `reconcile_parked_plans` adds
  `plan-human-required-<plan>` for the same parking. Both are open in production for both plans.
  This is tracked as **ARIA-MEDIUM-429** (OPEN, owner claude, deadline 2026-10-24) and is not
  changed here.
- **The two production plans stay as they are.** They are HUMAN_REQUIRED already, and their items
  are the operator's.
- **No attribution change.** The forced row is never attributed to the drafter. That is the
  intended outcome: the plan is sound, and only the lane's authority boundary keeps it from being
  delivered. The code is listed in `KERNEL_FORCED_CODES` (see the review section) but is not an
  `ATTRIBUTABLE_GATE_CODES` member.

## ARIA-MEDIUM-429 — one exhausted plan, two operator items (fix, wave 2)

### Symptom

On the archive (f5c5c86a1, `human-required/`), both plans that delivery exhausted have two open
items for one parking:

| Plan                             | `converged-delivery-exhausted-<plan>` | `plan-human-required-<plan>` (origin `reconcile`) |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `plan-cyc-20261008T120143Z-auto` | open, 10-08 19:06:27Z                 | open, 19:06:41Z                                   |
| `plan-cyc-20261008T151306Z-auto` | open, 10-10 09:21:07Z                 | open, 09:21:24Z                                   |

The first item carries the attempts `[1, 2, 3]` and `runner_exception:BridgeContractViolation`.
The second carries neither. Both describe one `plan_evaluated` row,
`implementation_delivery_exhausted`.

### Evidence

- `converged_delivery.py:378-404` (parent): `_record_exhaustion` writes its own record, with
  request id `converged-delivery-exhausted-<plan>` and context kind `converged_plan_delivery`.
- `converged_delivery.py:445` (parent): `escalate_exhausted_plan` writes that record after the
  HUMAN_REQUIRED transition.
- `converged_delivery.py:799` (parent): the sweep then runs `reconcile_parked_plans`. That
  function writes `plan-human-required-<plan>` for any HUMAN_REQUIRED plan whose parked item is
  missing (`convergence_outcome.py:168-177`). The exhaustion never wrote that item.
- `converged_delivery.py:720-726` (parent): the sweep's repair branch rewrote a missing
  exhaustion record. That made a second writer for the same fact.

### Root cause

`convergence_outcome.record_parked_plan` is documented as the ONE operator item per parked plan.
The independence migration and the no-writable-scope parking (ARIA-HIGH-416) both use it.
Delivery exhaustion predates it and kept its own record. The reconcile, which guarantees the
one item, then added the plan's item next to it.

### Fix (tier 1: one writer)

- `escalate_exhausted_plan` writes the plan's item through `record_parked_plan`, with verdict
  `attempts_exhausted`, origin `converged_delivery` and the last rejection class.
- `record_parked_plan` derives `delivery_attempts` from the plan's own ledger. So the reconcile's
  repair writes the same attempts as the escalation would have.
- `_record_exhaustion`, `human_required_request_id` and the sweep's repair branch are deleted,
  along with the sweep report's `repaired` key. An escalation that did not live to write its item
  is repaired by the `reconcile_parked_plans` at the end of the same sweep. That was already the
  one place the invariant is guaranteed. Its report gains a `folded` list.
- **Existing duplicates, append-only.** `reconcile_parked_plans` folds an open legacy
  `converged-delivery-exhausted-<plan>` item into the plan's item, in an order a crash can
  resume. The reconcile already skips a plan whose item exists, so it cannot add a second item.
  1. When the kept item is open, it takes the legacy item's attempts and last rejection class
     (`refresh_open_record_context`, kind unchanged, plus `folded_from`).
  2. One `parked_plan_duplicate_folded` governance row is appended, once per legacy id.
  3. The legacy item is resolved by the kernel with `kernel_disposition`
     `folded_into_parked_plan_item`, naming the kept item.
- A legacy item of a plan that left HUMAN_REQUIRED is resolved together with the plan's other
  items (`_resolve_left_items`).
- The no-authority record (`converged-delivery-no-authority-<plan>`) is unchanged. That plan
  stays CONVERGED, so it is not a parking.

### Production evidence (copy of `human-required/`, `plans/` and `governance.jsonl`)

|                                     | parent                                     | this fix                                                                                                          |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| open items for the two plans        | 4                                          | 2, one per plan                                                                                                   |
| first reconcile                     | `{recorded: [], resolved: [], failed: []}` | `folded`: both legacy ids                                                                                         |
| kept items                          | no attempts                                | `delivery_attempts` `[1, 2, 3]`, `last_rejection_class` `runner_exception:BridgeContractViolation`, `folded_from` |
| legacy items                        | open                                       | `resolved`, `resolved_by: kernel`, `folded_into_parked_plan_item`                                                 |
| `parked_plan_duplicate_folded` rows | 0                                          | 2                                                                                                                 |
| second reconcile                    |                                            | all four lists empty; `human-required/` and `governance.jsonl` byte-identical                                     |

The governance ledger stays append-only: the old bytes are a prefix of the new file.

### Tests

`tests/test_parked_plan_single_item.py` has 4 tests on the delivery suite's real CONVERGED plan.
All 4 are red on the parent.

- An exhaustion writes the plan's one item, with its attempts and last rejection class, and the
  reconcile adds nothing.
- The production pair folds into the plan's item, and a second reconcile writes nothing.
- A legacy item of an abandoned plan is resolved with the plan's other items.
- A fold interrupted after its governance row completes once.

`test_converged_delivery.py` now pins the exhaustion item as the plan's own item, and the repair
as the reconcile's. `test_converged_delivery_scope_precheck.py` changed only for the rename and
the report's new `folded` key.

### Not done here

- **The two production pairs are not changed by this commit.** They fold on the first cycle
  sweep that runs this code. The resolved legacy item keeps all of its content.
