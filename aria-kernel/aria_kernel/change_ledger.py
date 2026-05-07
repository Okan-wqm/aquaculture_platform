"""Change Ledger primitive (Plan 019 Phase 7 — operator critique #8).

Why a separate module: ARIA's plans, findings, debts, and commits are
each tracked but the linkage between them (which finding drove which
commit, which validation run covered it, what the rollback path is)
lives only in commit message prose. Operators cannot query "which
remediations have touched this file?" or "is this commit's validation
chain complete?" without manual git archaeology. The Change Ledger
records that linkage as a hash-chained event stream.

**Append-only event-stream model (operator critique #8):**

The earlier draft of Phase 7 envisioned one record per change with
`commit_sha` set after the commit lands — that pattern requires
in-place row mutation, which breaks the append-only / hash-chain
contract every other ARIA ledger upholds (governance.jsonl,
claims.jsonl, results.jsonl, etc.). The corrected design splits one
change into three append-only events linked by `change_id`:

- `change_planned`    — emitted BEFORE remediation: plan_id, finding_id,
                        intended_affected_files, intended_validation_refs,
                        rollback_ref, architectural_tier.
- `change_committed`  — emitted AFTER the commit lands: commit_sha,
                        actual_affected_files, affected_files_hash, claim_id.
- `change_validated`  — emitted AFTER spine postcheck / test runs:
                        validation_run_refs, baseline_comparison_ref,
                        post_remediation_invariants.

`change_id = sha256(plan_id|finding_id|intended_affected_files_canonical)[:16]`
is content-addressed so a duplicate `emit_change_planned` for the same
(plan, finding, files) is a no-op (returns the existing row). The
committed/validated events use the same change_id as their key plus
`(commit_sha, affected_files_hash)` for committed-event idempotency.

Sequence invariants:
- `change_committed` requires an existing `change_planned` for the
  same change_id.
- `change_validated` requires an existing `change_committed`.
- Out-of-order emit raises GovernanceError; this is the contract that
  makes the chain queryable in either direction.

Storage:
  aria-tools/change-ledger/planned.jsonl
  aria-tools/change-ledger/committed.jsonl
  aria-tools/change-ledger/validated.jsonl
Each row also emits a matching governance event (change_planned /
change_committed / change_validated) on the existing governance.jsonl
hash chain so spine postchecks and dashboards can join across.

Distinct from `governance.jsonl`: that file mixes every kernel event
kind (one event per row, no chain semantics across rows of the same
work unit). Change Ledger imposes the planned→committed→validated
ordering and lets operators query a single chain end-to-end.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    utc_now,
)


CHANGE_RECORD_SCHEMA = "aria/change-record/v1"
ARCHITECTURAL_TIERS = (1, 2, 3, 4)


# ---------------------------- helpers ----------------------------


def _ledger_dir(tools_root: Path) -> Path:
    return tools_root / "change-ledger"


def _planned_path(tools_root: Path) -> Path:
    return _ledger_dir(tools_root) / "planned.jsonl"


def _committed_path(tools_root: Path) -> Path:
    return _ledger_dir(tools_root) / "committed.jsonl"


def _validated_path(tools_root: Path) -> Path:
    return _ledger_dir(tools_root) / "validated.jsonl"


def _files_hash(files: list[str]) -> str:
    canonical = json.dumps(sorted(files), separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _allocate_change_id(*, plan_id: str, finding_id: str, intended_files: list[str]) -> str:
    """Content-addressed change_id. Duplicate emits collapse to the same id."""
    canonical = "|".join([
        plan_id,
        finding_id,
        ",".join(sorted(intended_files)),
    ])
    return "chg_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _find_planned(tools_root: Path, change_id: str) -> dict[str, Any] | None:
    for row in load_jsonl(_planned_path(tools_root)):
        if row.get("change_id") == change_id:
            return row
    return None


def _find_committed(tools_root: Path, change_id: str) -> dict[str, Any] | None:
    for row in load_jsonl(_committed_path(tools_root)):
        if row.get("change_id") == change_id:
            return row
    return None


# ---------------------------- public API ----------------------------


def emit_change_planned(
    *,
    plan_id: str,
    finding_id: str,
    intended_affected_files: list[str],
    intended_validation_refs: list[str],
    rollback_ref: str | None = None,
    architectural_tier: int,
    intended_request_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Open a change-chain. Idempotent on (plan_id, finding_id, intended_files)."""
    if not plan_id.strip():
        raise GovernanceError("plan_id is required")
    if not finding_id.strip():
        raise GovernanceError("finding_id is required")
    if not intended_affected_files:
        raise GovernanceError("intended_affected_files must not be empty")
    if architectural_tier not in ARCHITECTURAL_TIERS:
        raise GovernanceError(
            f"architectural_tier must be one of {ARCHITECTURAL_TIERS}, "
            f"got {architectural_tier!r}"
        )
    tools_root = ensure_tools_dir(base_dir)
    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)

    change_id = _allocate_change_id(
        plan_id=plan_id,
        finding_id=finding_id,
        intended_files=intended_affected_files,
    )
    existing = _find_planned(tools_root, change_id)
    if existing is not None:
        # Idempotent: same (plan_id, finding_id, files) returns the
        # existing row without emitting a new event.
        return existing

    row = {
        "$schema": CHANGE_RECORD_SCHEMA,
        "schema_version": 1,
        "event": "change_planned",
        "change_id": change_id,
        "plan_id": plan_id,
        "finding_id": finding_id,
        "intended_request_id": intended_request_id,
        "intended_affected_files": sorted(intended_affected_files),
        "intended_files_hash": _files_hash(intended_affected_files),
        "intended_validation_refs": list(intended_validation_refs),
        "rollback_ref": rollback_ref,
        "architectural_tier": architectural_tier,
        "recorded_at": utc_now(),
    }
    persisted = append_jsonl(_planned_path(tools_root), row)
    append_tools_governance(
        tools_root,
        "change_planned",
        {
            "change_id": change_id,
            "plan_id": plan_id,
            "finding_id": finding_id,
            "architectural_tier": architectural_tier,
            "intended_files_hash": row["intended_files_hash"],
        },
    )
    return persisted


