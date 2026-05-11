"""Plan 026R §D.1 — validation_runs.jsonl ledger + log_hash binding.

Pre-§D.1 ``validation_matrix_gate._check_run_pass_layer`` (Layer 3
of the validation matrix) accepted any structured ref shape with
``{cmd, exit_code, log_path, ran_at}`` fields. The ``log_path`` was
an OPAQUE pointer: nothing verified the file at that path existed,
matched any specific content, or was produced by a TRUSTED runner.
A planner submitting an attestation could fabricate a
``validation_run_ref`` pointing at any path with any text.

§D.1 closes the gap with three architectural pieces:

1. **NEW append-only ledger ``validation_runs.jsonl``** — records
   every executed validation command. Schema (Plan 026R §D.1):
   ``{validation_run_id, change_id, cmd, exit_code, log_hash,
   commit_sha, runner_identity, started_at, completed_at}``.
   Every field is REQUIRED at write time. ``log_hash`` is the
   sha256 of the log file content (content-addressed binding).

2. **Self-attestation reject** — ``runner_identity`` MUST be
   non-empty AND MUST differ from the change's author identity
   (the planner / agent that emitted the change_planned row).
   The runner is the EXECUTOR, not the planner — an attestation
   that the runner == planner is a self-attestation and rejected.

3. **`verify_validation_run(run_id, base_dir)`** — re-reads the log
   file at the stored log_path, recomputes the sha256, asserts
   equality with the stored log_hash. Mismatch raises
   ``GovernanceError`` so a tampered log file surfaces at gate time
   rather than silently passing the matrix gate.

The §D.4 auto-merge triple-gate consumes this ledger. The §D.5
no-risk evidence check requires AT LEAST one verified
validation_run_id ref under enforced mode + zero risk types.
"""
from __future__ import annotations

import hashlib
import secrets
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


VALIDATION_RUNS_FILENAME = "validation-runs.jsonl"


def _runs_path(root: Path) -> Path:
    return root / "validation" / VALIDATION_RUNS_FILENAME


def _hash_log_file(log_path: Path) -> str:
    """Return ``sha256:<hex>`` of the log file content."""
    if not log_path.exists() or not log_path.is_file():
        raise GovernanceError(
            f"validation_run_log_missing: {log_path.as_posix()}"
        )
    return "sha256:" + hashlib.sha256(log_path.read_bytes()).hexdigest()


def _allocate_validation_run_id() -> str:
    return f"vrun-{secrets.token_hex(8)}"


def record_validation_run(
    *,
    change_id: str,
    cmd: str,
    exit_code: int,
    log_path: str | Path,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    started_at: str,
    completed_at: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan 026R §D.1 — record an executed validation command on the
    append-only ``validation-runs.jsonl`` ledger.

    Required fields:

    * ``change_id`` — links to the change_ledger committed row.
    * ``cmd`` — exact command string executed.
    * ``exit_code`` — integer; only ``0`` (success) is a valid
      pass-layer reference but the ledger records ALL outcomes.
    * ``log_path`` — file on disk; content is hashed into
      ``log_hash`` at write time.
    * ``commit_sha`` — the commit_sha the runner executed against.
    * ``runner_identity`` — the executor's identity (e.g.
      ``ci-executor:gha-1234567``). MUST be non-empty.
    * ``started_at`` / ``completed_at`` — ISO 8601 timestamps.

    Self-attestation reject (Plan 026R §D.1 round-1 fix):

    If ``change_author_identity`` is provided AND equals
    ``runner_identity``, the call raises
    ``validation_run_self_attestation``. The runner is the
    EXECUTOR, not the planner — a self-attestation defeats the
    matrix gate's adversarial intent.
    """
    if not change_id or not change_id.strip():
        raise GovernanceError("validation_run_change_id_required")
    if not cmd or not cmd.strip():
        raise GovernanceError("validation_run_cmd_required")
    if not isinstance(exit_code, int):
        raise GovernanceError(
            f"validation_run_exit_code_must_be_int: got {type(exit_code).__name__}"
        )
    if not commit_sha or len(commit_sha) < 7:
        raise GovernanceError(
            f"validation_run_commit_sha_required: got {commit_sha!r}"
        )
    if not runner_identity or not runner_identity.strip():
        raise GovernanceError("validation_run_runner_identity_required")
    if (
        change_author_identity is not None
        and runner_identity == change_author_identity
    ):
        raise GovernanceError(
            f"validation_run_self_attestation: runner_identity "
            f"{runner_identity!r} == change_author_identity "
            f"{change_author_identity!r}; runner MUST differ from "
            f"the change's author (operator/agent that emitted "
            f"change_planned)"
        )
    log = Path(log_path)
    log_hash = _hash_log_file(log)
    row = {
        "$schema": "aria/validation-run/v1",
        "schema_version": 1,
        "validation_run_id": _allocate_validation_run_id(),
        "change_id": change_id,
        "cmd": cmd,
        "exit_code": exit_code,
        "log_path": log.as_posix(),
        "log_hash": log_hash,
        "commit_sha": commit_sha,
        "runner_identity": runner_identity,
        "started_at": started_at,
        "completed_at": completed_at,
        "recorded_at": utc_now(),
    }
    return append_jsonl(_runs_path(ensure_tools_dir(base_dir)), row)


def list_validation_runs(
    *, base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    return load_jsonl(_runs_path(ensure_tools_dir(base_dir)))


def find_validation_run_by_id(
    validation_run_id: str,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    for row in reversed(list_validation_runs(base_dir=base_dir)):
        if row.get("validation_run_id") == validation_run_id:
            return row
    return None


def verify_validation_run(
    validation_run_id: str,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Re-hash the log file + assert equality with the stored log_hash.

    Returns the verified row on success. Raises ``GovernanceError``
    on any of: row not found, log file missing, hash mismatch.
    """
    row = find_validation_run_by_id(validation_run_id, base_dir=base_dir)
    if row is None:
        raise GovernanceError(
            f"validation_run_not_found: {validation_run_id!r}"
        )
    stored_hash = row.get("log_hash")
    log_path = Path(row.get("log_path") or "")
    actual_hash = _hash_log_file(log_path)
    if actual_hash != stored_hash:
        raise GovernanceError(
            f"validation_run_log_hash_mismatch: "
            f"validation_run_id={validation_run_id!r} "
            f"stored={stored_hash!r} actual={actual_hash!r}"
        )
    return row


def list_validation_runs_for_change(
    change_id: str,
    *,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    return [
        row for row in list_validation_runs(base_dir=base_dir)
        if row.get("change_id") == change_id
    ]


__all__ = [
    "VALIDATION_RUNS_FILENAME",
    "find_validation_run_by_id",
    "list_validation_runs",
    "list_validation_runs_for_change",
    "record_validation_run",
    "verify_validation_run",
]
