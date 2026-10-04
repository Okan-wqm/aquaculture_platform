"""V9.5 check 12 — the merge owner's walk from a plan back to the operator request it consumed.

WHY: the pre-merge predicate must prove, from captured evidence, that the
merged plan's synthesis applied the signature rule — and, since review round 2
(AISAFETY-HIGH-001, GSEC-MEDIUM-001), that the consumed request is still in
force and is merged once. The merge lane runs on a fresh GitHub-hosted clone
with no runner state: everything it needs is the verified ledger prefixes the
merge owner captured and the allowed-signers file committed on ``main``.

WHAT: :func:`observe_operator_feedback_for_plan` walks
``plan_started.content_hash`` → the ``synthesis_bound`` row → the scan it
names → every consumed request row, and for each consumed row

* re-verifies the operator signature against the committed anchor
  (``…_consumed_row_unsigned:<reason>``);
* re-checks the signed terms at merge time — expiry, audience, grounding
  digest present (``…_consumed_row_refused:<reason>``);
* matches the signed subject the binding recorded, so a row swapped under
  the same id and position is refused;
* refuses when the same request id is bound to another plan whose
  implementation already merged (``…_request_already_merged``). That proof is
  derived from the plan and ingestion ledgers the merge owner captured; a
  store rolled back past the earlier merge would hide it, which is what the
  signed expiry bounds.

Every gap is a named ``operator_feedback_unavailable_reason``; the
predicate never infers a pass from an empty field.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .operator_feedback_ingestion import EVIDENCE_REF_PREFIX
from .operator_feedback_signature import operator_request_schema_reason
from .operator_request_signature import AllowedSigners, request_subject_digest, verify_operator_request
from .operator_request_spend import INGESTION_ROW_TYPE, SYNTHESIS_BOUND_ROW_TYPE
from .tool_registry import GovernanceError

ALREADY_MERGED = "operator_feedback_request_already_merged"


def _consumed_refs(plan_content: Any) -> set[str]:
    refs = plan_content.get("evidence_refs") if isinstance(plan_content, dict) else None
    return {
        str(ref)[len(EVIDENCE_REF_PREFIX):]
        for ref in (refs or []) if isinstance(ref, str) and ref.startswith(EVIDENCE_REF_PREFIX)
    }


def _merged_elsewhere(
    request_id: str, *, plan_id: str, ingestion_rows: list[dict[str, Any]], plan_events: list[dict[str, Any]],
) -> bool:
    """Is ``request_id`` bound to ANOTHER plan whose implementation merged?"""
    bound_hashes = {
        row.get("plan_content_hash") for row in ingestion_rows
        if row.get("row_type") == SYNTHESIS_BOUND_ROW_TYPE
        and any(isinstance(entry, dict) and entry.get("id") == request_id for entry in row.get("consumed") or [])
    }
    started: dict[str, str] = {}
    merged: set[str] = set()
    for event in plan_events:
        other = event.get("plan_id")
        if not isinstance(other, str):
            continue
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event.get("event_type") == "plan_started" and isinstance(payload.get("content_hash"), str):
            started[other] = payload["content_hash"]
        elif event.get("event_type") == "implementation_merged":
            merged.add(other)
    return any(other != plan_id and started.get(other) in bound_hashes for other in merged)


def observe_operator_feedback_for_plan(
    *,
    plan_id: str,
    plan_started: dict[str, Any] | None,
    ingestion_rows: list[dict[str, Any]],
    feedback_rows: list[dict[str, Any]],
    plan_events: list[dict[str, Any]],
    allowed_signers: AllowedSigners | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The pre-merge observation; see the module docstring for every refusal it names."""
    moment = now or datetime.now(timezone.utc)
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
        identity = ("id", "ledger_hash", "signer", "subject_digest")
        admitted_keys = {tuple(entry.get(key) for key in identity) for entry in admitted if isinstance(entry, dict)}
        for entry in consumed:
            if tuple(entry.get(key) for key in identity) not in admitted_keys:
                raise GovernanceError(reason)
        reason = "operator_feedback_consumed_row_unavailable"
        row_hashes: list[str] = []
        signers: list[str] = []
        for entry in consumed:
            matches = [row for row in feedback_rows
                       if row.get("ledger_hash") == entry.get("ledger_hash")
                       and row.get("id") == entry.get("id")
                       and row.get("signer_principal") == entry.get("signer")]
            if len(matches) != 1 or request_subject_digest(matches[0]) != entry.get("subject_digest"):
                raise GovernanceError(reason)
            verdict = verify_operator_request(matches[0], allowed_signers=allowed_signers)
            if not verdict.valid:
                # The synthesis consumed a row the committed trust anchor no
                # longer vouches for — a revoked principal, or a rewritten row.
                raise GovernanceError("operator_feedback_consumed_row_unsigned:" + str(verdict.reason))
            terms = operator_request_schema_reason(matches[0], now=moment, anchor=allowed_signers)
            if terms is not None:
                raise GovernanceError("operator_feedback_consumed_row_refused:" + terms)
            if _merged_elsewhere(str(entry["id"]), plan_id=plan_id,
                                 ingestion_rows=ingestion_rows, plan_events=plan_events):
                raise GovernanceError(ALREADY_MERGED)
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


__all__ = ["ALREADY_MERGED", "observe_operator_feedback_for_plan"]
