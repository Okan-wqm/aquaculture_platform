from __future__ import annotations

import argparse
import hashlib
import json
import re
from difflib import get_close_matches
from importlib import resources
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, read_jsonl, verify_index_hashes, write_index
from .workspace import WorkspacePaths, require_workspace_v2

FEEDBACK_KINDS = {
    "missed_signal",
    "false_positive",
    "confirmed_signal",
    "unknown_capability",
    "external_contradiction",
}
FEEDBACK_SOURCES = {"self", "operator", "external_scanner", "ai_judge", "manual_audit"}


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
    if args.source not in FEEDBACK_SOURCES:
        raise ValueError(f"unsupported feedback source: {args.source}")
    ref = args.ref
    surface = args.surface or infer_surface(ref)
    failure_mode = args.failure_mode or args.kind
    validate_failure_mode(failure_mode)
    parser_kind = args.parser_kind or infer_parser_kind(ref)
    gap_key = args.capability_gap_key or capability_gap_key(surface, failure_mode, parser_kind)
    created_at = now_iso()
    identity = {
        "kind": args.kind,
        "source": args.source,
        "capability_gap_key": gap_key,
        "refs": [ref],
        "summary": args.summary,
    }
    return {
        "$schema": "aria/feedback-event/v2",
        "event_id": _stable_event_id("FB", f"{args.kind}-{gap_key}", identity),
        "cycle_id": cycle_id,
        "kind": args.kind,
        "source": args.source,
        "concept": args.concept,
        "refs": [ref],
        "summary": args.summary,
        "capability_gap_key": gap_key,
        "evidence_refs": [],
        "legacy_event_ids": [],
        "trusted": False,
        "created_at": created_at,
        "schema_version": 2,
    }


def add_feedback(paths: WorkspacePaths, event: dict[str, Any]) -> list[dict[str, Any]]:
    require_workspace_v2(paths)
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    event = normalize_feedback_event(event)
    append_jsonl(paths.ledgers[ledger_name_for_kind(event["kind"])], event)
    pressure = derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)
    return pressure


def import_feedback(paths: WorkspacePaths, source_file: Path, *, cycle_id: str | None = None) -> int:
    require_workspace_v2(paths)
    records = [normalize_feedback_event(record, cycle_id=cycle_id) for record in read_jsonl(source_file)]
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    for record in records:
        append_jsonl(paths.ledgers[ledger_name_for_kind(record["kind"])], record)
    derive_pressure(paths, index)
    write_index(paths.feedback_index, index, paths.ledgers)
    return len(records)


def list_feedback(paths: WorkspacePaths, kind: str | None = None) -> list[dict[str, Any]]:
    verify_index_hashes(paths.feedback_index, paths.ledgers)
    records: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        records.extend(read_jsonl(paths.ledgers[name]))
    if kind:
        records = [record for record in records if record.get("kind") == kind]
    return records


def derive_pressure(paths: WorkspacePaths, index: dict[str, Any]) -> list[dict[str, Any]]:
    existing_fingerprints = set(index.setdefault("pressure_evidence_fingerprints_emitted", []))
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
            event_ids = sorted({str(item.get("event_id")) for item in items if item.get("event_id")})
            fingerprint = pressure_evidence_fingerprint(primitive, subtype, event_ids)
            if fingerprint in existing_fingerprints:
                continue
            pressure_key = f"{primitive}:{subtype}:{gap_key}"
            identity = {
                "primitive": primitive,
                "subtype": subtype,
                "feedback_event_ids": event_ids,
            }
            event = {
                "$schema": "aria/pressure-event/v2",
                "event_id": _stable_event_id("PE", pressure_key, identity),
                "cycle_id": None,
                "primitive": primitive,
                "subtype": subtype,
                "capability_gap_key": gap_key,
                "magnitude": len(refs),
                "threshold": 3 if primitive != "CONTRADICTION" or subtype == "repeated_false_positive" else 1,
                "exceeds_threshold": True,
                "evidence_refs": [],
                "feedback_event_ids": event_ids,
                "legacy_feedback_event_ids": [
                    legacy_id
                    for item in items
                    for legacy_id in item.get("legacy_event_ids", [])
                    if isinstance(legacy_id, str)
                ],
                "legacy_event_ids": [],
                "evidence_fingerprint": fingerprint,
                "detected_at": now_iso(),
                "drives": drives,
                "schema_version": 2,
            }
            append_jsonl(paths.ledgers["pressure"], event)
            existing_fingerprints.add(fingerprint)
            index["pressure_evidence_fingerprints_emitted"] = sorted(existing_fingerprints)
            emitted.append(event)
    return emitted


