from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_jsonl as append_chained_jsonl
from .ledger import load_jsonl as load_chained_jsonl
from .ledger import rewrite_jsonl as rewrite_chained_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FEEDBACK_VERDICTS = ("true_positive", "false_positive")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")


def findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "findings.jsonl"


def feedback_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def record_findings_for_run(run: dict[str, Any], base_dir: str | Path | None = None) -> None:
    findings = run.get("emitted_findings", [])
    if not isinstance(findings, list) or not findings:
        return
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        append_jsonl(
            findings_path(base_dir),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "tool_id": run["tool_id"],
                "run_id": run["run_id"],
                "finding_id": finding.get("id"),
                "status": "open",
                "finding": finding,
            },
        )


def mark_findings_need_revalidation(tool_id: str, base_dir: str | Path | None = None) -> int:
    rows = load_jsonl(findings_path(base_dir))
    updated = 0
    next_rows: list[dict[str, Any]] = []
    for row in rows:
        if row.get("tool_id") == tool_id and row.get("status") == "open":
            row = dict(row)
            row["status"] = "needs_revalidation"
            row["updated_at"] = utc_now()
            updated += 1
        next_rows.append(row)
    rewrite_jsonl(findings_path(base_dir), next_rows)
    return updated


def list_findings(
    *,
    tool_id: str | None = None,
    status: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(findings_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    if status is not None:
        rows = [row for row in rows if row.get("status") == status]
    return rows


def record_operator_feedback(
    *,
    tool_id: str,
    run_id: str,
    finding_id: str,
    verdict: str,
    severity: str,
    note: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if verdict not in FEEDBACK_VERDICTS:
        raise GovernanceError(f"unknown feedback verdict: {verdict}")
    if severity not in FEEDBACK_SEVERITIES:
        raise GovernanceError(f"unknown feedback severity: {severity}")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "tool_id": tool_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "verdict": verdict,
        "severity": severity,
        "note": note,
    }
    append_jsonl(feedback_path(base_dir), row)
    return row


def load_feedback(
    *,
    tool_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(feedback_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    append_chained_jsonl(path, payload)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    rewrite_chained_jsonl(path, rows)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return load_chained_jsonl(path)
