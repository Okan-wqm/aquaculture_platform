"""V9.5 check 12 — operator-feedback ingestion, the binding a merge reads back, and spends.

WHY: the contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12,
superseded for request rows by ADR-0020) has three parts: the synthesizer
must DROP a request row whose signature is missing or invalid, must record
ONE ``unsigned_operator_feedback`` governance event per drop, and the
pre-merge predicate must prove — from captured evidence, not from a flag —
that the rule was applied to the synthesis the merged plan came from.

WHAT: :func:`ingest_operator_feedback` is the one reader of the ledger for
plan-candidate purposes.

* It reads the feedback ledger the way the merge owner reads it: only the
  hash-chain-verified prefix can be admitted; every request row after a
  chain break is refused by name (``ledger_chain_broken``, review round 2
  GSEC-MEDIUM-004).
* Every request is verified against the allowed-signers file committed at
  the cycle checkout's commit, proven on ``main`` (:mod:`main_anchor`,
  ADR-0020); the anchor commit and blob id are recorded on the scan row.
* A request is admitted once, keyed on its signed id
  (:mod:`operator_request_spend`, ADR-0018 D3): spent and reused ids come
  from the kernel's own hash-chained ingestion history, independent of where
  a row sits in the feedback ledger; a validly signed row that is expired,
  for another audience, or malformed is refused AND spent
  (``request_refused``); a runner fault (no anchor, no verifier) is reported
  and never spends.
* A drop already reported is not announced again (GSEC-LOW-009).

When the provider selects a candidate, :func:`bind_plan_synthesis` appends a
``synthesis_bound`` row joining the scan to the synthesized ``plan_content``
by content hash; :func:`record_request_refused` spends a request whose
target is not a plan ground. The merge owner's walk lives in
:mod:`operator_feedback_observation`.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .operator_feedback_signature import (
    OPERATOR_FEEDBACK_LEDGER_NAME,
    is_operator_request_row,
    operator_request_schema_reason,
)
from .operator_request_signature import (
    ALLOWED_SIGNERS_UNAVAILABLE,
    VERIFICATION_RUNNER_FAULTS,
    allowed_signers_for_checkout,
    request_subject_digest,
    verify_operator_request,
)
from .operator_request_spend import (
    INGESTION_ROW_TYPE,
    REQUEST_REFUSAL_REASONS,
    REQUEST_REFUSED_ROW_TYPE,
    SYNTHESIS_BOUND_ROW_TYPE,
    RequestHistory,
    drop_key,
    request_history,
    started_plan_hashes,
)
from .plan_candidate_source import PlanCandidateSource
from .tool_registry import GovernanceError, ensure_tools_dir_readonly, utc_now

INGESTION_SURFACE = "operator_feedback_ingestion"
INGESTION_LEDGER_NAME = "operator-feedback-ingestion.jsonl"
UNSIGNED_OPERATOR_FEEDBACK_EVENT = "unsigned_operator_feedback"
# A row whose id the kernel already holds under another signed subject, or
# two subjects sharing one id in one scan: the id, not the position, is the
# request, so neither is admitted and neither spends the other.
REQUEST_ID_REUSED = "request_id_reused"
# A byte-identical copy of an admitted request: the request is admitted
# once; the copy is reported, not planned twice.
REQUEST_DUPLICATE_COPY = "request_duplicate_copy"
# A row after the first hash-chain break: the merge owner cannot vouch for
# it, so the synthesizer does not admit it either.
LEDGER_CHAIN_BROKEN = "ledger_chain_broken"
# The ``plan_content.provenance_refs`` entry the synthesizer writes for a
# consumed request row; the pre-merge join reads it back to prove the plan
# consumed exactly what the ingestion admitted. Provenance, never evidence:
# the row is ARIA's own ledger, which no challenger may cite (ORPHAN-HIGH-519).
PROVENANCE_REF_PREFIX = "aria-tools/operator-feedback.jsonl:"
_INGESTION_SCHEMA_VERSION = 3


@dataclass(frozen=True)
class OperatorFeedbackIngestion:
    """What one scan admitted, dropped and found spent, plus the ledger row that recorded it."""

    ledger_hash: str | None
    admitted: tuple[dict[str, Any], ...]
    dropped: tuple[dict[str, Any], ...]
    candidates: tuple[dict[str, Any], ...] = field(default=())
    spent: tuple[dict[str, Any], ...] = field(default=())


def ingestion_ledger_path(base_dir: str | Path) -> Path:
    return Path(base_dir) / INGESTION_LEDGER_NAME


def _tools_root(base_dir: str | Path | None) -> Path:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        # Never create a tools root from a scanner: an implicit root is the
        # shadow-tree defect (tool_registry.tools_dir docstring).
        raise GovernanceError("operator_feedback_tools_root_unavailable")
    return root


def request_history_for(root: Path) -> RequestHistory:
    """Claimed, spent and reported ids from the kernel's own hash-chained ledgers."""
    from .ledger import load_declared_jsonl

    ingestion_path = ingestion_ledger_path(root)
    ingestion_rows = (load_declared_jsonl(ingestion_path, expected_surface=INGESTION_SURFACE)
                      if ingestion_path.exists() else [])
    # The plan ledger read the way the merge owner reads it, not through
    # plan_convergence.events_path: that accessor runs ensure_tools_dir, and
    # a scanner never mutates the tools root.
    plans = root / "plans" / "events.jsonl"
    plan_events = (load_declared_jsonl(plans, expected_surface="plan_convergence_events")
                   if plans.exists() else [])
    return request_history(ingestion_rows=ingestion_rows, started_hashes=started_plan_hashes(plan_events))


