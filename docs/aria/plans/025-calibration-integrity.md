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
