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
- The lifecycle is kernel-enforced (CONTRACTS.md §6.6, ARIA-LOW-605):
  every status change after OPEN is a hash-chained `debt_status_changed`
  event (`transition_debt`; the debt-events.jsonl ledger under
  ``debts_dir()`` is the one state machine), OVERDUE is derived from
  `due_date` (`effective_debt_status` — no date-driven writer), and
  `import_committed_debts` adopts the committed aria-debts/*.json
  history into that ledger idempotently.

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
from .evidence_probe import GitProbeSession
from .evidence_trust import classify_evidence_ref
from .finding import (
    SEVERITIES,
    _check_banned_phrases,
    find_by_evidence_chain_id,
    show_finding,
)
from .git_object_id import ANY_OBJECT_FORMAT, is_object_id, is_object_id_prefix
from .ledger import (
    append_declared_jsonl,
    append_declared_jsonl_rows,
    atomic_write_json,
    load_declared_jsonl,
)
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding
from .tool_registry import utc_now_datetime as _utc_now


SHORT_TERM_ACTION_KINDS = (
    "test_added",
    "feature_flag",
    "runtime_guard",
    "api_narrowing",
    "code_marker",
    "no_action_yet",
)
DEBT_STATUSES = ("OPEN", "IN_PROGRESS", "RESOLVED", "OVERDUE", "WITHDRAWN")
# CONTRACTS §6.6 lifecycle, kernel-enforced (ARIA-LOW-605). OVERDUE is
# DERIVED from due_date (``effective_debt_status``) and is never a writable
# target; a stored-OVERDUE row exists only in hand-edited committed JSON,
# so its targets are those of its base state (OPEN | IN_PROGRESS).
# OPEN -> RESOLVED is legal because a fix-shipped event (merge sha +
# re-verified chain) satisfies the contract's NEVER list ("no state change
# without operator action OR fix-shipped event") — the committed corpus
# resolved three debts exactly that way. Progress annotations that re-state
# the current status are NOT transitions; they belong in escalation_history.
DEBT_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "OPEN": ("IN_PROGRESS", "RESOLVED", "WITHDRAWN"),
    "IN_PROGRESS": ("RESOLVED", "WITHDRAWN"),
    "OVERDUE": ("RESOLVED", "WITHDRAWN"),
    "RESOLVED": ("WITHDRAWN",),
    "WITHDRAWN": (),
}
# One unresolved predicate for every consumer (reflection, cycle_guard,
# surface_manifest_validator, handoff_ledger): an overdue debt never leaves
# the open count.
UNRESOLVED_DEBT_STATUSES = ("OPEN", "IN_PROGRESS", "OVERDUE")
CLOSED_DEBT_STATUSES = ("RESOLVED", "WITHDRAWN")
_OPERATOR_ACT_RE = re.compile(r"^(manual:operator|operator:[A-Za-z0-9._-]+)$")
# `by` names a commit as `commit:<id or abbreviation git resolves>`; a fix
# merge sha is a full id git produced. Both rules are git_object_id's
# (ARIA-LOW-518), in whichever object format the repository uses.
_COMMIT_REF_PREFIX = "commit:"
_COMMIT_REF_MIN_DIGITS = 7


def _is_commit_ref(by: str) -> bool:
    return by.startswith(_COMMIT_REF_PREFIX) and is_object_id_prefix(
        by[len(_COMMIT_REF_PREFIX):], formats=ANY_OBJECT_FORMAT, min_digits=_COMMIT_REF_MIN_DIGITS,
    )


def _is_merge_sha(value: object) -> bool:
    return is_object_id(value, formats=ANY_OBJECT_FORMAT)


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


def debts_dir(repo_root: str | Path) -> Path:
    """SSoT for where committed debts live — the debt twin of
    ``finding.findings_dir`` (ARIA-HIGH-191). PUBLIC so a reader never
    rebuilds ``repo_root / "aria-debts"`` by hand; one resolver, so the two
    roots cannot drift."""
    from .workspace import repo_state_root

    return repo_state_root(Path(repo_root)) / "aria-debts"


def _index_path(repo_root: Path) -> Path:
    return debts_dir(repo_root) / "_index.json"


def _events_path(repo_root: Path) -> Path:
    return debts_dir(repo_root) / "debt-events.jsonl"


def _parse_due_date(due_iso: Any) -> datetime | None:
    """Best-effort due-date parse for derivation; ``None`` when absent or
    unparseable (an unparseable due date cannot make a debt louder)."""
    if not isinstance(due_iso, str) or not due_iso:
        return None
    try:
        due = datetime.fromisoformat(due_iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    return due


def effective_debt_status(record: dict[str, Any], *, now: datetime | None = None) -> str:
    """CONTRACTS §6.6: ``OPEN | IN_PROGRESS`` past ``due_date`` IS overdue.

    OVERDUE is a derived status — no date-driven writer lane exists or is
    needed, and deriving it does not conflict with "no state change without
    operator action or fix-shipped event" (a derivation changes no store).
    """
    status = record.get("current_status") or "OPEN"
    if status in ("OPEN", "IN_PROGRESS"):
        due = _parse_due_date(record.get("due_date"))
        if due is not None and due < (now if now is not None else _utc_now()):
            return "OVERDUE"
    return status


def is_unresolved_debt(record: dict[str, Any], *, now: datetime | None = None) -> bool:
    """The one open-debt predicate: an overdue debt never leaves the open
    count, in any consumer."""
    return effective_debt_status(record, now=now) in UNRESOLVED_DEBT_STATUSES


def is_closed_debt(record: dict[str, Any], *, now: datetime | None = None) -> bool:
    return effective_debt_status(record, now=now) in CLOSED_DEBT_STATUSES


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
    probe_session: GitProbeSession | None = None,
) -> dict[str, Any]:
    """``probe_session`` is the emitting decision's one git-probe session
    (evidence_probe); the ref is graded through it so the debt's baseline
    resolution and probe clock belong to the decision, not to this call."""
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
                probe_session=probe_session,
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
        # E21-d audit catch (ORPHAN-693) — twin of finding.py's fix: under
        # ARIA_REPO_STATE_ROOT the store lives outside the repo tree.
        "source_ledger": _events_path(repo_root).relative_to(
            debts_dir(repo_root).parent
        ).as_posix(),
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
                # Derived at read (CONTRACTS §6.6): a debt past its due date
                # lists as OVERDUE without any date-driven writer lane.
                "effective_status": effective_debt_status(doc),
                "due_date": doc.get("due_date"),
                "permanent_fix_owner": doc.get("permanent_fix_owner"),
                "path": f"{debt_id}.json",
                "source_event_id": doc.get("source_event_id"),
                "source_ledger_hash": doc.get("source_ledger_hash"),
            }
        )
    index["debts"] = rows
    atomic_write_json(_index_path(repo_root), index)
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
    # One probe session per emitted debt — the decision's, threaded into
    # every evidence grade it makes (one ref today; the shape holds for N).
    short_term_action = _validate_short_term_action(
        short_term_action, repo_root=repo_path, probe_session=GitProbeSession(),
    )

    debts_root = debts_dir(repo_path)
    debts_root.mkdir(parents=True, exist_ok=True)
    from .file_lock import with_exclusive_lock
    with with_exclusive_lock(debts_root / ".alloc.lock", timeout_seconds=5.0):
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
        output_path = debts_root / f"{debt_id}.json"
        if output_path.exists():
            raise GovernanceError(f"debt {debt_id} already exists at {output_path}")
        atomic_write_json(output_path, record)
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
            # E21-d audit catch (ORPHAN-693) — twin of finding.py's fix.
            "path": output_path.relative_to(debts_root.parent).as_posix(),
        },
    )
    return record


def list_debts(repo_root: str | Path) -> list[dict[str, Any]]:
    repo_path = Path(repo_root).resolve()
    return list(_refresh_index(repo_path).get("debts", []))


def transition_debt(
    *,
    repo_root: str | Path,
    debt_id: str,
    to_status: str,
    by: str,
    base_dir: str | Path | None = None,
    note: str | None = None,
    fix_merge_sha: str | None = None,
    withdrawn_reason: str | None = None,
) -> dict[str, Any]:
    """Move a debt through the CONTRACTS §6.6 state machine.

    The ONE writable path for a status change: every transition lands as a
    hash-chained ``debt_status_changed`` event in debt-events.jsonl, never
    as a hand edit of a committed JSON (ARIA-LOW-605).

    - ``OPEN -> IN_PROGRESS`` — ``by`` must be an operator act
      (``manual:operator`` / ``operator:<name>``) or a commit ref
      (``commit:<40-hex>``).
    - ``-> RESOLVED`` — fix-shipped: ``fix_merge_sha`` (40-hex, the merge
      that shipped the permanent fix) plus a re-verified originating
      evidence chain (the finding must still exist and still carry the
      chain the debt was emitted against).
    - ``-> WITHDRAWN`` — operator act with a ``withdrawn_reason`` that
      passes the banned-phrase gate.
    - ``-> OVERDUE`` — refused; OVERDUE is derived from ``due_date``.
    """
    from .runtime_profile import enforce_profile_for_write

    enforce_profile_for_write("debt", base_dir=base_dir)
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)

    if to_status == "OVERDUE":
        raise GovernanceError(
            "OVERDUE is derived from due_date (effective_debt_status); "
            "no event may set it directly"
        )
    if to_status not in DEBT_STATUSES:
        raise GovernanceError(f"unknown debt status {to_status!r}")

    debts_root = debts_dir(repo_path)
    debts_root.mkdir(parents=True, exist_ok=True)
    from .file_lock import with_exclusive_lock

    now = _utc_now()
    with with_exclusive_lock(debts_root / ".alloc.lock", timeout_seconds=5.0):
        replayed = _replay_debts(repo_path)
        doc = replayed.get(debt_id)
        if doc is None:
            raise GovernanceError(f"debt {debt_id} not found")
        stored = doc.get("current_status")
        if to_status not in DEBT_TRANSITIONS.get(stored, ()):
            raise GovernanceError(
                f"illegal debt transition {stored} -> {to_status} on {debt_id} "
                f"(allowed from {stored}: {DEBT_TRANSITIONS.get(stored, ())})"
            )
        if not isinstance(by, str) or not by.strip():
            raise GovernanceError("a debt transition requires who (by)")
        if note is not None:
            _check_banned_phrases(note, field="note")
        if to_status == "IN_PROGRESS":
            if not (_is_commit_ref(by) or _OPERATOR_ACT_RE.match(by)):
                raise GovernanceError(
                    "OPEN -> IN_PROGRESS needs an operator act or a commit ref "
                    f"as `by` (e.g. 'commit:<40-hex>', 'manual:operator'), got {by!r}"
                )
        if to_status == "RESOLVED":
            if not _is_merge_sha(fix_merge_sha):
                raise GovernanceError(
                    "RESOLVED is fix-shipped: fix_merge_sha must be the full merge sha "
                    "(a 40-hex SHA-1 or 64-hex SHA-256 git object id) that shipped "
                    "the permanent fix"
                )
            _verify_originating_evidence_chain(repo_path, doc)
        if to_status == "WITHDRAWN":
            if not isinstance(withdrawn_reason, str) or not withdrawn_reason.strip():
                raise GovernanceError(
                    "WITHDRAWN is an operator act: withdrawn_reason is required"
                )
            _check_banned_phrases(withdrawn_reason, field="withdrawn_reason")

        events = load_declared_jsonl(
            _events_path(repo_path), expected_surface="repo_debt_events"
        )
        prior = sum(
            1
            for e in events
            if e.get("event") == "debt_status_changed" and e.get("debt_id") == debt_id
        )
        event: dict[str, Any] = {
            "schema_version": 1,
            "event": "debt_status_changed",
            "event_id": f"debt:{debt_id}:status:{prior + 1:03d}",
            "debt_id": debt_id,
            "from_status": stored,
            "to_status": to_status,
            "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "by": by,
            "authority": "kernel",
        }
        if note:
            event["note"] = note
        if to_status == "RESOLVED":
            event["resolved_by_commit"] = fix_merge_sha
        if to_status == "WITHDRAWN":
            event["withdrawn_reason"] = withdrawn_reason
        append_declared_jsonl(
            _events_path(repo_path), event, expected_surface="repo_debt_events"
        )
        _refresh_index(repo_path)

    append_tools_governance(
        tools_root,
        "debt_status_changed",
        {
            "debt_id": debt_id,
            "from_status": stored,
            "to_status": to_status,
            "by": by,
            **({"resolved_by_commit": fix_merge_sha} if to_status == "RESOLVED" else {}),
        },
    )
    return _replay_debts(repo_path)[debt_id]


def _verify_originating_evidence_chain(repo_path: Path, doc: dict[str, Any]) -> None:
    """RESOLVED re-verifies the originating evidence chain (CONTRACTS §6.6):
    the finding the debt was emitted against must still exist and still
    carry that chain. The chain identity — not a re-grade of its refs — is
    what is verifiable after a fix lands (the fix changes the cited files;
    refs going stale is the fix working, the chain moving is not)."""
    finding_id = doc.get("originating_finding_id")
    chain_id = doc.get("originating_finding_evidence_chain_id")
    if chain_id:
        finding = find_by_evidence_chain_id(repo_path, str(chain_id))
        if finding is None:
            raise GovernanceError(
                f"originating finding {finding_id!r} no longer carries evidence "
                f"chain {chain_id!r}; RESOLVED needs a re-verified chain"
            )
        if finding.get("finding_id") != finding_id:
            raise GovernanceError(
                f"evidence chain {chain_id!r} moved to {finding.get('finding_id')!r}; "
                "relink the debt before resolving it"
            )
    else:
        try:
            show_finding(repo_path, str(finding_id))
        except GovernanceError as exc:
            raise GovernanceError(
                f"originating finding for the debt is not re-verifiable: {exc}"
            ) from exc


def import_committed_debts(
    *, repo_root: str | Path, base_dir: str | Path | None = None
) -> dict[str, Any]:
    """Replay every committed ``aria-debts/DEBT-*.json`` into the
    debt-events ledger, idempotently (ARIA-LOW-605).

    The committed JSONs are git-tracked operator documents whose statuses
    were historically set by hand; this verb adopts that history into the
    hash-chained ledger (the SSoT seam at ``debts_dir()``) so replay and
    the committed corpus cannot drift. Each status row lands as a
    ``debt_status_changed`` event stamped ``authority: committed-import``
    with a deterministic event id, so a second run appends nothing, and a
    later hand edit of a committed JSON surfaces here as a named refusal
    instead of silently diverging.
    """
    from .runtime_profile import enforce_profile_for_write

    enforce_profile_for_write("debt", base_dir=base_dir)
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_binding(base_dir, workspace_root=repo_path)
    committed_dir = repo_path / "aria-debts"

    debts_root = debts_dir(repo_path)
    debts_root.mkdir(parents=True, exist_ok=True)
    from .file_lock import with_exclusive_lock

    imported: list[str] = []
    appended = 0
    with with_exclusive_lock(debts_root / ".alloc.lock", timeout_seconds=5.0):
        events = load_declared_jsonl(
            _events_path(repo_path), expected_surface="repo_debt_events"
        )
        known_ids = {str(e.get("event_id")) for e in events}
        emitted_ids = {
            str(e.get("debt_id")) for e in events if e.get("event") == "debt_emitted"
        }
        replayed = _replay_debts(repo_path)
        for path in sorted(committed_dir.glob("DEBT-*.json")):
            debt_id = path.name[: -len(".json")]
            if not DEBT_ID_RE.match(debt_id):
                raise GovernanceError(
                    f"committed debt file {path.name} is not a debt id"
                )
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise GovernanceError(
                    f"committed debt {debt_id} is unreadable: {exc}"
                ) from exc
            if not isinstance(record, dict) or record.get("debt_id") != debt_id:
                raise GovernanceError(
                    f"committed debt {debt_id} disagrees with its own debt_id"
                )
            history = record.get("status_history")
            history = history if isinstance(history, list) else []
            _validate_committed_history(debt_id, record, history)
            batch: list[dict[str, Any]] = []
            if debt_id not in emitted_ids:
                emission_record = dict(record)
                emission_record["current_status"] = history[0]["status"]
                emission_record["status_history"] = [history[0]]
                emission_record["resolved_at"] = None
                emission_record["resolved_by_commit"] = None
                emission_record["withdrawn_reason"] = None
                batch.append(
                    {
                        "schema_version": 1,
                        "event": "debt_emitted",
                        "event_id": f"debt:{debt_id}:emitted",
                        "debt_id": debt_id,
                        "originating_finding_id": record.get("originating_finding_id"),
                        "record": emission_record,
                        "authority": "committed-import",
                    }
                )
            current = replayed.get(debt_id, {}).get("current_status") or history[0]["status"]
            for index, row in enumerate(history[1:], start=1):
                event_id = f"debt:{debt_id}:imported:{index:03d}"
                if event_id in known_ids:
                    # Already adopted; keep pace with the ledger's state.
                    current = row["status"]
                    continue
                if history[index - 1]["status"] != current:
                    raise GovernanceError(
                        f"committed debt {debt_id} history row {index} follows "
                        f"{history[index - 1]['status']!r} but the ledger is at "
                        f"{current!r}; the committed corpus and the ledger have "
                        "drifted (import refuses to launder it)"
                    )
                event: dict[str, Any] = {
                    "schema_version": 1,
                    "event": "debt_status_changed",
                    "event_id": event_id,
                    "debt_id": debt_id,
                    "from_status": current,
                    "to_status": row["status"],
                    "history_row": dict(row),
                    "authority": "committed-import",
                }
                if row["status"] == "RESOLVED" and record.get("resolved_by_commit"):
                    event["resolved_by_commit"] = record["resolved_by_commit"]
                if row["status"] == "WITHDRAWN" and record.get("withdrawn_reason"):
                    event["withdrawn_reason"] = record["withdrawn_reason"]
                batch.append(event)
                current = row["status"]
            if batch:
                append_declared_jsonl_rows(
                    _events_path(repo_path), batch, expected_surface="repo_debt_events"
                )
                appended += len(batch)
                imported.append(debt_id)
        _refresh_index(repo_path)

    if appended:
        append_tools_governance(
            tools_root,
            "debt_imported",
            {"debts": imported, "appended_events": appended},
        )
    return {
        "debts": sorted(p.name[: -len(".json")] for p in committed_dir.glob("DEBT-*.json")),
        "imported": imported,
        "appended_events": appended,
    }


def _validate_committed_history(
    debt_id: str, record: dict[str, Any], history: list[Any]
) -> None:
    if not history or not all(isinstance(row, dict) for row in history):
        raise GovernanceError(f"committed debt {debt_id} has no usable status_history")
    if history[0].get("status") != "OPEN":
        raise GovernanceError(
            f"committed debt {debt_id} history does not start at OPEN"
        )
    for row in history:
        if row.get("status") not in DEBT_STATUSES:
            raise GovernanceError(
                f"committed debt {debt_id} history has unknown status "
                f"{row.get('status')!r}"
            )
    final = record.get("current_status")
    if history[-1].get("status") != final:
        raise GovernanceError(
            f"committed debt {debt_id} current_status {final!r} disagrees with "
            f"its last history row {history[-1].get('status')!r}"
        )
    if final == "WITHDRAWN" and not str(record.get("withdrawn_reason") or "").strip():
        raise GovernanceError(
            f"committed debt {debt_id} is WITHDRAWN without a withdrawn_reason"
        )


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
        kind = event.get("event")
        if kind == "debt_emitted":
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
        elif kind == "debt_status_changed":
            _apply_status_event(debts, event)
        # Unknown event kinds are not state changes; skip them.
    return debts


def _apply_status_event(
    debts: dict[str, dict[str, Any]], event: dict[str, Any]
) -> None:
    """Apply one ``debt_status_changed`` event under the state machine.

    The chain must be continuous (``from_status`` equals the stored status)
    for every event, and a kernel-authority event (anything not stamped
    ``committed-import``) must also be table-legal and carry its target's
    required evidence — the machine is enforced at read, so a well-chained
    but illegal row cannot launder state through replay.
    """
    debt_id = str(event.get("debt_id") or "")
    doc = debts.get(debt_id)
    if doc is None:
        raise GovernanceError(
            f"debt event {event.get('event_id')!r} transitions unknown debt {debt_id!r}"
        )
    stored = doc.get("current_status")
    from_status = event.get("from_status")
    if from_status != stored:
        raise GovernanceError(
            f"debt event {event.get('event_id')!r} from_status {from_status!r} "
            f"does not match stored status {stored!r}"
        )
    to_status = event.get("to_status")
    if to_status not in DEBT_STATUSES:
        raise GovernanceError(
            f"debt event {event.get('event_id')!r} has unknown to_status {to_status!r}"
        )
    imported = event.get("authority") == "committed-import"
    if not imported:
        if to_status not in DEBT_TRANSITIONS.get(stored, ()):
            raise GovernanceError(
                f"illegal debt transition {stored} -> {to_status} "
                f"on {debt_id} (event {event.get('event_id')!r})"
            )
        if to_status == "WITHDRAWN" and not str(event.get("withdrawn_reason") or "").strip():
            raise GovernanceError(
                f"debt event {event.get('event_id')!r} withdraws {debt_id} without a withdrawn_reason"
            )
        if to_status == "RESOLVED" and not _is_merge_sha(event.get("resolved_by_commit")):
            raise GovernanceError(
                f"debt event {event.get('event_id')!r} resolves {debt_id} without a fix merge sha"
            )
    if imported and isinstance(event.get("history_row"), dict):
        history_row = dict(event["history_row"])
    else:
        history_row = {
            "status": to_status,
            "at": event.get("at"),
            "by": event.get("by"),
        }
        if event.get("note"):
            history_row["note"] = event["note"]
    doc["current_status"] = to_status
    doc["status_history"] = [*doc.get("status_history", []), history_row]
    if to_status == "WITHDRAWN":
        doc["withdrawn_reason"] = event.get("withdrawn_reason")
    elif to_status == "RESOLVED":
        doc["resolved_at"] = history_row.get("at")
        if event.get("resolved_by_commit"):
            doc["resolved_by_commit"] = event["resolved_by_commit"]
