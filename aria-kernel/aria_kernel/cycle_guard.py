"""Empty-cycle guard (Plan 016 Faz D8).

Why: Plan 016's convergent planning loop is expensive (5 rounds x 2
decision-tier planners). Issuing it for an empty cycle — no fresh
pressure above threshold, no operator-facing findings to act on, no
queued plans — burns budget without producing operator value. The
guard is a pure read-only check the kernel CLI exposes so an
orchestrator (or operator) can short-circuit before spending on
planner envelopes.

Distinct from the existing `discovery_dirty_tree_skipped` event in
discovery.py: that event blocks discovery on a dirty tree (a
SAFETY guard); the cycle guard is a COST guard that runs AFTER
discovery + pressure scoring to decide whether the next-step
convergent planning is worth firing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .debt import debts_dir
from .finding import findings_dir
from .ledger import load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir


# Default threshold below which a pressure record is treated as "noise"
# for empty-cycle purposes. Plan 007 §Pressure Scoring caps scores at
# 100; 30 is the operational threshold the daily-report next-cycle plan
# uses to decide whether a pressure is worth listing as actionable.
DEFAULT_PRESSURE_THRESHOLD = 30.0


@dataclass(frozen=True)
class CycleEmptiness:
    """Result of evaluating whether a cycle should fire convergent planning.

    `is_empty=True` means the orchestrator MAY short-circuit; the kernel
    does not block — it advises. The orchestrator records its own
    decision (run anyway / skip / defer) so the trail stays auditable.
    """

    cycle_id: str
    is_empty: bool
    pressure_count_above_threshold: int
    pressure_threshold: float
    open_findings: int
    open_debts: int
    reason: str


class CycleGuardRefusal(GovernanceError):
    """ARIA-MEDIUM-230 — the guard cannot see the backlog it was asked about.

    Every unresolvable input used to read as ZERO: no bound repository, a
    bound path that no longer exists, an index that would not parse. Zero
    open findings and zero debts is exactly the verdict that lets a caller
    skip the cycle, so the guard advised "empty" over a backlog it never
    read. It refuses by name instead; the CLI prints the refusal and exits
    3, which is neither "work to do" (0) nor "empty" (2).
    """


def _read_index(index: Path) -> dict[str, Any]:
    """An index that does not exist is an empty backlog; one that exists and
    cannot be read is a refusal."""
    if not index.exists():
        return {}
    try:
        payload = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CycleGuardRefusal(
            f"cycle_guard_index_unreadable:{index.as_posix()}:{type(exc).__name__}"
        ) from exc
    if not isinstance(payload, dict):
        raise CycleGuardRefusal(f"cycle_guard_index_unreadable:{index.as_posix()}:not_an_object")
    return payload


def _open_finding_count(repo_root: Path) -> int:
    # ARIA-HIGH-191: through the seam the writers use, so a redirected
    # state store is counted, not the checkout's stale copy.
    payload = _read_index(findings_dir(repo_root) / "_index.json")
    rows = payload.get("findings") or []
    # E25-a (ORPHAN-710) — IN_PROGRESS counts as backlog: work someone has
    # started is still unfinished work, and the rhythm gate exists so ARIA
    # finishes what it opened before discovering more. The emptiness guard
    # reads the same truth (a cycle with in-progress work is not empty).
    return sum(
        1 for r in rows
        if isinstance(r, dict) and r.get("status") in {"OPEN", "IN_PROGRESS"}
    )


def _open_debt_count(repo_root: Path) -> int:
    payload = _read_index(debts_dir(repo_root) / "_index.json")
    rows = payload.get("debts") or []
    return sum(1 for r in rows if isinstance(r, dict) and r.get("current_status") in {"OPEN", "IN_PROGRESS"})


def _resolve_repo_root(tools_root: Path, override: str | Path | None) -> Path:
    """The checkout the backlog is read through, or a named refusal.

    ``--workspace-root`` when given (it must exist); otherwise the tools
    root's bound repository, which must be bound and must still exist.
    Under ``ARIA_REPO_STATE_ROOT`` the findings and debts live in the store
    and the seam ignores the checkout path — but an unbound or stale
    identity is still a tools root that cannot say which repository's
    backlog it holds, and it used to turn into a count of zero.
    """
    if override is not None:
        candidate = Path(override)
        if not candidate.exists():
            raise CycleGuardRefusal(f"cycle_guard_workspace_root_missing:{candidate.as_posix()}")
        return candidate
    identity = tools_root / "repo_identity.json"
    if not identity.exists():
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_missing:{identity.as_posix()}")
    try:
        payload = json.loads(identity.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CycleGuardRefusal(
            f"cycle_guard_repo_identity_unreadable:{identity.as_posix()}:{type(exc).__name__}"
        ) from exc
    bound = payload.get("bound_repo_root") if isinstance(payload, dict) else None
    if not bound:
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_unbound:{identity.as_posix()}")
    candidate = Path(str(bound))
    if not candidate.exists():
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_stale:{candidate.as_posix()}")
    return candidate


def evaluate_cycle_emptiness(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    repo_root_override: str | Path | None = None,
    pressure_threshold: float = DEFAULT_PRESSURE_THRESHOLD,
) -> CycleEmptiness:
    """Decide whether a cycle is empty enough to skip convergent planning.

    Empty when ALL of these hold:
    - no recorded pressure for `cycle_id` has score >= `pressure_threshold`;
    - no `aria-findings/F-*.json` is in OPEN status;
    - no `aria-debts/DEBT-*.json` is OPEN or IN_PROGRESS.

    Returns a `CycleEmptiness` record with the count breakdown so the
    operator can audit the decision.
    """
    tools_root = ensure_tools_dir(base_dir)
    repo_root = _resolve_repo_root(tools_root, repo_root_override)

    pressure_path = tools_root / "pressure" / f"{cycle_id}.json"
    pressures: list[dict[str, Any]] = []
    if pressure_path.exists():
        try:
            payload = json.loads(pressure_path.read_text(encoding="utf-8"))
            pressures = payload.get("pressures") or []
            if not isinstance(pressures, list):
                pressures = []
        except (OSError, json.JSONDecodeError):
            pressures = []
    above = sum(
        1 for p in pressures
        if isinstance(p, dict) and isinstance(p.get("score"), (int, float)) and float(p["score"]) >= pressure_threshold
    )

    open_findings = _open_finding_count(repo_root)
    open_debts = _open_debt_count(repo_root)

    is_empty = above == 0 and open_findings == 0 and open_debts == 0
    if is_empty:
        reason = (
            f"no pressure>={pressure_threshold}, no open findings, no open debts"
        )
    else:
        parts = []
        if above > 0:
            parts.append(f"{above} pressure>={pressure_threshold}")
        if open_findings > 0:
            parts.append(f"{open_findings} open findings")
        if open_debts > 0:
            parts.append(f"{open_debts} open debts")
        reason = "non-empty: " + ", ".join(parts)

    return CycleEmptiness(
        cycle_id=cycle_id,
        is_empty=is_empty,
        pressure_count_above_threshold=above,
        pressure_threshold=pressure_threshold,
        open_findings=open_findings,
        open_debts=open_debts,
        reason=reason,
    )
