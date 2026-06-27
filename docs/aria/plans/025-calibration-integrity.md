<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 025 — Calibration Integrity (>=2-judge fan-out · gold-set activation · replay recall)

> **Status:** Phase A implemented (>=2-judge fan-out). Phases B (gold-set activation) and C (replay recall) follow on this branch.
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

## Phase 025b — Gold-set activation (tier-2 "make it automatic")

- New `goldset.promote_goldset_proposal` transforms a `ready` proposal into an
  active `semantic_regression` fixture case at `<tool["fixture_set"]>/cases/<name>.json`
  (`lane:"semantic_regression"` + `curation.curator` + `curation.gold_set.{true_positive_count, known_false_positive_count}` + `input`/`expected`
  with `required_findings`/`forbidden_findings` derived from the proposal's TP/FP
  item rules). `run_fixture_suite` then re-runs it every cycle
  (`fixture_runner.py:43`).
- New CLI `aria-kernel goldset propose|list|promote`, mirroring the `feedback`
  subcommand registration (`cli.py:415-431` + dispatch `cli.py:1913`) — the
  surface the curator agent doc references but that was never implemented.

## Phase 025c — Gold-set-replay recall (tier-3 measurement)

- New `judge_replay.replay_judges_on_goldset` mints judge envelopes (reusing
  025a's path) on the promoted gold items, tagged with a `replay:<...>`
  `judgment_group_id`, and seeds each gold item's known verdict as `ai_consensus`
  ground truth. True recall then falls out of `compute_judge_calibration`
  (recall already computed there; gold items are now surfaced + ground-truth-backed).
- New CLI `aria-kernel judge replay --tool-id ...`.

## Acceptance

- `tests/test_judge_fanout.py` passes; full kernel suite green.
- Each sampled finding produces exactly two judge requests with distinct
  judge agents and one shared `judgment_group_id`.
- (025b) A `ready` proposal promotes to a valid fixture case that
  `run_fixture_suite` executes.
- (025c) Replaying judges on gold items yields a recall figure in
  `compute_judge_calibration` keyed by `judge_id`.

## Assumptions & risk

- 025a/025c re-invoke real Codex judges (LLM cost) in real mode — tested in
  mock mode via the direct-envelope pattern (`test_judgment_bridge_e2e`); judges
  run on Sonnet per Plan 023 tiering, and `cost_budget.py` caps fan-out volume.
- Fan-out volume is `sample_size` × 2 per tool per cycle.
- 025b's per-item → `input`/`expected` transform is adapter-specific; it starts
  scoped to `SEMANTIC_FIXTURE_REQUIRED_TOOLS` (the 3 adapters where the semantic
  lane is already a hard blocker) and widens as transforms are proven.
