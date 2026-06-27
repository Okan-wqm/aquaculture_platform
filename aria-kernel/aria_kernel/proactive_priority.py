"""Plan 027 — proactive Impact x Opportunity prioritization.

ARIA was purely reactive: ``run_pressure`` scores Unknown/Repetition/
Contradiction signals, and when there is no pressure the cycle only reflects
(ARCHITECTURE.md: "if there is no pressure, no plan is synthesized"). The
pressure score is severity x recurrence — there is no *value* axis answering
"with nothing on fire, where would effort pay off most?".

This module adds that axis. For every registered tool it computes
``priority = impact x opportunity``:

* **Impact** — criticality of the tool's blast radius (security / tenant / auth
  / billing / SCADA / PLC / edge / audit weigh highest; domain adapters next;
  everything else baseline).
* **Opportunity** — the gap where attention would pay off: no promoted gold
  corpus (Plan 025), under-judged (few ground-truth verdicts), and a modest bump
  when judge calibration is currently degraded (Plan 024) so its findings are
  riskier to trust.

It runs every cycle regardless of reactive pressure, so ARIA always has a
ranked "where to invest next" list. Cheap by construction — registry + feedback
ledger + the active-goldset / calibration artifacts, no LLM.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .feedback_store import load_feedback, load_jsonl
from .goldset import load_active_goldset
from .judge_calibration import calibration_path
from .tool_registry import ensure_tools_dir, list_tools, utc_now


# Criticality buckets by substring of tool_id. Highest blast radius first.
_HIGH_IMPACT_TOKENS = (
    "security", "tenant", "auth", "authz", "rbac", "isolation", "billing",
    "scada", "plc", "edge", "audit", "secret", "compliance",
)
_MED_IMPACT_TOKENS = (
    "sensor", "farm", "hr", "messaging", "alert", "hydroponics", "ai", "outbox",
)
DEFAULT_MIN_JUDGED = 10


def _impact(tool_id: str) -> float:
    # Match on tokenized segments, not raw substrings — otherwise short tokens
    # like "ai"/"hr" spuriously match "claim"/"threshold"/"maintainability".
    tokens = set(re.split(r"[-_.]+", tool_id.lower()))
    if tokens & set(_HIGH_IMPACT_TOKENS):
        return 1.0
    if tokens & set(_MED_IMPACT_TOKENS):
        return 0.7
    return 0.5


def _calibration_degraded(root: Path) -> bool:
    rows = load_jsonl(calibration_path(root))
    if not rows:
        return False
    return bool(rows[-1].get("degraded_judges"))


def _opportunity(
    *, tool_id: str, root: Path, min_judged: int, degraded: bool,
) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = 0.2  # baseline: every tool carries some opportunity
    if load_active_goldset(tool_id=tool_id, base_dir=root) is None:
        score += 0.4
        reasons.append("no_active_goldset")
    judged = sum(
        1 for r in load_feedback(tool_id=tool_id, base_dir=root)
        if r.get("source_type") in ("human", "ai_consensus", "ai_judge")
    )
    if judged < min_judged:
        ratio = (min_judged - judged) / min_judged
        score += 0.4 * ratio
        reasons.append(f"under_judged({judged}/{min_judged})")
    if degraded:
        score += 0.1
        reasons.append("calibration_degraded")
    return min(1.0, score), reasons


def compute_proactive_priorities(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    top_n: int = 5,
    min_judged: int = DEFAULT_MIN_JUDGED,
) -> dict[str, Any]:
    """Rank tools by impact x opportunity and persist + return the worklist."""
    root = ensure_tools_dir(base_dir)
    degraded = _calibration_degraded(root)
    ranked: list[dict[str, Any]] = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id:
            continue
        impact = _impact(tool_id)
        opportunity, reasons = _opportunity(
            tool_id=tool_id, root=root, min_judged=min_judged, degraded=degraded,
        )
        ranked.append({
            "tool_id": tool_id,
            "priority": round(impact * opportunity * 100, 1),
            "impact": round(impact, 3),
            "opportunity": round(opportunity, 3),
            "reasons": reasons,
        })
    ranked.sort(key=lambda r: (-r["priority"], r["tool_id"]))
    result = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "calibration_degraded": degraded,
        "ranked_count": len(ranked),
        "top": ranked[:top_n],
    }
    path = root / "proactive" / "priorities.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    from .feedback_store import append_jsonl
    append_jsonl(path, result)
    return result
