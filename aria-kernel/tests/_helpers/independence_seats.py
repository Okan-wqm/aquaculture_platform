"""Record a panel seat the way a drained panel leaves it (ARIA-MEDIUM-225).

`independence_check` binds a seat through four facts: the claim (receipt),
the request (the agent it was minted for), the accepted result, and the
sealed response that result names — stamped by the executor with the agent
it ran and the route it ran on. Fixtures used to write only the first two,
a shape in which a seat's principal was a name with nothing behind it.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

EXECUTOR_CARRIER = "ci-executor:gha-1"


def seal_accepted_seat(
    tools: Path,
    *,
    request_id: str,
    claim_id: str,
    agent_id: str,
    subagent_type: str,
    dispatch_model: str | None,
    role: str = "cross_review",
) -> Path:
    """Seal one response and record the accepted result naming it."""
    root = ensure_tools_dir(tools)
    details: dict[str, str] = {"agent_subagent_type": subagent_type}
    if dispatch_model:
        details["agent_dispatch_model"] = dispatch_model
    sealed = json.dumps({
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": claim_id,
        "agent_id": agent_id,
        "role": role,
        "details": details,
    }).encode("utf-8")
    output = root / "agent-invocations" / f"{request_id}.sealed.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(sealed)
    append_declared_jsonl(
        root / "agent-invocations" / "results.jsonl",
        {
            "request_id": request_id,
            "claim_id": claim_id,
            "role": role,
            "status": "accepted",
            "agent_id": agent_id,
            "output_path": output.as_posix(),
            "output_hash": "sha256:" + hashlib.sha256(sealed).hexdigest(),
        },
        expected_surface="agent_invocation_results",
    )
    return output


def seed_bound_seats(
    tools: Path,
    seats: Iterable[Mapping[str, str]],
    *,
    carrier: str = EXECUTOR_CARRIER,
    dispatch_model: str = "opus",
) -> None:
    """Record each seat (``request_id``, ``claim_id``, ``target_agent``, and
    optionally its own ``dispatch_model``) as one executor run drained it."""
    root = ensure_tools_dir(tools)
    invocations = root / "agent-invocations"
    for seat in seats:
        append_declared_jsonl(
            invocations / "requests.jsonl",
            {"request_id": seat["request_id"], "target_agent": seat["target_agent"]},
            expected_surface="agent_invocation_requests",
        )
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {"request_id": seat["request_id"], "claim_id": seat["claim_id"], "agent_id": carrier},
            expected_surface="agent_invocation_claims",
        )
        seal_accepted_seat(
            root,
            request_id=seat["request_id"],
            claim_id=seat["claim_id"],
            agent_id=carrier,
            subagent_type=seat["target_agent"],
            dispatch_model=seat.get("dispatch_model", dispatch_model),
        )


__all__ = ["EXECUTOR_CARRIER", "seal_accepted_seat", "seed_bound_seats"]
