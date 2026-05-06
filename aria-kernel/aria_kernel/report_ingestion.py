from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from .feedback import add_feedback, build_feedback_event, slug
from .phase2_utils import atomic_write_json, utc_now_iso
from .workspace import WorkspacePaths, record_workspace_governance


DEFAULT_BACKFILL_LIMIT = 100
LARGE_BACKFILL_THRESHOLD = 500


def report_ingestion_scan(
    paths: WorkspacePaths,
    *,
    cycle_id: str,
    tools_root: str | Path | None = None,
    backfill_limit: int = DEFAULT_BACKFILL_LIMIT,
    confirm_large_backfill: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    registry = paths.repo_root / "docs" / "reviews" / "_registry" / "findings.jsonl"
    cache_path = paths.state_dir / "ingested_findings.json"
    if not registry.exists():
        record_workspace_governance(
            paths,
            "report_ingestion_skipped",
            {"cycle_id": cycle_id, "reason": "registry_missing", "registry_path": registry.relative_to(paths.repo_root).as_posix()},
        )
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "registry_missing", "ingested_count": 0}

    rows, malformed = _read_registry(registry)
    if len(rows) > LARGE_BACKFILL_THRESHOLD and not (confirm_large_backfill and acknowledge):
        raise ValueError("large_backfill_requires_confirm_large_backfill_and_acknowledge")

    cache_missing = not cache_path.exists()
    previously_baselined = _has_report_baseline(paths)
    if cache_missing:
        if previously_baselined:
            record_workspace_governance(paths, "report_ingestion_cache_missing", {"cycle_id": cycle_id, "cache_path": cache_path.as_posix()})
        baseline = sorted({_finding_key(row) for row in rows if _finding_key(row)})
        _write_cache(cache_path, baseline)
        record_workspace_governance(
            paths,
            "report_ingestion_skipped",
            {
                "cycle_id": cycle_id,
                "reason": "baseline_rebuilt" if previously_baselined else "baseline_created",
                "baseline_count": len(baseline),
                "malformed_count": len(malformed),
            },
        )
        return {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "status": "baselined",
            "cache_missing": True,
            "baseline_count": len(baseline),
            "malformed_count": len(malformed),
            "ingested_count": 0,
        }

    cache = _read_cache(cache_path)
    known = set(cache.get("finding_keys", []))
    candidates = [row for row in rows if _finding_key(row) and _finding_key(row) not in known]
    if len(candidates) > backfill_limit:
        candidates = candidates[:backfill_limit]

    ingested: list[dict[str, Any]] = []
    skipped = 0
    for row in candidates:
        known.add(_finding_key(row))
        if str(row.get("status") or row.get("state") or "").upper() != "OPEN":
            skipped += 1
            continue
        event = _feedback_event_from_finding(paths, row, cycle_id=cycle_id)
        add_feedback(paths, event)
        ingested.append({"finding_key": _finding_key(row), "feedback_event_id": event["event_id"], "owner_agent": _owner_agent(row), "severity": _severity(row)})
        record_workspace_governance(
            paths,
            "agent_report_ingested",
            {
                "cycle_id": cycle_id,
                "finding_key": _finding_key(row),
                "feedback_event_id": event["event_id"],
                "owner_agent": _owner_agent(row),
                "severity": _severity(row),
            },
        )
    _write_cache(cache_path, sorted(known))
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "ingested_count": len(ingested),
        "skipped_count": skipped,
        "malformed_count": len(malformed),
        "cache_path": cache_path.as_posix(),
        "ingested": ingested,
    }


def _read_registry(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    malformed: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            malformed.append({"line": line_no, "reason": str(exc)})
            continue
        if not isinstance(row, dict):
            malformed.append({"line": line_no, "reason": "row_not_object"})
            continue
        rows.append(row)
    return rows, malformed


def _feedback_event_from_finding(paths: WorkspacePaths, row: dict[str, Any], *, cycle_id: str) -> dict[str, Any]:
    refs = _refs(row)
    ref = refs[0] if refs else "docs/reviews/_registry/findings.jsonl"
    args = argparse.Namespace(
        kind="missed_signal",
        summary=str(row.get("summary") or row.get("title") or row.get("message") or "agent report finding"),
        ref=ref,
        concept=str(row.get("concept") or _owner_agent(row)),
        source="external_scanner",
        surface=row.get("surface"),
        failure_mode=str(row.get("failure_mode") or "evidence_gap"),
        parser_kind=row.get("parser_kind"),
        capability_gap_key=row.get("capability_gap_key"),
        cycle_id=cycle_id,
        evidence_ref=[f"agent:{_owner_agent(row)}", "docs/reviews/_registry/findings.jsonl"],
        evidence_chain=[
            json.dumps(
                {
                    "source_type": "external_scanner",
                    "reference": str(row.get("id") or row.get("finding_id") or _finding_key(row)),
                    "trust_level": "medium",
                },
                sort_keys=True,
            ),
        ],
    )
    return build_feedback_event(args, cycle_id=cycle_id, paths=paths)


def _read_cache(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema_version": 1, "finding_keys": []}
    return payload if isinstance(payload, dict) else {"schema_version": 1, "finding_keys": []}


def _write_cache(path: Path, keys: list[str]) -> None:
    atomic_write_json(path, {"schema_version": 1, "rebuilt_at": utc_now_iso(), "finding_keys": keys})


def _has_report_baseline(paths: WorkspacePaths) -> bool:
    from .ledger import read_jsonl

    return any(row.get("kind") == "report_ingestion_skipped" and row.get("details", {}).get("reason") in {"baseline_created", "baseline_rebuilt"} for row in read_jsonl(paths.ledgers["governance"]))


def _finding_key(row: dict[str, Any]) -> str:
    value = row.get("finding_id") or row.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    identity = {"summary": row.get("summary") or row.get("title") or row.get("message"), "refs": _refs(row), "owner_agent": _owner_agent(row)}
    return "finding:" + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]


def _owner_agent(row: dict[str, Any]) -> str:
    return slug(str(row.get("owner_agent") or row.get("agent") or row.get("reported_by") or "unknown_agent"))


def _severity(row: dict[str, Any]) -> str:
    return str(row.get("severity") or "unknown").lower()


def _refs(row: dict[str, Any]) -> list[str]:
    raw = row.get("refs") or row.get("evidence_refs") or row.get("paths") or row.get("path") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if isinstance(item, str) and item.strip()]
