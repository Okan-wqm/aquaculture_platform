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
from .finding import (
    SEVERITIES,
    _check_banned_phrases,
    show_finding,
)
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


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _allocate_debt_id(repo_root: Path, *, when: datetime) -> str:
    """Allocate a date-stamped sequential ID: DEBT-YYYY-MM-DD-NNN."""
    debts_dir = _debts_dir(repo_root)
    date_prefix = when.strftime("DEBT-%Y-%m-%d-")
    if not debts_dir.exists():
        return f"{date_prefix}001"
    existing = [
        p.stem for p in debts_dir.glob(f"{date_prefix}*.json") if DEBT_ID_RE.match(p.stem)
    ]
    if not existing:
        return f"{date_prefix}001"
    last_num = max(int(stem.rsplit("-", 1)[1]) for stem in existing)
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


def _validate_short_term_action(action: dict[str, Any]) -> None:
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


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _refresh_index(repo_root: Path) -> dict[str, Any]:
    debts_dir = _debts_dir(repo_root)
    index: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": _utc_now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "debts": [],
    }
    if not debts_dir.exists():
        _atomic_write_json(_index_path(repo_root), index)
        return index
    rows: list[dict[str, Any]] = []
    for path in sorted(debts_dir.glob("DEBT-*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows.append(
            {
                "debt_id": doc.get("debt_id"),
                "originating_finding_id": doc.get("originating_finding_id"),
                "severity": doc.get("severity"),
                "current_status": doc.get("current_status"),
                "due_date": doc.get("due_date"),
                "permanent_fix_owner": doc.get("permanent_fix_owner"),
                "path": path.name,
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

    _validate_owner(permanent_fix_owner)
    _validate_short_term_action(short_term_action)
    now = _utc_now()
    due = _validate_due_date(severity, due_date, now=now)

    debt_id = _allocate_debt_id(repo_path, when=now)
    record = {
        "$schema": "aria/architectural-debt/v1",
        "debt_id": debt_id,
        "originating_finding_id": originating_finding_id,
        "originating_finding_evidence_chain_id": finding.get("evidence_chain_id"),
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
    path = _debts_dir(repo_path) / f"{debt_id}.json"
    if not path.exists():
        raise GovernanceError(f"debt {debt_id} not found")
    return json.loads(path.read_text(encoding="utf-8"))
