from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


APPROVED_CODEX_AUTH = frozenset({"chatgpt_managed_codex_cli", "codex_cli_chatgpt"})


def record_runner_attestation(
    attestation: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_runner_attestation",
        **dict(attestation),
    }
    row.setdefault("row_id", f"runner:{row.get('pr_number')}:{row.get('head_sha')}:{row.get('runner_id')}")
    _validate_attestation(row)
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "runner-attestations.jsonl",
        row,
        expected_surface="enterprise_runner_attestations",
    )


def verify_runner_attestation(
    *,
    pr_number: int,
    head_sha: str,
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "runner-attestations.jsonl",
        expected_surface="enterprise_runner_attestations",
    )
    match = next(
        (
            row for row in reversed(rows)
            if row.get("pr_number") == pr_number
            and row.get("head_sha") == head_sha
            and row.get("readiness_claim_id") == readiness_claim_id
        ),
        None,
    )
    if match is None:
        raise GovernanceError("runner_attestation_required_for_merge")
    _validate_attestation(match)
    return {
        "valid": True,
        "runner_id": match.get("runner_id"),
        "ledger_hash": match.get("ledger_hash"),
    }


def _validate_attestation(row: dict[str, Any]) -> None:
    required = ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id", "runner_id", "runner_group", "codex_auth")
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError("runner_attestation_missing_fields:" + ",".join(missing))
    if row.get("ephemeral_runner") is not True:
        raise GovernanceError("runner_attestation_ephemeral_runner_required")
    if row.get("approved_runner_group") is not True:
        raise GovernanceError("runner_attestation_approved_group_required")
    if row.get("sandbox_available") is not True:
        raise GovernanceError("runner_attestation_sandbox_required")
    if row.get("api_key_auth") is not False:
        raise GovernanceError("runner_attestation_api_key_auth_forbidden")
    if row.get("codex_auth") not in APPROVED_CODEX_AUTH:
        raise GovernanceError("runner_attestation_codex_chatgpt_auth_required")


__all__ = [
    "APPROVED_CODEX_AUTH",
    "record_runner_attestation",
    "verify_runner_attestation",
]
