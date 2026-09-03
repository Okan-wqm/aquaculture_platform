from __future__ import annotations

from pathlib import Path
from typing import Any

from .budget import record_budget_usage
from .ledger import append_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


REQUIRED_RESPONSE_FIELDS = ("title", "problem", "summary", "proposed_change", "evidence_refs", "validation_commands")


def amplify_proposal(
    *,
    packet: dict[str, Any],
    response: dict[str, Any],
    provider: str = "external",
    model: str = "operator-supplied",
    input_tokens: int = 0,
    output_tokens: int = 0,
    estimated_usd: float = 0.0,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Validate and record an LLM-amplified proposal without calling a provider SDK."""
    _validate_packet(packet)
    _validate_response(packet, response)
    budget_row = record_budget_usage(
        action="proposal_amplification",
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        estimated_usd=estimated_usd,
        base_dir=base_dir,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "packet_id": packet["packet_id"],
        "provider": provider,
        "model": model,
        "budget_ref": budget_row["ledger_hash"],
        "response": {
            "title": response["title"],
            "problem": response["problem"],
            "summary": response["summary"],
            "proposed_change": response["proposed_change"],
            "evidence_refs": response["evidence_refs"],
            "validation_commands": response["validation_commands"],
        },
    }
    return append_declared_jsonl(ensure_tools_dir(base_dir) / "llm" / "proposal-amplifications.jsonl", row, expected_surface="llm_proposal_amplifications")


def _validate_packet(packet: dict[str, Any]) -> None:
    if not isinstance(packet, dict):
        raise GovernanceError("proposal packet must be a JSON object")
    if not isinstance(packet.get("packet_id"), str) or not packet["packet_id"].strip():
        raise GovernanceError("proposal packet requires packet_id")
    evidence = packet.get("evidence_refs")
    validations = packet.get("validation_commands")
    if not isinstance(evidence, list) or not all(isinstance(item, str) and item.strip() for item in evidence):
        raise GovernanceError("proposal packet requires evidence_refs")
    if not isinstance(validations, list) or not all(isinstance(item, str) and item.strip() for item in validations):
        raise GovernanceError("proposal packet requires validation_commands")


def _validate_response(packet: dict[str, Any], response: dict[str, Any]) -> None:
    if not isinstance(response, dict):
        raise GovernanceError("LLM response must be a JSON object")
    for field in REQUIRED_RESPONSE_FIELDS:
        if field not in response:
            raise GovernanceError(f"LLM response missing field: {field}")
    for field in ("title", "problem", "summary", "proposed_change"):
        if not isinstance(response[field], str) or not response[field].strip():
            raise GovernanceError(f"LLM response {field} must be a non-empty string")
    allowed_evidence = set(packet["evidence_refs"])
    response_evidence = response["evidence_refs"]
    if not isinstance(response_evidence, list) or not response_evidence:
        raise GovernanceError("LLM response evidence_refs must be a non-empty array")
    if any(not isinstance(item, str) or item not in allowed_evidence for item in response_evidence):
        raise GovernanceError("LLM response introduced uncited evidence")
    allowed_validations = set(packet["validation_commands"])
    response_validations = response["validation_commands"]
    if not isinstance(response_validations, list) or not response_validations:
        raise GovernanceError("LLM response validation_commands must be a non-empty array")
    if any(not isinstance(item, str) or item not in allowed_validations for item in response_validations):
        raise GovernanceError("LLM response introduced unapproved validation command")
