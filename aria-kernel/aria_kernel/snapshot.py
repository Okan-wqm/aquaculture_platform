from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, utc_now


SNAPSHOT_MODES = ("committed", "working-tree")
DIRTY_IGNORE_PREFIXES = (
    "aria-tools/",
    "aria-kernel/aria_kernel/__pycache__/",
    "aria-kernel/tests/__pycache__/",
    "aria-kernel/.pytest_cache/",
    ".nx/cache/",
    "node_modules/",
)
DIRTY_IGNORE_EXACT = {
    "aria-kernel/aria_kernel.egg-info/",
}
GENERATED_PREFIXES = ("dist/", "coverage/", ".nx/cache/", "node_modules/")
GENERATED_PARTS = ("/dist/", "/coverage/", "/.nx/cache/", "/node_modules/")


def build_repo_snapshot(
    *,
    workspace_root: str | os.PathLike[str],
    mode: str = "committed",
    enforce_clean: bool = False,
) -> dict[str, Any]:
    if mode not in SNAPSHOT_MODES:
        raise GovernanceError(f"unknown snapshot mode: {mode}")
    root = Path(workspace_root).resolve()
    git_available = _git_available(root)
    dirty_paths = _dirty_paths(root) if git_available else []
    dirty_blockers = [path for path in dirty_paths if not ignored_dirty_path(path)]
    if mode == "committed" and enforce_clean and dirty_blockers:
        raise GovernanceError(f"workspace_dirty_blocked: {', '.join(dirty_blockers[:20])}")

    if git_available:
        tracked = _git_lines(root, ["ls-files"])
        paths = tracked
        if mode == "working-tree":
            paths = sorted(set(tracked + _git_lines(root, ["ls-files", "--others", "--exclude-standard"])))
    else:
        paths = _filesystem_paths(root)

    fates = [_file_fate(root, path) for path in paths]
    allowed_paths = sorted(row["path"] for row in fates if row.get("fate") == "tracked")
    snapshot = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "snapshot_mode": mode,
        "dirty_snapshot": mode == "working-tree" and bool(dirty_blockers),
        "base_commit_sha": _git_rev_parse(root, "HEAD") if git_available else None,
        "tracked_file_count": len([row for row in fates if row.get("fate") == "tracked"]),
        "allowed_paths": allowed_paths,
        "dirty_paths": dirty_blockers,
        "generated_paths": sorted(row["path"] for row in fates if row.get("fate") == "generated"),
        "fates": fates,
    }
    snapshot["snapshot_hash"] = _snapshot_hash(snapshot)
    snapshot["repo_state_id"] = _repo_state_id(snapshot)
    return snapshot


def snapshot_allowed_set(snapshot: dict[str, Any] | None) -> set[str]:
    if not isinstance(snapshot, dict):
        return set()
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return set()
    return {normalize_path(path) for path in allowed if isinstance(path, str) and path.strip()}


def normalize_path(raw_path: Any) -> str:
    path = str(raw_path).replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def _git_available(root: Path) -> bool:
    return _run_git(root, ["rev-parse", "--is-inside-work-tree"]).returncode == 0


def _git_lines(root: Path, args: list[str]) -> list[str]:
    completed = _run_git(root, args)
    if completed.returncode != 0:
        return []
    return sorted(path for path in completed.stdout.splitlines() if path)


def _git_rev_parse(root: Path, ref: str) -> str | None:
    completed = _run_git(root, ["rev-parse", ref])
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def _dirty_paths(root: Path) -> list[str]:
    completed = _run_git(root, ["status", "--porcelain", "-z", "--untracked-files=all"])
    if completed.returncode != 0:
        return []
    entries = [entry for entry in completed.stdout.split("\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:
            skip_next = False
            continue
        status = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry
        if status.startswith("R") or status.startswith("C"):
            skip_next = True
        if path:
            paths.append(normalize_path(path))
    return sorted(set(paths))


def ignored_dirty_path(path: str) -> bool:
    normalized = normalize_path(path)
    return normalized in DIRTY_IGNORE_EXACT or any(normalized.startswith(prefix) for prefix in DIRTY_IGNORE_PREFIXES)


def _run_git(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)


def _filesystem_paths(root: Path) -> list[str]:
    paths: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".git/"):
            continue
        paths.append(rel)
    return sorted(paths)


def _file_fate(root: Path, relative_path: str) -> dict[str, Any]:
    normalized = normalize_path(relative_path)
    fate = "tracked"
    if normalized.startswith(GENERATED_PREFIXES) or any(part in normalized for part in GENERATED_PARTS):
        fate = "generated"
    path = root / normalized
    row: dict[str, Any] = {
        "path": normalized,
        "fate": fate,
        "suffix": path.suffix,
    }
    if path.exists() and path.is_file():
        try:
            row["size_bytes"] = path.stat().st_size
            row["content_hash"] = _sha256(path.read_bytes())
        except OSError:
            row["fate"] = "unknown"
            row["error"] = "stat_or_read_failed"
    return row


def _snapshot_hash(snapshot: dict[str, Any]) -> str:
    stable = {
        "mode": snapshot.get("snapshot_mode"),
        "base_commit_sha": snapshot.get("base_commit_sha"),
        "files": [(row.get("path"), row.get("content_hash")) for row in snapshot.get("fates", [])],
    }
    return _sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _repo_state_id(snapshot: dict[str, Any]) -> str:
    digest = hashlib.sha256(str(snapshot["snapshot_hash"]).encode("utf-8")).hexdigest()
    return f"repo-state:{digest}"


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
