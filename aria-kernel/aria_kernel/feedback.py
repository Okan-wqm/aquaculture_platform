from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, read_jsonl, verify_index_hashes, write_index
from .workspace import WorkspacePaths

FEEDBACK_KINDS = {
    "missed_signal",
    "false_positive",
    "confirmed_signal",
    "unknown_capability",
    "external_contradiction",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return re.sub(r"_+", "_", value).strip("_") or "unknown"


def infer_surface(ref: str) -> str:
    if ref.startswith(("web/modules/", "web/apps/")):
        return "frontend"
    if ref.startswith("apps/"):
        return "backend"
    if ref.startswith("infra/") or ref.startswith(".github/"):
        return "infra"
    return "repo"


def infer_parser_kind(ref: str) -> str:
    suffix = Path(ref.split(":", 1)[0]).suffix.lower().lstrip(".")
    return suffix or "unknown"


def capability_gap_key(surface: str, failure_mode: str, parser_kind: str) -> str:
    return f"{slug(surface)}:{slug(failure_mode)}:{slug(parser_kind)}"


def ledger_name_for_kind(kind: str) -> str:
    if kind == "unknown_capability":
        return "unknowns"
    if kind == "missed_signal":
        return "missed_signals"
    return "external_feedback"


def build_feedback_event(args: argparse.Namespace, cycle_id: str | None = None) -> dict[str, Any]:
    if args.kind not in FEEDBACK_KINDS:
        raise ValueError(f"unsupported feedback kind: {args.kind}")
    ref = args.ref
    surface = args.surface or infer_surface(ref)
    failure_mode = args.failure_mode or args.kind
    parser_kind = args.parser_kind or infer_parser_kind(ref)
    gap_key = args.capability_gap_key or capability_gap_key(surface, failure_mode, parser_kind)
    created_at = now_iso()
    stable = slug(f"{args.kind}:{args.source}:{gap_key}:{ref}:{args.summary}")[:72]
    return {
        "$schema": "aria/feedback-event/v1",
        "event_id": f"FB-{stable}",
        "cycle_id": cycle_id,
        "kind": args.kind,
        "source": args.source,
        "concept": args.concept,
        "refs": [ref],
        "summary": args.summary,
        "capability_gap_key": gap_key,
        "evidence_refs": [],
        "trusted": False,
        "created_at": created_at,
        "schema_version": 1,
    }


def add_feedback(paths: WorkspacePaths, event: dict[str, Any]) -> list[dict[str, Any]]:
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    append_jsonl(paths.ledgers[ledger_name_for_kind(event["kind"])], event)
    pressure = derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)
    return pressure


def import_feedback(paths: WorkspacePaths, source_file: Path) -> int:
    imported = 0
    for record in read_jsonl(source_file):
        if record.get("kind") not in FEEDBACK_KINDS:
            raise ValueError(f"unsupported feedback kind in import: {record.get('kind')}")
        record.setdefault("$schema", "aria/feedback-event/v1")
        record.setdefault("source", "external_scanner")
        record.setdefault("trusted", False)
        record.setdefault("schema_version", 1)
        record.setdefault("created_at", now_iso())
        record.setdefault("evidence_refs", [])
        record.setdefault("refs", [])
        if "capability_gap_key" not in record:
            ref = record.get("refs", ["unknown"])[0]
            record["capability_gap_key"] = capability_gap_key(
                infer_surface(ref),
                record["kind"],
                infer_parser_kind(ref),
            )
        add_feedback(paths, record)
        imported += 1
    return imported


def list_feedback(paths: WorkspacePaths, kind: str | None = None) -> list[dict[str, Any]]:
    verify_index_hashes(paths.feedback_index, paths.ledgers)
    records: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        records.extend(read_jsonl(paths.ledgers[name]))
    if kind:
        records = [record for record in records if record.get("kind") == kind]
    return records


def derive_pressure(paths: WorkspacePaths, index: dict[str, Any]) -> list[dict[str, Any]]:
    existing = set(index.setdefault("pressure_keys_emitted", []))
    records = list_feedback_without_integrity(paths)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        grouped.setdefault(record.get("capability_gap_key", "unknown"), []).append(record)

    emitted: list[dict[str, Any]] = []
    for gap_key, items in sorted(grouped.items()):
        refs = sorted({ref for item in items for ref in item.get("refs", [])})
        kinds = {item.get("kind") for item in items}
        sources = {item.get("source") for item in items}

        candidates: list[tuple[str, str, list[str]]] = []
        unknown_count = sum(1 for item in items if item.get("kind") == "unknown_capability")
        missed_count = sum(1 for item in items if item.get("kind") == "missed_signal")
        false_positive_count = sum(1 for item in items if item.get("kind") == "false_positive")

        if unknown_count >= 3 and len(refs) >= 3:
            candidates.append(("UNKNOWN", "repeated_unknown_capability", ["adapter_birth"]))
        if missed_count >= 3 and len(refs) >= 3:
            candidates.append(("REPETITION", "repeated_missed_signal", ["skill_birth"]))
        if "external_contradiction" in kinds or (
            "external_scanner" in sources and ("missed_signal" in kinds or "confirmed_signal" in kinds)
        ):
            candidates.append(("CONTRADICTION", "external_feedback_disagrees", ["investigation_task"]))
        if false_positive_count >= 3 and len(refs) >= 3:
            candidates.append(("CONTRADICTION", "repeated_false_positive", ["calibration"]))

        for primitive, subtype, drives in candidates:
            pressure_key = f"{primitive}:{subtype}:{gap_key}"
            if pressure_key in existing:
                continue
            event = {
                "$schema": "aria/pressure-event/v1",
                "event_id": f"PE-{slug(pressure_key)}",
                "cycle_id": None,
                "primitive": primitive,
                "subtype": subtype,
                "capability_gap_key": gap_key,
                "magnitude": len(refs),
                "threshold": 3 if primitive != "CONTRADICTION" or subtype == "repeated_false_positive" else 1,
                "exceeds_threshold": True,
                "evidence_refs": [],
                "feedback_event_ids": [item.get("event_id") for item in items],
                "detected_at": now_iso(),
                "drives": drives,
                "schema_version": 1,
            }
            append_jsonl(paths.ledgers["pressure"], event)
            existing.add(pressure_key)
            index["pressure_keys_emitted"] = sorted(existing)
            emitted.append(event)
    return emitted


def list_feedback_without_integrity(paths: WorkspacePaths) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        records.extend(read_jsonl(paths.ledgers[name]))
    return records
