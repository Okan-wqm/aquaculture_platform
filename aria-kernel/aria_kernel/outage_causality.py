"""Whether a waiting piece of work is waiting ON A PROVIDER, the gate on every outage pause.

WHY (ARIA-HIGH-365, PR #1835 review HIGH-1). The provider-available clock
pauses a timer while the provider heading the work's role is out. Pausing
on the head alone is wrong when a failover rung DID serve the work: with
Anthropic lapsed and Z.ai serving rung 2, a plan whose newest request was
answered and then escalated for its own reason (``agent_refused``) still saw
the head out, so its available age stayed near zero, the 72 h stall bound
never fired and the plan was re-adopted every cycle while ARIA did nothing
else. A serving rung resets none of these clocks (the stall stamp is the plan
ledger's), so the pause needs its own causal test.

The rule, one place for every timer: an outage may pause a timer only for
work still waiting on a provider —

* the request's last recorded cause is in the ``harness`` fault domain
  (``release_reason``: every provider-class release — quota, auth,
  logged_out, unreachable, admission refusals), or
* the request never left PENDING/REQUEUED (nothing ever answered it).

Anything else — a request answered and refused, escalated, rejected or
accepted — is measured on the wall clock.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

WAITING_STATES: frozenset[str] = frozenset({"PENDING", "REQUEUED"})


def awaits_provider(*, fault_domain: str | None, request_state: str | None) -> bool:
    """The rule (module docstring) on the two facts it reads."""
    return fault_domain == "harness" or request_state in WAITING_STATES


def request_awaits_provider(request_id: str | None, *, base_dir: str | Path | None,
                            claims: list[dict[str, Any]] | None = None) -> bool:
    """Whether ``request_id`` is still waiting on a provider (None: no request, so no)."""
    from .agent_invocations import _claims_path, derive_request_state
    from .ledger import load_jsonl
    from .release_reason import parse_release_reason
    from .tool_registry import tools_dir

    if not request_id:
        return False
    if claims is None:
        path = _claims_path(tools_dir(base_dir))
        claims = load_jsonl(path) if path.is_file() else []
    reasoned = [row for row in claims if row.get("request_id") == request_id
                and isinstance(row.get("reason"), str) and row["reason"].strip()]
    domain = parse_release_reason(reasoned[-1]["reason"]).fault_domain if reasoned else None
    return awaits_provider(fault_domain=domain,
                           request_state=derive_request_state(request_id=request_id, base_dir=base_dir))


def newest_request_id(requests: list[dict[str, Any]], *, plan_id: str, role: str | None = None) -> str | None:
    """The newest request a plan minted (for ``role`` when named)."""
    mine = [row for row in requests if row.get("convergence_id") == plan_id
            and (role is None or row.get("role") == role)]
    return str(mine[-1].get("request_id")) if mine else None


__all__ = ["WAITING_STATES", "awaits_provider", "newest_request_id", "request_awaits_provider"]
