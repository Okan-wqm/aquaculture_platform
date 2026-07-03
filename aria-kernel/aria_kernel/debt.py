"""Architectural debt record emission for ARIA (Plan 016 Faz A3, CONTRACTS §6.6).

Every short-term action that doesn't permanently fix a verified problem must
be tracked as a Debt record. Kernel-side rules (fail-closed):

- `originating_finding_id` must point at an existing F-* finding;
- `verification_status` must be `VERIFIED` (debts cannot be opened from
  unverified observations);
- `root_cause_summary`, `permanent_fix_required`, and `withdrawn_reason`
  pass the banned-phrase gate;
- `permanent_fix_owner` must be a specific person or named team;
- `due_date` cannot exceed the severity-tiered ceiling
  (CRITICAL ≤30d, HIGH ≤60d, MEDIUM ≤90d, LOW ≤180d).
- `auto_close_forbidden: true` — no silent disappearance.

Distinct from `feedback_store`: debts are operator-facing committed
documents tied to a specific finding-fix pair, not run-level feedback rows.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .agent_genesis import BANNED_PHRASES
from .evidence_trust import classify_evidence_ref
from .finding import (
    SEVERITIES,
    _check_banned_phrases,
    show_finding,
)
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding


SHORT_TERM_ACTION_KINDS = (
    "test_added",
    "feature_flag",
    "runtime_guard",
    "api_narrowing",
    "code_marker",
    "no_action_yet",
)
DEBT_STATUSES = ("OPEN", "IN_PROGRESS", "RESOLVED", "OVERDUE", "WITHDRAWN")
SEVERITY_DUE_DAYS = {
    "HIGH": 60,
    "MEDIUM": 90,
    "LOW": 180,
    "INFORMATIONAL": 365,
}
# CRITICAL severity exists in CONTRACTS §6.6 even though §6 finding severities
# top out at HIGH. A debt may be promoted to CRITICAL by operator override
# (e.g. life-safety, regulatory) — its due window is 30 days regardless.
SEVERITY_DUE_DAYS_WITH_CRITICAL = {**SEVERITY_DUE_DAYS, "CRITICAL": 30}

GENERIC_OWNERS = {"tbd", "the team", "someone", "tba", "team", ""}
SCHEMA_VERSION = 1
DEBT_ID_RE = re.compile(r"^DEBT-\d{4}-\d{2}-\d{2}-\d{3}$")


def _debts_dir(repo_root: Path) -> Path:
    return Path(repo_root) / "aria-debts"


def _index_path(repo_root: Path) -> Path:
    return _debts_dir(repo_root) / "_index.json"


def _events_path(repo_root: Path) -> Path:
    return _debts_dir(repo_root) / "debt-events.jsonl"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _allocate_debt_id(repo_root: Path, *, when: datetime) -> str:
    """Allocate a date-stamped sequential ID from the event ledger."""
    date_prefix = when.strftime("DEBT-%Y-%m-%d-")
    existing: list[str] = []
    for event in load_declared_jsonl(_events_path(repo_root), expected_surface="repo_debt_events"):
        debt_id = str(event.get("debt_id") or "")
        if event.get("event") == "debt_emitted" and debt_id.startswith(date_prefix) and DEBT_ID_RE.match(debt_id):
            existing.append(debt_id)
    if not existing:
        return f"{date_prefix}001"
    last_num = max(int(debt_id.rsplit("-", 1)[1]) for debt_id in existing)
    return f"{date_prefix}{last_num + 1:03d}"


def _validate_owner(owner: str) -> None:
    cleaned = (owner or "").strip().lower()
    if not cleaned or cleaned in GENERIC_OWNERS:
        raise GovernanceError(
            f"permanent_fix_owner must be a specific person or named team, got {owner!r}"
        )


def _validate_due_date(severity: str, due_date_iso: str, *, now: datetime) -> datetime:
    try:
        due = datetime.fromisoformat(due_date_iso.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise GovernanceError(f"invalid due_date {due_date_iso!r}: {exc}") from exc
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    if due <= now:
        raise GovernanceError(f"due_date {due_date_iso!r} is not in the future")
    max_days = SEVERITY_DUE_DAYS_WITH_CRITICAL.get(severity)
    if max_days is None:
        raise GovernanceError(f"unknown severity {severity!r} for due-date ceiling")
    ceiling = now + timedelta(days=max_days)
    if due > ceiling:
        raise GovernanceError(
            f"due_date {due_date_iso!r} exceeds {severity} ceiling of {max_days} days"
        )
    return due


def _validate_short_term_action(
    action: dict[str, Any],
    *,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    kind = action.get("kind")
    if kind not in SHORT_TERM_ACTION_KINDS:
        raise GovernanceError(f"unknown short_term_action kind: {kind!r}")
    rationale = action.get("rationale", "")
    if not isinstance(rationale, str) or not rationale.strip():
        raise GovernanceError("short_term_action.rationale is required")
    _check_banned_phrases(rationale, field="short_term_action.rationale")
    if kind != "no_action_yet":
        ref = action.get("ref", "")
        if not isinstance(ref, str) or not ref.strip():
            raise GovernanceError(f"short_term_action kind={kind!r} requires non-empty ref")
        if repo_root is not None:
            target_sha = "HEAD" if (repo_root / ".git").exists() else None
            envelope = classify_evidence_ref(
                ref,
                workspace_root=repo_root,
                source_hint="repo_source",
                context="debt_short_term_action",
                target_sha=target_sha,
            )
            if target_sha is not None and envelope.trust_grade != "repo_verified":
                raise GovernanceError(
                    "short_term_action.ref must be repo_verified: "
                    f"ref={ref!r} grade={envelope.trust_grade!r} "
                    f"errors={envelope.validation_errors!r}"
                )
            stamped = dict(action)
            stamped["ref_evidence_envelope"] = envelope.to_dict()
            return stamped
    return dict(action)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _refresh_index(repo_root: Path) -> dict[str, Any]:
    # ORPHAN-MEDIUM-307 — the index is DERIVED from the (uncommitted)
    # debt-events ledger, but the index itself is COMMITTED audit
    # content. On a fresh checkout the ledger is absent; deriving from
    # nothing must never clobber the committed truth — an absent source
    # ledger with an existing index is a read-only situation, not an
    # empty-derivation write.
    events_path = _events_path(repo_root)
    index_path = _index_path(repo_root)
    if not events_path.exists() and index_path.exists():
        try:
            return json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    event_rows = load_declared_jsonl(events_path, expected_surface="repo_debt_events")
    source_tip = event_rows[-1].get("ledger_hash") if event_rows else None
    index: dict[str, Any] = {
        "schema_version": 2,
        "generated_at": _utc_now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_ledger": _events_path(repo_root).relative_to(repo_root).as_posix(),
        "source_ledger_tip_hash": source_tip,
        "debts": [],
    }
    rows: list[dict[str, Any]] = []
    replayed = _replay_debts(repo_root)
    for debt_id in sorted(replayed):
        doc = replayed[debt_id]
        rows.append(
            {
                "debt_id": doc.get("debt_id"),
                "originating_finding_id": doc.get("originating_finding_id"),
                "severity": doc.get("severity"),
                "current_status": doc.get("current_status"),
                "due_date": doc.get("due_date"),
                "permanent_fix_owner": doc.get("permanent_fix_owner"),
                "path": f"{debt_id}.json",
                "source_event_id": doc.get("source_event_id"),
                "source_ledger_hash": doc.get("source_ledger_hash"),
            }
        )
    index["debts"] = rows
    _atomic_write_json(_index_path(repo_root), index)
    return index


def emit_debt(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    originating_finding_id: str,
    root_cause_summary: str,
    short_term_action: dict[str, Any],
    permanent_fix_required: str,
    permanent_fix_owner: str,
    due_date: str,
    severity: str,
) -> dict[str, Any]:
    """Emit a hash-chained operator-facing architectural debt record.

    Plan 026R §A.4 — frozen-profile gate at function entry. Debt
    emission is one of the 8 legacy mutators §A.4 brings under the
    Plan 020 SCOPED no-write invariant.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("debt", base_dir=base_dir)
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)

    if severity not in SEVERITY_DUE_DAYS_WITH_CRITICAL:
        raise GovernanceError(f"invalid severity {severity!r}")

    # Originating finding must exist and be VERIFIED — verification is the
    # finding being committed in aria-findings/ (operator-facing already).
    finding = show_finding(repo_path, originating_finding_id)
    if finding.get("status") not in {"OPEN", "IN_PROGRESS", "RESOLVED"}:
        raise GovernanceError(
            f"originating finding {originating_finding_id} status "
            f"{finding.get('status')!r} cannot be cited by a debt"
        )

    if not isinstance(root_cause_summary, str) or not root_cause_summary.strip():
        raise GovernanceError("root_cause_summary is required")
    _check_banned_phrases(root_cause_summary, field="root_cause_summary")

    if not isinstance(permanent_fix_required, str) or not permanent_fix_required.strip():
        raise GovernanceError("permanent_fix_required is required")
    _check_banned_phrases(permanent_fix_required, field="permanent_fix_required")

    now = _utc_now()
    due = _validate_due_date(severity, due_date, now=now)
    _validate_owner(permanent_fix_owner)
    short_term_action = _validate_short_term_action(short_term_action, repo_root=repo_path)

    debts_dir = _debts_dir(repo_path)
    debts_dir.mkdir(parents=True, exist_ok=True)
    from .file_lock import with_exclusive_lock
    with with_exclusive_lock(debts_dir / ".alloc.lock", timeout_seconds=5.0):
        debt_id = _allocate_debt_id(repo_path, when=now)
        record = {
            "$schema": "aria/architectural-debt/v1",
            "debt_id": debt_id,
            "originating_finding_id": originating_finding_id,
            "originating_finding_evidence_chain_id": finding.get("evidence_chain_id"),
            "originating_finding_evidence_envelope_hashes": [
                ev.get("evidence_envelope", {}).get("envelope_hash")
                for ev in finding.get("evidences", [])
                if isinstance(ev, dict)
            ],
            "verification_status": "VERIFIED",
            "root_cause_summary": root_cause_summary,
            "short_term_action_taken": short_term_action,
            "permanent_fix_required": permanent_fix_required,
            "permanent_fix_owner": permanent_fix_owner,
            "due_date": due.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "severity": severity,
            "current_status": "OPEN",
            "status_history": [
                {
                    "status": "OPEN",
                    "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "by": "manual:operator",
                }
            ],
            "escalation_history": [],
            "auto_close_forbidden": True,
            "withdrawn_reason": None,
            "schema_version": SCHEMA_VERSION,
        }
        event = append_declared_jsonl(
            _events_path(repo_path),
            {
                "schema_version": 1,
                "event": "debt_emitted",
                "event_id": f"debt:{debt_id}:emitted",
                "debt_id": debt_id,
                "originating_finding_id": originating_finding_id,
                "record": record,
            },
            expected_surface="repo_debt_events",
        )
        record["source_event_id"] = event.get("event_id")
        record["source_ledger_hash"] = event.get("ledger_hash")
        output_path = _debts_dir(repo_path) / f"{debt_id}.json"
        if output_path.exists():
            raise GovernanceError(f"debt {debt_id} already exists at {output_path}")
        _atomic_write_json(output_path, record)
        _refresh_index(repo_path)

    append_tools_governance(
        tools_root,
        "debt_emitted",
        {
            "debt_id": debt_id,
            "originating_finding_id": originating_finding_id,
            "severity": severity,
            "due_date": record["due_date"],
            "permanent_fix_owner": permanent_fix_owner,
            "path": output_path.relative_to(repo_path).as_posix(),
        },
    )
    return record


