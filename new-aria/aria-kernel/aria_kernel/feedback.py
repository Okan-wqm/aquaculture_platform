from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
from difflib import get_close_matches
from importlib import resources
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    file_hash,
    load_index,
    read_jsonl,
    verify_index_hashes,
    write_index,
)
from .phase2_utils import git_head
from .pressure import close_pressures_from_signals
from .workspace import WorkspacePaths, record_workspace_governance, require_workspace_v2

FEEDBACK_KINDS = {
    "missed_signal",
    "false_positive",
    "confirmed_signal",
    "unknown_capability",
    "external_contradiction",
    "closed_signal",
}
FEEDBACK_SOURCES = {"self", "operator", "external_scanner", "ai_judge", "manual_audit"}
CLOSED_SIGNAL_EVIDENCE_PREFIXES = ("git:commit:", "github:PR:", "agent:", "manual:")
DEFAULT_FAILURE_MODE_BY_KIND = {
    "missed_signal": "evidence_gap",
    "false_positive": "framework_convention_false_positive",
    "confirmed_signal": "evidence_gap",
    "unknown_capability": "adapter_missing",
    "external_contradiction": "evidence_contradiction",
    "closed_signal": "evidence_gap",
}


_WORKSPACE_MEMORY_SURFACE_BY_FILENAME: dict[str, str] = {
    "unknowns.jsonl": "workspace_memory_unknowns",
    "missed_signals.jsonl": "workspace_memory_missed_signals",
    "external_feedback.jsonl": "workspace_memory_external_feedback",
    "pressure.jsonl": "workspace_memory_pressure",
    "pressure_state.jsonl": "workspace_memory_pressure_state",
    "vocabulary_rejections.jsonl": "workspace_memory_vocabulary_rejections",
    "since_migration_events.jsonl": "workspace_memory_since_migration_events",
    "governance.jsonl": "workspace_memory_governance",
}


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    concrete = Path(path)
    if concrete.parent.name == "aria-memory":
        surface = _WORKSPACE_MEMORY_SURFACE_BY_FILENAME.get(concrete.name)
        if surface is not None:
            return append_declared_jsonl(path, record, expected_surface=surface)
    return _append_jsonl(path, record)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    return re.sub(r"_+", "_", value).strip("_") or "unknown"


# ARIA v13 Phase-1: 4-tier surface resolution.
# Resolution order at call sites: operator --surface override > exact root-file > ordered prefix > "repo".
# The override is applied at the caller (build_feedback_event); this function handles tiers 2-4.
#
# Ordering policy: longest/most-specific prefix MUST appear first; iteration is in declared order, first match wins.
# Adding a new top-level subtree to the repo requires extending _SURFACE_PREFIXES and updating tests.
SURFACE_ROOT_FILE_GLOBS: tuple[tuple[str, str], ...] = (
    ("Dockerfile*", "infra"),
    ("docker-compose*.yml", "infra"),
    ("docker-compose*.yaml", "infra"),
)

SURFACE_PREFIXES: tuple[tuple[str, str], ...] = (
    ("platform/libs/", "platform"),
    ("libs/", "shared_lib"),
    ("aria-kernel/", "aria"),
    ("aria-tools/", "aria"),
    ("agents/", "agent_runtime"),
    ("agent-workspace/", "agent_runtime"),
    ("mcp/", "integration"),
    ("sens-api-gateway/", "edge"),
    ("tools/", "tooling"),
    ("scripts/", "tooling"),
    ("e2e/", "test"),
    ("tests/", "test"),
    ("infra/", "infra"),
    ("infrastructure/", "infra"),
    (".github/", "infra"),
    ("deploy/", "infra"),
    ("nginx/", "infra"),
    ("database/", "infra"),
    ("web/", "frontend"),
    ("apps/", "backend"),
)