def list_feedback_without_integrity(paths: WorkspacePaths) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        records.extend(read_jsonl(paths.ledgers[name]))
    return records


def normalize_feedback_event(record: dict[str, Any], *, cycle_id: str | None = None) -> dict[str, Any]:
    if record.get("kind") not in FEEDBACK_KINDS:
        raise ValueError(f"unsupported feedback kind in import: {record.get('kind')}")
    source = record.get("source") or "operator"
    if source not in FEEDBACK_SOURCES:
        raise ValueError(f"unsupported feedback source in import: {source}")
    refs = record.get("refs") or ["unknown"]
    if not isinstance(refs, list):
        refs = [str(refs)]
    refs = [str(ref) for ref in refs if str(ref).strip()] or ["unknown"]
    failure_mode = str(record.get("failure_mode") or record.get("kind"))
    validate_failure_mode(failure_mode)
    gap_key = record.get("capability_gap_key")
    if not isinstance(gap_key, str) or not gap_key:
        ref = refs[0]
        gap_key = capability_gap_key(infer_surface(ref), failure_mode, infer_parser_kind(ref))
    event = dict(record)
    legacy_ids = list(event.get("legacy_event_ids") or [])
    existing_id = event.get("event_id")
    if isinstance(existing_id, str) and existing_id.startswith("FB-") and event.get("schema_version") != 2:
        legacy_ids.append(existing_id)
    identity = {
        "kind": event["kind"],
        "source": source,
        "capability_gap_key": gap_key,
        "refs": refs,
        "summary": event.get("summary", ""),
    }
    event.update(
        {
            "$schema": "aria/feedback-event/v2",
            "event_id": _stable_event_id("FB", f"{event['kind']}-{gap_key}", identity),
            "cycle_id": cycle_id if cycle_id is not None else event.get("cycle_id"),
            "source": source,
            "refs": refs,
            "capability_gap_key": gap_key,
            "trusted": bool(event.get("trusted", False)),
            "created_at": event.get("created_at") or now_iso(),
            "evidence_refs": event.get("evidence_refs") if isinstance(event.get("evidence_refs"), list) else [],
            "legacy_event_ids": sorted(dict.fromkeys(legacy_ids)),
            "schema_version": 2,
        },
    )
    return event


def pressure_evidence_fingerprint(primitive: str, subtype: str, feedback_event_ids: list[str]) -> str:
    raw = primitive + "\x1f" + subtype + "\x1f" + "\x1e".join(sorted(set(feedback_event_ids)))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _stable_event_id(prefix: str, slug_source: str, identity: dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"{prefix}-{slug(slug_source)[:48]}-{digest[:16]}"


def load_failure_modes() -> set[str]:
    try:
        resource = resources.files("aria_kernel.data").joinpath("default_failure_modes.json")
        payload = json.loads(resource.read_text(encoding="utf-8"))
    except (FileNotFoundError, ModuleNotFoundError):
        return set(FEEDBACK_KINDS)
    modes = payload.get("modes", [])
    return {str(item.get("id") if isinstance(item, dict) else item) for item in modes if item}


def validate_failure_mode(value: str) -> None:
    vocabulary = load_failure_modes()
    if value in vocabulary:
        return
    suggestions = get_close_matches(value, sorted(vocabulary), n=3, cutoff=0.6)
    suffix = f"; did you mean: {', '.join(suggestions)}" if suggestions else ""
    raise ValueError(f"unsupported failure mode: {value}{suffix}")
