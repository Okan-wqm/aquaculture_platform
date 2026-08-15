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

E21-a — ONE surface, ONE writer, ONE schema
-------------------------------------------

Until E21-a the ``validation_runs`` surface had TWO writers with TWO
incompatible schemas: this module, and ``validation._run_one`` (Lane A),
which appended ``{status, duration_ms, stdout_hash, stderr_hash}`` rows
carrying NO ``change_id``, NO ``commit_sha`` and NO ``runner_identity``.
Both went through ``append_declared_jsonl(expected_surface=
"validation_runs")``, so the surface machinery could not tell them apart.
Two consequences, both live:

* ``observability`` counted every row whose ``status`` was not ``"ok"``
  as failed. Lane-B rows carry no ``status``, so EVERY row this module
  wrote was reported as a failure and contributed 0 ms of duration.
* the merge gate and the matrix gate read ``change_id``, which Lane-A
  rows never carried — so Lane A's evidence was structurally invisible
  to the two readers that decide whether a change may merge.

E21-a deletes the second writer. ``validation.run_validation_commands``
now records THROUGH ``record_validation_run``, and the unified required
core is derived from what the READERS need:

* merge gate / matrix gate → ``change_id``, ``exit_code``,
  ``commit_sha``, ``runner_identity``, ``log_path`` + ``log_hash``;
* observability → ``status`` and ``duration_ms``.

``status`` is DERIVED from ``exit_code``/``timed_out`` by
``derive_validation_run_status`` at write time, so no reader ever has to
guess again, and ``classify_validation_run_status`` REFUSES a row that
does not carry one rather than silently classifying it.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


VALIDATION_RUNS_FILENAME = "validation-runs.jsonl"

# E21-a — the unified row's ``$schema``. Bumped from v1 because the
# required core grew (status, duration_ms, timed_out) when Lane A's
# writer was folded in; a v1 row is a pre-unification row.
VALIDATION_RUN_SCHEMA = "aria/validation-run/v2"
VALIDATION_RUN_SCHEMA_VERSION = 2

# Closed status vocabulary. ``timeout`` is NOT ``failed``: a command the
# runner killed produced no exit code, and collapsing the two would let
# an infrastructure stall read as a code defect.
VALIDATION_RUN_STATUSES: tuple[str, ...] = ("ok", "failed", "timeout")

_COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{7,64}$")


def derive_validation_run_status(
    *, exit_code: int | None, timed_out: bool,
) -> str:
    """The ONE status rule for the ``validation_runs`` surface.

    Writers stamp it; readers read it. No reader re-derives, because a
    second derivation is a second schema.
    """
    if timed_out:
        return "timeout"
    if exit_code == 0:
        return "ok"
    return "failed"


def classify_validation_run_status(row: dict[str, Any]) -> str:
    """Read a row's status, REFUSING a row that does not carry one.

    The surface has exactly one writer and that writer always stamps
    ``status``, so a row without one is either pre-unification or
    tampered. Guessing (the pre-E21-a ``status not in ("ok",)``
    expression) reported every Lane-B row as a failure; defaulting the
    other way would report a genuine failure as success. Both are lies,
    so the reader refuses instead.
    """
    status = row.get("status")
    if isinstance(status, str) and status in VALIDATION_RUN_STATUSES:
        return status
    raise GovernanceError(
        f"validation_run_status_missing: validation_run_id="
        f"{row.get('validation_run_id')!r} carries status={status!r}; "
        f"the unified surface requires one of {VALIDATION_RUN_STATUSES}"
    )


def validation_run_duration_ms(row: dict[str, Any]) -> int:
    """Read a row's duration, REFUSING a row that does not carry one.

    Same reasoning as ``classify_validation_run_status``: the pre-E21-a
    dashboard coerced a missing ``duration_ms`` to 0, so half the runs
    silently contributed nothing to the reported total.
    """
    duration = row.get("duration_ms")
    if isinstance(duration, bool) or not isinstance(duration, int) or duration < 0:
        raise GovernanceError(
            f"validation_run_duration_missing: validation_run_id="
            f"{row.get('validation_run_id')!r} carries duration_ms="
            f"{duration!r}; the unified surface requires a non-negative int"
        )
    return duration


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


def validation_runs_path(base_dir: str | Path | None = None) -> Path:
    """The one declared path of the ``validation_runs`` surface."""
    return _runs_path(ensure_tools_dir(base_dir))


