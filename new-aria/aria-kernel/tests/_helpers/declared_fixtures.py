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


def seed_validation_provenance(
    *,
    workspace_root: str | Path,
    base_dir: str | Path,
    plan_id: str = "plan-fixture",
    finding_id: str = "F-fixture",
    affected_files: list[str] | None = None,
) -> tuple[str, str]:
    """E21-a — emit the change chain a validation run must bind to.

    ``run_validation_commands`` resolves ``change_id`` against the change
    ledger and ``commit_sha`` against the workspace repository, so a test
    that wants to record a validation run needs both to be REAL. Returns
    ``(change_id, commit_sha)``.
    """
    from aria_kernel.change_ledger import (
        emit_change_committed,
        emit_change_planned,
    )

    repo = Path(workspace_root)
    commit_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repo, text=True,
    ).strip()
    files = affected_files or ["fixture.txt"]
    planned = emit_change_planned(
        plan_id=plan_id,
        finding_id=finding_id,
        intended_affected_files=files,
        intended_validation_refs=["python3 -m unittest --help"],
        architectural_tier=1,
        base_dir=base_dir,
    )
    change_id = str(planned["change_id"])
    emit_change_committed(
        change_id=change_id,
        commit_sha=commit_sha,
        actual_affected_files=files,
        base_dir=base_dir,
    )
    return change_id, commit_sha
