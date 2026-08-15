"""M4+M8/E8 — the belief-verdict channel: contradictions reach a human,
and the human's verdict finally moves belief confidence.

Two halves of one severed loop, closed together because each is useless
alone:

* M4 — contradictions had no escalation producer. `_record_contradiction`
  appended `status: open` rows and the pressure path surfaced a generic
  "review the ledger" line, but nothing ever minted a HUMAN_REQUIRED
  record a human could adjudicate: a contradiction could stay open for
  months with no path to a verdict.
* M8 — `record_operator_feedback` accepted `affected_belief_ids` and
  `memory._feedback_adjustment` read it, but NO producer ever passed it:
  human and AI verdicts could never move belief confidence. The general
  producer (bind beliefs to findings by evidence overlap) belongs to the
  comprehension program — mechanical file-matching would re-introduce the
  drift the field exists to avoid. But when an operator adjudicates a
  BELIEF escalation, the affected belief is exact, by construction: this
  module is that narrow, honest producer.

Channel: contradiction open across >= min_open_cycles distinct cycles →
`record_human_required(kind=belief_escalation, belief_id, ...)` (idempotent
per belief) → operator resolves with a verdict → `resolve_human_required`
routes it to a feedback row carrying `affected_belief_ids=[belief_id]` →
`_feedback_adjustment` moves the belief's confidence. The learning loop is
closed end to end for the first time.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import ensure_tools_dir

__all__ = ["BELIEF_ESCALATION_KIND", "escalate_stuck_contradictions"]

BELIEF_ESCALATION_KIND = "belief_escalation"

# WHY 3: one contradictory sighting can be adapter noise, two can be a flaky
# rule; three distinct cycles of the same open contradiction is a standing
# disagreement between ARIA's memory and its scanners — exactly the thing a
# human should settle.
DEFAULT_MIN_OPEN_CYCLES = 3


def escalate_stuck_contradictions(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    min_open_cycles: int = DEFAULT_MIN_OPEN_CYCLES,
) -> dict[str, Any]:
    """Mint a HUMAN_REQUIRED record per belief whose contradiction persists.

    Idempotent by request_id (`HR-belief-<belief_id>`): the same standing
    contradiction re-observed next cycle folds into the existing record
    instead of re-paging the operator.
    """
    from .memory import load_jsonl
    from .human_required import record_human_required

    root = ensure_tools_dir(base_dir)
    path = root / "memory" / "contradictions.jsonl"
    rows = load_jsonl(path) if path.exists() else []
    cycles_by_belief: dict[str, set[str]] = {}
    latest_row: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("status", "open") != "open":
            continue
        belief_id = str(row.get("belief_id") or "")
        if not belief_id:
            continue
        cycles_by_belief.setdefault(belief_id, set()).add(
            str(row.get("cycle_id") or "")
        )
        latest_row[belief_id] = row
    escalated: list[str] = []
    for belief_id, cycles in sorted(cycles_by_belief.items()):
        if len(cycles) < min_open_cycles:
            continue
        row = latest_row[belief_id]
        record_human_required(
            request_id=f"HR-belief-{belief_id}",
            severity="medium",
            reason=(
                f"belief {belief_id} has an open contradiction across "
                f"{len(cycles)} cycles: {row.get('reason')}"
            ),
            context={
                "kind": BELIEF_ESCALATION_KIND,
                "belief_id": belief_id,
                "source_tool_id": str(row.get("source_tool_id") or ""),
                "contradiction_reason": str(row.get("reason") or ""),
                "open_cycle_count": len(cycles),
            },
            base_dir=root,
        )
        escalated.append(belief_id)
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "escalated_belief_ids": escalated,
        "open_contradiction_beliefs": len(cycles_by_belief),
    }
