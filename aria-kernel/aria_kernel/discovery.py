from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

from .snapshot import build_repo_snapshot
from .tool_registry import ensure_tools_dir, utc_now


def run_discovery(
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
    snapshot_mode: str = "committed",
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    snapshot = build_repo_snapshot(workspace_root=root, mode=snapshot_mode, enforce_clean=True)
    fates = snapshot["fates"]
    missing = [fate["path"] for fate in fates if fate["fate"] == "unknown"]
    file_counts = snapshot["file_counts"]
    legacy_tracked_file_count = file_counts["allowed"]
    fingerprint = _repo_fingerprint(root, fates, file_counts)
    service_map = _service_map(root)
    completion_proof = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "generated_at": utc_now(),
        "base_commit_sha": snapshot.get("base_commit_sha"),
        "repo_state_id": snapshot.get("repo_state_id"),
        "snapshot_hash": snapshot.get("snapshot_hash"),
        "snapshot_mode": snapshot.get("snapshot_mode"),
        "dirty_snapshot": snapshot.get("dirty_snapshot", False),
        "dirty_path_count": len(snapshot.get("dirty_paths", [])),
        "file_counts": file_counts,
        "tracked_file_count": legacy_tracked_file_count,
        "legacy_tracked_file_count": legacy_tracked_file_count,
        "fated_file_count": file_counts["fated"],
        "unknown_count": file_counts["unknown"],
        "missing_fates": missing,
        "complete": len(snapshot.get("allowed_paths", [])) <= len(fates) and not missing,
    }

    output_dir = ensure_tools_dir(base_dir) / "discovery" / cycle_id
    _write_json(output_dir / "FATES.json", {"schema_version": 1, "cycle_id": cycle_id, "files": fates})
    _write_json(output_dir / "SNAPSHOT.json", {key: value for key, value in snapshot.items() if key != "fates"})
    _write_json(output_dir / "REPO_FINGERPRINT.json", fingerprint)
    _write_json(output_dir / "SERVICE_MAP.json", service_map)
    _write_json(output_dir / "COMPLETION_PROOF.json", completion_proof)
    return {
        "fates": fates,
        "fingerprint": fingerprint,
        "service_map": service_map,
        "completion_proof": completion_proof,
        "snapshot": {key: value for key, value in snapshot.items() if key != "fates"},
        "artifact_dir": output_dir.as_posix(),
    }


def _repo_fingerprint(root: Path, fates: list[dict[str, Any]], file_counts: dict[str, int]) -> dict[str, Any]:
    language_histogram = Counter(str(fate.get("suffix") or "<none>") for fate in fates)
    legacy_tracked_file_count = len(fates)
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "file_counts": file_counts,
        "tracked_file_count": legacy_tracked_file_count,
        "legacy_tracked_file_count": legacy_tracked_file_count,
        "fated_file_count": file_counts["fated"],
        "language_histogram": dict(sorted(language_histogram.items())),
        "service_count": len(_children(root / "apps")),
        "web_module_count": len(_children(root / "web")),
        "platform_lib_count": len(_children(root / "platform/libs")),
        "shared_lib_count": len(_children(root / "libs")),
        "adr_count": len(list((root / "docs/adr").glob("*.md"))) if (root / "docs/adr").exists() else 0,
        "migration_count": sum(1 for fate in fates if str(fate.get("path", "")).startswith("apps/") and "/src/database/migrations/" in str(fate.get("path", ""))),
        "has_nx": (root / "nx.json").exists(),
        "has_package_json": (root / "package.json").exists(),
    }


def _service_map(root: Path) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "apps": _project_rows(root, "apps"),
        "web": _project_rows(root, "web"),
        "platform_libs": _project_rows(root, "platform/libs"),
        "libs": _project_rows(root, "libs"),
    }


def _project_rows(root: Path, relative_dir: str) -> list[dict[str, Any]]:
    base = root / relative_dir
    rows = []
    for child in _children(base):
        rows.append(
            {
                "name": child.name,
                "path": child.relative_to(root).as_posix(),
                "has_project_json": (child / "project.json").exists(),
                "has_readme": (child / "README.md").exists(),
            },
        )
    return rows


def _children(path: Path) -> list[Path]:
    if not path.exists() or not path.is_dir():
        return []
    return sorted(child for child in path.iterdir() if child.is_dir())


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
