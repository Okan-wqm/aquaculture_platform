"""Plan 031 Faz 031a — burn-in → autonomy-ladder bridge.

WHY this module exists
----------------------
ARIA shipped an autonomy unlock ladder (``autonomy_unlock.evaluate_autonomy_unlock``)
and a counter writer (``record_acceptance_event``) — but the writer had NO runtime
caller (only tests). So a clean cycle never accumulated toward the unlock
thresholds: autonomy was structurally unable to progress. This module is the
missing bridge — it turns a deterministically-clean cycle into a ``observe_success``
acceptance event, so clean cycles actually move the ladder.

The load-bearing safety property is MODE SEPARATION:

- ``mode="real"`` writes the REAL ledger (``enterprise/acceptance-events.jsonl``)
  that ``evaluate_autonomy_unlock`` reads to gate real merge. It is enterprise-
  governed (profile-gated), so it only succeeds on a properly-profiled runner.
- ``mode="mock"`` writes a SEPARATE demonstration ledger
  (``aria-acceptance/mock-acceptance-events.jsonl``) that is NOT an enterprise
  surface at all. Mock burn-in proves the mechanism end-to-end but can NEVER
  unlock real merge — a sandbox cannot hack itself toward merge authority.
  ``evaluate_mock_unlock`` reads only that mock ledger with the IDENTICAL
  counting + threshold logic (shared ``verdict_from_rows``), so the
  demonstration is faithful without ever touching the real ledger.

The 031c precondition is enforced here: ``record_clean_cycle`` REQUIRES
``harness_accepted=True``. A cycle counts toward autonomy only if the Plan 030
deterministic acceptance harness still ACCEPTs ARIA's outputs — drift evidence
clean, cycle invariants held, scenario reactions intact.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .autonomy_unlock import (
    AutonomyUnlockVerdict,
    record_acceptance_event,
    verdict_from_rows,
)
from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

MODE_REAL = "real"
MODE_MOCK = "mock"
LADDER_MODES: frozenset[str] = frozenset({MODE_REAL, MODE_MOCK})


def _mock_ledger_path(base_dir: str | Path | None) -> Path:
    return ensure_tools_dir(base_dir) / "aria-acceptance" / "mock-acceptance-events.jsonl"


def record_clean_cycle(
    *,
    cycle_id: str,
    mode: str,
    harness_accepted: bool,
    base_dir: str | Path | None = None,
    profile: str | None = None,
    pr_number: int | None = None,
    head_sha: str | None = None,
    lane: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """Record a deterministically-clean cycle as an ``observe_success`` event.

    Requires ``harness_accepted`` (the 031c precondition). On ``mode="real"`` it
    delegates to ``record_acceptance_event`` (the real, profile-gated unlock
    ledger). On ``mode="mock"`` it appends to the separate demonstration ledger
    that can never unlock real merge.
    """
    if mode not in LADDER_MODES:
        raise GovernanceError(f"autonomy_ladder_mode_unknown:{mode}")
    if not harness_accepted:
        raise GovernanceError(
            "autonomy_ladder_requires_harness_accept: a cycle counts toward "
            "autonomy only when the Plan 030 acceptance harness ACCEPTs "
            f"(cycle_id={cycle_id!r})"
        )
    resolved_reason = reason or f"clean_cycle:{cycle_id}:harness_accept"

    if mode == MODE_REAL:
        return record_acceptance_event(
            event_type="observe_success",
            base_dir=base_dir,
            pr_number=pr_number,
            head_sha=head_sha,
            cycle_id=cycle_id,
            lane=lane,
            reason=resolved_reason,
        )

    # mode == MODE_MOCK — demonstration ledger, deliberately NOT an enterprise
    # declared surface so it is structurally incapable of unlocking real merge.
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "mock_acceptance_event",
        "event_type": "observe_success",
        "status": "success",
        "mode": MODE_MOCK,
        "cycle_id": cycle_id,
        "lane": lane,
        "profile": profile,
        "harness_accepted": True,
        "reason": resolved_reason,
    }
    return append_jsonl(_mock_ledger_path(base_dir), row)


def evaluate_mock_unlock(
    *,
    lane: str,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
) -> AutonomyUnlockVerdict:
    """Evaluate the unlock ladder against the MOCK ledger only.

    Uses the same ``verdict_from_rows`` rule + policy as the real evaluator, so
    a mock burn-in faithfully shows the ladder advancing — while the real
    ``evaluate_autonomy_unlock`` (which reads only the real ledger) stays at
    zero. Proves the mechanism; cannot open real merge.
    """
    path = _mock_ledger_path(base_dir)
    rows = load_jsonl(path) if path.exists() else []
    return verdict_from_rows(rows, lane=lane, policy=policy)


__all__ = [
    "MODE_REAL",
    "MODE_MOCK",
    "LADDER_MODES",
    "record_clean_cycle",
    "evaluate_mock_unlock",
]