def infer_surface(ref: str) -> str:
    # Strip ":line[:col]" suffix and a single leading "./" if present.
    # Use removeprefix rather than lstrip("./") so that paths starting with "."
    # (e.g. ".github/...") keep their leading dot.
    path = ref.split(":", 1)[0]
    if path.startswith("./"):
        path = path[2:]
    # Tier 2: exact root-file match — only one-segment paths (no "/") can match here.
    if "/" not in path:
        for pattern, surface in SURFACE_ROOT_FILE_GLOBS:
            if fnmatch.fnmatch(path, pattern):
                return surface
    # Tier 3: ordered prefix match.
    for prefix, surface in SURFACE_PREFIXES:
        if path.startswith(prefix):
            return surface
    # Tier 4: fallback bucket for genuinely unrecognised top-level paths.
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


def build_feedback_event(args: argparse.Namespace, cycle_id: str | None = None, paths: WorkspacePaths | None = None) -> dict[str, Any]:
    if args.kind not in FEEDBACK_KINDS:
        raise ValueError(f"unsupported feedback kind: {args.kind}")
    if args.source not in FEEDBACK_SOURCES:
        raise ValueError(f"unsupported feedback source: {args.source}")
    ref = args.ref
    surface = args.surface or infer_surface(ref)
    failure_mode = args.failure_mode or DEFAULT_FAILURE_MODE_BY_KIND[args.kind]
    parser_kind = args.parser_kind or infer_parser_kind(ref)
    validate_failure_mode(
        failure_mode,
        paths=paths,
        rejection_context={"refs": [ref], "surface": surface, "parser_kind": parser_kind},
    )
    gap_key = args.capability_gap_key or capability_gap_key(surface, failure_mode, parser_kind)
    evidence_refs = _normalize_evidence_refs(getattr(args, "evidence_ref", None))
    evidence_chain = _parse_evidence_chain_args(getattr(args, "evidence_chain", None))
    if args.kind == "closed_signal":
        _validate_closed_signal_evidence(evidence_refs)
    created_at = now_iso()
    identity = {
        "kind": args.kind,
        "source": args.source,
        "capability_gap_key": gap_key,
        "refs": [ref],
        "summary": args.summary,
        "evidence_refs": evidence_refs,
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
        "failure_mode": failure_mode,
        "evidence_refs": evidence_refs,
        "evidence_chain": evidence_chain,
        "observed_commit": git_head(paths.repo_root) if paths is not None else None,
        "legacy_event_ids": [],
        "trusted": False,
        "created_at": created_at,
        "schema_version": 2,
    }


def add_feedback(paths: WorkspacePaths, event: dict[str, Any]) -> list[dict[str, Any]]:
    require_workspace_v2(paths)
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    event = normalize_feedback_event(event, paths=paths)
    _record_normalization_drift(paths, [event])
    append_jsonl(paths.ledgers[ledger_name_for_kind(event["kind"])], event)
    index = load_index(paths.feedback_index)
    pressure = derive_pressure(paths, index)
    pressure.extend(close_pressures_from_signals(paths, cycle_id=event.get("cycle_id")))
    write_index(paths.feedback_index, index, paths.ledgers)
    return pressure


