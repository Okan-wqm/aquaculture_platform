from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


def record_incident_event(
    event: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_type": "enterprise_incident_event",
        **dict(event),
    }
    row.setdefault("row_id", f"{row.get('incident_event')}:{row.get('pr_number')}:{row.get('head_sha')}")
    _require_common(row)
    if row.get("incident_event") not in {"pre_merge_no_incident", "merge_finalized_no_incident", "merge_failed", "incident_opened"}:
        raise GovernanceError("incident_event_unknown")
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "incidents.jsonl",
        row,
        expected_surface="enterprise_incidents",
    )


def ensure_pre_merge_incident_row(
    *,
    pr: dict[str, Any],
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    pr_number = int(pr.get("number") or 0)
    head_sha = str(pr.get("head_sha") or pr.get("headRefOid") or pr.get("head") or "")
    rows = load_declared_jsonl(
        root / "enterprise" / "incidents.jsonl",
        expected_surface="enterprise_incidents",
    )
    existing = next(
        (
            row for row in reversed(rows)
            if row.get("incident_event") == "pre_merge_no_incident"
            and row.get("pr_number") == pr_number
            and row.get("head_sha") == head_sha
            and row.get("readiness_claim_id") == readiness_claim_id
        ),
        None,
    )
    if existing is not None:
        return existing
    return record_incident_event(
        {
            "incident_event": "pre_merge_no_incident",
            "repo": pr.get("repository") or pr.get("repo") or pr.get("repo_full_name"),
            "pr_number": pr_number,
            "target_ref": pr.get("base_branch") or pr.get("baseRefName") or pr.get("base") or pr.get("target_ref"),
            "head_ref": pr.get("head_ref") or pr.get("headRefName") or pr.get("head_branch"),
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
            "incident_status": "none",
        },
        base_dir=root,
    )


def finalize_merge_incident(
    *,
    pr: dict[str, Any],
    readiness_claim_id: str,
    merge_result: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return record_incident_event(
        {
            "incident_event": "merge_finalized_no_incident",
            "repo": pr.get("repository") or pr.get("repo") or pr.get("repo_full_name"),
            "pr_number": int(pr.get("number") or 0),
            "target_ref": pr.get("base_branch") or pr.get("baseRefName") or pr.get("base") or pr.get("target_ref"),
            "head_ref": pr.get("head_ref") or pr.get("headRefName") or pr.get("head_branch"),
            "head_sha": pr.get("head_sha") or pr.get("headRefOid") or pr.get("head"),
            "readiness_claim_id": readiness_claim_id,
            "incident_status": "none",
            "merge_result": merge_result,
        },
        base_dir=base_dir,
    )


def record_merge_failed_incident(
    *,
    pr: dict[str, Any],
    readiness_claim_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return record_incident_event(
        {
            "incident_event": "merge_failed",
            "repo": pr.get("repository") or pr.get("repo") or pr.get("repo_full_name"),
            "pr_number": int(pr.get("number") or 0),
            "target_ref": pr.get("base_branch") or pr.get("baseRefName") or pr.get("base") or pr.get("target_ref"),
            "head_ref": pr.get("head_ref") or pr.get("headRefName") or pr.get("head_branch"),
            "head_sha": pr.get("head_sha") or pr.get("headRefOid") or pr.get("head"),
            "readiness_claim_id": readiness_claim_id,
            "incident_status": "none",
            "reason": reason,
        },
        base_dir=base_dir,
    )


def _require_common(row: dict[str, Any]) -> None:
    required = ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id")
    missing = [key for key in required if row.get(key) in (None, "", [], {})]
    if missing:
        raise GovernanceError("incident_event_missing_fields:" + ",".join(missing))


__all__ = [
    "ensure_pre_merge_incident_row",
    "finalize_merge_incident",
    "record_incident_event",
    "record_merge_failed_incident",
]
