"""Why a request expired ANCHOR_STALE, and what that cause may cost it (ARIA-HIGH-360).

WHY this module exists. The anchor-stale disposition (``anchor_stale``)
re-mints an expired request whose subject is live, once. An expiry the
request did not cause (the provider it is routed to was in an outage for the
window) must not spend that one chance. Review of PR #1825 measured that
the exemption could never fire: every reason the selection boundary and the
expiry sweep write on an ``anchor_stale`` claim row (``anchor_expired``,
``anchor_undatable``, ``anchor_unreachable``; ``agent_invocations``
``_anchor_refusal_reason`` and ``sweep_expired_anchors``) classifies as
``unclassified`` in the release-reason table.

THE CONTRACT with the expiry clock (ARIA-HIGH-365, which owns that clock):
when an anchor expiry overlapped an open outage of the request's provider,
the writer records the reason ``anchor_expiry_reason_in_outage(providers)``
on the ``anchor_stale`` row, ``anchor_expired_during_provider_outage:`` plus
the providers sorted and joined by ``+``, the same shape as that lane's
``lease_expired_during_provider_outage:<providers>`` lease reason. This
module is the one reader of that spelling (``expiry_fault_class``). It has
no kernel imports at module scope, so the writer in ``agent_invocations``
can import it without a cycle.

THE CAP. A harness-class expiry is free, but a lineage is not unbounded:
``MAX_EXPIRY_LINEAGE_REMINTS`` successors per lineage whatever the causes,
the same bound as ``step_request.MAX_STEP_REQUEST_REMINTS`` and
``human_required_adjudication.MAX_REQUEST_REMINTS`` (2). A provider that
never serves cannot make the kernel re-mint forever.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

ANCHOR_EXPIRED_IN_OUTAGE_PREFIX = "anchor_expired_during_provider_outage:"

# Request-class expiries one lineage may re-mint after: a successor that
# expires for a reason of its own has shown the queue cannot reach it.
ANCHOR_STALE_REMINT_BUDGET = 1

# Successors per lineage, whatever the causes (module docstring).
MAX_EXPIRY_LINEAGE_REMINTS = 2

HARNESS_FAULT_CLASS = "harness"


def anchor_expiry_reason_in_outage(providers: Iterable[str]) -> str:
    """The ``anchor_stale`` reason for an expiry that overlapped a provider outage."""
    names = sorted({str(name).strip() for name in providers if str(name).strip()})
    if not names:
        raise ValueError("an outage expiry names at least one provider")
    return f"{ANCHOR_EXPIRED_IN_OUTAGE_PREFIX}{'+'.join(names)}"


def expiry_fault_class(reason: str) -> str:
    """``harness`` for an outage expiry, else the release-reason table's class."""
    if str(reason or "").startswith(ANCHOR_EXPIRED_IN_OUTAGE_PREFIX):
        return HARNESS_FAULT_CLASS
    from .agent_invocations import classify_release_reason

    return classify_release_reason(reason)


@dataclass(frozen=True)
class ExpiryCause:
    """Why a request derived ANCHOR_STALE: its claim row's reason and that reason's fault class."""

    reason: str
    fault_class: str

    @classmethod
    def from_reason(cls, reason: str) -> "ExpiryCause":
        return cls(reason=str(reason or ""), fault_class=expiry_fault_class(reason))

    @property
    def spends_remint_budget(self) -> bool:
        """An outage expiry says nothing about the request (module docstring)."""
        return self.fault_class != HARNESS_FAULT_CLASS


__all__ = [
    "ANCHOR_EXPIRED_IN_OUTAGE_PREFIX",
    "ANCHOR_STALE_REMINT_BUDGET",
    "ExpiryCause",
    "HARNESS_FAULT_CLASS",
    "MAX_EXPIRY_LINEAGE_REMINTS",
    "anchor_expiry_reason_in_outage",
    "expiry_fault_class",
]
