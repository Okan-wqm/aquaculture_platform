from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from aria_kernel.ledger import append_declared_jsonl, rewrite_declared_jsonl, segment_paths
from aria_kernel.state_manifest import memory_surfaces
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
    """Rewrite a NON-memory declared ledger through the kernel writer.

    A memory-class surface (``state_manifest.memory_surfaces()``) is
    append-only: the writer refuses any rewrite that changes a recorded row
    (``memory_class.refuse_history_rewrite``). A fixture that reaches for
    this helper on one is building its state the wrong way round, so it is
    refused here by name, before the kernel's refusal surfaces as an
    unrelated ``LedgerIntegrityError`` deep in the test. Build the state by
    appending rows in their final order (``append_declared_fixture``), or —
    for a tamper/loss the gates must catch — write the bytes out of band
    (``rewrite_declared_out_of_band``).
    """
    if not expected_surface or not expected_surface.strip():
        raise AssertionError("expected_surface is required for declared fixtures")
    if expected_surface in {surface.name for surface in memory_surfaces()}:
        raise AssertionError(
            f"rewrite_declared_fixture: surface {expected_surface!r} is memory-class and append-only; "
            "build the fixture with append_declared_fixture in its final row order, or simulate a "
            "tamper/loss with rewrite_declared_out_of_band (a direct filesystem write)"
        )
    rewrite_declared_jsonl(
        Path(path),
        rows,
        expected_surface=expected_surface,
        migration_id=migration_id,
        bypass_profile_gate=True,
    )


def rewrite_declared_out_of_band(
    path: str | Path,
    rows: list[dict[str, Any]],
    *,
    expected_surface: str,
) -> None:
    """Re-chain ``rows`` and write the bytes directly, bypassing the writer.

    The out-of-band half of the memory fixtures: the kernel's writer refuses
    a rewrite that changes a recorded memory row (``memory_class``, tier 1),
    so a fixture that simulates the loss the PUBLISH and SNAPSHOT gates
    exist to catch — the 01f37e939 manual reset, a runner rebuild — must
    produce the tree the way those losses actually arrived: bytes on disk,
    never a kernel call. The rows are re-chained exactly as
    ``_rewrite_jsonl_unlocked`` would, so the snapshot's chain verification
    sees a valid, shrunken or rewritten ledger rather than a corrupt one.
    """
    if not expected_surface or not expected_surface.strip():
        raise AssertionError("expected_surface is required for declared fixtures")
    from aria_kernel.ledger import _record_hash

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    previous: str | None = None
    lines = []
    for row in rows:
        stored = dict(row)
        stored["previous_ledger_hash"] = previous
        stored["ledger_hash"] = _record_hash(stored, previous)
        previous = stored["ledger_hash"]
        lines.append(json.dumps(stored, sort_keys=True, separators=(",", ":")))
    target.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


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


def segmented_ledger_bytes(tools: str | Path, surface: str) -> bytes:
    """Every file of a segmented ledger (ARIA-HIGH-275) in chain order: what a
    "nothing was appended" assertion compares, since rows land in segments."""
    return b"".join(path.read_bytes() for path in segment_paths(tools, surface))


def native_invocation_bytes(tools: str | Path) -> dict[str, bytes]:
    """The request, context and prompt ledgers a sealed native mint wrote."""
    return {
        "requests": segmented_ledger_bytes(tools, "agent_invocation_requests"),
        "contexts": (Path(tools) / "agent-invocations" / "contexts.jsonl").read_bytes(),
        "prompts": segmented_ledger_bytes(tools, "agent_invocation_prompts"),
    }


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
