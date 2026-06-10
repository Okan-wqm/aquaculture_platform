from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any

from aria_kernel.ledger import append_declared_jsonl, rewrite_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir


def init_test_tools_root(base_dir: str | Path) -> Path:
    """Create a root-bound aria-tools fixture directory."""
    return ensure_tools_dir(base_dir)


def append_declared_fixture(
    path: str | Path,
    record: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any]:
    if not expected_surface or not expected_surface.strip():
        raise AssertionError("expected_surface is required for declared fixtures")
    return append_declared_jsonl(
        Path(path),
        record,
        expected_surface=expected_surface,
        bypass_profile_gate=True,
    )


def rewrite_declared_fixture(
    path: str | Path,
    rows: list[dict[str, Any]],
    *,
    expected_surface: str,
    migration_id: str = "test-fixture-rewrite",
) -> None:
    if not expected_surface or not expected_surface.strip():
        raise AssertionError("expected_surface is required for declared fixtures")
    rewrite_declared_jsonl(
        Path(path),
        rows,
        expected_surface=expected_surface,
        migration_id=migration_id,
        bypass_profile_gate=True,
    )


def seed_repo_verified_evidence(repo: Path, files: dict[str, str]) -> str:
    """Seed files into a git repo and return the full target commit SHA."""
    for rel, content in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", *sorted(files)], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "fixture: repo verified evidence"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


def sha256_file(path: str | Path) -> str:
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()

