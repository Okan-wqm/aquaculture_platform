from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


POLICY_APPROVAL_SCHEMA = "aria/policy-approval/v1"
POLICY_APPROVAL_PATH = Path(__file__).resolve().parents[2] / "docs" / "aria" / "policy" / "policy-approval.json"


def load_policy_approval_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(policy) if policy is not None else json.loads(POLICY_APPROVAL_PATH.read_text(encoding="utf-8"))
    if payload.get("$schema") != POLICY_APPROVAL_SCHEMA:
        raise GovernanceError("policy_approval_policy_schema_must_be_v1")
    if payload.get("schema_version") != 1:
        raise GovernanceError("policy_approval_policy_schema_version_must_be_1")
    stages = payload.get("required_stages")
    if not isinstance(stages, list) or set(stages) != {"risk_owner", "exception_owner"}:
        raise GovernanceError("policy_approval_requires_risk_and_exception_owner")
    if payload.get("separation_of_duties") is not True:
        raise GovernanceError("policy_approval_separation_of_duties_required")
    return payload


def record_policy_approval(
    approval: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_policy_approval",
        **dict(approval),
    }
    row.setdefault("row_id", f"{row.get('approval_id')}:{row.get('stage')}")
    _validate_approval_row(row)
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "policy-approvals.jsonl",
        row,
        expected_surface="enterprise_policy_approvals",
    )


def verify_policy_approval(
    *,
    pr_number: int,
    head_sha: str,
    policy_hash: str,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active = load_policy_approval_policy(policy)
    required_stages = set(active["required_stages"])
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "policy-approvals.jsonl",
        expected_surface="enterprise_policy_approvals",
    )
    matches = [
        row for row in rows
        if row.get("pr_number") == pr_number
        and row.get("head_sha") == head_sha
        and row.get("policy_hash") == policy_hash
        and row.get("state", "approved") == "approved"
        and _expiry_is_future(str(row.get("expires_at") or ""))
    ]
    stages = {str(row.get("stage") or "") for row in matches}
    missing = sorted(required_stages - stages)
    if missing:
        raise GovernanceError("policy_approval_missing_required_stages:" + ",".join(missing))
    actors = {str(row.get("actor") or "") for row in matches if str(row.get("stage") or "") in required_stages}
    if len(actors) < len(required_stages):
        raise GovernanceError("policy_approval_separation_of_duties_violation")
    return {
        "valid": True,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "policy_hash": policy_hash,
        "approval_ledger_hashes": [row.get("ledger_hash") for row in matches if row.get("stage") in required_stages],
    }


def _validate_approval_row(row: dict[str, Any]) -> None:
    required = ("approval_id", "stage", "actor", "pr_number", "head_sha", "policy_hash", "expires_at")
    missing = [key for key in required if not row.get(key)]
    if missing:
        raise GovernanceError("policy_approval_missing_fields:" + ",".join(missing))
    if row["stage"] not in {"risk_owner", "exception_owner"}:
        raise GovernanceError("policy_approval_stage_unknown")
    if not isinstance(row.get("pr_number"), int) or row["pr_number"] <= 0:
        raise GovernanceError("policy_approval_pr_number_required")
    if not isinstance(row.get("head_sha"), str) or len(row["head_sha"]) != 40:
        raise GovernanceError("policy_approval_head_sha_must_be_full_sha")
    if not str(row.get("policy_hash") or "").startswith("sha256:"):
        raise GovernanceError("policy_approval_policy_hash_required")
    if not _expiry_is_future(str(row.get("expires_at") or "")):
        raise GovernanceError("policy_approval_expiry_must_be_future")


def _expiry_is_future(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc) > datetime.now(timezone.utc)


__all__ = [
    "POLICY_APPROVAL_SCHEMA",
    "load_policy_approval_policy",
    "record_policy_approval",
    "verify_policy_approval",
]