def _read_feedback_ledger(ledger: Path) -> tuple[list[dict[str, Any]], list[Any]] | None:
    """(verified prefix rows, rows after the first chain break), or None when unreadable.

    The same verified-prefix reader the merge owner uses
    (``merge_authority._capture_pre_merge_context``): a row is admissible
    only while every row before it chains.
    """
    from .ledger import _verify_jsonl_from_text, torn_tail_length
    from .state_store import StateStoreError, _read_bounded_regular_file

    try:
        text = _read_bounded_regular_file(ledger)[0].decode("utf-8")
    except (OSError, StateStoreError, UnicodeDecodeError):
        return None
    verdict, verified = _verify_jsonl_from_text(ledger, text, expected_surface="operator_feedback")
    if verdict.get("valid", False):
        return verified, []
    # The walk stops at the first row that does not chain, so the verified
    # rows are exactly the first len(verified) non-empty lines; everything
    # after them is the unvouched tail (the verdict's own line number is the
    # decoder's line within one row on a parse error, not a ledger line).
    body = text[: len(text) - torn_tail_length(text)]
    lines = [line for line in body.splitlines() if line.strip()]
    tail: list[Any] = []
    for line in lines[len(verified):]:
        try:
            tail.append(json.loads(line))
        except ValueError:
            tail.append(line)
    return verified, tail