def list_debts(repo_root: str | Path) -> list[dict[str, Any]]:
    repo_path = Path(repo_root).resolve()
    return list(_refresh_index(repo_path).get("debts", []))


def show_debt(repo_root: str | Path, debt_id: str) -> dict[str, Any]:
    repo_path = Path(repo_root).resolve()
    if not DEBT_ID_RE.match(debt_id):
        raise GovernanceError(f"debt_id format invalid: {debt_id!r}")
    record = _replay_debts(repo_path).get(debt_id)
    if record is None:
        raise GovernanceError(f"debt {debt_id} not found")
    return record


def _replay_debts(repo_root: Path) -> dict[str, dict[str, Any]]:
    rows = load_declared_jsonl(_events_path(repo_root), expected_surface="repo_debt_events")
    debts: dict[str, dict[str, Any]] = {}
    for event in rows:
        if event.get("event") != "debt_emitted":
            continue
        debt_id = str(event.get("debt_id") or "")
        if not DEBT_ID_RE.match(debt_id):
            raise GovernanceError(f"debt event has invalid debt_id: {debt_id!r}")
        record = event.get("record")
        if not isinstance(record, dict):
            raise GovernanceError(f"debt event {event.get('event_id')!r} missing record")
        source_ledger_hash = event.get("ledger_hash")
        if not isinstance(source_ledger_hash, str) or not source_ledger_hash:
            raise GovernanceError(f"debt event {event.get('event_id')!r} missing ledger_hash")
        doc = dict(record)
        doc["source_event_id"] = event.get("event_id")
        doc["source_ledger_hash"] = source_ledger_hash
        debts[debt_id] = doc
    return debts
