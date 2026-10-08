"""Whether a plan's failure names the lane (a provider outage, a harness fault) or the work.

WHY (ARIA-HIGH-367). ``finding_grounding`` put every failed plan's finding on
the 7-day re-planning cool-off, so a finding whose plan an outage killed
waited a week after the provider came back, and the finding the operator
paid for was planned last.

The answer comes from two recorded facts: the release envelope's fault domain
on the abandonment's stall record (ARIA-MEDIUM-291 writes it; ``harness``
covers every provider-class release reason, ``provider_unreachable:`` and
``lease_expired_during_provider_outage:`` included), and, for the failure
modes that mean "nobody answered", whether the plan's last wait overlapped a
outage of any provider heading a planning role (``provider_clock``, scoped
per review HIGH-2 so an off-ladder provider's open outage freezes nothing). A
cool-off skipped wrongly costs one extra plan of a finding, one applied
wrongly costs a week of the finding the outage already delayed.

The learner side of the same rule is ARIA-HIGH-370's
``failure_attribution`` (lane fix/aria-learning-actuator): it attributes a
failure only on an allowlist of the work's own evidence, so every outage-kind
release (quota, auth, logged_out, unreachable — all fault domain ``harness``)
and every no-answer reason code is unattributed there by construction. This
module does not duplicate it in ``agent_eval``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from .provider_clock import ProviderClock

# Failure modes that mean an agent never answered — what an outage looks like
# from the plan ledger. A REJECTED answer or a material risk is an answer.
NO_ANSWER_FAILURE_MODES: frozenset[str] = frozenset({
    "pending_tasks_present", "partial_coverage", "stalled", "convergence_envelope_dead",
    "orchestrator_restart_reaped_orphan", "no_claim_timeout", "in_flight_abandoned",
})


def failure_mode_of(event: dict[str, Any]) -> str | None:
    """The failure mode a terminal plan event records: its first reason token, or the rejection class."""
    kind, payload = event.get("event_type"), event.get("payload") or {}
    if kind == "plan_abandoned":
        return str(payload.get("reason", "")).split(":", 1)[0].strip()
    if kind == "plan_evaluated" and payload.get("terminal_state") == "HUMAN_REQUIRED":
        return str([*payload.get("reason_codes", []), "human_required"][0]).split(":", 1)[0].strip()
    if kind == "implementation_rejected":
        return str(payload.get("rejection_class"))
    return None


def failure_is_lane_fault(
    event: dict[str, Any], *, waited_since: datetime | None, at: datetime | None, clock: ProviderClock,
) -> bool:
    """True when the failure ``event`` records was caused by the lane, not by the work."""
    from .release_reason import parse_release_reason

    # ARIA-HIGH-388 — a settled implementation outcome names its own fault
    # domain (`implementation_rejections.DELIVERY_STAGE_SETTLEMENT`): GitHub
    # refusing a push or a PR is the lane's, never the finding's.
    if event.get("event_type") == "implementation_rejected" and (
            (event.get("payload") or {}).get("fault_domain") == "harness"):
        return True
    stall = (event.get("payload") or {}).get("stall")
    if isinstance(stall, dict):
        domain = stall.get("fault_domain") or parse_release_reason(str(stall.get("cause") or "")).fault_domain
        if domain == "harness":
            return True
    if failure_mode_of(event) not in NO_ANSWER_FAILURE_MODES or waited_since is None or at is None:
        return False
    from .provider_clock import planning_heads

    return clock.covered_any(waited_since, at, planning_heads()).total_seconds() > 0


__all__ = ["NO_ANSWER_FAILURE_MODES", "failure_is_lane_fault", "failure_mode_of"]
