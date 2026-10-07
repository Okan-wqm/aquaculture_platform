"""The evaluator's HUMAN_REQUIRED row, written the way ``evaluate_plan`` writes it.

ARIA-HIGH-370 (review of #1829, HIGH-1) — a FORCED escalation
(``force_plan_human_required``) is the kernel's only for the codes its own
callers write; any other code there is an operator's act and teaches nothing.
Tests that need an attributable gate refusal therefore write the evaluator's
row (gate decisions without ``human_escalation``) through the plan ledger's
own validated append, not through the operator's force path.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from aria_kernel.plan_convergence import _append_event, _plan_lock
from aria_kernel.tool_registry import ensure_tools_dir


def evaluator_escalation(tools: Path, plan_id: str, *codes: str, round_number: int = 1) -> dict[str, Any]:
    root = ensure_tools_dir(tools)
    payload = {
        "round_number": round_number, "terminal_state": "HUMAN_REQUIRED", "risks_rollup_summary": {},
        "gate_decisions": [{"gate": "evaluator", "passed": False}], "reason_codes": list(codes),
    }
    with _plan_lock(root):
        return _append_event(root=root, plan_id=plan_id, event_type="plan_evaluated", payload=payload,
                             idempotency_key="sha256:" + hashlib.sha256(f"{plan_id}:{round_number}".encode()).hexdigest())
