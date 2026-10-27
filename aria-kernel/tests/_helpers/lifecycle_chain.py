"""Lifecycle ledger fixtures — replayable chains and hand-appended rows.

Shared by the SE-5 tests (``test_se5_lifecycle_replay.py``, ``test_se5_role_agent_owner.py``,
``test_se5_seat_routing.py``) and every test that needs an entity in a given lifecycle state.
NON-test code (the directory name keeps it out of ``unittest discover``); no model is called.

``chain`` appends REPLAYABLE rows to the genesis lifecycle ledger the way ``record_transition`` writes
them (``from_state`` = the previous state, the evidence each state's own gate asks of
``validate_transition``), but without the proofs ``record_transition`` computes kernel-side: a chain is a
fixture of the LEDGER, never a call to the recorder. ``forged_row`` appends one arbitrary row, which is
how a hand-appended ledger line is built.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from aria_kernel.genesis_lifecycle import lifecycle_events_path
from aria_kernel.ledger import append_declared_jsonl

LADDER = (
    "PRESSURE", "CANDIDATE_PROPOSED", "HUMAN_REQUIRED", "REQUEST", "DRAFT",
    "REAL_SANDBOX", "SHADOW", "EVAL_WINDOW", "ACTIVE",
)
_PROOF = {
    "eval_harness_id": "harness-se5", "fixture_run_id": "fixture-se5",
    "transcript_hash": "sha256:" + "a" * 64, "operator_provenance_ref": "operator-se5",
}


def evidence_for(state: str, *, scope: str | None = None, with_proof: bool = True) -> dict[str, Any]:
    """The evidence a ``record_transition`` into ``state`` would carry, as far as ``validate_transition`` reads it."""
    if state == "PRESSURE":
        return {"gap_id": "gap-se5"}
    if state == "CANDIDATE_PROPOSED":
        return {"valid_cycles": 99, "source_types": ["a", "b"]}
    if state == "HUMAN_REQUIRED":
        return {"capability_resolution": {"decision": "request"}}
    if state == "REQUEST":
        return {"operator_feedback_ref": "operator-feedback-se5"}
    if state == "DRAFT":
        return {"draft_ref": "draft-se5"}
    if state in ("REAL_SANDBOX", "SHADOW", "EVAL_WINDOW"):
        return dict(_PROOF)
    if state == "ACTIVE":
        evidence: dict[str, Any] = {"reviewers": ["r1", "r2"]}
        if with_proof:
            evidence["resolved_eval_window_superiority"] = {
                "passed": True, "window": {"verdict": "improved"}, "duel": {"status": "not_evaluated"},
            }
        if scope is not None:
            evidence["scope"] = scope
        return evidence
    return {}


def forged_row(
    store: Path, entity: str, to_state: str, *, from_state: str | None, evidence: Mapping[str, Any] | None = None,
    kind: str = "agent",
) -> dict[str, Any]:
    """Append ONE lifecycle row exactly as given: the hand-appended line a ledger could be handed."""
    row = {
        "schema_version": 1, "recorded_at": "2026-10-27T00:00:00+00:00", "entity_id": entity, "entity_kind": kind,
        "from_state": from_state, "to_state": to_state, "evidence": dict(evidence or {}),
        "operator_approval_ref": None,
    }
    return append_declared_jsonl(lifecycle_events_path(store), row, expected_surface="genesis_lifecycle_events")


def chain(
    store: Path, entity: str, through: str, *, kind: str = "agent", scope: str | None = None, with_proof: bool = True,
) -> None:
    """Append the replayable chain of ``entity`` up to ``through``: every row legal from the one before it.

    ``through`` is a rung of ``LADDER`` or ``REJECTED`` (a rejection of the draft). ``scope`` and ``with_proof``
    only shape the ACTIVE row.
    """
    if through == "REJECTED":
        states = [*LADDER[: LADDER.index("DRAFT") + 1], "REJECTED"]
    else:
        states = list(LADDER[: LADDER.index(through) + 1])
    previous: str | None = None
    for state in states:
        forged_row(
            store, entity, state, from_state=previous, kind=kind,
            evidence=evidence_for(state, scope=scope, with_proof=with_proof),
        )
        previous = state


def reason_texts(result: Any) -> list[str]:
    """The ``reasons`` of an invalid chain as strings (a fixture reads them by containment, not by shape)."""
    return [str(reason) for reason in getattr(result, "reasons", ())]
