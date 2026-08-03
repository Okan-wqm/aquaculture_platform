# ARIA Wave 2 — work that outlives the cycle that saw it

Date: 2026-08-03
Branch: `claude/aria-w2-mission-core`
Scope: `aria_kernel/mission.py` (new), `aria_kernel/confidence.py` (new),
`aria_kernel/state_manifest.py`, `aria_kernel/cli.py`,
`aria_kernel/tool_runner.py`, `aria_kernel/instinct_candidate.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2 PR 1.1

## The gap

`task.py` derives task identity from `cycle_id`
(`_task_id(cycle_id, source, source_id)`), so the same defect rediscovered
tonight is a NEW task every night. Nothing accumulates, nothing resumes, and
"no plan silently half-done" — the program's first rule — has no durable
subject to be enforced against. `generate_task_candidates` compounds it: the
generator exists and no production code calls it.

## Identity is WHAT, never WHEN

`mission_id = m-sha256(source_kind|source_id|repo_hash)[:16]`. No timestamp,
no counter, no cycle reference: the same source re-observed in any later cycle
folds into the same mission, which is what makes resuming structurally
possible rather than a matter of discipline.

The pin (I-W1-05) is an AST test, not a behavioural one, and the reason is
worth keeping: a time component would collide within one second and pass a
same-run equality check, so `test_mission_id_source_never_reads_cycle_or_time`
walks the module source and refuses any mission-id function that references
cycle identity OR any source of freshness (clock, uuid, randomness). The
derivation cannot regress by someone "helpfully" adding a freshness component
without deleting the test that says so.

## The vocabularies are closed, with one honest exception

States (9 mainline + 5 waiting + 5 terminal), transition edges, retry rungs,
wake kinds, binding keys and event kinds are each a finite table in
`mission.py` and nowhere else. Terminal states have no outgoing edges — the
table says so and the tests keep it so.

The exception: a FORWARD jump along the mainline is legal only when
`reason_code == "coarse_observation"`. Today's pipeline genuinely cannot
distinguish CONTRACTING from PLANNING from VALIDATING; a skip that says so is
honest, where a skip wearing a precise reason would be the schema lying about
its own resolution. Backward moves always need an explicit table edge —
reconciliation's `reconciled_lost_branch` re-entry to PLANNING is an edge, not
a special case in code.

The waiting states are OUTSIDE `ACTIVE_WIP_STATES` on purpose: a mission waiting
on a human releases its WIP slot instead of deadlocking the pipeline, and its
wake condition records what would un-stick it.

## Event-sourced on the proven pattern

Ledger + fold, exactly `plan_convergence`'s shape: `state_transaction` locks,
verified reads, hash-chained declared appends
(`missions/mission-events.jsonl`, surface `mission_events`), idempotent
replay by `sha256(mission_id|step_id|target_sha|action_type)[:16]`. The index
(`mission_index`, rewrite_fsync) is a derived projection — the test deletes
it, rebuilds, and requires byte-identical content, so losing it costs one
rebuild and nothing else.

`assert_cycle_closure` is "no plan silently half-done" as an executable check:
every open mission must carry `next_action` + `wake_condition`; a violation is
recorded as a `mission_closure_violation` governance event because a violation
nobody recorded is a violation nobody will fix. This PR provides the check;
wiring it into `cycle_seal` (and the per-profile decision of what a violation
does to the cycle) is PR 1.2, where the phase table owns it.

## ORPHAN-HIGH-541 rides here, per its deadline

`tool_runner._valid_memory_candidates` accepted any non-negative `confidence`
and clamped it — `min(float(confidence), 1.0)` — so an adapter emitting a
count, a severity grade or a milliseconds reading was silently promoted to
1.0, maximum certainty, and recorded as a belief weight. `instinct_candidate`
three modules away already refused the same input.

One definition now lives in `confidence.py` and both callers use it: the
adapter path DROPS an out-of-range candidate (the adapter contract skips
malformed candidates rather than aborting the batch), the instinct path
raises as it always did. Booleans are refused even though `bool` is an `int`
— a flag is a claim of kind, not of degree, and `True` reading as certainty
re-opens the same door. The clamp is deleted, not widened.

## Verification

- `aria-kernel/tests/test_mission.py` — 27 tests, written before the module.
- `aria-kernel/tests/test_confidence_validation.py` — 10 tests, red before
  the fix.
- **Mutation-checked seven ways**: freshness added to the identity (1 fails —
  the AST pin, after strengthening it beyond `cycle_id` alone); idempotency
  lookup dropped (2 fail); forward skip without `coarse_observation` allowed
  (1); retry ladder walks backward (1); governance flag set without the row
  (1 — after the test was strengthened to read the LEDGER, because a result
  field claiming "recorded" proves the function said so, not that it did so);
  binding dedupe dropped (1); the confidence clamp reintroduced (2).
- Kernel suite 3130 OK; `invariants:fast` 2269 green; run **sequentially**.

## Findings

- **ORPHAN-HIGH-541** — adapter confidence clamp fails open to maximum
  certainty. CLOSED here (registered in the #1061 branch;
  `docs/reviews/claude/2026-08-03-aria-typed-confidence.md`).
- **ORPHAN-HIGH-542** — task identity is cycle-scoped and the candidate
  generator has no production caller, so no piece of work can accumulate
  evidence or resume across cycles. The identity half CLOSES here; the
  no-production-caller half closes in PR 1.2 (`mission_ingest`), tracked on
  the same finding until then.

Owner: okan