def _row_key(row: Any) -> str:
    if isinstance(row, dict) and isinstance(row.get("ledger_hash"), str) and row["ledger_hash"]:
        return row["ledger_hash"]
    encoded = row if isinstance(row, str) else json.dumps(row, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8", errors="replace")).hexdigest()


class _Scan:
    """One ingestion's bookkeeping: drops (reported once), spends, admissions."""

    def __init__(self, root: Path, cycle_id: str | None, history: RequestHistory) -> None:
        self.root, self.cycle_id, self.history = root, cycle_id, history
        self.dropped: list[dict[str, Any]] = []
        self.refusals: list[tuple[dict[str, Any], str]] = []
        self._announced: set[str] = set()

    def drop(self, row: Any, line_no: int, reason: str, *, signer: str | None = None) -> None:
        from .operator_feedback_signature import valid_request_id
        from .tool_registry import append_tools_governance

        key = _row_key(row)
        raw_id = row.get("id") if isinstance(row, dict) else None
        row_id = raw_id if valid_request_id(raw_id) else None
        announce_key = drop_key(key, reason)
        reported_before = announce_key in self.history.reported or announce_key in self._announced
        governance_hash = None
        if not reported_before:
            self._announced.add(announce_key)
            event = append_tools_governance(self.root, UNSIGNED_OPERATOR_FEEDBACK_EVENT, {
                # Never the row body: it is untrusted text by definition.
                "id": row_id, "line_no": line_no, "reason": reason, "signer": signer,
                "row_key": key, "runner_fault": reason in VERIFICATION_RUNNER_FAULTS,
                "cycle_id": self.cycle_id,
            })
            governance_hash = event.get("ledger_hash")
        self.dropped.append({
            "id": row_id, "line_no": line_no, "reason": reason, "row_key": key,
            "runner_fault": reason in VERIFICATION_RUNNER_FAULTS,
            "reported_before": reported_before, "governance_ledger_hash": governance_hash,
        })


def ingest_operator_feedback(
    *, base_dir: str | Path | None, cycle_id: str | None, repo_root: str | Path,
    now: datetime | None = None,
) -> OperatorFeedbackIngestion:
    """Verify, refuse, spend, record. Returns the admitted rows as plan candidates.

    ``repo_root`` is the cycle's checkout: its commit, once proven on
    ``main``, holds the allowed-signers file every signature is judged
    against.
    """
    root = _tools_root(base_dir)
    moment = now or datetime.now(timezone.utc)
    ledger = root / OPERATOR_FEEDBACK_LEDGER_NAME
    history = request_history_for(root)
    signers, anchor_reason = allowed_signers_for_checkout(repo_root, base_dir=root)
    scan = _Scan(root, cycle_id, history)
    spent_rows: list[dict[str, Any]] = []
    groups: dict[str, list[tuple[dict[str, Any], str]]] = {}
    rows_scanned = 0
    read = _read_feedback_ledger(ledger) if ledger.exists() else ([], [])
    verified, tail = read if read is not None else ([], [])
    for line_no, row in enumerate(verified, start=1):
        rows_scanned += 1
        if not is_operator_request_row(row):
            continue
        verdict = verify_operator_request(row, allowed_signers=signers)
        if verdict.reason is not None:
            scan.drop(row, line_no, verdict.reason, signer=verdict.signer)
            continue
        identifier, digest = str(row.get("id")), request_subject_digest(row)
        if identifier in history.claimed and history.claimed[identifier] != digest:
            scan.drop(row, line_no, REQUEST_ID_REUSED, signer=verdict.signer)
            continue
        if identifier in history.spent:
            spent_rows.append({"id": identifier, "subject_digest": digest, "reason": history.spent[identifier]})
            continue
        schema = operator_request_schema_reason(row, now=moment, anchor=signers)
        if schema is not None:
            scan.drop(row, line_no, schema, signer=verdict.signer)
            scan.refusals.append((dict(row, _subject_digest=digest), schema))
            continue
        groups.setdefault(identifier, []).append((dict(row, _line_no=line_no, _signer=verdict.signer), digest))
    for offset, row in enumerate(tail, start=len(verified) + 1):
        rows_scanned += 1
        if not isinstance(row, dict) or is_operator_request_row(row):
            scan.drop(row, offset, LEDGER_CHAIN_BROKEN)
    admitted: list[dict[str, Any]] = []
    for identifier, entries in groups.items():
        if len({digest for _row, digest in entries}) > 1:
            # Two subjects under one id and no history to say which is the
            # request: refuse both, whatever their order (order-independent).
            for row, _digest in entries:
                scan.drop(row, row["_line_no"], REQUEST_ID_REUSED, signer=row["_signer"])
            continue
        (row, digest), copies = entries[0], entries[1:]
        for copy, _digest in copies:
            scan.drop(copy, copy["_line_no"], REQUEST_DUPLICATE_COPY, signer=copy["_signer"])
        admitted.append({
            "id": identifier, "ledger_hash": row["ledger_hash"], "signer": row["_signer"],
            "subject_digest": digest, "finding_id": row["finding_id"],
            "grounding_digest": row["grounding_digest"], "expires_at": row["expires_at"],
            "priority": row["priority"], "request": row["request"], "authored_at": row["authored_at"],
        })
    refused_ids: list[str] = []
    for row, reason in scan.refusals:
        if row["id"] in refused_ids:
            continue
        refused_ids.append(row["id"])
        record_request_refused(
            base_dir=root, cycle_id=cycle_id, request_id=row["id"],
            request_ledger_hash=row.get("ledger_hash"), subject_digest=row["_subject_digest"],
            finding_id=row.get("finding_id"), reason=reason, refused_surfaces=[],
        )
    record = append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": _INGESTION_SCHEMA_VERSION,
        "row_type": INGESTION_ROW_TYPE,
        "ingested_at": utc_now(),
        "cycle_id": cycle_id,
        "ledger_present": ledger.exists(),
        "ledger_readable": read is not None,
        "rows_scanned": rows_scanned,
        "anchor": ({"commit": signers.commit, "allowed_signers_blob": signers.blob_oid} if signers
                   else {"reason": anchor_reason or ALLOWED_SIGNERS_UNAVAILABLE}),
        "admitted": [
            {key: entry[key] for key in ("id", "ledger_hash", "signer", "subject_digest")}
            for entry in admitted
        ],
        "dropped": scan.dropped,
        "spent": spent_rows,
        "refused": refused_ids,
    }, expected_surface=INGESTION_SURFACE)
    candidates = tuple({
        "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
        "candidate_id": entry["id"],
        "finding_id": entry["finding_id"],
        "grounding_digest": entry["grounding_digest"],
        "expires_at": entry["expires_at"],
        "priority": entry["priority"],
        "request": entry["request"],
        "authored_at": entry["authored_at"],
        "signer": entry["signer"],
        "subject_digest": entry["subject_digest"],
        "row_ledger_hash": entry["ledger_hash"],
        "ingestion_ledger_hash": record.get("ledger_hash"),
        "title_hint": f"Operator request {entry['id']}",
    } for entry in admitted)
    return OperatorFeedbackIngestion(
        ledger_hash=record.get("ledger_hash"), admitted=tuple(admitted),
        dropped=tuple(scan.dropped), candidates=candidates, spent=tuple(spent_rows),
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
            "signer": candidate.get("signer"),
            "subject_digest": candidate.get("subject_digest"),
        })
    return append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": _INGESTION_SCHEMA_VERSION,
        "row_type": SYNTHESIS_BOUND_ROW_TYPE,
        "bound_at": utc_now(),
        "cycle_id": cycle_id,
        "ingestion_ledger_hash": ingestion.get("ledger_hash") if ingestion else None,
        "plan_content_hash": content_hash(plan_content),
        "candidate_id": candidate.get("candidate_id"),
        "source_type": candidate.get("source_type"),
        "consumed": consumed,
    }, expected_surface=INGESTION_SURFACE)


