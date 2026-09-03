"""Plan 020 Phase 3 — session / handoff ledger.

WHY this module exists
----------------------
ARIA work spans multiple sessions (operator A starts, hours pass, operator B
or A-after-context-compact resumes). Pre-Plan-020 there was no append-only
record of "what was the active plan + open findings + open debts + pending
claims at session boundary X" — context disappeared with the conversation
buffer. Phase 3 makes the snapshot a first-class ledger.

Snapshot fields (Plan v3.3 §Phase 3.A — 7 fields)
-------------------------------------------------
1. active_plan         — newest docs/aria/plans/*.md (by mtime).
2. open_findings       — list_findings(repo) filtered status != WITHDRAWN.
3. open_debts          — list_debts(repo) filtered status not in {RESOLVED}.
4. pending_requests    — list_agent_invocation_requests(state='pending').
5. claimed_requests    — derive_request_state(...) per pending row that has
                         been CLAIMED / RUNNING / SUBMITTED.
6. last_change_chain   — list_change_chains() newest by recorded_at.
7. last_validation     — governance.jsonl last architecture_spine_postcheck
                         OR change_validated event.
+ next_logical_step    — heuristic recommendation for the next session.

Triggers
--------
manual         — explicit operator invocation (CLI or kernel API).
session_start  — workflow start step (CI runner, before any work).
pre_compact    — about to compact the conversation buffer.
session_stop   — workflow finish step (CI runner, after all work lands).

Frozen-aware: take_handoff_snapshot is a Plan 020 surface
(handoffs in PLAN_020_WRITE_SURFACES). Frozen blocks the persist step;
observe permits it (handoffs is in OBSERVE_PERMITTED_SURFACES — snapshots
are observation-class).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_invocations import (
    derive_request_state,
    list_agent_invocation_requests,
)
from .change_ledger import list_change_chains
from .debt import list_debts
from .finding import list_findings
from .governance_reader import read_governance_rows
from .ledger import append_declared_jsonl
from .runtime_profile import enforce_profile_for_write
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

HANDOFFS_FILENAME = "handoffs.jsonl"

VALID_TRIGGERS: frozenset[str] = frozenset({
    "manual",
    "session_start",
    "pre_compact",
    "session_stop",
})

# Governance event kinds that count as "validation" for snapshot purposes.
# Last one wins (newest by appearance order in governance.jsonl).
VALIDATION_EVENT_KINDS: frozenset[str] = frozenset({
    "architecture_spine_postcheck",
    "change_validated",
})

# Finding statuses that DO NOT count as open (Plan v3.3 §Phase 3.A
# "list_findings filter status != WITHDRAWN"; STALE + RESOLVED also closed).
CLOSED_FINDING_STATUSES: frozenset[str] = frozenset({"WITHDRAWN", "RESOLVED", "STALE"})

# Debt statuses that DO NOT count as open.
CLOSED_DEBT_STATUSES: frozenset[str] = frozenset({"RESOLVED", "WITHDRAWN", "CANCELLED"})


def _resolve_repo_root(repo_root: str | Path | None) -> Path:
    return Path(repo_root or Path.cwd()).resolve()


def _newest_plan_doc(repo_root: Path) -> dict[str, Any] | None:
    plans_dir = repo_root / "docs" / "aria" / "plans"
    if not plans_dir.exists() or not plans_dir.is_dir():
        return None
    md_files = [p for p in plans_dir.glob("*.md") if p.is_file()]
    if not md_files:
        return None
    newest = max(md_files, key=lambda p: p.stat().st_mtime)
    stat = newest.stat()
    return {
        "path": str(newest.relative_to(repo_root)),
        "mtime": int(stat.st_mtime),
        "size_bytes": stat.st_size,
    }


def _open_findings(repo_root: Path) -> list[dict[str, Any]]:
    findings_dir = repo_root / "aria-findings"
    if not findings_dir.exists():
        return []
    rows = list_findings(repo_root)
    return [
        {
            "finding_id": r.get("finding_id"),
            "severity": r.get("severity"),
            "status": r.get("status"),
            "title": r.get("title"),
        }
        for r in rows
        if r.get("status") not in CLOSED_FINDING_STATUSES
    ]


def _open_debts(repo_root: Path) -> list[dict[str, Any]]:
    debts_dir = repo_root / "aria-debts"
    if not debts_dir.exists():
        return []
    rows = list_debts(repo_root)
    return [
        {
            "debt_id": r.get("debt_id"),
            "severity": r.get("severity"),
            "status": r.get("status"),
            "originating_finding_id": r.get("originating_finding_id"),
        }
        for r in rows
        if r.get("status") not in CLOSED_DEBT_STATUSES
    ]


def _request_states(base_dir: str | Path | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (pending_requests, claimed_requests) snapshots."""
    pending: list[dict[str, Any]] = []
    claimed: list[dict[str, Any]] = []
    rows = list_agent_invocation_requests(base_dir=base_dir)
    for row in rows:
        rid = row.get("request_id")
        if not rid:
            continue
        derived = derive_request_state(request_id=rid, base_dir=base_dir)
        snap = {
            "request_id": rid,
            "target_agent": row.get("target_agent"),
            "role": row.get("role"),
            "derived_state": derived,
        }
        if derived == "PENDING":
            pending.append(snap)
        elif derived in {"CLAIMED", "RUNNING", "SUBMITTED", "REQUEUED"}:
            claimed.append(snap)
    return pending, claimed


