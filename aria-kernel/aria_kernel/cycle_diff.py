from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .snapshot import file_counts_from_payload
from .tool_registry import ensure_tools_dir, utc_now


FINGERPRINT_FIELDS = (
    "tracked_file_count",
    "service_count",
    "web_module_count",
    "platform_lib_count",
    "shared_lib_count",
    "adr_count",
    "migration_count",
)
FILE_COUNT_FIELDS = ("git_tracked", "working_tree", "allowed", "generated", "unknown", "fated")


def run_cycle_diff(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    current_dir = root / "discovery" / cycle_id
    current_fates = _load_fates(current_dir)
    current_fingerprint = _read_json(current_dir / "REPO_FINGERPRINT.json")
    previous_cycle_id = _previous_discovery_cycle(root, cycle_id)
    previous_fates = _load_fates(root / "discovery" / previous_cycle_id) if previous_cycle_id else {}
    previous_fingerprint = (
        _read_json(root / "discovery" / previous_cycle_id / "REPO_FINGERPRINT.json") if previous_cycle_id else {}
    )
    current_file_counts = file_counts_from_payload(current_fingerprint, fallback_fated=len(current_fates))
    previous_file_counts = file_counts_from_payload(previous_fingerprint, fallback_fated=len(previous_fates)) if previous_cycle_id else {}

    added = sorted(path for path in current_fates if path not in previous_fates) if previous_cycle_id else []
    removed = sorted(path for path in previous_fates if path not in current_fates) if previous_cycle_id else []
    changed = (
        sorted(
            path
            for path, current in current_fates.items()
            if path in previous_fates
            and current.get("content_hash") != previous_fates[path].get("content_hash")
        )
        if previous_cycle_id
        else []
    )
    payload = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "cycle_id": cycle_id,
        "previous_cycle_id": previous_cycle_id,
        "baseline": previous_cycle_id is None,
        "summary": {
            "added_count": len(added),
            "removed_count": len(removed),
            "changed_count": len(changed),
            "file_counts": current_file_counts,
            "tracked_file_count": len(current_fates),
            "legacy_tracked_file_count": len(current_fates),
            "fated_file_count": len(current_fates),
        },
        "fingerprint_delta": _fingerprint_delta(current_fingerprint, previous_fingerprint),
        "file_counts_delta": _file_counts_delta(current_file_counts, previous_file_counts),
        "added_paths": added,
        "removed_paths": removed,
        "changed_paths": changed,
    }
    output_path = root / "cycle-diff" / f"{cycle_id}.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    append_declared_jsonl(root / "cycle-diffs.jsonl", payload, expected_surface="cycle_diffs")
    return payload


def _previous_discovery_cycle(root: Path, cycle_id: str) -> str | None:
    discovery_root = root / "discovery"
    if not discovery_root.exists():
        return None
    cycles = sorted(path.name for path in discovery_root.iterdir() if path.is_dir() and path.name != cycle_id)
    if not cycles:
        return None
    prior = [candidate for candidate in cycles if candidate < cycle_id]
    return (prior or cycles)[-1]


def _load_fates(discovery_dir: Path) -> dict[str, dict[str, Any]]:
    payload = _read_json(discovery_dir / "FATES.json")
    files = payload.get("files", [])
    if not isinstance(files, list):
        return {}
    return {
        str(row.get("path")): row
        for row in files
        if isinstance(row, dict) and isinstance(row.get("path"), str)
    }


def _fingerprint_delta(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, int]:
    if not previous:
        delta = {field: 0 for field in FINGERPRINT_FIELDS}
        delta["file_counts"] = {field: 0 for field in FILE_COUNT_FIELDS}
        return delta
    delta = {}
    for field in FINGERPRINT_FIELDS:
        current_value = current.get(field, 0)
        previous_value = previous.get(field, 0)
        delta[field] = _as_int(current_value) - _as_int(previous_value)
    delta["file_counts"] = _file_counts_delta(
        file_counts_from_payload(current),
        file_counts_from_payload(previous),
    )
    return delta


def _file_counts_delta(current: dict[str, int], previous: dict[str, int]) -> dict[str, int]:
    if not previous:
        return {field: 0 for field in FILE_COUNT_FIELDS}
    return {field: _as_int(current.get(field)) - _as_int(previous.get(field)) for field in FILE_COUNT_FIELDS}


def _as_int(value: Any) -> int:
    return value if isinstance(value, int) else 0


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}