def record_request_refused(
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
    request_id: Any,
    request_ledger_hash: Any,
    subject_digest: Any,
    finding_id: Any,
    reason: str,
    refused_surfaces: list[dict[str, str]],
) -> dict[str, Any]:
    """ADR-0018 I4/D3 — the request is refused for a reason of its own, and spent.

    Written on the hash-chained ingestion ledger so the next ingestion reads
    it back as a spend: a refused request never re-enters the ranking at
    priority 0. Only request-intrinsic reasons are accepted; a runner fault
    is not in :data:`REQUEST_REFUSAL_REASONS`, so a transient failure cannot
    spend a request (arbiter ruling iii).
    """
    if reason not in REQUEST_REFUSAL_REASONS:
        raise GovernanceError(f"operator_request_refusal_reason_unknown: {reason!r}")
    if not isinstance(request_id, str) or not request_id:
        raise GovernanceError("operator_request_refusal_requires_request_id")
    root = _tools_root(base_dir)
    return append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": _INGESTION_SCHEMA_VERSION,
        "row_type": REQUEST_REFUSED_ROW_TYPE,
        "refused_at": utc_now(),
        "cycle_id": cycle_id,
        "id": request_id,
        "request_ledger_hash": request_ledger_hash,
        "subject_digest": subject_digest,
        "finding_id": finding_id,
        "reason": reason,
        "refused_surfaces": list(refused_surfaces),
    }, expected_surface=INGESTION_SURFACE)


__all__ = [
    "INGESTION_LEDGER_NAME",
    "INGESTION_ROW_TYPE",
    "INGESTION_SURFACE",
    "LEDGER_CHAIN_BROKEN",
    "PROVENANCE_REF_PREFIX",
    "REQUEST_DUPLICATE_COPY",
    "REQUEST_ID_REUSED",
    "SYNTHESIS_BOUND_ROW_TYPE",
    "UNSIGNED_OPERATOR_FEEDBACK_EVENT",
    "OperatorFeedbackIngestion",
    "bind_plan_synthesis",
    "ingest_operator_feedback",
    "ingestion_ledger_path",
    "latest_ingestion_for_cycle",
    "record_request_refused",
    "request_history_for",
]
