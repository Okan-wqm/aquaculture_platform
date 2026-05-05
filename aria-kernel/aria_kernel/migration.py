from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .feedback import normalize_feedback_event, pressure_evidence_fingerprint, slug
from .ledger import read_jsonl, rewrite_jsonl, write_index
from .tool_registry import covered_tool_ledgers, ensure_tools_binding, update_tools_index
from .workspace import WorkspacePaths, record_workspace_governance, repo_hash, workspace_paths


def migrate_workspace_v1_to_v2(
    *,
    workspace_root: str | Path,
    workspace_base: str | Path | None = None,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("migration requires --acknowledge and --reason")
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    backup = _backup_dir(paths.workspace_root, "workspace-v1")
    if paths.workspace_root.exists() and not backup.exists():
        shutil.copytree(paths.workspace_root, backup)
    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    _migrate_workspace_ledgers(paths)
    identity = {
        "aria_workspace_contract_version": 2,
        "repo_hash": repo_hash(Path(workspace_root)),
        "repo_root": str(Path(workspace_root).resolve()),
        "schema_version": 2,
    }
    paths.identity_file.write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_index(paths.feedback_index, {"pressure_evidence_fingerprints_emitted": _pressure_fingerprints(paths)}, paths.ledgers)
    record_workspace_governance(paths, "migration_completed", {"schema_from": 1, "schema_to": 2, "phase": "workspace", "reason": reason})
    state = {"schema_version": 2, "migration": "workspace_v1_to_v2", "backup_path": backup.as_posix(), "completed_at": _now()}
    (paths.workspace_root / "migration_state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return state


def rollback_workspace_v2_to_v1(
    *,
    workspace_root: str | Path,
    workspace_base: str | Path | None = None,
    from_backup: str | Path,
    acknowledge: bool,
    reason: str,
    force_discard_since_migration: bool = False,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("rollback requires --acknowledge and --reason")
    paths = workspace_paths(Path(workspace_root), Path(workspace_base) if workspace_base else None)
    backup = Path(from_backup)
    _guard_post_migration_rows(paths.ledgers, backup / "aria-memory", force_discard_since_migration)
    if paths.workspace_root.exists():
        shutil.rmtree(paths.workspace_root)
    shutil.copytree(backup, paths.workspace_root)
    return {"schema_version": 2, "rollback": "workspace_v2_to_v1", "from_backup": backup.as_posix(), "force_discard": force_discard_since_migration}


def migrate_tools_v1_to_v2(
    *,
    tools_dir: str | Path,
    workspace_root: str | Path,
    acknowledge: bool,
    reason: str,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("tools migration requires --acknowledge and --reason")
    root = Path(tools_dir)
    backup = _backup_dir(root, "tools-v1")
    if root.exists() and not backup.exists():
        shutil.copytree(root, backup)
    root = ensure_tools_binding(root, workspace_root=workspace_root)
    for path in covered_tool_ledgers(root).values():
        rows = [_restamp(row) for row in read_jsonl(path)]
        rewrite_jsonl(path, rows)
    identity = {
        "aria_tools_contract_version": 2,
        "bound_repo_hash": repo_hash(Path(workspace_root)),
        "bound_repo_root": str(Path(workspace_root).resolve()),
        "schema_version": 2,
    }
    (root / "repo_identity.json").write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    update_tools_index(root)
    state = {"schema_version": 2, "migration": "tools_v1_to_v2", "backup_path": backup.as_posix(), "completed_at": _now()}
    (root / "migration_state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return state


def rollback_tools_v2_to_v1(
    *,
    tools_dir: str | Path,
    from_backup: str | Path,
    acknowledge: bool,
    reason: str,
    force_discard_since_migration: bool = False,
) -> dict[str, Any]:
    if not acknowledge or not reason.strip():
        raise ValueError("tools rollback requires --acknowledge and --reason")
    root = Path(tools_dir)
    backup = Path(from_backup)
    _guard_post_migration_rows(covered_tool_ledgers(root), backup, force_discard_since_migration)
    if force_discard_since_migration:
        _write_since_migration(root, backup)
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(backup, root)
    return {"schema_version": 2, "rollback": "tools_v2_to_v1", "from_backup": backup.as_posix(), "force_discard": force_discard_since_migration}


def _migrate_workspace_ledgers(paths: WorkspacePaths) -> None:
    for name in ("unknowns", "missed_signals", "external_feedback"):
        path = paths.ledgers[name]
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [normalize_feedback_event(row) for row in read_jsonl(path)]
        rewrite_jsonl(path, rows)
    pressure_rows = []
    id_map = _legacy_feedback_id_map(paths)
    for row in read_jsonl(paths.ledgers["pressure"]):
        migrated = _restamp(row)
        migrated["$schema"] = "aria/pressure-event/v2"
        migrated["schema_version"] = 2
        legacy_ids = [str(item) for item in row.get("feedback_event_ids", []) if isinstance(item, str)]
        feedback_ids = sorted(id_map.get(item, item) for item in legacy_ids)
        migrated["feedback_event_ids"] = feedback_ids
        migrated["legacy_feedback_event_ids"] = legacy_ids
        migrated["legacy_event_ids"] = [row["event_id"]] if isinstance(row.get("event_id"), str) else []
        primitive = str(migrated.get("primitive") or migrated.get("type") or "UNKNOWN")
        subtype = str(migrated.get("subtype") or "legacy")
        migrated["evidence_fingerprint"] = pressure_evidence_fingerprint(primitive, subtype, feedback_ids)
        pressure_rows.append(migrated)
    rewrite_jsonl(paths.ledgers["pressure"], pressure_rows)
    paths.ledgers["governance"].parent.mkdir(parents=True, exist_ok=True)
    paths.ledgers["governance"].touch(exist_ok=True)


def _legacy_feedback_id_map(paths: WorkspacePaths) -> dict[str, str]:
    result = {}
    for name in ("unknowns", "missed_signals", "external_feedback"):
        for row in read_jsonl(paths.ledgers[name]):
            for legacy in row.get("legacy_event_ids", []):
                result[str(legacy)] = str(row.get("event_id"))
    return result


def _pressure_fingerprints(paths: WorkspacePaths) -> list[str]:
    return sorted(
        str(row["evidence_fingerprint"])
        for row in read_jsonl(paths.ledgers["pressure"])
        if isinstance(row.get("evidence_fingerprint"), str)
    )


def _restamp(row: dict[str, Any]) -> dict[str, Any]:
    migrated = dict(row)
    if int(migrated.get("schema_version") or 0) < 2:
        migrated["schema_version"] = 2
    return migrated


def _backup_dir(root: Path, label: str) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root.parent / f"{root.name}.backup.{label}.{ts}"


def _guard_post_migration_rows(current: dict[str, Path], backup_root: Path, force: bool) -> None:
    if force:
        return
    for name, path in current.items():
        backup_path = backup_root / path.name
        if backup_root.name != "aria-memory":
            backup_path = backup_root / path.relative_to(path.parent)
        if len(read_jsonl(path)) > len(read_jsonl(backup_path)):
            raise ValueError(f"post_migration_rows_present:{name}")


def _write_since_migration(root: Path, backup: Path) -> None:
    rows = []
    for name, path in covered_tool_ledgers(root).items():
        backup_path = backup / path.name
        rows.extend({"ledger": name, "row": row} for row in read_jsonl(path)[len(read_jsonl(backup_path)) :])
    rewrite_jsonl(root / "since_migration_events.jsonl", rows)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()
