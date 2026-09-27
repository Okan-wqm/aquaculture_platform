"""V9.5 check 12 — operator-feedback ingestion, and the evidence a merge reads back.

WHY: the contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12) has
three parts and the pre-fix code had none of them: the synthesizer must
DROP a row whose ``signature``/``signer_kid`` is missing or invalid, must
record ONE ``unsigned_operator_feedback`` governance event per drop, and
the pre-merge predicate must be able to prove — from captured evidence,
not from a flag — that the rule was applied to the synthesis the merged
plan came from. Presence-checking rows and stashing a drop count on the
first surviving candidate satisfied none of those.

WHAT: :func:`ingest_operator_feedback` is the one reader of the ledger for
plan-candidate purposes. It verifies every ``unaddressed`` row through
:mod:`operator_feedback_signature`, emits the governance row per drop, and
appends an ``ingestion`` row to ``operator-feedback-ingestion.jsonl`` naming
what was admitted (by ledger hash + signer kid) and what was dropped (by
reason + governance hash). When the provider selects a candidate it appends
a ``synthesis_bound`` row joining that ingestion to the synthesized
``plan_content`` by content hash — the same hash ``plan_started`` records —
so the merge owner can walk plan → binding → ingestion → consumed rows and
re-verify each signature against the key file at merge time
(:func:`observe_operator_feedback_for_plan`). Absent evidence is a named
reason, never a pass.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .operator_feedback_signature import (
    OPERATOR_FEEDBACK_LEDGER_NAME,
    OPERATOR_REQUEST_STATUS_UNADDRESSED,
    operator_request_schema_valid,
    signing_key_path,
    verify_operator_feedback_row,
)
from .plan_candidate_source import PlanCandidateSource
from .tool_registry import GovernanceError, ensure_tools_dir_readonly, utc_now

INGESTION_SURFACE = "operator_feedback_ingestion"
INGESTION_LEDGER_NAME = "operator-feedback-ingestion.jsonl"
INGESTION_ROW_TYPE = "ingestion"
SYNTHESIS_BOUND_ROW_TYPE = "synthesis_bound"
UNSIGNED_OPERATOR_FEEDBACK_EVENT = "unsigned_operator_feedback"
SCHEMA_INVALID = "schema_invalid"
# Evidence refs the synthesizer writes for a consumed request row; the
# pre-merge join reads them back to prove the plan cites exactly what the
# ingestion admitted.
EVIDENCE_REF_PREFIX = "aria-tools/operator-feedback.jsonl:"


@dataclass(frozen=True)
class OperatorFeedbackIngestion:
    """What one scan admitted and dropped, plus the ledger row that recorded it."""

    ledger_hash: str | None
    admitted: tuple[dict[str, Any], ...]
    dropped: tuple[dict[str, Any], ...]
    candidates: tuple[dict[str, Any], ...] = field(default=())


def ingestion_ledger_path(base_dir: str | Path) -> Path:
    return Path(base_dir) / INGESTION_LEDGER_NAME


def _tools_root(base_dir: str | Path | None) -> Path:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        # Never create a tools root from a scanner: an implicit root is the
        # shadow-tree defect (tool_registry.tools_dir docstring).
        raise GovernanceError("operator_feedback_tools_root_unavailable")
    return root


def ingest_operator_feedback(
    *, base_dir: str | Path | None, cycle_id: str | None,
) -> OperatorFeedbackIngestion:
    """Verify, drop, record. Returns the admitted rows as plan candidates."""
    from .strict_jsonl_reader import read_strict_jsonl
    from .tool_registry import append_tools_governance

    root = _tools_root(base_dir)
    ledger = root / OPERATOR_FEEDBACK_LEDGER_NAME
    admitted: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    rows_scanned = 0
    if ledger.exists():
        # Tolerant per-row decoding on purpose: a hand-appended line breaks
        # the hash chain for everything after it, and the contract wants
        # each such row judged and reported individually, not the ledger
        # declared unreadable at the first bad line.
        for line_no, row in enumerate(
            read_strict_jsonl(ledger, on_corruption="tolerant", base_dir=root), start=1,
        ):
            rows_scanned += 1
            if row.get("status") != OPERATOR_REQUEST_STATUS_UNADDRESSED:
                continue
            verdict = verify_operator_feedback_row(row, base_dir=root)
            reason = verdict.reason
            if verdict.valid and not operator_request_schema_valid(row):
                reason = SCHEMA_INVALID
            if reason is not None:
                row_id = row.get("id") if isinstance(row.get("id"), str) else None
                event = append_tools_governance(root, UNSIGNED_OPERATOR_FEEDBACK_EVENT, {
                    # Never the row body: it is untrusted text by definition.
                    "id": row_id,
                    "line_no": line_no,
                    "reason": reason,
                    "signer_kid": verdict.signer_kid,
                    "cycle_id": cycle_id,
                })
                dropped.append({
                    "id": row_id, "line_no": line_no, "reason": reason,
                    "governance_ledger_hash": event.get("ledger_hash"),
                })
                continue
            admitted.append({
                "id": row["id"],
                "ledger_hash": row.get("ledger_hash"),
                "signer_kid": verdict.signer_kid,
                "priority": row["priority"],
                "request": row["request"],
                "authored_at": row["authored_at"],
            })
    record = append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": 1,
        "row_type": INGESTION_ROW_TYPE,
        "ingested_at": utc_now(),
        "cycle_id": cycle_id,
        "ledger_present": ledger.exists(),
        "rows_scanned": rows_scanned,
        "admitted": [
            {"id": entry["id"], "ledger_hash": entry["ledger_hash"], "signer_kid": entry["signer_kid"]}
            for entry in admitted
        ],
        "dropped": dropped,
    }, expected_surface=INGESTION_SURFACE)
    candidates = tuple({
        "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
        "candidate_id": entry["id"],
        "priority": entry["priority"],
        "request": entry["request"],
        "authored_at": entry["authored_at"],
        "signer_kid": entry["signer_kid"],
        "row_ledger_hash": entry["ledger_hash"],
        "ingestion_ledger_hash": record.get("ledger_hash"),
        "title_hint": f"Operator request {entry['id']}",
    } for entry in admitted)
    return OperatorFeedbackIngestion(
        ledger_hash=record.get("ledger_hash"), admitted=tuple(admitted),
        dropped=tuple(dropped), candidates=candidates,
    )


def latest_ingestion_for_cycle(
    *, base_dir: str | Path, cycle_id: str | None,
) -> dict[str, Any] | None:
    from .ledger import load_declared_jsonl

    path = ingestion_ledger_path(base_dir)
    if not path.exists():
        return None
    rows = [row for row in load_declared_jsonl(path, expected_surface=INGESTION_SURFACE)
            if row.get("row_type") == INGESTION_ROW_TYPE and row.get("cycle_id") == cycle_id]
    return rows[-1] if rows else None


def bind_plan_synthesis(
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
    plan_content: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    """Join the selected synthesis to the ingestion that preceded it.

    The binding names the ingestion row by ledger hash and the plan by
    ``content_hash(plan_content)`` — the value ``plan_started`` will carry,
    so the merge owner joins on a hash it already verified. A missing
    ingestion is RECORDED as missing (``ingestion_ledger_hash`` null): the
    pre-merge predicate turns that into a refusal, and a binding that lied
    about having ingested would be worse than one that says it did not.
    """
    from .plan_convergence import content_hash

    root = _tools_root(base_dir)
    ingestion = latest_ingestion_for_cycle(base_dir=root, cycle_id=cycle_id)
    consumed: list[dict[str, Any]] = []
    if candidate.get("source_type") == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        consumed.append({
            "id": candidate.get("candidate_id"),
            "ledger_hash": candidate.get("row_ledger_hash"),
            "signer_kid": candidate.get("signer_kid"),
        })
    return append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": 1,
        "row_type": SYNTHESIS_BOUND_ROW_TYPE,
        "bound_at": utc_now(),
        "cycle_id": cycle_id,
        "ingestion_ledger_hash": ingestion.get("ledger_hash") if ingestion else None,
        "plan_content_hash": content_hash(plan_content),
        "candidate_id": candidate.get("candidate_id"),
        "source_type": candidate.get("source_type"),
        "consumed": consumed,
    }, expected_surface=INGESTION_SURFACE)


def _consumed_refs(plan_content: Any) -> set[str]:
    refs = plan_content.get("evidence_refs") if isinstance(plan_content, dict) else None
    return {
        str(ref)[len(EVIDENCE_REF_PREFIX):]
        for ref in (refs or []) if isinstance(ref, str) and ref.startswith(EVIDENCE_REF_PREFIX)
    }


def observe_operator_feedback_for_plan(
    *,
    tools: Path,
    plan_started: dict[str, Any] | None,
    ingestion_rows: list[dict[str, Any]],
    feedback_rows: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
    """The pre-merge observation: walk plan → binding → ingestion → rows.

    Reads only verified prefixes the merge owner captured (it rechecks them
    after this returns) plus the key file, whose bytes are returned so the
    same recheck covers a rotation racing the capture. Every gap is a named
    ``operator_feedback_unavailable_reason``; the predicate never infers a
    pass from an empty field.
    """
    from .state_store import StateStoreError as _StateStoreError
    from .state_store import _read_bounded_regular_file

    observation: dict[str, Any] = {}
    files: dict[Path, bytes | None] = {}
    reason = "operator_feedback_plan_start_unavailable"
    try:
        if not isinstance(plan_started, dict):
            raise GovernanceError(reason)
        started_hash = plan_started.get("content_hash")
        started_content = plan_started.get("plan_content")
        if not isinstance(started_hash, str) or not started_hash or not isinstance(started_content, dict):
            raise GovernanceError(reason)
        observation["operator_feedback_plan_started_hash"] = started_hash
        reason = "operator_feedback_synthesis_binding_unavailable"
        bindings = [row for row in ingestion_rows
                    if row.get("row_type") == SYNTHESIS_BOUND_ROW_TYPE
                    and row.get("plan_content_hash") == started_hash]
        if not bindings:
            raise GovernanceError(reason)
        binding = bindings[-1]
        observation["operator_feedback_binding_hash"] = binding["ledger_hash"]
        observation["operator_feedback_bound_content_hash"] = binding["plan_content_hash"]
        reason = "operator_feedback_ingestion_unavailable"
        ingestion_hash = binding.get("ingestion_ledger_hash")
        ingestions = [row for row in ingestion_rows
                      if row.get("row_type") == INGESTION_ROW_TYPE
                      and ingestion_hash and row.get("ledger_hash") == ingestion_hash]
        if len(ingestions) != 1 or ingestions[0].get("cycle_id") != binding.get("cycle_id"):
            raise GovernanceError(reason)
        ingestion = ingestions[0]
        observation["operator_feedback_ingestion_hash"] = ingestion["ledger_hash"]
        dropped = ingestion.get("dropped")
        admitted = ingestion.get("admitted")
        if not isinstance(dropped, list) or not isinstance(admitted, list):
            raise GovernanceError(reason)
        observation["operator_feedback_dropped_count"] = len(dropped)
        reason = "operator_feedback_consumption_mismatch"
        consumed = binding.get("consumed")
        if not isinstance(consumed, list):
            raise GovernanceError(reason)
        consumed_ids = {str(entry.get("id")) for entry in consumed if isinstance(entry, dict)}
        if consumed_ids != _consumed_refs(started_content):
            raise GovernanceError(reason)
        admitted_hashes = {(entry.get("id"), entry.get("ledger_hash"), entry.get("signer_kid"))
                           for entry in admitted if isinstance(entry, dict)}
        for entry in consumed:
            if (entry.get("id"), entry.get("ledger_hash"), entry.get("signer_kid")) not in admitted_hashes:
                raise GovernanceError(reason)
        key_path = signing_key_path(tools)
        try:
            files[key_path] = _read_bounded_regular_file(key_path)[0]
        except (OSError, _StateStoreError):
            files[key_path] = None
        reason = "operator_feedback_consumed_row_unavailable"
        row_hashes: list[str] = []
        signer_kids: list[str] = []
        for entry in consumed:
            matches = [row for row in feedback_rows
                       if row.get("ledger_hash") == entry.get("ledger_hash")
                       and row.get("id") == entry.get("id")
                       and row.get("signer_kid") == entry.get("signer_kid")]
            if len(matches) != 1:
                raise GovernanceError(reason)
            verdict = verify_operator_feedback_row(matches[0], base_dir=tools)
            if not verdict.valid:
                # The synthesis consumed a row the store can no longer vouch
                # for at merge time — a lost or rotated-out key, or a
                # rewritten row.
                raise GovernanceError("operator_feedback_consumed_row_unsigned:" + str(verdict.reason))
            row_hashes.append(str(entry["ledger_hash"]))
            signer_kids.append(str(entry["signer_kid"]))
        observation["operator_feedback_consumed_row_hashes"] = tuple(row_hashes)
        observation["operator_feedback_consumed_signer_kids"] = tuple(signer_kids)
        observation["operator_feedback_verified"] = True
        return observation, files
    except (GovernanceError, KeyError, TypeError, ValueError) as exc:
        observation["operator_feedback_verified"] = False
        observation["operator_feedback_unavailable_reason"] = (
            str(exc) if isinstance(exc, GovernanceError) and str(exc) else reason
        )
        return observation, files


__all__ = [
    "EVIDENCE_REF_PREFIX",
    "INGESTION_LEDGER_NAME",
    "INGESTION_ROW_TYPE",
    "INGESTION_SURFACE",
    "SCHEMA_INVALID",
    "SYNTHESIS_BOUND_ROW_TYPE",
    "UNSIGNED_OPERATOR_FEEDBACK_EVENT",
    "OperatorFeedbackIngestion",
    "bind_plan_synthesis",
    "ingest_operator_feedback",
    "ingestion_ledger_path",
    "latest_ingestion_for_cycle",
    "observe_operator_feedback_for_plan",
]
