<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 027 — Proactive Impact x Opportunity prioritization (D3)

> **Status:** Implemented (per-cycle proactive ranking, operator-surfaced).
> **Branch:** `claude/aria-gaps-cost-review-rebmuc`
> **Closes:** ARIA-023-D3 (no proactive prioritization — only severity x recurrence pressure).

## Summary

ARIA was purely reactive: `run_pressure` scores Unknown/Repetition/
Contradiction signals (severity x recurrence), and when there is no pressure the
cycle only reflects ("if there is no pressure, no plan is synthesized"). There
was no *value* axis answering "with nothing on fire, where would effort pay off
most?". Plan 027 adds it.

## Implementation (tier-2 "make it automatic")

New `aria_kernel/proactive_priority.py::compute_proactive_priorities`. For every
registered tool it computes `priority = impact x opportunity`:

- **Impact** — blast-radius criticality from the tool_id: security / tenant /
  auth / billing / SCADA / PLC / edge / audit highest (1.0), domain adapters
  next (0.7), baseline (0.5).
- **Opportunity** — the gap where attention pays off: no promoted gold corpus
  (Plan 025), under-judged (few ground-truth verdicts vs `min_judged`), and a
  bump when judge calibration is currently degraded (Plan 024). Each reason is
  recorded so the ranking is explainable.

It reuses Plan 024/025 signals and is cheap (registry + feedback ledger +
active-goldset / calibration artifacts, no LLM). Wired as a per-cycle phase
after `judge_calibration`, **computed regardless of reactive pressure**, so ARIA
always has a ranked "where to invest next" list — the reactive→proactive shift.
Surfaced on `state["proactive_priorities"]`, persisted to
`proactive/priorities.jsonl`, and rendered in the operator daily report via a new
`_render_proactive_section`.

## Acceptance

- A high-impact (security) tool outranks a domain tool at equal opportunity.
- Promoting a gold corpus + adding ground-truth verdicts lowers a tool's
  opportunity (and thus priority).
- The phase runs every cycle (not gated on pressure) and appears in the daily
  report. Test: `tests/test_proactive_priority.py`.

## Assumptions & deferred — ARIA-027-D1

- The ranking is **surfaced** (operator-visible) but does not yet **drive**
  autonomous dispatch: feeding the top proactive items into the next-cycle plan
  (alongside, or as fallback when empty, the reactive pressure top-3) is the
  next step — tracked as ARIA-027-D1 (owner: aria-core, due 2026-09-25).
- Impact is a keyword-criticality heuristic; enriching it with the nx
  dependency-graph blast radius (cross-service fan-out) is a follow-up. Keeping
  it keyword-based keeps the phase dependency-light and deterministic for now.
