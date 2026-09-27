"""Seed a panel member's opinion the way the executor seals it (ARIA-HIGH-097).

Every panel test used to write ``{"verdict": ..., "rationale": ...}`` straight
into the output file — a shape no live envelope ever had: the executor bridge
carries only ``details`` (and evidence_refs / notes / plan_content) from the
agent's JSON, so the live top-level verdict was dropped and 215/215 folds
stayed escalated while every one of these tests passed. The opinion now goes
through the executor's real ``_build_envelope_from_claude_output``, so a test
only passes when an agent's answer survives the bridge.

ARIA-MEDIUM-225 — each seat is sealed the way the executor seals THAT seat:
stamped with the subagent its request was minted for, carrying the route that
ran it (the seat's profile model by default, or a native runtime-attempt row),
and recorded under the real content hash of the sealed bytes. Every seat used
to be stamped ``aria-evidence-judge`` with no route and a placeholder hash, a
shape in which three seats on one model read as three principals.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import append_tools_governance

from .executor_module import load_ci_executor

_EXECUTOR = load_ci_executor("ci_executor_adjudication_helper")


def adjudicator_agent_text(
    *, verdict: str, rationale: str, disposition: str | None = None,
) -> str:
    """The JSON an adjudicator writes as its final message, per the contract."""
    block: dict[str, Any] = {"verdict": verdict, "rationale": rationale}
    if disposition is not None:
        block["disposition"] = disposition
    return json.dumps({"status": "submitted", "details": {hra.ADJUDICATION_DETAILS_KEY: block}})


def sealed_envelope(
    *,
    request_id: str,
    agent_id: str,
    agent_text: str,
    subagent_type: str = "aria-evidence-judge",
    dispatch_model: str | None = None,
) -> dict[str, Any]:
    """The envelope the executor seals for ``agent_text`` (real builder)."""
    return _EXECUTOR._build_envelope_from_claude_output(
        raw_stdout=agent_text,
        request_id=request_id,
        claim_id=f"claim-{request_id}",
        agent_id=agent_id,
        role=hra.ADJUDICATION_ROLE,
        subagent_type=subagent_type,
        must_satisfy=[],
        dispatch_model=dispatch_model,
    )


def _minted_target(tools: Path, request_id: str) -> str:
    rows = list_agent_invocation_requests(request_id=request_id, base_dir=tools)
    if len(rows) != 1 or not rows[0].get("target_agent"):
        raise AssertionError(
            f"seed_adjudicator_opinion: {request_id} has no minted target; pass subagent_type"
        )
    return str(rows[0]["target_agent"])


def seed_adjudicator_opinion(
    tools: Path,
    request_id: str,
    *,
    agent_id: str,
    verdict: str,
    rationale: str | None = None,
    disposition: str | None = None,
    agent_text: str | None = None,
    subagent_type: str | None = None,
    dispatch_model: str | None = None,
    stamp_route: bool = True,
    runtime_attempt_provider: str | None = None,
) -> Path:
    """Seal one opinion and record its claim + accepted result.

    ``agent_text`` overrides the contract-shaped answer, for tests that need
    an adjudicator to answer badly; the bridge still seals whatever it wrote.
    The ledgers go through ``append_declared_jsonl``: both are hash-chained
    declared surfaces, and a hand-written row fails strict verification.

    The seat is stamped with ``subagent_type`` (default: the agent the
    request was minted for) and run on ``dispatch_model`` (default: that
    agent's runtime-profile model). ``stamp_route=False`` seals no route at
    all. ``runtime_attempt_provider`` records the native path instead: a
    ``runtime_attempt_started`` governance row on that provider and model,
    bound to this request and claim, whose hash the envelope carries.
    """
    invocations = tools / "agent-invocations"
    invocations.mkdir(parents=True, exist_ok=True)
    text = agent_text if agent_text is not None else adjudicator_agent_text(
        verdict=verdict,
        rationale=rationale if rationale is not None else f"{agent_id} says {verdict}",
        disposition=disposition,
    )
    seat = subagent_type if subagent_type is not None else _minted_target(tools, request_id)
    model = dispatch_model if dispatch_model is not None else read_agent_runtime_profile(seat).model
    envelope = sealed_envelope(
        request_id=request_id, agent_id=agent_id, agent_text=text,
        subagent_type=seat, dispatch_model=model if stamp_route else None,
    )
    if runtime_attempt_provider is not None:
        attempt = append_tools_governance(
            tools,
            "runtime_attempt_started",
            {
                "request_id": request_id,
                "claim_id": f"claim-{request_id}",
                "agent_id": agent_id,
                "provider": runtime_attempt_provider,
                "model": model,
            },
        )
        envelope["details"]["runtime_attempt_ledger_hash"] = attempt["ledger_hash"]
    output = invocations / f"{request_id}.opinion.json"
    sealed = json.dumps(envelope).encode("utf-8")
    output.write_bytes(sealed)
    append_declared_jsonl(
        invocations / "claims.jsonl",
        {"request_id": request_id, "claim_id": f"claim-{request_id}", "agent_id": agent_id},
        expected_surface="agent_invocation_claims",
    )
    append_declared_jsonl(
        invocations / "results.jsonl",
        {
            "request_id": request_id,
            "role": hra.ADJUDICATION_ROLE,
            "status": "accepted",
            "agent_id": agent_id,
            "output_path": output.as_posix(),
            "output_hash": "sha256:" + hashlib.sha256(sealed).hexdigest(),
        },
        expected_surface="agent_invocation_results",
    )
    return output


__all__ = ["adjudicator_agent_text", "sealed_envelope", "seed_adjudicator_opinion"]
