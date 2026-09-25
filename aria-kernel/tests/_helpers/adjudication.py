"""Seed a panel member's opinion the way the executor seals it (ARIA-HIGH-097).

Every panel test used to write ``{"verdict": ..., "rationale": ...}`` straight
into the output file — a shape no live envelope ever had: the executor bridge
carries only ``details`` (and evidence_refs / notes / plan_content) from the
agent's JSON, so the live top-level verdict was dropped and 215/215 folds
stayed escalated while every one of these tests passed. The opinion now goes
through the executor's real ``_build_envelope_from_claude_output``, so a test
only passes when an agent's answer survives the bridge.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aria_kernel import human_required_adjudication as hra
from aria_kernel.ledger import append_declared_jsonl

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


def sealed_envelope(*, request_id: str, agent_id: str, agent_text: str) -> dict[str, Any]:
    """The envelope the executor seals for ``agent_text`` (real builder)."""
    return _EXECUTOR._build_envelope_from_claude_output(
        raw_stdout=agent_text,
        request_id=request_id,
        claim_id=f"claim-{request_id}",
        agent_id=agent_id,
        role=hra.ADJUDICATION_ROLE,
        subagent_type="aria-evidence-judge",
        must_satisfy=[],
    )


def seed_adjudicator_opinion(
    tools: Path,
    request_id: str,
    *,
    agent_id: str,
    verdict: str,
    rationale: str | None = None,
    disposition: str | None = None,
    agent_text: str | None = None,
) -> Path:
    """Seal one opinion and record its claim + accepted result.

    ``agent_text`` overrides the contract-shaped answer, for tests that need
    an adjudicator to answer badly; the bridge still seals whatever it wrote.
    The ledgers go through ``append_declared_jsonl``: both are hash-chained
    declared surfaces, and a hand-written row fails strict verification.
    """
    invocations = tools / "agent-invocations"
    invocations.mkdir(parents=True, exist_ok=True)
    text = agent_text if agent_text is not None else adjudicator_agent_text(
        verdict=verdict,
        rationale=rationale if rationale is not None else f"{agent_id} says {verdict}",
        disposition=disposition,
    )
    output = invocations / f"{request_id}.opinion.json"
    output.write_text(
        json.dumps(sealed_envelope(request_id=request_id, agent_id=agent_id, agent_text=text)),
        encoding="utf-8",
    )
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
            "output_hash": "sha256:" + "0" * 64,
        },
        expected_surface="agent_invocation_results",
    )
    return output


__all__ = ["adjudicator_agent_text", "sealed_envelope", "seed_adjudicator_opinion"]