def _last_change_chain(base_dir: str | Path | None) -> dict[str, Any] | None:
    chains = list_change_chains(base_dir=base_dir)
    if not chains:
        return None
    # Sort by validated > committed > planned recorded_at to pick the newest
    # activity per chain.
    def _chain_recency(chain: dict[str, Any]) -> str:
        for stage in ("validated", "committed", "planned"):
            row = chain.get(stage) or {}
            ra = row.get("recorded_at")
            if isinstance(ra, str):
                return ra
        return ""
    newest = max(chains, key=_chain_recency)
    summary: dict[str, Any] = {}
    for stage in ("planned", "committed", "validated"):
        row = newest.get(stage)
        if row:
            summary[stage] = {
                "change_id": row.get("change_id"),
                "plan_id": row.get("plan_id"),
                "finding_id": row.get("finding_id"),
                "recorded_at": row.get("recorded_at"),
            }
    return summary or None


def _last_validation(base_dir: str | Path | None) -> dict[str, Any] | None:
    """Read aria-tools/governance.jsonl tail for the last validation event.

    Plan 025 §A.2 — uses the shared governance_reader helper. STRICT
    default is correct for governance.jsonl (audit-bound CRITICAL
    ledger); silent skip on corrupt rows would have masked exactly
    the kind of integrity break this reader exists to surface.
    """
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return None
    gov = root / "governance.jsonl"
    last: dict[str, Any] | None = None
    for row in read_governance_rows(gov, base_dir=root):
        if row.get("kind") in VALIDATION_EVENT_KINDS:
            last = row
    if last is None:
        return None
    return {
        "kind": last.get("kind"),
        "recorded_at": last.get("recorded_at") or last.get("ts"),
        "details": last.get("details"),
    }


def _next_logical_step(
    *,
    pending: list[dict[str, Any]],
    claimed: list[dict[str, Any]],
    open_findings: list[dict[str, Any]],
    open_debts: list[dict[str, Any]],
    last_chain: dict[str, Any] | None,
) -> str:
    """Heuristic recommendation for the next session.

    The order encodes the operator's typical priority:
    1. Drain in-flight work first (claimed > pending).
    2. Move stuck OPEN findings to debt or remediation.
    3. Validate any committed change still missing the validated row.
    4. Otherwise, idle — review observation backlog.
    """
    if claimed:
        return f"resume in-flight work: {len(claimed)} claimed/running request(s)"
    if pending:
        return f"claim pending request(s): {len(pending)} in queue"
    findings_no_debt = [f for f in open_findings if not f.get("originating_finding_id")]
    if open_findings and not open_debts:
        return f"emit debt(s) for {len(open_findings)} OPEN finding(s)"
    if open_debts:
        return f"execute debt remediation: {len(open_debts)} OPEN debt(s)"
    if last_chain and "committed" in last_chain and "validated" not in last_chain:
        cid = last_chain["committed"].get("change_id", "?")
        return f"validate change chain: {cid} committed without validated row"
    return "no actionable work — review observation backlog"


