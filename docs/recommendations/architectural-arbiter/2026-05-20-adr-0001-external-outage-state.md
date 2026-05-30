# ADR-0001 — EXTERNAL_OUTAGE Lifecycle State

**Status:** proposed
**Date:** 2026-05-20
**Branch:** snowball
**Resolves:** ARCH-CRIT-003 (V10.5 v2 architectural-arbiter audit)
**Plan reference:** `/root/.claude/plans/immutable-sparking-waterfall.md` §C
**Finding reference:** to-be-emitted as F-AUTO-V10.5-EXTERNAL-OUTAGE-RATIFICATION on commit

## Context

V10.5 Phase 3 introduces an Anthropic API 529-class outage retry policy (F-023). The mechanism observes 529 responses in subprocess stderr or envelope text, sleeps with exponential backoff + retry-after-aware timing + jitter, and after 3 exhausted attempts raises `APIOutageDetected`. A new derived lifecycle state `EXTERNAL_OUTAGE` is introduced to distinguish API-transient failures from `HUMAN_REQUIRED` agent refusals.

The architectural-arbiter audit identified three load-bearing decisions that require explicit ratification:

1. **State precedence** — order of `EXTERNAL_OUTAGE` vs `HUMAN_REQUIRED` in `derive_request_state`. Pre-audit, the v1 plan inserted `EXTERNAL_OUTAGE` BEFORE the HUMAN_REQUIRED check. The architectural-arbiter audit (SEC-HIGH-005) determined this was incorrect — `HUMAN_REQUIRED` is sticky-by-design and represents operator intent; transient API outage must NOT be able to escape it.
2. **Reaper mechanism** — pre-audit, the plan claimed "requeue after 30 min" but specified no mechanism. `next_pending_request` only treats `PENDING`/`REQUEUED` as eligible; an EXTERNAL_OUTAGE request would be stranded without explicit re-enqueue.
3. **Stickiness semantics** — what happens when `api_backoff_exhausted` and `human_required_record` both appear in the claim event sequence? The state machine needs a documented total-order, not "latest wins."

## Decision

### 1. Order: `EXTERNAL_OUTAGE` is checked AFTER `HUMAN_REQUIRED`

`derive_request_state` in `aria-kernel/aria_kernel/agent_invocations.py` will be extended:

```python
# Existing rule (preserved at line ~612-614): HUMAN_REQUIRED is sticky.
if any(row.get("event") == "human_required" and row.get("request_id") == request_id for row in claims):
    return "HUMAN_REQUIRED"
# NEW (V10.5 Phase 3): EXTERNAL_OUTAGE comes AFTER HUMAN_REQUIRED.
# A transient API outage MUST NOT escape operator review.
latest_claim_event = _latest_claim_event(claims, request_id)
if latest_claim_event == "api_backoff_exhausted":
    return "EXTERNAL_OUTAGE"
```

Rationale: `HUMAN_REQUIRED` is the only state where the operator is in the loop. Reordering so anything cancels HUMAN_REQUIRED is a privilege-de-escalation bug in the autonomy state machine (per SEC-HIGH-005 audit finding).

### 2. Reaper: `external_outage_reaper.py` requeues after 30 min, capped at 4 requeues

A new kernel module `aria-kernel/aria_kernel/external_outage_reaper.py` (~100 LOC) mirrors `human_required.py:177-193`:
- Scans requests in EXTERNAL_OUTAGE state on every cycle reaping pass
- If wall-clock since latest `api_backoff_exhausted` claim event > `EXTERNAL_OUTAGE_REQUEUE_DELAY_SECONDS = 1800`: append `requeued` claim event → state returns to REQUEUED
- After `MAX_EXTERNAL_OUTAGE_REQUEUES = 4` requeues for a single request_id: escalate to HUMAN_REQUIRED (so the operator MUST be in the loop after 4×30min = 2 hours of sustained outage)
- Registered in `aria-kernel/aria_kernel/cycle.py` reaping pipeline alongside existing reapers

### 3. Stickiness semantics: latest claim event determines state UNLESS HUMAN_REQUIRED appears anywhere in the sequence

Once `human_required_record` fires for a request_id, it is sticky regardless of subsequent events (existing behavior preserved). EXTERNAL_OUTAGE is non-sticky — the reaper transitions it back to REQUEUED. If a request has the sequence `api_backoff_exhausted → human_required_record → api_backoff_exhausted`, the state is HUMAN_REQUIRED (because HUMAN_REQUIRED took precedence at insertion time). The reaper does NOT re-process requests already in HUMAN_REQUIRED.

### 4. Cost-attribution semantics

EXTERNAL_OUTAGE requeues count toward an EXTERNAL_OUTAGE-specific budget (`MAX_EXTERNAL_OUTAGE_REQUEUES = 4`), separate from `DEFAULT_MAX_REQUEUES`. Wall-clock spent in EXTERNAL_OUTAGE is recorded via `record_zero_cost_blocked_window` in `aria-kernel/aria_kernel/budget.py` with `ai_cost_usd=0.0` + `attribution="api_outage"`. Operators audit `aggregate_cost_attribution` rolls up to see total blocked-wall-clock per cycle without inflating AI spend.

## Consequences

### Positive
- HUMAN_REQUIRED stickiness preserved — operator review intent is non-bypassable
- EXTERNAL_OUTAGE is a transient state with bounded lifetime (4 requeues × 30min = 2h ceiling)
- Cost telemetry correctly distinguishes blocked-wall-clock from AI spend
- The new state is a closed-set extension; downstream consumers (`human_required.py`, `handoff_ledger.py`) treat it as a non-terminal state by default

### Negative
- DERIVED_STATES tuple grows from 11 to 12 members. Any `match`/`case` exhaustiveness check on this tuple needs an explicit EXTERNAL_OUTAGE arm. The V10.5 Phase 3 implementation MUST audit `aria_kernel/human_required.py:177-193`, `aria_kernel/handoff_ledger.py:139-148`, and `aria_kernel/cycle_phases/*.py` for exhaustive consumers and add the missing case.
- 2-hour ceiling on sustained outage means a long Anthropic API degradation will eventually trigger HUMAN_REQUIRED escalations. Acceptable per the autopoietic discipline: operator MUST be in the loop after sustained external failures.

### Neutral
- The new state is read-only from the autonomy_orchestrator's view; the kernel reducer + reaper own all transitions.

## Compliance

This ADR ratifies a Tier-1 change to a closed-set lifecycle taxonomy. Per CLAUDE.md §Architectural Approach, the change is structurally enforced (the reducer adds the increment; the reaper handles the transition; `next_pending_request` will skip EXTERNAL_OUTAGE until reaper requeues). Tier-3 invariants in `aria-kernel/tests/invariants/v10/test_phase_v10_5_phase_3_api_backoff.py` detect regression of the ordering rule (test #8: "non-529 paths to HUMAN_REQUIRED still terminate as HUMAN_REQUIRED, not EXTERNAL_OUTAGE").

## Implementation owners

- Plan reference: `/root/.claude/plans/immutable-sparking-waterfall.md` §C (V10.5 Phase 3)
- Implementer: operator (Okan) via V10.5 sprint
- Reviewers: architectural-arbiter (for state-machine semantics), security-reviewer (for HUMAN_REQUIRED stickiness preservation)
- Validation: 11 invariants in test_phase_v10_5_phase_3_api_backoff.py + replay of cyc-20260520T144934Z-auto 529 capture
