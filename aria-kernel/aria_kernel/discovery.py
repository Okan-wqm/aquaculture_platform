from __future__ import annotations

import hashlib
import json
import os
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

from .tool_registry import ensure_tools_dir, utc_now


FORBIDDEN_PREFIXES = ("agent-workspace/", "aria-tools/", ".aria-poc/")
GENERATED_PREFIXES = ("dist/", "coverage/", ".nx/cache/", "node_modules/")
GENERATED_PARTS = ("/dist/", "/coverage/", "/.nx/cache/", "/node_modules/")


def run_discovery(
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    tracked_files = _tracked_files(root)
    fates = [_file_fate(root, path) for path in tracked_files]
    missing = [fate["path"] for fate in fates if fate["fate"] == "unknown"]
    fingerprint = _repo_fingerprint(root, fates)
    service_map = _service_map(root)
    commit_sha = _git_rev_parse(root, "HEAD")
    repo_state_id = _repo_state_id(commit_sha, fates)
    completion_proof = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "generated_at": utc_now(),
        "base_commit_sha": commit_sha,
        "repo_state_id": repo_state_id,
        "tracked_file_count": len(tracked_files),
        "fated_file_count": len(fates),
        "unknown_count": len(missing),
        "missing_fates": missing,
        "complete": len(tracked_files) == len(fates) and not missing,
    }

    output_dir = ensure_tools_dir(base_dir) / "discovery" / cycle_id
    _write_json(output_dir / "FATES.json", {"schema_version": 1, "cycle_id": cycle_id, "files": fates})
    _write_json(output_dir / "REPO_FINGERPRINT.json", fingerprint)
    _write_json(output_dir / "SERVICE_MAP.json", service_map)
    _write_json(output_dir / "COMPLETION_PROOF.json", completion_proof)
    return {
        "fates": fates,
        "fingerprint": fingerprint,
        "service_map": service_map,
        "completion_proof": completion_proof,
        "artifact_dir": output_dir.as_posix(),
    }


def _tracked_files(root: Path) -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode == 0:
        return sorted(path for path in completed.stdout.splitlines() if path)
    files: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".git/"):
            continue
        files.append(rel)
    return sorted(files)


def _git_rev_parse(root: Path, ref: str) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", ref],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None


def _repo_state_id(commit_sha: str | None, fates: list[dict[str, Any]]) -> str:
    content = {
        "commit_sha": commit_sha,
        "files": [(row.get("path"), row.get("content_hash")) for row in fates],
    }
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"repo-state:{digest}"


def _file_fate(root: Path, relative_path: str) -> dict[str, Any]:
    fate = "tracked"
    if relative_path.startswith(FORBIDDEN_PREFIXES):
        fate = "forbidden"
    elif relative_path.startswith(GENERATED_PREFIXES) or any(part in relative_path for part in GENERATED_PARTS):
        fate = "generated"
    path = root / relative_path
    row: dict[str, Any] = {
        "path": relative_path,
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


def _repo_fingerprint(root: Path, fates: list[dict[str, Any]]) -> dict[str, Any]:
    language_histogram = Counter(str(fate.get("suffix") or "<none>") for fate in fates)
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "tracked_file_count": len(fates),
        "language_histogram": dict(sorted(language_histogram.items())),
        "service_count": len(_children(root / "apps")),
        "web_module_count": len(_children(root / "web")),
        "platform_lib_count": len(_children(root / "platform/libs")),
        "shared_lib_count": len(_children(root / "libs")),
        "adr_count": len(list((root / "docs/adr").glob("*.md"))) if (root / "docs/adr").exists() else 0,
        "migration_count": len(list(root.glob("apps/*/src/database/migrations/*.ts"))),
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


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()
