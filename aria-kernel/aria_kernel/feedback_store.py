from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any

from .ledger import append_jsonl as append_chained_jsonl
from .ledger import load_jsonl as load_chained_jsonl
from .ledger import rewrite_jsonl as rewrite_chained_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FEEDBACK_VERDICTS = ("true_positive", "false_positive")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
JUDGMENT_STRATEGIES = ("stratified_by_rule", "random")
DEFAULT_MIN_JUDGED_SAMPLES = 10


def findings_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "findings.jsonl"


def feedback_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def judgment_samples_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "judgment-samples.jsonl"


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
    affected_belief_ids: list[str] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if verdict not in FEEDBACK_VERDICTS:
        raise GovernanceError(f"unknown feedback verdict: {verdict}")
    if severity not in FEEDBACK_SEVERITIES:
        raise GovernanceError(f"unknown feedback severity: {severity}")
    if affected_belief_ids is not None and not _valid_string_list(affected_belief_ids):
        raise GovernanceError("affected_belief_ids must be an array of non-empty strings")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "tool_id": tool_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "verdict": verdict,
        "severity": severity,
        "note": note,
        "affected_belief_ids": affected_belief_ids or [],
    }
    append_jsonl(feedback_path(base_dir), row)
    return row


def generate_judgment_sample(
    *,
    tool_id: str,
    sample_size: int,
    strategy: str = "stratified_by_rule",
    cycle_id: str | None = None,
    min_judged_samples: int = DEFAULT_MIN_JUDGED_SAMPLES,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if sample_size <= 0:
        raise GovernanceError("feedback judge sample_size must be positive")
    if strategy not in JUDGMENT_STRATEGIES:
        raise GovernanceError(f"unknown feedback judge strategy: {strategy}")
    if min_judged_samples <= 0:
        raise GovernanceError("feedback judge min_judged_samples must be positive")
    findings = _sampleable_raw_findings(tool_id=tool_id, cycle_id=cycle_id, base_dir=base_dir)
    selected = _select_findings(findings, sample_size=sample_size, strategy=strategy)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "sample_id": _sample_id(tool_id, cycle_id, selected),
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "strategy": strategy,
        "sample_size": sample_size,
        "min_judged_samples": min_judged_samples,
        "status": "pending" if selected else "empty",
        "sampled_count": len(selected),
        "items": selected,
        "instructions": {
            "verdicts": list(FEEDBACK_VERDICTS),
            "lane": "record one operator-feedback verdict per sampled finding_id",
            "cli": "aria-kernel feedback record --tool-id ... --run-id ... --finding-id ... --verdict true_positive|false_positive",
        },
    }
    append_jsonl(judgment_samples_path(base_dir), row)
    return row


def list_judgment_samples(
    *,
    tool_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(judgment_samples_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def load_feedback(
    *,
    tool_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(feedback_path(base_dir))
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def _sampleable_raw_findings(
    *,
    tool_id: str,
    cycle_id: str | None,
    base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    existing_feedback = {
        (str(row.get("run_id")), str(row.get("finding_id")))
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
    }
    candidates = []
    for run in load_jsonl(ensure_tools_dir(base_dir) / "runs.jsonl"):
        if run.get("tool_id") != tool_id or run.get("status") != "ok":
            continue
        if cycle_id is not None and run.get("cycle_id") != cycle_id:
            continue
        for finding in run.get("runner", {}).get("raw_findings_sample", []):
            if not isinstance(finding, dict):
                continue
            finding_id = str(finding.get("id") or "")
            run_id = str(run.get("run_id"))
            if not finding_id or (run_id, finding_id) in existing_feedback:
                continue
            candidates.append(
                {
                    "tool_id": tool_id,
                    "run_id": run_id,
                    "cycle_id": run.get("cycle_id"),
                    "finding_id": finding_id,
                    "rule": str(finding.get("rule") or "unknown"),
                    "severity": str(finding.get("severity") or "medium"),
                    "path": str(finding.get("path") or ""),
                    "message": str(finding.get("message") or ""),
                    "evidence": finding.get("evidence", []) if isinstance(finding.get("evidence"), list) else [],
                },
            )
    return candidates


def _select_findings(findings: list[dict[str, Any]], *, sample_size: int, strategy: str) -> list[dict[str, Any]]:
    if strategy == "random":
        return sorted(findings, key=lambda item: _stable_sort_key(item))[:sample_size]
    by_rule: dict[str, list[dict[str, Any]]] = {}
    for finding in sorted(findings, key=lambda item: _stable_sort_key(item)):
        by_rule.setdefault(str(finding.get("rule") or "unknown"), []).append(finding)
    selected: list[dict[str, Any]] = []
    while len(selected) < sample_size and any(by_rule.values()):
        for rule in sorted(by_rule):
            bucket = by_rule[rule]
            if bucket:
                selected.append(bucket.pop(0))
                if len(selected) >= sample_size:
                    break
    return selected


def _stable_sort_key(item: dict[str, Any]) -> str:
    return hashlib.sha256(
        f"{item.get('run_id')}:{item.get('finding_id')}:{item.get('rule')}".encode("utf-8"),
    ).hexdigest()


def _sample_id(tool_id: str, cycle_id: str | None, items: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256(
        json.dumps(
            {"tool_id": tool_id, "cycle_id": cycle_id, "items": [(i.get("run_id"), i.get("finding_id")) for i in items]},
            sort_keys=True,
        ).encode("utf-8"),
    ).hexdigest()[:12]
    return f"judge-{digest}"


def _valid_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    append_chained_jsonl(path, payload)


def rewrite_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    rewrite_chained_jsonl(path, rows)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return load_chained_jsonl(path)
