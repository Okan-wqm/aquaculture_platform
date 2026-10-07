"""ARIA-HIGH-370 — kernel-attributed failure modes gate candidate admission.

WHY. The 2026-10-06 loop RCA (blocker 7) measured a planner that re-admitted
the same candidate after every failure: four failing_ci plans built on the
same ``gh-run-list:`` pseudo-ref, each refused for that ref (the evidence law
on 08-16, the challenger's ``agent_refused:evidence`` on 09-29 and 09-30),
and nothing between the record of those failures and the next admission.
The lesson reader (ARIA-HIGH-309) tells the NEXT PLANNER what failed; it
cannot stop the synthesizer from minting the identical plan again, which
burns a challenger turn per cycle on a refusal already recorded.

WHAT. :func:`recurring_attributed_refusal` judges a converted candidate
before it is admitted. A candidate is identified by what its plan is built
on — its ``finding_id`` and the grounds of its evidence refs (the text
before the first ``:``: a file path, or a pseudo-ref's scheme), so a new CI
run id or a new line number is the same candidate and a different file is
not. When the last ``LESSON_EPISODE_THRESHOLD`` ATTRIBUTED drafter episodes
of earlier plans with that identity all failed in the same attributed mode
(``failure_attribution``), the candidate is refused unchanged; a converged
episode in that window, a different mode, or a changed identity admits it.
Unattributed episodes (a stall, a dead lease, a provider outage) are
skipped, never counted: they say nothing about the candidate.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .agent_eval import LESSON_EPISODE_THRESHOLD, list_performance_observations
from .ledger import load_declared_jsonl
from .tool_registry import ensure_tools_dir_readonly

RECURRING_ATTRIBUTED_FAILURE = "recurring_attributed_failure"


def candidate_identity(plan_content: Mapping[str, Any]) -> str:
    """What a plan is built on: its finding and the grounds of its refs."""
    refs = plan_content.get("evidence_refs")
    grounds = sorted({str(ref).split(":", 1)[0].strip() for ref in refs}) if isinstance(refs, list) else []
    finding = plan_content.get("finding_id")
    canonical = json.dumps([finding if isinstance(finding, str) else None, grounds], sort_keys=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _plan_identities(root: Path) -> dict[str, str]:
    from .plan_convergence import events_file

    ledger = events_file(root)
    rows = load_declared_jsonl(ledger, expected_surface="plan_convergence_events") if ledger.is_file() else []
    identities: dict[str, str] = {}
    for row in rows:
        content = row["payload"].get("plan_content") if row["event_type"] == "plan_started" else None
        if isinstance(content, dict):
            identities[str(row["plan_id"])] = candidate_identity(content)
    return identities


def recurring_attributed_refusal(
    *, base_dir: str | Path | None, plan_content: Mapping[str, Any],
    threshold: int = LESSON_EPISODE_THRESHOLD,
) -> dict[str, Any] | None:
    """The recorded lesson that refuses this candidate unchanged, or None."""
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return None
    identity = candidate_identity(plan_content)
    same = {plan for plan, other in _plan_identities(root).items() if other == identity}
    attributed = [
        row for row in list_performance_observations(base_dir=root)
        if row["role"] == "drafter" and row["plan_id"] in same and row["attributable"]
    ]
    window = attributed[-threshold:]
    if len(window) < threshold or any(row["success"] for row in window):
        return None
    modes = {(str(row["failure_mode"]), str((row.get("attribution") or {}).get("role") or "drafter"))
             for row in window}
    if len(modes) != 1:
        return None
    mode, role = modes.pop()
    return {
        "reason": RECURRING_ATTRIBUTED_FAILURE, "candidate_identity": identity, "failure_mode": mode,
        "attributed_role": role, "episodes": len(window),
        "plan_ids": [str(row["plan_id"]) for row in window],
    }


__all__ = ["RECURRING_ATTRIBUTED_FAILURE", "candidate_identity", "recurring_attributed_refusal"]
