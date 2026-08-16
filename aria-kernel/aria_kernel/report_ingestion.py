from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from .feedback import add_feedback, build_feedback_event, slug
from .batch_containment import guard_item, with_item_failures
from .ledger import append_declared_jsonl
from .phase2_utils import atomic_write_json, utc_now_iso
from .tool_registry import GovernanceError, ensure_tools_dir
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
    strict_registry: bool = True,
) -> dict[str, Any]:
    """Plan 026R §A.5 — ``strict_registry=True`` (default) makes
    ``_read_registry`` raise GovernanceError on the first corrupt
    row. Operator opt-in ``strict_registry=False`` preserves the
    legacy tolerant tuple shape (rows, malformed) for compatibility
    with downstream reports that count malformed rows; corrupt
    rows still emit ``ledger_row_corrupt`` to the diagnostic sink
    (Plan 024 §H-7) so the audit trail records them either way.
    """
    registry = paths.repo_root / "docs" / "reviews" / "_registry" / "findings.jsonl"
    cache_path = paths.state_dir / "ingested_findings.json"
    tools_base = Path(tools_root) if tools_root is not None else None
    if not registry.exists():
        record_workspace_governance(
            paths,
            "report_ingestion_skipped",
            {"cycle_id": cycle_id, "reason": "registry_missing", "registry_path": registry.relative_to(paths.repo_root).as_posix()},
        )
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "registry_missing", "ingested_count": 0}

    # Plan 026R §A.5 — strict by default; corrupt rows raise.
    # Operator-opt-in tolerant mode preserves the legacy
    # ``malformed_count`` reporting for known-imperfect upstream
    # exports (e.g. partial third-party scan dumps).
    rows, malformed = _read_registry(registry, strict=strict_registry)
    if len(rows) > LARGE_BACKFILL_THRESHOLD and not (confirm_large_backfill and acknowledge):
        raise ValueError("large_backfill_requires_confirm_large_backfill_and_acknowledge")

    cache_missing = not cache_path.exists()
    previously_baselined = _has_report_baseline(paths)
    if cache_missing:
        if previously_baselined:
            record_workspace_governance(paths, "report_ingestion_cache_missing", {"cycle_id": cycle_id, "cache_path": cache_path.as_posix()})
        baseline = sorted({_finding_key(row) for row in rows if _finding_key(row)})
        _write_cache(cache_path, baseline)
        _record_cache_event(
            tools_base,
            {
                "cycle_id": cycle_id,
                "event": "baseline_created" if not previously_baselined else "baseline_rebuilt",
                "baseline_count": len(baseline),
                "cache_path": cache_path.as_posix(),
            },
        )
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
    item_failures: list[dict[str, Any]] = []
    skipped = 0
    for row in candidates:
        if str(row.get("status") or row.get("state") or "").upper() != "OPEN":
            known.add(_finding_key(row))
            skipped += 1
            continue
        ok, finding_event = guard_item(
            item_failures,
            item_kind="finding",
            item_id=str(_finding_key(row)),
            work=lambda row=row: _ingest_one_finding(
                paths, row, cycle_id=cycle_id, tools_base=tools_base,
            ),
        )
        if not ok or finding_event is None:
            # Deliberately NOT added to `known`. Containment must not consume
            # the item: the dedup cache is now written on every run, so marking
            # a finding seen after failing to ingest it would drop that finding
            # permanently. Left unknown, the next cycle offers it again.
            continue
        known.add(_finding_key(row))
        ingested.append(finding_event)
    _write_cache(cache_path, sorted(known))
    return with_item_failures({
        "schema_version": 1,
        "cycle_id": cycle_id,
        "status": "ok",
        "ingested_count": len(ingested),
        "skipped_count": skipped,
        "malformed_count": len(malformed),
        "cache_path": cache_path.as_posix(),
        "ingested": ingested,
    }, item_failures)


