from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, read_jsonl, write_index


@dataclass(frozen=True)
class WorkspacePaths:
    repo_root: Path
    workspace_root: Path
    memory_dir: Path
    state_dir: Path
    cycle_dir: Path
    feedback_index: Path
    identity_file: Path
    lock_file: Path
    ledgers: dict[str, Path]


def repo_hash(repo_root: Path) -> str:
    resolved = repo_root.resolve()
    remote = ""
    try:
        remote = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=resolved,
            text=True,
            capture_output=True,
            check=False,
        ).stdout.strip()
    except OSError:
        remote = ""
    return hashlib.sha256(f"{resolved}\n{remote}".encode("utf-8")).hexdigest()[:16]


def workspace_paths(repo_root: Path, workspace_base: Path | None = None) -> WorkspacePaths:
    base = workspace_base or Path.home() / ".aria" / "workspaces"
    root = base.expanduser().resolve() / repo_hash(repo_root)
    memory = root / "aria-memory"
    state = root / "aria-state"
    ledgers = {
        "unknowns": memory / "unknowns.jsonl",
        "missed_signals": memory / "missed_signals.jsonl",
        "external_feedback": memory / "external_feedback.jsonl",
        "pressure": memory / "pressure.jsonl",
        "governance": memory / "governance.jsonl",
    }
    return WorkspacePaths(
        repo_root=repo_root.resolve(),
        workspace_root=root,
        memory_dir=memory,
        state_dir=state,
        cycle_dir=state / "cycles",
        feedback_index=state / "integrity_index.json",
        identity_file=root / "repo_identity.json",
        lock_file=state / "feedback.lock",
        ledgers=ledgers,
    )


def ensure_workspace(paths: WorkspacePaths) -> None:
    repo_root = paths.repo_root.resolve()

    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    for ledger in paths.ledgers.values():
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.touch(exist_ok=True)

    identity = {
        "repo_root": str(repo_root),
        "repo_hash": paths.workspace_root.name,
        "aria_workspace_contract_version": 2,
        "schema_version": 2,
    }
    if paths.identity_file.exists():
        existing = json.loads(paths.identity_file.read_text(encoding="utf-8"))
        if existing.get("repo_hash") != identity["repo_hash"]:
            raise ValueError("ARIA workspace belongs to a different repository hash")
        if workspace_contract_version(paths) < 2:
            return
    else:
        paths.identity_file.write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        record_workspace_governance(paths, "workspace_root_bootstrapped", {"schema_from": None, "schema_to": 2})
    write_index(paths.feedback_index, _index_state(paths), paths.ledgers)


def workspace_contract_version(paths: WorkspacePaths) -> int:
    if not paths.identity_file.exists():
        return 0
    try:
        identity = json.loads(paths.identity_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return int(identity.get("aria_workspace_contract_version") or identity.get("schema_version") or 1)


def require_workspace_v2(paths: WorkspacePaths) -> None:
    version = workspace_contract_version(paths)
    if version < 2:
        raise RuntimeError("workspace_migration_required")


def record_workspace_governance(paths: WorkspacePaths, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    event = governance_event(kind=kind, details=details)
    stored = append_jsonl(paths.ledgers["governance"], event)
    if paths.feedback_index.exists():
        write_index(paths.feedback_index, _index_state(paths), paths.ledgers)
    return stored


def governance_event(kind: str, details: dict[str, Any]) -> dict[str, Any]:
    import os
    import socket
    from datetime import datetime, timezone

    ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    actor = {"kind": "agent", "id": os.environ.get("USER") or "codex"}
    canonical = {
        "actor": actor,
        "details": details,
        "kind": kind,
        "ts": ts,
    }
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    slug_prefix = kind.replace("_", "-")[:32] or "event"
    return {
        "$schema": "aria/governance-event/v2",
        "event_id": f"GE-{slug_prefix}-{digest[:16]}",
        "kind": kind,
        "actor": actor,
        "ts": ts,
        "details": details,
        "host": socket.gethostname(),
        "schema_version": 2,
    }


def _index_state(paths: WorkspacePaths) -> dict[str, Any]:
    current: dict[str, Any] = {}
    if paths.feedback_index.exists():
        try:
            current = json.loads(paths.feedback_index.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
    current.setdefault("pressure_keys_emitted", [])
    current.setdefault("pressure_evidence_fingerprints_emitted", _pressure_fingerprints(paths))
    return current


def _pressure_fingerprints(paths: WorkspacePaths) -> list[str]:
    rows = read_jsonl(paths.ledgers["pressure"])
    return sorted(
        str(row["evidence_fingerprint"])
        for row in rows
        if isinstance(row.get("evidence_fingerprint"), str) and row.get("evidence_fingerprint")
    )
