<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 025 — Calibration Integrity (>=2-judge fan-out · gold-set activation · replay recall)

> **Status:** All three phases implemented (A >=2-judge fan-out, B gold-set activation, C replay recall). Operator CLI deferred (ARIA-025-D1).
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-024-D1 (gold-set-replay recall + gold-set promotion) — the part Plan 024 deferred.

## Summary

Plan 024 built judge calibration but three gaps left it half-fed:

1. **`generate_judgment_sample` is a human worklist, not judge dispatch** — it
   mints no `judge_id`, no `judgment_group_id`, no envelopes. For tool findings
   the kernel never fanned out to two judges, so a finding could get 0/1
   `ai_judge` row and sit as `single_judge` forever
   (`generate_ai_consensus` needs >=2 unique judges). Consensus + calibration
   were starved of data.
2. **`goldset.py` is dead-ended** — `propose_goldset` + `list_goldset_proposals`
   only; no module imports it, no CLI, the `goldset_promoted` event is a
   misnamed marker. The gold set never becomes an active fixture.
3. **Recall is over surfaced findings only** (`judge_calibration.py`); no replay
   re-invokes judges on gold findings they never saw.

## Phase 025a — >=2-judge fan-out (tier-1 "make it impossible") ✅

New `aria_kernel/judge_fanout.py::dispatch_judges_for_sample`. For each finding
in a judgment sample it mints **two** judge invocation envelopes via
`create_agent_invocation_request` — `evidence_judgment`→`aria-evidence-judge`
and `adversarial_judgment`→`aria-adversarial-judge` — sharing one
`judgment_group_id` with distinct `judge_id`. Idempotent (deterministic
`request_id`; already-dispatched groups skipped). Wired into
`heartbeat._produce_judgment_work` right after `generate_judgment_sample`, so a
sampled finding is structurally dispatched to >=2 judges; the resulting
`ai_judge` rows — and consensus — land asynchronously in a later tick.
`single_judge` now means "a judge did not respond", not "only one was ever
asked". Test: `tests/test_judge_fanout.py`.

## Phase 025b — Gold-set activation (tier-2 "make it automatic") ✅

`goldset.py` was dead-ended (`propose_goldset` + a misnamed `goldset_promoted`
marker; no promotion, no consumer). Phase B makes it live:
- New `goldset.promote_goldset_proposal(*, tool_id, curator, ...)` — an explicit
  operator act (a named `curator` accepts a `ready` proposal) writes the approved
  TP/FP gold items to a stable per-tool active file
  (`goldsets/active/<tool_id>.json`); `load_active_goldset` reads it back. This
  is the corpus the §C replay consumes.
- **Design correction:** the gold corpus is JUDGE ground truth (findings +
  verdicts), not an adapter regression fixture. A proposal carries no adapter
  `input`/`expected`, so it is deliberately NOT forced into a
  `semantic_regression` case — that would fabricate adapter inputs. Generating
  adapter fixtures from gold is a separate concern, out of scope here.

**Deferred — ARIA-025-D1 (owner: aria-core, due 2026-08-26):** the operator CLI
`aria-kernel goldset propose|list|promote` + `judge replay`. The kernel
functions are complete and consumed programmatically; the CLI is a thin operator
wrapper held back to avoid destabilising `cli.py`'s heavy invariant surface in
this change. The curator agent doc references `aria-kernel goldset propose`,
which this CLI will finally implement.

## Phase 025c — Gold-set-replay recall (tier-3 measurement) ✅

- New `judge_replay.replay_judges_on_goldset` mints judge envelopes (reusing
  025a's path) on the promoted gold items, tagged with a `replay:<...>`
  `judgment_group_id`, and seeds each gold item's known verdict as `ai_consensus`
  ground truth under that group. True recall then falls out of
  `compute_judge_calibration(judgment_group_prefix="replay:")` — a thin filter
  added to the Plan 024 module; `compute_replay_recall` is the convenience
  wrapper. No new recall math. Test: `tests/test_judge_replay.py`.
- The `judge replay` operator CLI is deferred with the goldset CLI (ARIA-025-D1).

## Acceptance

- `tests/test_judge_fanout.py` passes; full kernel suite green.
- Each sampled finding produces exactly two judge requests with distinct
  judge agents and one shared `judgment_group_id`.
- (025b) A `ready` proposal promotes to an active gold corpus that
  `load_active_goldset` reads and the §C replay consumes; a `blocked` proposal
  cannot be promoted.
- (025c) Replaying judges on gold items and scoring with
  `compute_replay_recall` yields per-`judge_id` recall (a judge that re-calls a
  known TP → recall 1.0; one that misses it → 0.0).

## Assumptions & risk

- 025a/025c re-invoke real Codex judges (LLM cost) in real mode — tested in
  mock mode via direct verdict injection (the `test_judgment_bridge_e2e`
  pattern); judges run on Sonnet per Plan 023 tiering, and `cost_budget.py` caps
  fan-out volume.
- Fan-out volume is `sample_size` × 2 per tool per cycle.
- The gold corpus is JUDGE ground truth, not adapter `input`/`expected`; it is
  consumed by judge replay, not by `run_fixture_suite`. Generating adapter
  regression fixtures from gold is a separate, out-of-scope concern.