def import_feedback(paths: WorkspacePaths, source_file: Path, *, cycle_id: str | None = None) -> int:
    require_workspace_v2(paths)
    observed_commit = git_head(paths.repo_root)
    records = [
        normalize_feedback_event(record, cycle_id=cycle_id, paths=paths, observed_commit=observed_commit)
        for record in read_jsonl(source_file)
    ]
    index = verify_index_hashes(paths.feedback_index, paths.ledgers)
    _record_normalization_drift(paths, records)
    for record in records:
        append_jsonl(paths.ledgers[ledger_name_for_kind(record["kind"])], record)
    index = load_index(paths.feedback_index)
    derive_pressure(paths, index)
    close_pressures_from_signals(paths, cycle_id=cycle_id)
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
        pressure_items = [item for item in items if item.get("kind") != "closed_signal"]
        if not pressure_items:
            continue
        refs = sorted({ref for item in pressure_items for ref in item.get("refs", [])})
        kinds = {item.get("kind") for item in pressure_items}
        sources = {item.get("source") for item in pressure_items}

        candidates: list[tuple[str, str, list[str]]] = []
        unknown_count = sum(1 for item in pressure_items if item.get("kind") == "unknown_capability")
        missed_count = sum(1 for item in pressure_items if item.get("kind") == "missed_signal")
        false_positive_count = sum(1 for item in pressure_items if item.get("kind") == "false_positive")

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
            event_ids = sorted({str(item.get("event_id")) for item in pressure_items if item.get("event_id")})
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
                "evidence_refs": list(refs),
                "feedback_event_ids": event_ids,
                "legacy_feedback_event_ids": [
                    legacy_id
                    for item in pressure_items
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


def normalize_feedback_event(
    record: dict[str, Any],
    *,
    cycle_id: str | None = None,
    paths: WorkspacePaths | None = None,
    observed_commit: str | None = None,
) -> dict[str, Any]:
    if record.get("kind") not in FEEDBACK_KINDS:
        raise ValueError(f"unsupported feedback kind in import: {record.get('kind')}")
    source = record.get("source") or "operator"
    if source not in FEEDBACK_SOURCES:
        raise ValueError(f"unsupported feedback source in import: {source}")
    refs = record.get("refs") or ["unknown"]
    if not isinstance(refs, list):
        refs = [str(refs)]
    refs = [str(ref) for ref in refs if str(ref).strip()] or ["unknown"]
    evidence_refs = _normalize_evidence_refs(record.get("evidence_refs"))
    if record.get("kind") == "closed_signal":
        _validate_closed_signal_evidence(evidence_refs)
    gap_key = record.get("capability_gap_key")
    failure_mode = str(record.get("failure_mode") or _failure_mode_from_gap_key(gap_key) or DEFAULT_FAILURE_MODE_BY_KIND[str(record.get("kind"))])
    if not isinstance(gap_key, str) or not gap_key:
        ref = refs[0]
        surface = infer_surface(ref)
        parser_kind = infer_parser_kind(ref)
        gap_key = capability_gap_key(infer_surface(ref), failure_mode, infer_parser_kind(ref))
    else:
        surface = infer_surface(refs[0])
        parser_kind = infer_parser_kind(refs[0])
    validate_failure_mode(
        failure_mode,
        paths=paths,
        rejection_context={"refs": refs, "surface": surface, "parser_kind": parser_kind},
    )
    evidence_chain = _normalize_evidence_chain(record.get("evidence_chain", []))
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
        "evidence_refs": evidence_refs,
    }
    event.update(
        {
            "$schema": "aria/feedback-event/v2",
            "event_id": _stable_event_id("FB", f"{event['kind']}-{gap_key}", identity),
            "cycle_id": cycle_id if cycle_id is not None else event.get("cycle_id"),
            "source": source,
            "refs": refs,
            "capability_gap_key": gap_key,
            "failure_mode": failure_mode,
            "trusted": bool(event.get("trusted", False)),
            "created_at": event.get("created_at") or now_iso(),
            "evidence_refs": evidence_refs,
            "evidence_chain": evidence_chain,
            "observed_commit": event.get("observed_commit") if "observed_commit" in event else observed_commit,
            "legacy_event_ids": sorted(dict.fromkeys(legacy_ids)),
            "schema_version": 2,
        },
    )
    return event


def pressure_evidence_fingerprint(primitive: str, subtype: str, feedback_event_ids: list[str]) -> str:
    raw = primitive + "\x1f" + subtype + "\x1f" + "\x1e".join(sorted(set(feedback_event_ids)))
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _normalize_evidence_refs(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        value = [str(value)]
    return sorted(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))


def _validate_closed_signal_evidence(evidence_refs: list[str]) -> None:
    if not evidence_refs:
        raise ValueError("closed_signal_evidence_required")
    invalid = [
        ref
        for ref in evidence_refs
        if not any(ref.startswith(prefix) for prefix in CLOSED_SIGNAL_EVIDENCE_PREFIXES)
    ]
    if invalid:
        raise ValueError(f"closed_signal_evidence_invalid: {', '.join(invalid)}")


