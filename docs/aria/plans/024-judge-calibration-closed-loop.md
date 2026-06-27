<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 024 — Closed-Loop Judge Calibration

> **Status:** Phase A implemented (judge calibration measurement). Phases B (operator-resolution feedback) and C (evidence-gated arbiter) follow on this branch.
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-023-D1 (judge calibration loop) from Plan 023.

## Summary

ARIA's entire trust rests on the judge → consensus chain, yet nothing measured
whether the judges are right: `tool_health.compute_metrics` scores the ADAPTER
(`tool_health.py` precision), and a full grep shows **no `judge_id`-keyed
precision anywhere**. The gold set is one-shot (`goldset.py`, no caller), and
the consensus arbiter is a mechanical average (`feedback_store.py:345`) whose
LLM agent file is orphaned (declared but absent from `DISPATCHABLE_ROLES`). So
Plan 023's scout-tier (Sonnet) move is currently **unmeasured**, the consensus
gate is **unvalidated**, and the new HUMAN_REQUIRED escalations are
**fire-and-forget**. Plan 024 closes the loop in three phases.

## Phase 024a — Judge calibration measurement (tier-3 "make it detectable") ✅

New module `aria_kernel/judge_calibration.py`. Scores every judge against
ground truth **without re-invoking any LLM**:

- Ground truth for a judge = a `human` or `ai_consensus` feedback row on the
  same `(run_id, finding_id, judgment_group_id)` the judge also voted on — the
  exact join `generate_ai_consensus` already uses; `human` outranks
  `ai_consensus`.
- Per `judge_id`: precision, recall, accuracy, and a calibration signal (mean
  confidence on correct vs wrong calls). A judge with ≥ `min_samples`
  ground-truth-backed verdicts whose precision falls below `precision_floor`
  reads `degraded`; too few reads `insufficient_data`.
- Persisted to `aria-tools/calibration/judge-calibration.jsonl` (plain chained
  append, consistent with its sibling artifacts `operator-feedback.jsonl` /
  `feedback-consensus-uncertainties.jsonl`, which are likewise unregistered).
- Cycle phase between `consensus_escalation` and `reflection` (`cycle.py`),
  surfaced on `state["judge_calibration"]` and rendered in the operator daily
  report via a new `_render_calibration_section` (reflection already accepted a
  `calibration_result` kwarg with no render section).
- Test: `tests/test_judge_calibration.py` (good judge → ok; over-flagging judge
  → degraded; thin judge → insufficient_data; confidence separation; persist).

## Phase 024b — Operator-resolution feedback loop (tier-2 "make it automatic")

Make the Plan 023 escalation close the loop instead of fire-and-forget:
- `sweep_consensus_uncertainties_for_human_required` persists structured
  `finding_id/tool_id/run_id/judgment_group_id` on the escalation record
  (today only in `reason` prose, `human_required.py:285`).
- `resolve_human_required` gains a structured `verdict` parameter constrained
  to `FEEDBACK_VERDICTS`; on resolving a consensus escalation it calls
  `record_operator_feedback(source_type="human", verdict=...)`, so the
  operator's adjudication flows automatically into the ground-truth pool 024a
  scores against — the loop closes.

## Phase 024c — Evidence-gated arbiter (tier-1 "make it impossible")

Turn "Opus does not trust Sonnet" from a prompt clause into a gate:
- Inside `generate_ai_consensus`, after the unanimity + mean-confidence checks
  pass but before the `ai_consensus` row is written (`feedback_store.py:352-372`),
  re-verify each judge's `evidence_refs` resolve `repo_verified` at the run's
  `target_sha` via `evidence_validator.validate_agent_response_evidence` /
  `classify_evidence_ref` + `EvidencePolicy.require_repo_verified`.
- Any judge whose evidence is not repo-verified → new uncertainty reason
  `evidence_not_repo_verified` → existing `_consensus_uncertainty` + Plan 023
  escalation path; the consensus row is NOT written. Unanimity/confidence math
  is untouched.
- One new dependency: thread the run's `target_sha` (from `runs.jsonl`, the
  source `_feedback_cycle` already reads) into the consensus computation.

## Acceptance

- `tests/test_judge_calibration.py` passes; the full kernel suite stays green.
- A degraded judge surfaces in `state["judge_calibration"].degraded_judges`
  and in the operator daily report.
- (024b) Resolving a consensus HUMAN_REQUIRED with a verdict writes a `human`
  feedback row that 024a then scores against.
- (024c) A judge with unverifiable evidence cannot produce a consensus row;
  it escalates as `evidence_not_repo_verified`.

## Assumptions & deferred

- Recall in 024a is over *surfaced* findings only. Gold-set-replay recall
  (re-invoking judges on known findings they never saw — needs LLM
  re-invocation) is deferred to Plan 025 as **ARIA-024-D1** (owner: aria-core,
  due 2026-08-26), which also builds the gold-set promotion path
  (`goldset.py` is one-shot with no caller today).
- The calibration ledger is a plain artifact surfaced via the reflection
  report (the operator channel); promotion to a gated/observable StateSurface
  is a clean follow-up if direct operator-tooling visibility is required.
