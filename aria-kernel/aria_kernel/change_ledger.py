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

from .ledger import append_declared_jsonl, load_declared_jsonl
from .runtime_profile import enforce_profile_for_action
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
    for row in load_declared_jsonl(_planned_path(tools_root), expected_surface="change_planned"):
        if row.get("change_id") == change_id:
            return row
    return None


def _find_committed(tools_root: Path, change_id: str) -> dict[str, Any] | None:
    for row in load_declared_jsonl(_committed_path(tools_root), expected_surface="change_committed"):
        if row.get("change_id") == change_id:
            return row
    return None


# ---------------------------- public API ----------------------------


# Plan 020 Phase 9.B — change_chain_stale detection.
# Strict-mode rule: a committed chain that has not validated within
# CHAIN_STALE_DAYS days emits change_chain_stale governance event so the
# operator dashboard surfaces it for cleanup.
CHAIN_STALE_DAYS: int = 7


def detect_stale_change_chains(
    *,
    base_dir: str | Path | None = None,
    stale_days: int = CHAIN_STALE_DAYS,
) -> list[dict[str, Any]]:
    """Return committed-but-not-validated chains older than stale_days.

    Read-only — DOES NOT emit governance events. Use
    emit_stale_chain_warnings(...) for the side-effecting variant.
    """
    from datetime import datetime, timedelta, timezone
    tools_root = ensure_tools_dir(base_dir)
    committed = load_declared_jsonl(_committed_path(tools_root), expected_surface="change_committed")
    validated = load_declared_jsonl(_validated_path(tools_root), expected_surface="change_validated")
    validated_ids = {row.get("change_id") for row in validated if row.get("change_id")}
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    stale: list[dict[str, Any]] = []
    for row in committed:
        cid = row.get("change_id")
        if not cid or cid in validated_ids:
            continue
        try:
            recorded = datetime.fromisoformat(
                str(row.get("recorded_at", "")).replace("Z", "+00:00")
            )
        except (TypeError, ValueError):
            continue
        if recorded < cutoff:
            stale.append({
                "change_id": cid,
                "commit_sha": row.get("commit_sha"),
                "plan_id": row.get("plan_id"),
                "committed_at": row.get("recorded_at"),
                "age_days": (datetime.now(timezone.utc) - recorded).days,
            })
    return stale