def _stable_event_id(prefix: str, slug_source: str, identity: dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"{prefix}-{slug(slug_source)[:48]}-{digest[:16]}"


def load_failure_modes(paths: WorkspacePaths | None = None) -> set[str]:
    modes, _metadata = load_failure_mode_vocabulary(paths)
    return modes


def load_failure_mode_vocabulary(paths: WorkspacePaths | None = None) -> tuple[set[str], dict[str, Any]]:
    try:
        resource = resources.files("aria_kernel.data").joinpath("default_failure_modes.json")
        payload = json.loads(resource.read_text(encoding="utf-8"))
    except (FileNotFoundError, ModuleNotFoundError):
        payload = {"$schema": "aria/failure-mode-vocab/v3", "modes": []}
    modes = _modes_from_payload(payload, ignore_feedback_kinds=False)
    metadata: dict[str, Any] = {
        "source": "embedded",
        "schema": payload.get("$schema"),
        "default_count": len(modes),
        "override_count": 0,
        "legacy_schema_detected": False,
    }
    if paths is None:
        return modes, metadata
    override_path = paths.workspace_root / "aria-config" / "failure_mode_vocabulary.json"
    if not override_path.exists():
        _record_vocabulary_loaded(paths, metadata, None)
        return modes, metadata
    override = json.loads(override_path.read_text(encoding="utf-8"))
    legacy = str(override.get("$schema") or "").endswith("/v2")
    override_modes = _modes_from_payload(override, ignore_feedback_kinds=legacy)
    merged = set(modes)
    merged.update(override_modes)
    metadata.update(
        {
            "source": "legacy-v2-tolerated" if legacy else "override-merged",
            "override_count": len(override_modes),
            "legacy_schema_detected": legacy,
        },
    )
    _record_vocabulary_loaded(paths, metadata, override_path)
    return merged, metadata


def validate_failure_mode(
    value: str,
    *,
    paths: WorkspacePaths | None = None,
    rejection_context: dict[str, Any] | None = None,
) -> None:
    vocabulary = load_failure_modes(paths)
    if value in vocabulary:
        return
    if paths is not None and rejection_context is not None:
        _record_vocabulary_rejection(paths, value, rejection_context)
    suggestions = get_close_matches(value, sorted(vocabulary), n=3, cutoff=0.4)
    suffix = f"; did you mean: {', '.join(suggestions)}" if suggestions else ""
    raise ValueError(f"unsupported failure mode: {value}{suffix}")


def _parse_evidence_chain_args(values: Any) -> list[dict[str, Any]]:
    if not values:
        return []
    parsed: list[dict[str, Any]] = []
    for value in values:
        try:
            item = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid evidence_chain JSON: {exc}") from exc
        parsed.append(item)
    return _normalize_evidence_chain(parsed)


def _normalize_evidence_chain(value: Any) -> list[dict[str, Any]]:
    if value in (None, ""):
        return []
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        raise ValueError("evidence_chain_must_be_array")
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("evidence_chain_entry_must_be_object")
        source_type = item.get("source_type")
        reference = item.get("reference")
        trust_level = item.get("trust_level")
        if source_type not in FEEDBACK_SOURCES:
            raise ValueError("evidence_chain_invalid_source_type")
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError("evidence_chain_reference_required")
        if trust_level not in {"low", "medium", "high"}:
            raise ValueError("evidence_chain_invalid_trust_level")
        normalized.append(
            {
                "source_type": source_type,
                "reference": reference.strip(),
                "trust_level": trust_level,
            },
        )
    return normalized


def _record_vocabulary_rejection(paths: WorkspacePaths, value: str, context: dict[str, Any]) -> None:
    refs = [str(ref) for ref in context.get("refs", []) if isinstance(ref, str) and _looks_like_workspace_ref(ref)]
    if not refs:
        return
    record = {
        "$schema": "aria/vocabulary-rejection/v1",
        "rejected_at": now_iso(),
        "failure_mode": value,
        "surface": str(context.get("surface") or infer_surface(refs[0])),
        "parser_kind": str(context.get("parser_kind") or infer_parser_kind(refs[0])),
        "refs": refs,
        "schema_version": 1,
    }
    append_jsonl(paths.ledgers["vocabulary_rejections"], record)
    _maybe_propose_vocabulary_extension(paths, record)


def _looks_like_workspace_ref(ref: str) -> bool:
    path = ref.split(":", 1)[0]
    return bool(path and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", path) and not Path(path).is_absolute())


def _maybe_propose_vocabulary_extension(paths: WorkspacePaths, rejection: dict[str, Any]) -> None:
    surface = rejection.get("surface")
    parser_kind = rejection.get("parser_kind")
    if not isinstance(surface, str) or not isinstance(parser_kind, str):
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)
    cluster = []
    for row in read_jsonl(paths.ledgers["vocabulary_rejections"]):
        if row.get("surface") != surface or row.get("parser_kind") != parser_kind:
            continue
        ts = str(row.get("rejected_at") or "")
        try:
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed.astimezone(timezone.utc) >= cutoff:
            cluster.append(row)
    if len(cluster) < 3:
        return
    details = {
        "surface": surface,
        "parser_kind": parser_kind,
        "rejection_count": len(cluster),
        "failure_modes": sorted({str(row.get("failure_mode")) for row in cluster if row.get("failure_mode")}),
    }
    for row in read_jsonl(paths.ledgers["governance"]):
        if row.get("kind") == "vocabulary_extension_proposed":
            existing = row.get("details", {})
            if existing.get("surface") == surface and existing.get("parser_kind") == parser_kind:
                return
    record_workspace_governance(paths, "vocabulary_extension_proposed", details)


def _modes_from_payload(payload: dict[str, Any], *, ignore_feedback_kinds: bool) -> set[str]:
    raw_modes = payload.get("modes", [])
    modes = {
        str(item.get("id") if isinstance(item, dict) else item)
        for item in raw_modes
        if item and str(item.get("id") if isinstance(item, dict) else item).strip()
    }
    if ignore_feedback_kinds:
        modes.difference_update(FEEDBACK_KINDS)
    return modes


def _failure_mode_from_gap_key(gap_key: Any) -> str | None:
    if not isinstance(gap_key, str):
        return None
    parts = gap_key.split(":")
    if len(parts) != 3:
        return None
    return parts[1] or None


def _record_vocabulary_loaded(paths: WorkspacePaths, metadata: dict[str, Any], override_path: Path | None) -> None:
    if not paths.feedback_index.exists():
        return
    marker = {
        "source": metadata.get("source"),
        "schema": metadata.get("schema"),
        "default_count": metadata.get("default_count"),
        "override_count": metadata.get("override_count"),
        "legacy_schema_detected": metadata.get("legacy_schema_detected", False),
        "override_hash": file_hash(override_path) if override_path is not None else None,
    }
    try:
        index = load_index(paths.feedback_index)
    except (OSError, ValueError, json.JSONDecodeError):
        return
    if index.get("failure_mode_vocabulary_loaded") == marker:
        return
    record_workspace_governance(paths, "vocabulary_loaded", marker)
    index = load_index(paths.feedback_index)
    index["failure_mode_vocabulary_loaded"] = marker
    write_index(paths.feedback_index, index, paths.ledgers)


def _record_normalization_drift(paths: WorkspacePaths, events: list[dict[str, Any]]) -> None:
    if not events:
        return
    existing = list_feedback_without_integrity(paths)
    drift_count = 0
    stored_gap_keys: set[str] = set()
    future_gap_keys: set[str] = set()
    for event in events:
        refs = set(str(ref) for ref in event.get("refs", []) if ref)
        if not refs:
            continue
        event_kind = event.get("kind")
        event_gap = event.get("capability_gap_key")
        for row in existing:
            if row.get("kind") != event_kind:
                continue
            row_refs = set(str(ref) for ref in row.get("refs", []) if ref)
            row_gap = row.get("capability_gap_key")
            if refs.intersection(row_refs) and isinstance(row_gap, str) and isinstance(event_gap, str) and row_gap != event_gap:
                drift_count += 1
                stored_gap_keys.add(row_gap)
                future_gap_keys.add(event_gap)
    if not drift_count:
        return
    record_workspace_governance(
        paths,
        "vocabulary_normalization_drift",
        {
            "drift_count": drift_count,
            "stored_gap_key_count": len(stored_gap_keys),
            "future_gap_key_count": len(future_gap_keys),
        },
    )