def _ingest_one_finding(
    paths: WorkspacePaths,
    row: dict[str, Any],
    *,
    cycle_id: str,
    tools_base: Path | None,
) -> dict[str, Any]:
    """Turn one registry finding into feedback, an ingestion row, and governance."""
    event = _feedback_event_from_finding(paths, row, cycle_id=cycle_id)
    add_feedback(paths, event)
    finding_event = {"finding_key": _finding_key(row), "feedback_event_id": event["event_id"], "owner_agent": _owner_agent(row), "severity": _severity(row), "source_refs": _refs(row)}
    _record_ingestion_event(tools_base, {"cycle_id": cycle_id, **finding_event})
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
    return finding_event


def _read_registry(
    path: Path,
    *,
    strict: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Plan 026R §A.5 — strict-by-default registry reader.

    Two modes:

    * **strict (default)** — routes through
      ``strict_jsonl_reader.read_strict_jsonl`` so the first corrupt
      row raises ``GovernanceError`` AFTER emitting the
      ``ledger_row_corrupt`` diagnostic. Returns (rows, []).
    * **tolerant** (operator opt-in via
      ``ingest_external_reports(strict_registry=False)``) — preserves
      the legacy (rows, malformed) tuple shape. Corrupt rows are
      tracked in the ``malformed`` list AND emit
      ``ledger_row_corrupt`` to the diagnostic sink, so the audit
      trail is recorded either way. Operators choose this mode
      when consuming known-imperfect third-party scan exports where
      "drop the bad row, keep going" is the desired behaviour.

    Non-dict rows (e.g. an array literal where an object is
    expected) are tracked as ``row_not_object`` in tolerant mode and
    raise ``GovernanceError`` in strict mode — a schema break is a
    real defect, not a missing-row.
    """
    rows: list[dict[str, Any]] = []
    malformed: list[dict[str, Any]] = []
    if not path.exists():
        return rows, malformed
    if strict:
        from .strict_jsonl_reader import read_strict_jsonl
        from .tool_registry import GovernanceError
        for line_no, row in enumerate(
            read_strict_jsonl(path, base_dir=path.parent), start=1,
        ):
            if not isinstance(row, dict):
                raise GovernanceError(
                    f"report_ingestion_row_not_object: "
                    f"{path}:{line_no}"
                )
            rows.append(row)
        return rows, malformed
    # Tolerant mode — explicit diagnostic emit + malformed tracking +
    # continue. Body is 3 statements (track + emit + continue), so it
    # does NOT match the §A.3 silent-skip AST predicate (which flags
    # only bare-``continue`` bodies inside JSONL-row-iteration loops).
    from .diagnostics import emit_ledger_corruption_diagnostic
    for line_no, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1,
    ):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            malformed.append({"line": line_no, "reason": str(exc)})
            emit_ledger_corruption_diagnostic(
                {
                    "kind": "ledger_row_corrupt",
                    "ledger": str(path),
                    "line_no": line_no,
                    "error": str(exc),
                    "raw_excerpt": line[:200],
                },
                base_dir=path.parent,
            )
            continue
        if not isinstance(row, dict):
            malformed.append({"line": line_no, "reason": "row_not_object"})
            continue
        rows.append(row)
    return rows, malformed


def _feedback_event_from_finding(paths: WorkspacePaths, row: dict[str, Any], *, cycle_id: str) -> dict[str, Any]:
    refs = _refs(row)
    ref = refs[0] if refs else "docs/reviews/_registry/findings.jsonl"
    evidence_refs = sorted(dict.fromkeys([*refs, "docs/reviews/_registry/findings.jsonl"]))
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
        evidence_ref=evidence_refs,
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
    except OSError as exc:
        raise GovernanceError(f"report_ingestion_cache_unreadable:{path.as_posix()}:{exc}") from exc
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"report_ingestion_cache_corrupt:{path.as_posix()}:{exc}") from exc
    if not isinstance(payload, dict):
        raise GovernanceError(f"report_ingestion_cache_not_object:{path.as_posix()}")
    if not isinstance(payload.get("finding_keys"), list):
        raise GovernanceError(f"report_ingestion_cache_missing_finding_keys:{path.as_posix()}")
    return payload


def _write_cache(path: Path, keys: list[str]) -> None:
    atomic_write_json(path, {"schema_version": 1, "rebuilt_at": utc_now_iso(), "finding_keys": keys})


def _record_ingestion_event(tools_root: Path | None, payload: dict[str, Any]) -> None:
    if tools_root is None:
        return
    root = ensure_tools_dir(tools_root)
    append_declared_jsonl(
        root / "report-ingestion" / "findings.jsonl",
        {"schema_version": 1, "recorded_at": utc_now_iso(), **payload},
        expected_surface="report_ingestion_findings",
    )


def _record_cache_event(tools_root: Path | None, payload: dict[str, Any]) -> None:
    if tools_root is None:
        return
    root = ensure_tools_dir(tools_root)
    append_declared_jsonl(
        root / "report-ingestion" / "cache-events.jsonl",
        {"schema_version": 1, "recorded_at": utc_now_iso(), **payload},
        expected_surface="report_ingestion_cache_events",
    )


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


def list_ingested_findings(paths: WorkspacePaths) -> dict[str, Any]:
    cache_path = paths.state_dir / "ingested_findings.json"
    if not cache_path.exists():
        return {"schema_version": 1, "status": "no_cache", "cache_path": cache_path.as_posix(), "ingested_count": 0, "finding_keys": []}
    payload = _read_cache(cache_path)
    keys = payload.get("finding_keys", []) if isinstance(payload, dict) else []
    return {
        "schema_version": 1,
        "status": "ok",
        "cache_path": cache_path.as_posix(),
        "rebuilt_at": payload.get("rebuilt_at") if isinstance(payload, dict) else None,
        "ingested_count": len(keys),
        "finding_keys": keys,
    }


def import_finding_file(
    paths: WorkspacePaths,
    file_path: str | Path,
    *,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    src = Path(file_path)
    if not src.exists():
        raise FileNotFoundError(f"finding_file_not_found: {src}")
    raw = src.read_text(encoding="utf-8").strip()
    if not raw:
        raise ValueError("finding_file_empty")
    rows: list[dict[str, Any]] = []
    if raw.startswith("["):
        payload = json.loads(raw)
        if isinstance(payload, list):
            rows = [row for row in payload if isinstance(row, dict)]
    elif raw.startswith("{"):
        payload = json.loads(raw)
        if isinstance(payload, dict):
            rows = [payload]
    else:
        for line_no, line in enumerate(raw.splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                row = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"finding_file_invalid_jsonl_line_{line_no}: {exc}") from exc
            if isinstance(row, dict):
                rows.append(row)
    if not rows:
        raise ValueError("finding_file_no_rows")
    cache_path = paths.state_dir / "ingested_findings.json"
    cache = _read_cache(cache_path) if cache_path.exists() else {"schema_version": 1, "finding_keys": []}
    known = set(cache.get("finding_keys", []))
    effective_cycle_id = cycle_id or "manual-import"
    ingested: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in rows:
        key = _finding_key(row)
        if not key:
            skipped.append({"reason": "missing_key", "row": row})
            continue
        if key in known:
            skipped.append({"reason": "already_ingested", "finding_key": key})
            continue
        if str(row.get("status") or row.get("state") or "").upper() not in {"OPEN", ""}:
            skipped.append({"reason": "non_open_state", "finding_key": key, "state": row.get("status") or row.get("state")})
            continue
        event = _feedback_event_from_finding(paths, row, cycle_id=effective_cycle_id)
        add_feedback(paths, event)
        known.add(key)
        ingested.append(
            {
                "finding_key": key,
                "feedback_event_id": event["event_id"],
                "owner_agent": _owner_agent(row),
                "severity": _severity(row),
            },
        )
        record_workspace_governance(
            paths,
            "agent_report_ingested",
            {
                "cycle_id": effective_cycle_id,
                "finding_key": key,
                "feedback_event_id": event["event_id"],
                "owner_agent": _owner_agent(row),
                "severity": _severity(row),
                "source": "manual_import",
                "file": src.as_posix(),
            },
        )
    _write_cache(cache_path, sorted(known))
    return {
        "schema_version": 1,
        "status": "ok",
        "cycle_id": effective_cycle_id,
        "file": src.as_posix(),
        "ingested_count": len(ingested),
        "skipped_count": len(skipped),
        "ingested": ingested,
        "skipped": skipped,
    }