def emit_change_committed(
    *,
    change_id: str,
    commit_sha: str,
    actual_affected_files: list[str],
    claim_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record the commit landing for a planned change.

    Idempotent on (change_id, commit_sha, files_hash). Returns the
    existing row if a commit_sha was already recorded for change_id.
    """
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    if not commit_sha.strip():
        raise GovernanceError("commit_sha is required")
    if not actual_affected_files:
        raise GovernanceError("actual_affected_files must not be empty")
    tools_root = ensure_tools_dir(base_dir)
    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)

    planned = _find_planned(tools_root, change_id)
    if planned is None:
        raise GovernanceError(
            f"change_committed sequence violation: no change_planned for {change_id!r}"
        )

    existing = _find_committed(tools_root, change_id)
    if existing is not None:
        if (existing.get("commit_sha") == commit_sha
                and existing.get("affected_files_hash") == _files_hash(actual_affected_files)):
            return existing
        raise GovernanceError(
            f"change_committed already recorded for {change_id!r} with a different "
            f"commit_sha or affected_files_hash; chain is immutable"
        )

    row = {
        "$schema": CHANGE_RECORD_SCHEMA,
        "schema_version": 1,
        "event": "change_committed",
        "change_id": change_id,
        "plan_id": planned.get("plan_id"),
        "finding_id": planned.get("finding_id"),
        "commit_sha": commit_sha,
        "actual_affected_files": sorted(actual_affected_files),
        "affected_files_hash": _files_hash(actual_affected_files),
        "claim_id": claim_id,
        "recorded_at": utc_now(),
    }
    persisted = append_jsonl(_committed_path(tools_root), row)
    append_tools_governance(
        tools_root,
        "change_committed",
        {
            "change_id": change_id,
            "commit_sha": commit_sha,
            "affected_files_hash": row["affected_files_hash"],
            "plan_id": planned.get("plan_id"),
        },
    )
    return persisted


def emit_change_validated(
    *,
    change_id: str,
    validation_run_refs: list[str],
    baseline_comparison_ref: str | None = None,
    post_remediation_invariants: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record the validation pass that closes a change chain."""
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    if not validation_run_refs:
        raise GovernanceError("validation_run_refs must not be empty")
    tools_root = ensure_tools_dir(base_dir)
    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)

    committed = _find_committed(tools_root, change_id)
    if committed is None:
        raise GovernanceError(
            f"change_validated sequence violation: no change_committed for {change_id!r}"
        )

    row = {
        "$schema": CHANGE_RECORD_SCHEMA,
        "schema_version": 1,
        "event": "change_validated",
        "change_id": change_id,
        "plan_id": committed.get("plan_id"),
        "finding_id": committed.get("finding_id"),
        "commit_sha": committed.get("commit_sha"),
        "validation_run_refs": list(validation_run_refs),
        "baseline_comparison_ref": baseline_comparison_ref,
        "post_remediation_invariants": dict(post_remediation_invariants or {}),
        "recorded_at": utc_now(),
    }
    persisted = append_jsonl(_validated_path(tools_root), row)
    append_tools_governance(
        tools_root,
        "change_validated",
        {
            "change_id": change_id,
            "commit_sha": committed.get("commit_sha"),
            "validation_run_count": len(validation_run_refs),
            "plan_id": committed.get("plan_id"),
        },
    )
    return persisted


# ---------------------------- query API ----------------------------


def get_change_chain(
    *,
    change_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Return {planned, committed, validated} blocks for a change_id.

    Each block is None if the corresponding event has not been emitted.
    """
    tools_root = ensure_tools_dir(base_dir)
    return {
        "change_id": change_id,
        "planned": _find_planned(tools_root, change_id),
        "committed": _find_committed(tools_root, change_id),
        "validated": next(
            (row for row in load_jsonl(_validated_path(tools_root))
             if row.get("change_id") == change_id),
            None,
        ),
    }


def list_change_chains(
    *,
    plan_id: str | None = None,
    finding_id: str | None = None,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """List every change chain (planned + matching committed + validated).

    Filter optionally by plan_id or finding_id (matched against the
    planned row).
    """
    tools_root = ensure_tools_dir(base_dir)
    chains: list[dict[str, Any]] = []
    for planned in load_jsonl(_planned_path(tools_root)):
        if plan_id is not None and planned.get("plan_id") != plan_id:
            continue
        if finding_id is not None and planned.get("finding_id") != finding_id:
            continue
        cid = planned.get("change_id")
        if not cid:
            continue
        chain = get_change_chain(change_id=cid, base_dir=tools_root)
        chains.append(chain)
    return chains


def find_changes_by_file(
    *,
    file_path: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """Return every change chain that touched (intended OR actual) file_path."""
    tools_root = ensure_tools_dir(base_dir)
    matched_ids: set[str] = set()
    for planned in load_jsonl(_planned_path(tools_root)):
        if file_path in (planned.get("intended_affected_files") or []):
            matched_ids.add(planned.get("change_id", ""))
    for committed in load_jsonl(_committed_path(tools_root)):
        if file_path in (committed.get("actual_affected_files") or []):
            matched_ids.add(committed.get("change_id", ""))
    return [
        get_change_chain(change_id=cid, base_dir=tools_root)
        for cid in sorted(matched_ids)
        if cid
    ]