def emit_stale_chain_warnings(
    *,
    base_dir: str | Path | None = None,
    stale_days: int = CHAIN_STALE_DAYS,
) -> list[dict[str, Any]]:
    """Detect stale chains + emit one change_chain_stale event per chain.

    Side-effecting variant for the strict-mode operator dashboard.
    """
    stale = detect_stale_change_chains(base_dir=base_dir, stale_days=stale_days)
    tools_root = ensure_tools_dir(base_dir)
    for row in stale:
        append_tools_governance(tools_root, "change_chain_stale", row)
    return stale


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
    persisted = append_declared_jsonl(
        _planned_path(tools_root),
        row,
        expected_surface="change_planned",
    )
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
    uncovered_intended_dispositions: dict[str, str] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record the commit landing for a planned change.

    Idempotent on (change_id, commit_sha, files_hash). Returns the
    existing row if a commit_sha was already recorded for change_id.

    ORPHAN-721 (2026-08-18 operator directive) — the completeness half of
    the scope gate. §D.2 below makes over-implementation impossible
    (actual ⊆ intended); nothing made UNDER-implementation visible: an
    implementer that landed 3 of 7 key_changes still recorded a normal
    commit and the chain read "complete". Now every intended file the
    diff did NOT touch requires a declared disposition ("reviewed, no
    change needed: <why>") in ``uncovered_intended_dispositions``; an
    undeclared shortfall refuses the row. Legitimate over-approximation
    by the planner stays cheap — one honest sentence per file — and the
    audit trail records it instead of silence.
    """
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    if not commit_sha.strip():
        raise GovernanceError("commit_sha is required")
    if not actual_affected_files:
        raise GovernanceError("actual_affected_files must not be empty")
    # Plan 020 Phase 1.B — runtime profile dispatch gate.
    # Why: change_committed is the durable record of a remediation landing;
    # observe profiles must not be able to record fake commits, and frozen
    # profiles must not record any state mutation in Plan 020's surface.
    enforce_profile_for_action("change_committed", base_dir=base_dir)
    tools_root = ensure_tools_dir(base_dir)
    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)

    planned = _find_planned(tools_root, change_id)
    if planned is None:
        raise GovernanceError(
            f"change_committed sequence violation: no change_planned for {change_id!r}"
        )

    # Plan 026R §D.2 — scope drift gate. Pre-§D.2 the committed row
    # was persisted regardless of whether ``actual_affected_files``
    # matched ``intended_affected_files`` from the corresponding
    # change_planned row. Drift was silent — a remediation that
    # touched 5 extra files outside the planned scope landed in the
    # audit trail as a normal commit. Post-§D.2 the subset check is
    # enforced at the boundary: actual MUST be a subset of intended;
    # superset / disjoint / empty-intended all raise
    # ``scope_drift_requires_human`` so the operator audit catches
    # the violation before the change_committed row lands.
    intended_files = set(planned.get("intended_affected_files") or [])
    actual_set = set(actual_affected_files)
    if not intended_files:
        raise GovernanceError(
            f"scope_drift_requires_human: change_planned for {change_id!r} "
            f"has empty intended_affected_files; cannot validate actual scope"
        )
    if not actual_set.issubset(intended_files):
        drift = sorted(actual_set - intended_files)
        raise GovernanceError(
            f"scope_drift_requires_human: change_committed for {change_id!r} "
            f"touches files outside the planned scope: drift={drift}. "
            f"intended={sorted(intended_files)} actual={sorted(actual_set)}"
        )

    uncovered = sorted(intended_files - actual_set)
    dispositions = dict(uncovered_intended_dispositions or {})
    undeclared = [f for f in uncovered if not str(dispositions.get(f, "")).strip()]
    if undeclared:
        raise GovernanceError(
            f"implementation_incomplete_undeclared: change_committed for "
            f"{change_id!r} leaves intended files untouched with no declared "
            f"disposition: {undeclared}. Either implement them or record "
            f"why each needs no change."
        )
    stray = sorted(set(dispositions) - set(uncovered))
    if stray:
        raise GovernanceError(
            f"implementation_disposition_for_covered_file: {stray} — a "
            f"disposition may only name an intended file the diff did not "
            f"touch; dispositions for touched or unplanned files would let "
            f"prose overwrite the diff's own record."
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
        "uncovered_intended": uncovered,
        "uncovered_intended_dispositions": dispositions,
        "implementation_complete": not uncovered,
        "claim_id": claim_id,
        "recorded_at": utc_now(),
    }
    persisted = append_declared_jsonl(
        _committed_path(tools_root),
        row,
        expected_surface="change_committed",
    )
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


def _find_validated_for_change(tools_root: Path, change_id: str) -> dict[str, Any] | None:
    """Plan 023 v3 §D-3 (M-G) — find existing validated row for a
    change_id (latest, since latest is the binding state)."""
    rows = load_declared_jsonl(_validated_path(tools_root), expected_surface="change_validated")
    matches = [r for r in rows if r.get("change_id") == change_id]
    if not matches:
        return None
    return matches[-1]  # latest


def _validated_content_hash(payload: dict[str, Any]) -> str:
    """Plan 023 v3 §D-3 (M-G) — canonical content hash for idempotence
    check. Hashes the load-bearing fields; ignores volatile or audit
    fields (recorded_at, ledger_hash, etc.)."""
    import hashlib as _h
    import json as _j
    fields = {
        "change_id": payload.get("change_id"),
        "validation_run_refs": payload.get("validation_run_refs"),
        "baseline_comparison_ref": payload.get("baseline_comparison_ref"),
        "post_remediation_invariants": payload.get("post_remediation_invariants"),
        "validation_mode": payload.get("validation_mode"),
    }
    serialized = _j.dumps(fields, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + _h.sha256(serialized.encode("utf-8")).hexdigest()


def emit_change_validated(
    *,
    change_id: str,
    validation_run_refs: list[Any],
    baseline_comparison_ref: str | None = None,
    post_remediation_invariants: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    validation_mode: str = "enforced",
    enforce_validation_matrix: bool = True,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Record the validation pass that closes a change chain.

    Plan 020 Phase 8.B — validation_mode + enforce_validation_matrix
    semantic split:

    - validation_mode='enforced' (Plan 020+ default):
        validation_run_refs MUST be a list of structured dicts
        ({cmd, exit_code, log_path, ran_at}); enforce_validation_matrix=True
        triggers the 3-layer matrix gate (existence + pattern + run-pass)
        BEFORE persistence. Gate fail → GovernanceError, row NOT written.
    - validation_mode='historical_attestation' (Plan 019 backfill only):
        accepts legacy string refs; matrix gate bypassed; row IS written
        (audit trail) but excluded from the aria_change_chain_validation
        _pct numerator (Phase 9).
    - enforce_validation_matrix=False overrides the gate (smoke tests
      / synthetic backfill scripts that produce structured refs but do
      not need full matrix coverage).
    """
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    if not validation_run_refs:
        raise GovernanceError("validation_run_refs must not be empty")
    # Plan 020 Phase 1.B — runtime profile dispatch gate.
    # Why: change_validated closes the change chain. Frozen profiles must
    # not be able to mark a change "validated" without an explicit operator
    # thaw transition.
    enforce_profile_for_action("change_validated", base_dir=base_dir)
    tools_root = ensure_tools_dir(base_dir)
    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)

    committed = _find_committed(tools_root, change_id)
    if committed is None:
        raise GovernanceError(
            f"change_validated sequence violation: no change_committed for {change_id!r}"
        )

    # Plan 023 v3 §D-3 (M-G) — change_validated idempotence.
    # Pre-Plan-023 emit_change_validated appended without checking
    # whether an existing validated row already existed for change_id.
    # Multiple writes were possible; find_change_validated returned
    # the FIRST row, masking later contradictions.
    # Post-fix: existing validated row + identical content (hash) →
    # idempotent return (no second append). Existing row + content
    # drift → reject with change_validated_content_drift.
    existing_validated = _find_validated_for_change(tools_root, change_id)
    if existing_validated is not None:
        # Compare content hash on the load-bearing fields.
        existing_hash = _validated_content_hash(existing_validated)
        candidate_hash = _validated_content_hash({
            "change_id": change_id,
            "validation_run_refs": list(validation_run_refs),
            "baseline_comparison_ref": baseline_comparison_ref,
            "post_remediation_invariants": dict(post_remediation_invariants or {}),
            "validation_mode": validation_mode,
        })
        if existing_hash == candidate_hash:
            # Idempotent return — same content, return existing row.
            return existing_validated
        raise GovernanceError(
            f"change_validated_content_drift: change_id={change_id!r} "
            f"already has a change_validated row; new content does not "
            f"match existing (existing_hash={existing_hash!r} != "
            f"candidate_hash={candidate_hash!r})"
        )

    # Plan 020 Phase 8.B — validation matrix gate fires BEFORE persistence.
    matrix_result: dict[str, Any] | None = None
    if enforce_validation_matrix:
        from .validation_matrix_gate import enforce_validation_matrix as _enforce_matrix
        # Raises GovernanceError on blocked; result returned only on pass.
        matrix_result = _enforce_matrix(
            change_id=change_id,
            base_dir=base_dir,
            repo_root=workspace_root,
            candidate_refs=list(validation_run_refs),
            validation_mode=validation_mode,
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
        "validation_mode": validation_mode,
        "baseline_comparison_ref": baseline_comparison_ref,
        "post_remediation_invariants": dict(post_remediation_invariants or {}),
        "recorded_at": utc_now(),
    }
    if matrix_result is not None:
        row["validation_matrix_passed"] = matrix_result.get("passed", False)
        row["validation_matrix_risk_types"] = matrix_result.get("risk_types", [])
    persisted = append_declared_jsonl(
        _validated_path(tools_root),
        row,
        expected_surface="change_validated",
    )
    # Plan v3.3 §"existing payload immutability": the change_validated
    # governance event detail payload locked at Plan 019 stays unchanged.
    # validation_mode lives ONLY on the validated.jsonl row + the new
    # validation_matrix_check event detail; it is NOT added here.
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