def validation_run_log_dir(base_dir: str | Path | None = None) -> Path:
    """Directory of the ``validation_run_logs`` declared artifact surface.

    The logs live under the tools root rather than a scratch directory
    because ``verify_validation_run`` re-reads them at gate time: a log
    written outside a declared surface is dropped at job teardown and
    the merge gate then blocks on a run it cannot verify.
    """
    directory = _runs_path(ensure_tools_dir(base_dir)).parent / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def record_validation_run(
    *,
    change_id: str,
    cmd: str,
    exit_code: int | None,
    duration_ms: int,
    log_path: str | Path,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    started_at: str,
    completed_at: str,
    timed_out: bool = False,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan 026R §D.1 — record an executed validation command on the
    append-only ``validation-runs.jsonl`` ledger.

    Required fields:

    * ``change_id`` — links to the change_ledger committed row.
    * ``cmd`` — exact command string executed.
    * ``exit_code`` — integer, or ``None`` EXACTLY when the run timed
      out (a killed process has no exit code). Only ``0`` is a valid
      pass-layer reference but the ledger records ALL outcomes.
    * ``duration_ms`` — non-negative wall-clock milliseconds. Required
      because the observability dashboard sums it; an absent value
      there used to silently coerce to 0.
    * ``log_path`` — file on disk; content is hashed into
      ``log_hash`` at write time.
    * ``commit_sha`` — the commit_sha the runner executed against.
      Must be lowercase hex (7-64 chars): a "sha" that is not a sha is
      a placeholder, and a placeholder is not provenance.
    * ``runner_identity`` — the executor's identity (e.g.
      ``ci-executor:gha-1234567``). MUST be non-empty.
    * ``started_at`` / ``completed_at`` — ISO 8601 timestamps.

    ``status`` is NOT a parameter: it is derived from
    ``exit_code``/``timed_out`` so the write side cannot disagree with
    the numbers it is stamping.

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
    if not isinstance(timed_out, bool):
        raise GovernanceError(
            f"validation_run_timed_out_must_be_bool: got "
            f"{type(timed_out).__name__}"
        )
    if timed_out:
        if exit_code is not None:
            raise GovernanceError(
                f"validation_run_timeout_exit_code_must_be_absent: a timed-out "
                f"run has no exit code, got {exit_code!r}"
            )
    elif isinstance(exit_code, bool) or not isinstance(exit_code, int):
        raise GovernanceError(
            f"validation_run_exit_code_must_be_int: got "
            f"{type(exit_code).__name__}"
        )
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or duration_ms < 0:
        raise GovernanceError(
            f"validation_run_duration_ms_required: expected a non-negative "
            f"int, got {duration_ms!r}"
        )
    if not commit_sha or len(commit_sha) < 7:
        raise GovernanceError(
            f"validation_run_commit_sha_required: got {commit_sha!r}"
        )
    if not _COMMIT_SHA_PATTERN.match(commit_sha):
        raise GovernanceError(
            f"validation_run_commit_sha_not_hex: got {commit_sha!r}; a "
            f"validation run that cannot name the commit it validated is "
            f"not evidence"
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
        "$schema": VALIDATION_RUN_SCHEMA,
        "schema_version": VALIDATION_RUN_SCHEMA_VERSION,
        "validation_run_id": _allocate_validation_run_id(),
        "change_id": change_id,
        "cmd": cmd,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "status": derive_validation_run_status(
            exit_code=exit_code, timed_out=timed_out,
        ),
        "duration_ms": duration_ms,
        "log_path": log.as_posix(),
        "log_hash": log_hash,
        "commit_sha": commit_sha,
        "runner_identity": runner_identity,
        "started_at": started_at,
        "completed_at": completed_at,
        "recorded_at": utc_now(),
    }
    return append_declared_jsonl(
        _runs_path(ensure_tools_dir(base_dir)),
        row,
        expected_surface="validation_runs",
    )


def list_validation_runs(
    *, base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        _runs_path(ensure_tools_dir(base_dir)),
        expected_surface="validation_runs",
    )


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
    "VALIDATION_RUN_SCHEMA",
    "VALIDATION_RUN_SCHEMA_VERSION",
    "VALIDATION_RUN_STATUSES",
    "classify_validation_run_status",
    "derive_validation_run_status",
    "find_validation_run_by_id",
    "list_validation_runs",
    "list_validation_runs_for_change",
    "record_validation_run",
    "validation_run_duration_ms",
    "validation_runs_path",
    "verify_validation_run",
]
