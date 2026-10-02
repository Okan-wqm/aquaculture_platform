"""V9.5 check 12 — operator-feedback ingestion, and the evidence a merge reads back.

WHY: the contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12,
superseded for request rows by ADR-0020) has three parts: the synthesizer
must DROP a request row whose signature is missing or invalid, must record
ONE ``unsigned_operator_feedback`` governance event per drop, and the
pre-merge predicate must prove — from captured evidence, not from a flag —
that the rule was applied to the synthesis the merged plan came from.

WHAT: :func:`ingest_operator_feedback` is the one reader of the ledger for
plan-candidate purposes. Every request row is verified against the
allowed-signers file committed at the cycle checkout's HEAD
(:mod:`operator_request_signature`, ADR-0020) and must name an F finding
(ADR-0018); a request is admitted once — a spent request (ADR-0018 D3,
:mod:`operator_request_spend`) and a reused id are not admitted again. The
scan appends an ``ingestion`` row naming what was admitted (ledger hash +
signer), dropped (reason + governance hash) and spent. When the provider
selects a candidate it appends a ``synthesis_bound`` row joining that
ingestion to the synthesized ``plan_content`` by content hash — the hash
``plan_started`` records — and a request whose finding is not a plan ground
gets a ``request_refused`` row (:func:`record_request_refused`). The merge
owner walks plan → binding → ingestion → consumed rows and re-verifies each
signature against the allowed-signers file committed on ``main``
(:func:`observe_operator_feedback_for_plan`), so no key file and no runner
state is needed on the GitHub-hosted lane. Absent evidence is a named
reason, never a pass.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .operator_feedback_signature import (
    OPERATOR_FEEDBACK_LEDGER_NAME,
    SCHEMA_INVALID,
    is_operator_request_row,
    operator_request_schema_reason,
)
from .operator_request_signature import committed_allowed_signers, verify_operator_request
from .operator_request_spend import (
    REQUEST_REFUSAL_REASONS,
    REQUEST_REFUSED_ROW_TYPE,
    SYNTHESIS_BOUND_ROW_TYPE,
    request_key,
    spent_requests,
    started_plan_hashes,
)
from .plan_candidate_source import PlanCandidateSource
from .tool_registry import GovernanceError, ensure_tools_dir_readonly, utc_now

INGESTION_SURFACE = "operator_feedback_ingestion"
INGESTION_LEDGER_NAME = "operator-feedback-ingestion.jsonl"
INGESTION_ROW_TYPE = "ingestion"
UNSIGNED_OPERATOR_FEEDBACK_EVENT = "unsigned_operator_feedback"
# A second row reusing an admitted or spent request's id: a replayed copy of
# a signed row verifies (same bytes), so the id — not the signature — is
# what makes the request single-use.
REQUEST_ID_REUSED = "request_id_reused"
# Evidence refs the synthesizer writes for a consumed request row; the
# pre-merge join reads them back to prove the plan cites exactly what the
# ingestion admitted.
EVIDENCE_REF_PREFIX = "aria-tools/operator-feedback.jsonl:"


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


def _spent_requests(root: Path) -> dict[tuple[str, str], str]:
    from .ledger import load_declared_jsonl

    ingestion_path = ingestion_ledger_path(root)
    ingestion_rows = (load_declared_jsonl(ingestion_path, expected_surface=INGESTION_SURFACE)
                      if ingestion_path.exists() else [])
    # The plan ledger read the way the merge owner reads it
    # (merge_authority's `plan_convergence_events` source), not through
    # plan_convergence.events_path: that accessor runs ensure_tools_dir, and
    # a scanner never mutates the tools root.
    plans = root / "plans" / "events.jsonl"
    plan_events = (load_declared_jsonl(plans, expected_surface="plan_convergence_events")
                   if plans.exists() else [])
    return spent_requests(ingestion_rows=ingestion_rows, started_hashes=started_plan_hashes(plan_events))


def ingest_operator_feedback(
    *, base_dir: str | Path | None, cycle_id: str | None, repo_root: str | Path,
) -> OperatorFeedbackIngestion:
    """Verify, refuse reuse, skip spent, record. Returns the admitted rows as plan candidates.

    ``repo_root`` is the cycle's checkout: its HEAD commit holds the
    allowed-signers file every signature is judged against.
    """
    from .strict_jsonl_reader import read_strict_jsonl
    from .tool_registry import append_tools_governance

    root = _tools_root(base_dir)
    ledger = root / OPERATOR_FEEDBACK_LEDGER_NAME
    admitted: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    spent_rows: list[dict[str, Any]] = []
    rows_scanned = 0
    if ledger.exists():
        allowed_signers = committed_allowed_signers(repo_root, rev="HEAD")
        spent = _spent_requests(root)
        # The id each request already holds on the ledger: only spent or
        # verified rows claim one, so an unsigned line cannot squat an id.
        claimed_ids: dict[str, str] = {}
        # Tolerant per-row decoding on purpose: a hand-appended line breaks
        # the hash chain for everything after it, and the contract wants
        # each such row judged and reported individually, not the ledger
        # declared unreadable at the first bad line.
        for line_no, row in enumerate(
            read_strict_jsonl(ledger, on_corruption="tolerant", base_dir=root), start=1,
        ):
            rows_scanned += 1
            if not is_operator_request_row(row):
                continue
            key = request_key(row)
            if key is not None and key in spent:
                claimed_ids.setdefault(key[0], key[1])
                spent_rows.append({"id": key[0], "ledger_hash": key[1], "reason": spent[key]})
                continue
            verdict = verify_operator_request(row, allowed_signers=allowed_signers)
            reason = verdict.reason
            if reason is None:
                reason = operator_request_schema_reason(row)
            if reason is None and key is None:
                reason = SCHEMA_INVALID
            if reason is None and key[0] in claimed_ids:
                reason = REQUEST_ID_REUSED
            if reason is not None:
                row_id = row.get("id") if isinstance(row.get("id"), str) else None
                event = append_tools_governance(root, UNSIGNED_OPERATOR_FEEDBACK_EVENT, {
                    # Never the row body: it is untrusted text by definition.
                    "id": row_id,
                    "line_no": line_no,
                    "reason": reason,
                    "signer": verdict.signer,
                    "cycle_id": cycle_id,
                })
                dropped.append({
                    "id": row_id, "line_no": line_no, "reason": reason,
                    "governance_ledger_hash": event.get("ledger_hash"),
                })
                continue
            claimed_ids[key[0]] = key[1]
            admitted.append({
                "id": row["id"],
                "ledger_hash": row["ledger_hash"],
                "signer": verdict.signer,
                "finding_id": row["finding_id"],
                "priority": row["priority"],
                "request": row["request"],
                "authored_at": row["authored_at"],
            })
    record = append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": 2,
        "row_type": INGESTION_ROW_TYPE,
        "ingested_at": utc_now(),
        "cycle_id": cycle_id,
        "ledger_present": ledger.exists(),
        "rows_scanned": rows_scanned,
        "admitted": [
            {"id": entry["id"], "ledger_hash": entry["ledger_hash"], "signer": entry["signer"]}
            for entry in admitted
        ],
        "dropped": dropped,
        "spent": spent_rows,
    }, expected_surface=INGESTION_SURFACE)
    candidates = tuple({
        "source_type": PlanCandidateSource.OPERATOR_FEEDBACK.value,
        "candidate_id": entry["id"],
        "finding_id": entry["finding_id"],
        "priority": entry["priority"],
        "request": entry["request"],
        "authored_at": entry["authored_at"],
        "signer": entry["signer"],
        "row_ledger_hash": entry["ledger_hash"],
        "ingestion_ledger_hash": record.get("ledger_hash"),
        "title_hint": f"Operator request {entry['id']}",
    } for entry in admitted)
    return OperatorFeedbackIngestion(
        ledger_hash=record.get("ledger_hash"), admitted=tuple(admitted),
        dropped=tuple(dropped), candidates=candidates, spent=tuple(spent_rows),
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
        })
    return append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": 2,
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


def record_request_refused(
    *,
    base_dir: str | Path | None,
    cycle_id: str | None,
    candidate: dict[str, Any],
    reason: str,
    refused_surfaces: list[dict[str, str]],
) -> dict[str, Any]:
    """ADR-0018 I4 — the request's target is not a plan ground; the request is spent.

    Written on the hash-chained ingestion ledger so ingestion reads it back
    as a spend (``operator_request_spend.SPENT_REFUSED``): a refused request
    never re-enters the ranking at priority 0, and the operator sees why in
    one row instead of a skip event repeated every cycle.
    """
    if reason not in REQUEST_REFUSAL_REASONS:
        raise GovernanceError(f"operator_request_refusal_reason_unknown: {reason!r}")
    if candidate.get("source_type") != PlanCandidateSource.OPERATOR_FEEDBACK.value:
        raise GovernanceError("operator_request_refusal_requires_operator_candidate")
    root = _tools_root(base_dir)
    return append_declared_jsonl(ingestion_ledger_path(root), {
        "schema_version": 2,
        "row_type": REQUEST_REFUSED_ROW_TYPE,
        "refused_at": utc_now(),
        "cycle_id": cycle_id,
        "id": candidate.get("candidate_id"),
        "request_ledger_hash": candidate.get("row_ledger_hash"),
        "finding_id": candidate.get("finding_id"),
        "reason": reason,
        "refused_surfaces": list(refused_surfaces),
    }, expected_surface=INGESTION_SURFACE)


def observe_operator_feedback_for_plan(
    *,
    plan_started: dict[str, Any] | None,
    ingestion_rows: list[dict[str, Any]],
    feedback_rows: list[dict[str, Any]],
    allowed_signers: bytes | None,
) -> dict[str, Any]:
    """The pre-merge observation: walk plan → binding → ingestion → rows.

    Reads only verified prefixes the merge owner captured (it rechecks them
    after this returns) and the allowed-signers bytes it read from a commit
    on ``main`` — an immutable git object, so there is no file to recheck
    and no key the lane must hold (ADR-0020). Every gap is a named
    ``operator_feedback_unavailable_reason``; the predicate never infers a
    pass from an empty field.
    """
    observation: dict[str, Any] = {}
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
        admitted_keys = {(entry.get("id"), entry.get("ledger_hash"), entry.get("signer"))
                         for entry in admitted if isinstance(entry, dict)}
        for entry in consumed:
            if (entry.get("id"), entry.get("ledger_hash"), entry.get("signer")) not in admitted_keys:
                raise GovernanceError(reason)
        reason = "operator_feedback_consumed_row_unavailable"
        row_hashes: list[str] = []
        signers: list[str] = []
        for entry in consumed:
            matches = [row for row in feedback_rows
                       if row.get("ledger_hash") == entry.get("ledger_hash")
                       and row.get("id") == entry.get("id")
                       and row.get("signer_principal") == entry.get("signer")]
            if len(matches) != 1:
                raise GovernanceError(reason)
            verdict = verify_operator_request(matches[0], allowed_signers=allowed_signers)
            if not verdict.valid:
                # The synthesis consumed a row the committed trust anchor no
                # longer vouches for — a revoked principal, or a rewritten row.
                raise GovernanceError("operator_feedback_consumed_row_unsigned:" + str(verdict.reason))
            row_hashes.append(str(entry["ledger_hash"]))
            signers.append(str(entry["signer"]))
        observation["operator_feedback_consumed_row_hashes"] = tuple(row_hashes)
        observation["operator_feedback_consumed_signers"] = tuple(signers)
        observation["operator_feedback_verified"] = True
        return observation
    except (GovernanceError, KeyError, TypeError, ValueError) as exc:
        observation["operator_feedback_verified"] = False
        observation["operator_feedback_unavailable_reason"] = (
            str(exc) if isinstance(exc, GovernanceError) and str(exc) else reason
        )
        return observation


__all__ = [
    "EVIDENCE_REF_PREFIX",
    "INGESTION_LEDGER_NAME",
    "INGESTION_ROW_TYPE",
    "INGESTION_SURFACE",
    "REQUEST_ID_REUSED",
    "SYNTHESIS_BOUND_ROW_TYPE",
    "UNSIGNED_OPERATOR_FEEDBACK_EVENT",
    "OperatorFeedbackIngestion",
    "bind_plan_synthesis",
    "ingest_operator_feedback",
    "ingestion_ledger_path",
    "latest_ingestion_for_cycle",
    "observe_operator_feedback_for_plan",
    "record_request_refused",
]
