from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkspacePaths:
    repo_root: Path
    workspace_root: Path
    memory_dir: Path
    state_dir: Path
    cycle_dir: Path
    feedback_index: Path
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
    }
    return WorkspacePaths(
        repo_root=repo_root.resolve(),
        workspace_root=root,
        memory_dir=memory,
        state_dir=state,
        cycle_dir=state / "cycles",
        feedback_index=state / "feedback_index.json",
        ledgers=ledgers,
    )


def ensure_workspace(paths: WorkspacePaths) -> None:
    repo_root = paths.repo_root.resolve()
    workspace_root = paths.workspace_root.resolve()
    if workspace_root == repo_root or repo_root in workspace_root.parents:
        raise ValueError("ARIA workspace must not live inside the repository")

    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    for ledger in paths.ledgers.values():
        ledger.touch(exist_ok=True)

    identity_file = paths.workspace_root / "repo_identity.json"
    identity = {
        "repo_root": str(repo_root),
        "repo_hash": paths.workspace_root.name,
        "schema_version": 1,
    }
    if identity_file.exists():
        existing = json.loads(identity_file.read_text(encoding="utf-8"))
        if existing.get("repo_hash") != identity["repo_hash"]:
            raise ValueError("ARIA workspace belongs to a different repository hash")
    else:
        identity_file.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