def take_handoff_snapshot(
    *,
    session_id: str,
    trigger: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    operator_note: str | None = None,
) -> dict[str, Any]:
    """Capture a handoff snapshot + persist to handoffs.jsonl ledger.

    The snapshot is read-only with respect to the underlying findings,
    debts, and change chains — it only WRITES the snapshot row + governance
    event. Frozen-aware via enforce_profile_for_write('handoffs', ...);
    observe permits the write (handoffs is observation-class).
    """
    if trigger not in VALID_TRIGGERS:
        raise GovernanceError(
            f"unknown handoff trigger: {trigger!r} (must be one of "
            f"{sorted(VALID_TRIGGERS)})"
        )
    if not (session_id or "").strip():
        raise GovernanceError("session_id is required for take_handoff_snapshot")
    enforce_profile_for_write("handoffs", base_dir=base_dir)

    repo = _resolve_repo_root(repo_root)
    pending, claimed = _request_states(base_dir)
    open_findings = _open_findings(repo)
    open_debts = _open_debts(repo)
    last_chain = _last_change_chain(base_dir)
    last_validation = _last_validation(base_dir)
    active_plan = _newest_plan_doc(repo)
    next_step = _next_logical_step(
        pending=pending,
        claimed=claimed,
        open_findings=open_findings,
        open_debts=open_debts,
        last_chain=last_chain,
    )

    snapshot: dict[str, Any] = {
        "$schema": "aria/handoff-snapshot/v1",
        "schema_version": 1,
        "session_id": session_id,
        "trigger": trigger,
        "recorded_at": utc_now(),
        "operator_note": operator_note,
        "active_plan": active_plan,
        "open_findings": open_findings,
        "open_debts": open_debts,
        "pending_requests": pending,
        "claimed_requests": claimed,
        "last_change_chain": last_chain,
        "last_validation": last_validation,
        "next_logical_step": next_step,
    }
    root = ensure_tools_dir(base_dir)
    append_declared_jsonl(
        root / HANDOFFS_FILENAME,
        snapshot,
        expected_surface="handoffs",
    )
    append_tools_governance(
        root,
        "handoff_snapshot_recorded",
        {
            "session_id": session_id,
            "trigger": trigger,
            "open_finding_count": len(open_findings),
            "open_debt_count": len(open_debts),
            "pending_request_count": len(pending),
            "claimed_request_count": len(claimed),
            "next_logical_step": next_step,
        },
    )
    return snapshot


def list_handoffs(
    *,
    base_dir: str | Path | None = None,
    session_id: str | None = None,
    trigger: str | None = None,
    limit: int | None = None,
    on_corruption: str = "strict",
) -> list[dict[str, Any]]:
    """Return recorded handoff snapshots (oldest → newest).

    Plan 024 §H-7 — handoff_ledger is a CRITICAL ledger (audit /
    integrity-chain bound), so a corrupt row defaults to STRICT —
    GovernanceError raised instead of silent skip. Operators who
    explicitly want to recover partial handoff state can pass
    ``on_corruption="tolerant"``; corrupt rows are then skipped from
    the result list AND emitted to the diagnostic sink at
    ``aria-tools/diagnostics/ledger-corruption.jsonl``. Either way,
    every corruption observation lands in the sink — silent skip is
    the only behaviour the fix removes.
    """
    if on_corruption not in {"strict", "tolerant"}:
        raise GovernanceError(
            f"list_handoffs_invalid_on_corruption_mode: {on_corruption!r} "
            f"(must be 'strict' or 'tolerant')"
        )
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = root / HANDOFFS_FILENAME
    if not path.exists():
        return []
    try:
        decoded = read_strict_jsonl(
            path,
            on_corruption=on_corruption,
            base_dir=root,
        )
        rows: list[dict[str, Any]] = []
        for row in decoded:
            if session_id is not None and row.get("session_id") != session_id:
                continue
            if trigger is not None and row.get("trigger") != trigger:
                continue
            rows.append(row)
    except GovernanceError as exc:
        if on_corruption == "strict":
            raise GovernanceError(
                f"ledger_row_corrupt_strict_mode: {exc}"
            ) from exc
        raise
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


def read_handoff(
    *,
    session_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return the LAST handoff snapshot recorded for session_id (or None)."""
    rows = list_handoffs(base_dir=base_dir, session_id=session_id)
    return rows[-1] if rows else None


__all__ = [
    "HANDOFFS_FILENAME",
    "VALID_TRIGGERS",
    "VALIDATION_EVENT_KINDS",
    "take_handoff_snapshot",
    "list_handoffs",
    "read_handoff",
]
