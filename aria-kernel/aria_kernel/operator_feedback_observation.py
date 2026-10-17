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
* requires the plan's start to name the signed ``finding_id`` and
  ``grounding_digest`` (``…_plan_subject_mismatch:<field>``, ARIA-LOW-265):
  synthesis matches them at admission, and the merge proves the plan it
  merges is still the one the operator signed for;
* matches the signed subject the binding recorded, so a row swapped under
  the same id and position is refused;
* refuses when main's history already carries the request
  (``…_request_merged_on_main``, ARIA-MEDIUM-264): every merged delivery of
  an operator plan lands a ``merged_request_line`` on main
  (``operator_request_spend``), and a rollback of aria/state cannot erase
  main. The merge owner reads that history at the PR's live base on the
  merge lane's fresh clone; an unreadable history is
  ``…_main_history_unavailable``, never "not merged";
* refuses when the same request id is bound to another plan whose
  implementation already merged (``…_request_already_merged``), from the
  plan and ingestion ledgers the merge owner captured.

Every gap is a named ``operator_feedback_unavailable_reason``; the
predicate never infers a pass from an empty field.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import load_declared_jsonl
from .operator_feedback_ingestion import INGESTION_SURFACE, ingestion_ledger_path, plan_request_ids
from .operator_feedback_signature import operator_request_schema_reason
from .operator_request_signature import AllowedSigners, request_subject_digest, verify_operator_request
from .operator_request_spend import INGESTION_ROW_TYPE, SYNTHESIS_BOUND_ROW_TYPE
from .tool_registry import GovernanceError, ensure_tools_dir_readonly

ALREADY_MERGED = "operator_feedback_request_already_merged"
# ARIA-MEDIUM-264 — main's history, the record a rollback of aria/state
# cannot erase, already carries the request; or that history could not be read.
MERGED_ON_MAIN = "operator_feedback_request_merged_on_main"
MAIN_HISTORY_UNAVAILABLE = "operator_feedback_main_history_unavailable"
# ARIA-LOW-265 — the plan_started content names another finding or grounding
# than the request row it consumed signs.
PLAN_SUBJECT_MISMATCH = "operator_feedback_plan_subject_mismatch"
_SIGNED_PLAN_SUBJECT: tuple[str, ...] = ("finding_id", "grounding_digest")


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


def _walk_synthesis_binding(
    plan_started: dict[str, Any] | None,
    ingestion_rows: list[dict[str, Any]],
    observation: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The structural half of the walk: ``plan_started`` → its ``synthesis_bound``
    row → the ingestion it names → the consumption the plan declares.

    Fills ``observation`` stage by stage and returns the started plan content
    with the consumed entries, or raises ``GovernanceError`` naming the first
    stage that failed. It reads no signature and no clock, so its answer is a
    property of the plan and the ingestion ledger alone: the merge reads it,
    and so does the implementation mint before anything is spent
    (:func:`synthesis_binding_refusal`).
    """
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
        if consumed_ids != plan_request_ids(started_content):
            raise GovernanceError(reason)
        identity = ("id", "ledger_hash", "signer", "subject_digest")
        admitted_keys = {tuple(entry.get(key) for key in identity) for entry in admitted if isinstance(entry, dict)}
        for entry in consumed:
            if tuple(entry.get(key) for key in identity) not in admitted_keys:
                raise GovernanceError(reason)
        return started_content, consumed
    except (KeyError, TypeError, ValueError) as exc:
        raise GovernanceError(reason) from exc


def synthesis_binding_refusal(
    plan_started: dict[str, Any] | None, ingestion_rows: list[dict[str, Any]],
) -> str | None:
    """ARIA-HIGH-529 — the reason the merge walk refuses ``plan_started``
    before it reads a single signature, or None when its synthesis is bound.

    Only the provider binds a synthesis (``bind_plan_synthesis``); a plan
    started by ``plan start``, by skill authoring or by the V7 fallback has
    no ``synthesis_bound`` row, and nothing appends one later, so this answer
    does not change for the plan's lifetime."""
    try:
        _walk_synthesis_binding(plan_started, ingestion_rows, {})
    except GovernanceError as exc:
        return str(exc)
    return None


def plan_synthesis_binding_refusal(state: dict[str, Any], *, base_dir: str | Path | None) -> str | None:
    """:func:`synthesis_binding_refusal` of a folded plan, read against the
    store's hash-chained ingestion ledger (an absent ledger binds nothing)."""
    root = ensure_tools_dir_readonly(base_dir)
    path = None if root is None else ingestion_ledger_path(root)
    rows = (load_declared_jsonl(path, expected_surface=INGESTION_SURFACE)
            if path is not None and path.exists() else [])
    return synthesis_binding_refusal(state.get("plan_started"), rows)


def observe_operator_feedback_for_plan(
    *,
    plan_id: str,
    plan_started: dict[str, Any] | None,
    ingestion_rows: list[dict[str, Any]],
    feedback_rows: list[dict[str, Any]],
    plan_events: list[dict[str, Any]],
    allowed_signers: AllowedSigners | None,
    main_request_ids: frozenset[str] | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The pre-merge observation; see the module docstring for every refusal it names.

    ``main_request_ids`` are the request ids main's history records as merged
    (``operator_request_spend.merged_request_ids`` over main), or None when
    that history could not be read.
    """
    moment = now or datetime.now(timezone.utc)
    observation: dict[str, Any] = {}
    reason = "operator_feedback_plan_start_unavailable"
    try:
        started_content, consumed = _walk_synthesis_binding(plan_started, ingestion_rows, observation)
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
            # ARIA-LOW-265 — the plan this merge starts from targets the
            # subject the operator signed: same finding, same grounding.
            for field in _SIGNED_PLAN_SUBJECT:
                if started_content.get(field) != matches[0].get(field):
                    raise GovernanceError(f"{PLAN_SUBJECT_MISMATCH}:{field}")
            if main_request_ids is None:
                raise GovernanceError(MAIN_HISTORY_UNAVAILABLE)
            if entry["id"] in main_request_ids:
                raise GovernanceError(MERGED_ON_MAIN)
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


__all__ = [
    "ALREADY_MERGED",
    "MAIN_HISTORY_UNAVAILABLE",
    "MERGED_ON_MAIN",
    "PLAN_SUBJECT_MISMATCH",
    "observe_operator_feedback_for_plan",
    "plan_synthesis_binding_refusal",
    "synthesis_binding_refusal",
]
