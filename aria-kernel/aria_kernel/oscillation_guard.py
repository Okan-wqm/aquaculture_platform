"""Plan 031 Gate B — oscillation (ping-pong) guard.

WHY this module exists
----------------------
Autonomy raises a specific regression hazard the operator asked about: ARIA
fixes finding X, a later fix reopens X, ARIA fixes X again, and the two fixes
ping-pong forever — each one "correct" in isolation, the pair never converging.
A human reviewer would notice the loop; an operator who cannot out-review the AI
cannot. So the convergence guarantee must be deterministic.

This guard counts how many times the SAME finding (keyed by its stable
``finding_fingerprint``, or a ``belief:<id>`` key for reopened beliefs) is
reopened without an intervening clean resolution. Once the streak crosses the
threshold (default 3) the guard:

1. escalates to a HUMAN_REQUIRED operator-triage record (the loop converges to
   "ask a human", not to infinite churn), and
2. BLOCKS any further autonomous fix dispatch for that fingerprint — breaking
   the ping-pong instead of feeding it.

Design mirrors ``architecture_spine_gate._consecutive_regression_count``: a
governance-event tail-scan, newest-first, where a clean-resolution event resets
the streak. Two surfaces are kept deliberately separate:

- ``record_reopen`` is a pure COUNTER increment (a governance append, no
  HUMAN_REQUIRED write, no profile gate). The belief-revalidation path in
  ``memory._apply_diff_to_existing_beliefs`` calls it as a side-effect-free
  observation when a belief is reopened because its evidence changed.
- ``guard_fix_dispatch`` is the DECIDER: the autonomous fix dispatcher calls it
  before acting; it escalates + raises at the threshold. Keeping escalation out
  of the observation path means belief bookkeeping can never be blocked by a
  frozen-profile HUMAN_REQUIRED write.
"""
from __future__ import annotations

import re
from typing import Any

from .governance_reader import read_governance_rows
from .human_required import record_human_required
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)

# Reopen N times without a clean resolution → escalate + block. Three is the
# first count that is unambiguously a loop (fix → reopen → refix → reopen →
# refix) rather than a single legitimate revision.
DEFAULT_OSCILLATION_THRESHOLD: int = 3

_REOPEN_EVENT = "finding_reopened"
_RESOLUTION_EVENT = "finding_resolution_clean"
_ESCALATION_EVENT = "oscillation_escalated"

_UNSAFE_REQUEST_ID_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_request_id(fingerprint: str) -> str:
    """Map a fingerprint to a filesystem-safe HUMAN_REQUIRED request_id.

    Fingerprints carry ``finding:<sha>`` / ``belief:<id>`` shapes whose colons
    and slashes would fork the human-required file path; collapse them to ``-``.
    """
    return "oscillation-" + _UNSAFE_REQUEST_ID_CHARS.sub("-", fingerprint).strip("-")


def reopen_streak(*, fingerprint: str, base_dir: Any = None) -> int:
    """Consecutive reopen events for ``fingerprint`` since its last clean
    resolution.

    Tail-scans governance newest-first (streak semantics): a
    ``finding_resolution_clean`` for the same fingerprint breaks the streak,
    exactly as a clean postcheck breaks the spine-gate regression streak.
    """
    if not fingerprint.strip():
        raise GovernanceError("fingerprint is required")
    tools_root = ensure_tools_dir(base_dir)
    governance = tools_root / "governance.jsonl"
    streak = 0
    for row in read_governance_rows(governance, reverse=True, base_dir=tools_root):
        kind = row.get("kind")
        if kind not in (_REOPEN_EVENT, _RESOLUTION_EVENT):
            continue
        details = row.get("details") or {}
        if details.get("fingerprint") != fingerprint:
            continue
        if kind == _RESOLUTION_EVENT:
            return streak  # clean resolution resets the loop counter
        streak += 1
    return streak


def record_reopen(
    *,
    fingerprint: str,
    cycle_id: str,
    base_dir: Any = None,
    context: dict[str, Any] | None = None,
) -> int:
    """Record that ``fingerprint`` was reopened; return the new streak.

    Pure counter increment — appends a ``finding_reopened`` governance event and
    nothing else. No HUMAN_REQUIRED write, no profile gate, so a side-effect-free
    observation point (e.g. belief revalidation) can call it unconditionally.
    """
    if not fingerprint.strip():
        raise GovernanceError("fingerprint is required")
    tools_root = ensure_tools_dir(base_dir)
    details: dict[str, Any] = {"fingerprint": fingerprint, "cycle_id": cycle_id}
    if context:
        details["context"] = context
    append_tools_governance(tools_root, _REOPEN_EVENT, details)
    return reopen_streak(fingerprint=fingerprint, base_dir=base_dir)


