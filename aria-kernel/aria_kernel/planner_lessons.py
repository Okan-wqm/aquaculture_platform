"""ARIA-HIGH-309 — the planner side of procedural memory's lesson reader.

WHY. ARIA-HIGH-285 records every finished drafter episode and derives a
lesson once one failure mode recurs (``agent_eval.recurring_failure_modes``),
but only the implementer envelope read it: the primary and challenger
planners were never told, so a plan repeated a mistake the system had
recorded three times.

WHAT. :func:`planner_lesson_obligations` turns the recurring drafter failure
modes of the plans in this plan's scope into binding obligations. The scope
is two facts the plan ledger already records on ``plan_started`` (no memory
``node_ids`` before K17, ADR-0022): the origin class (``plan_origin``) and
the affected-surface paths. A recorded plan is in scope when it has the same
origin class and a path that overlaps one of this plan's. At most
``MAX_PLANNER_LESSONS`` per envelope, the most frequent first, ties by mode.
The obligation's text is the kernel's (``must_satisfy.observed_plan_failure_obligation``).

ARIA-HIGH-370 — a lesson names the role whose work the failure's evidence
named (``failure_attribution``). An envelope carries the plan's own lessons
(role ``drafter``: a gate or the cross-review refused the plan, or an agent
refused the request it was handed) and the lessons of ITS role (the
challenger's refused outputs reach the next challenger envelope, not the
primary's). The role rides as data (``attributed_role``).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_eval import recurring_failure_modes
from .ledger import load_declared_jsonl
from .must_satisfy import observed_plan_failure_obligation
from .plan_origin import plan_origin
from .tool_registry import GovernanceError, ensure_tools_dir_readonly

#: The program plan's per-envelope lesson cap (measurement §3, "Okuyucular").
MAX_PLANNER_LESSONS = 5
DRAFTER_ROLE = "drafter"


def _surface_root(path: str) -> str:
    """The directory a surface names: the path up to its first glob."""
    return path.split("*", 1)[0].rstrip("/")


def _overlap(left: frozenset[str], right: frozenset[str]) -> bool:
    return any(
        a == b or not a or not b or a.startswith(b + "/") or b.startswith(a + "/")
        for a in left for b in right
    )


def _plan_scopes(root: Path) -> dict[str, tuple[str, frozenset[str]]]:
    """plan_id → (origin class, surface roots) from each plan's ``plan_started``.
    A plan whose origin the kernel cannot derive has no scope and matches none."""
    from .plan_convergence import affected_surface_paths, events_file

    ledger = events_file(root)
    rows = load_declared_jsonl(ledger, expected_surface="plan_convergence_events") if ledger.is_file() else []
    scopes: dict[str, tuple[str, frozenset[str]]] = {}
    for row in rows:
        content = row["payload"].get("plan_content") if row["event_type"] == "plan_started" else None
        if not isinstance(content, dict):
            continue
        try:
            kind = plan_origin(content).kind
        except GovernanceError:  # a finding id no commit contract is derived for
            continue
        roots = frozenset(_surface_root(path) for path in affected_surface_paths(content["affected_surfaces"]))
        scopes[str(row["plan_id"])] = (kind, roots)
    return scopes


def planner_lesson_obligations(
    *, base_dir: str | Path | None, plan_id: str, envelope_role: str,
) -> list[dict[str, Any]]:
    """The binding lessons a planning envelope of ``envelope_role`` for ``plan_id`` carries."""
    root = ensure_tools_dir_readonly(base_dir)
    scopes = _plan_scopes(root) if root is not None else {}
    own = scopes.get(plan_id)
    if own is None:
        return []
    in_scope = {
        other for other, (kind, roots) in scopes.items()
        if other != plan_id and kind == own[0] and _overlap(roots, own[1])
    }
    recurring = [
        lesson for lesson in recurring_failure_modes(base_dir=root, role=DRAFTER_ROLE, subject=None, plan_ids=in_scope)
        if lesson["attributed_role"] in (DRAFTER_ROLE, envelope_role)
    ]
    ranked = sorted(recurring, key=lambda lesson: (-lesson["episodes"], lesson["failure_mode"]))
    return [observed_plan_failure_obligation(**lesson) for lesson in ranked[:MAX_PLANNER_LESSONS]]


__all__ = ["DRAFTER_ROLE", "MAX_PLANNER_LESSONS", "planner_lesson_obligations"]