def list_committed_change_ids_in_window(
    *,
    since: datetime,
    base_dir: str | Path | None = None,
) -> list[str]:
    """Plan 025 §C — return change_ids whose ``change_committed
    .recorded_at`` >= ``since``.

    Used by the cycle validation_matrix phase to bound matrix
    enforcement to changes landed inside the current cycle window
    (a global "list all committed" surface would cause the gate to
    re-run on every historical change, defeating per-cycle
    discrimination). ``since`` is a UTC datetime; ``recorded_at``
    rows are ISO-8601 strings written by emit_change_committed.

    Rows with missing/unparseable ``recorded_at`` are skipped
    (defensive against legacy rows; the change ledger has no
    schema drift today, but the iso-parse failure is silently
    skipped rather than hard-failed because the validation matrix
    phase should keep going on the remaining changes).
    """
    tools_root = ensure_tools_dir(base_dir)
    out: list[str] = []
    for row in load_declared_jsonl(_committed_path(tools_root), expected_surface="change_committed"):
        cid = row.get("change_id")
        recorded = row.get("recorded_at")
        if not cid or not isinstance(recorded, str):
            continue
        try:
            ts = datetime.fromisoformat(recorded.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts >= since:
            out.append(cid)
    return out


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
            (row for row in load_declared_jsonl(_validated_path(tools_root), expected_surface="change_validated")
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
    for planned in load_declared_jsonl(_planned_path(tools_root), expected_surface="change_planned"):
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
    for planned in load_declared_jsonl(_planned_path(tools_root), expected_surface="change_planned"):
        if file_path in (planned.get("intended_affected_files") or []):
            matched_ids.add(planned.get("change_id", ""))
    for committed in load_declared_jsonl(_committed_path(tools_root), expected_surface="change_committed"):
        if file_path in (committed.get("actual_affected_files") or []):
            matched_ids.add(committed.get("change_id", ""))
    return [
        get_change_chain(change_id=cid, base_dir=tools_root)
        for cid in sorted(matched_ids)
        if cid
    ]