def record_resolution(
    *,
    fingerprint: str,
    cycle_id: str,
    base_dir: Any = None,
) -> None:
    """Record that ``fingerprint`` was durably resolved — resets the streak.

    Call this when a fix is confirmed to have closed the finding for good (e.g.
    a clean cycle that no longer surfaces it). The next reopen starts a fresh
    streak from zero, so a single legitimate revision after a real fix never
    counts toward the loop threshold.
    """
    if not fingerprint.strip():
        raise GovernanceError("fingerprint is required")
    tools_root = ensure_tools_dir(base_dir)
    append_tools_governance(
        tools_root, _RESOLUTION_EVENT,
        {"fingerprint": fingerprint, "cycle_id": cycle_id},
    )


def is_oscillating(
    *,
    fingerprint: str,
    base_dir: Any = None,
    threshold: int = DEFAULT_OSCILLATION_THRESHOLD,
) -> bool:
    """Read-only: True iff the reopen streak has reached the threshold."""
    if threshold < 1:
        raise GovernanceError("threshold must be >= 1")
    return reopen_streak(fingerprint=fingerprint, base_dir=base_dir) >= threshold


def assert_fix_dispatch_allowed(
    *,
    fingerprint: str,
    base_dir: Any = None,
    threshold: int = DEFAULT_OSCILLATION_THRESHOLD,
) -> None:
    """Raise if ``fingerprint`` is oscillation-blocked (read-only).

    The cheap pre-dispatch guard. Does NOT escalate (no HUMAN_REQUIRED write) —
    use ``guard_fix_dispatch`` for the escalate-and-block decision.
    """
    if is_oscillating(fingerprint=fingerprint, base_dir=base_dir, threshold=threshold):
        raise GovernanceError(
            f"oscillation_fix_dispatch_blocked: fingerprint={fingerprint!r} has "
            f"reopened >= {threshold} times without a clean resolution; "
            f"autonomous fix dispatch refused — operator must intervene"
        )


def guard_fix_dispatch(
    *,
    fingerprint: str,
    cycle_id: str,
    base_dir: Any = None,
    threshold: int = DEFAULT_OSCILLATION_THRESHOLD,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The decider: escalate to a human + BLOCK if ``fingerprint`` is oscillating.

    Called by the autonomous fix dispatcher before acting on a finding. When the
    reopen streak has reached the threshold it records an idempotent
    HUMAN_REQUIRED escalation, emits an ``oscillation_escalated`` governance
    event, and raises ``GovernanceError`` to refuse the dispatch — converging the
    loop to "ask a human" instead of another fix attempt. Below the threshold it
    returns ``{blocked: False, streak}`` and the dispatch proceeds.
    """
    if threshold < 1:
        raise GovernanceError("threshold must be >= 1")
    streak = reopen_streak(fingerprint=fingerprint, base_dir=base_dir)
    if streak < threshold:
        return {"blocked": False, "streak": streak, "fingerprint": fingerprint}

    request_id = _safe_request_id(fingerprint)
    record_human_required(
        request_id=request_id,
        severity="HIGH",
        reason=(
            f"Oscillation guard: finding {fingerprint!r} has been reopened "
            f"{streak} times without a clean resolution — autonomous fixes are "
            f"ping-ponging and not converging. Operator must decide the durable "
            f"remediation; further autonomous fix attempts are blocked."
        ),
        context={
            "kind": "oscillation",
            "fingerprint": fingerprint,
            "reopen_count": streak,
            "cycle_id": cycle_id,
            **(context or {}),
        },
        base_dir=base_dir,
    )
    tools_root = ensure_tools_dir(base_dir)
    append_tools_governance(
        tools_root, _ESCALATION_EVENT,
        {
            "fingerprint": fingerprint,
            "reopen_count": streak,
            "cycle_id": cycle_id,
            "request_id": request_id,
        },
    )
    raise GovernanceError(
        f"oscillation_fix_dispatch_blocked: fingerprint={fingerprint!r} reopened "
        f"{streak} times (>= {threshold}); escalated to HUMAN_REQUIRED "
        f"{request_id!r} and refused autonomous fix dispatch"
    )


__all__ = [
    "DEFAULT_OSCILLATION_THRESHOLD",
    "reopen_streak",
    "record_reopen",
    "record_resolution",
    "is_oscillating",
    "assert_fix_dispatch_allowed",
    "guard_fix_dispatch",
]
