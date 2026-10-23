"""C4-d — the genesis SHADOW proof chain's real-mode bridge.

WHY this module exists: `verify_shadow_eval_proof` (genesis_lifecycle)
demands an eval run row carrying EIGHT SourceLedgerRefs plus a passing
fixture-run suite row and an operator-approval row — but nothing in
production ever assembled that row from a COMPLETED real invocation.
C4-a minted the approval ledger, C4-b derived sandbox evidence from the
fixture suite, C4-c recorded the prefix chain up to DRAFT, and there
the arc stopped: DRAFT → REAL_SANDBOX → SHADOW stayed structurally
unreachable because no writer joined the invocation ledgers
(requests/claims/contexts/prompts/results/transcripts) to
`run_agent_eval` and `record_transition`.

WHAT it does: given one completed invocation, it resolves the REAL
ledger rows, builds the 8 refs via `ledger_refs.ledger_ref_for_row`
(reusing each row's own row_id/row_type — legacy rows without source
identity are refused, never re-minted), runs the real-mode eval (which
re-validates the whole chain via `_validate_real_eval_provenance`), and
records the two lifecycle transitions whose proof
`verify_shadow_eval_proof` re-derives from the same ledgers.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, TypeVar

from .agent_eval import run_agent_eval
from .genesis_lifecycle import (
    ALLOWED_TRANSITIONS,
    GenesisState,
    record_transition,
    require_lifecycle_state,
)
from .ledger import load_declared_jsonl, segment_rows
from .ledger_refs import ledger_ref_for_row
from .operator_provenance import require_approval_scope
from .tool_registry import GovernanceError, ensure_tools_dir


# The lifecycle moves this bridge records, in order. One module constant so
# the transition loop and the entry-state derivation below read the same
# chain (literal_provenance resolves a module-level Name, so both states stay
# "written" for the surface-reachability gate).
_BRIDGE_TRANSITIONS: tuple[GenesisState, ...] = ("REAL_SANDBOX", "SHADOW")
# The states a target may be in for the bridge to start: every state from
# which ALLOWED_TRANSITIONS permits the first bridge move (today {"DRAFT"}).
# Derived from the one transition table, never restated, so a table edit
# cannot leave the pre-write check guarding a stale set.
_BRIDGE_ENTRY_STATES: frozenset[GenesisState] = frozenset(
    state
    for state, successors in ALLOWED_TRANSITIONS.items()
    if _BRIDGE_TRANSITIONS[0] in successors
)


def _rows(root: Path, ledger_path: str, surface: str) -> list[dict[str, Any]]:
    return load_declared_jsonl(root / ledger_path, expected_surface=surface)


_Row = TypeVar("_Row")


def _unique_row(
    rows: list[_Row],
    predicate: Callable[[_Row], bool],
    *,
    what: str,
    key: str,
) -> _Row:
    matches = [row for row in rows if predicate(row)]
    if not matches:
        raise GovernanceError(f"shadow_bridge_{what}_not_found:{key}")
    if len(matches) > 1:
        raise GovernanceError(f"shadow_bridge_{what}_ambiguous:{key}")
    return matches[0]


def _source_ref(surface: str, ledger_path: str, row: dict[str, Any]) -> dict[str, Any]:
    # WHY no fallback derivation: the ROOT contract is that every writer
    # mints row_id/row_type at append time (all six invocation writers
    # do). A row without them is a pre-contract legacy row the bridge
    # cannot target — re-deriving an identity here would forge a ref the
    # writer never committed to.
    row_id = str(row.get("row_id") or "")
    row_type = str(row.get("row_type") or "")
    if not row_id or not row_type:
        raise GovernanceError(f"shadow_bridge_row_missing_source_identity:{surface}")
    return ledger_ref_for_row(
        surface=surface,
        ledger_path=ledger_path,
        row_id=row_id,
        row_type=row_type,
        row=row,
    )


def _resolve_response_envelope(result: dict[str, Any], root: Path) -> dict[str, Any]:
    # WHAT: the accepted result row's output file IS the agent response
    # envelope (submit_claim_result validated it before writing the
    # row). Rows recorded with an inline envelope are honored second.
    output_path = str(result.get("output_path") or "")
    if output_path:
        from .agent_invocations import resolve_output_artifact_path

        path = resolve_output_artifact_path(root, output_path)
        if not path.is_file():
            raise GovernanceError(f"shadow_bridge_result_output_missing:{output_path}")
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GovernanceError(
                f"shadow_bridge_result_output_unreadable:{output_path}"
            ) from exc
        if not isinstance(envelope, dict):
            raise GovernanceError("shadow_bridge_result_envelope_not_object")
        return envelope
    inline = result.get("response_envelope") or result.get("envelope")
    if isinstance(inline, dict):
        return dict(inline)
    raise GovernanceError("shadow_bridge_result_missing_envelope")


def bridge_shadow_eval_from_invocation(
    *,
    invocation_id: str,
    fixture_id: str,
    fixture_run_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    """Promote a DRAFT genesis agent to SHADOW from one real invocation.

    Resolves the completed invocation's ledger rows, runs the real-mode
    eval bound to them, and records DRAFT → REAL_SANDBOX → SHADOW with
    the proof fields `verify_shadow_eval_proof` re-derives. Refuses —
    before any write — on a missing/ambiguous row, a legacy row without
    source identity, a non-passing fixture suite, a target-agent
    mismatch across the chain, or a target that is not in a state that
    may enter REAL_SANDBOX (`genesis_lifecycle_state_required`). The
    lifecycle refusal is pre-write for one bridge run per agent at a
    time: no lock spans this check and the two transitions.
    """
    invocation_id = str(invocation_id or "").strip()
    fixture_id = str(fixture_id or "").strip()
    fixture_run_id = str(fixture_run_id or "").strip()
    operator_approval_ref = str(operator_approval_ref or "").strip()
    missing = [
        name
        for name, value in (
            ("invocation_id", invocation_id),
            ("fixture_id", fixture_id),
            ("fixture_run_id", fixture_run_id),
            ("operator_approval_ref", operator_approval_ref),
        )
        if not value
    ]
    if missing:
        raise GovernanceError("shadow_bridge_requires_fields:" + ",".join(missing))

    root = ensure_tools_dir(base_dir)

    # --- Resolve the REAL rows (read-only; every refusal lands before
    # any ledger write so a rejected bridge leaves no partial state).
    claim = _unique_row(
        _rows(root, "agent-invocations/claims.jsonl", "agent_invocation_claims"),
        lambda row: str(row.get("claim_id") or "") == invocation_id
        and str(row.get("event") or "") == "claimed",
        what="claim",
        key=invocation_id,
    )
    request_id = str(claim.get("request_id") or "")
    # Segmented ledgers (ARIA-HIGH-275): the ref names the segment file the
    # row lives in, which is the file its verifier re-reads.
    request_ledger, request = _unique_row(
        segment_rows(root, "agent_invocation_requests"),
        lambda item: str(item[1].get("request_id") or "") == request_id,
        what="request",
        key=request_id,
    )
    context = _unique_row(
        _rows(root, "agent-invocations/contexts.jsonl", "agent_invocation_contexts"),
        lambda row: str(row.get("request_id") or "") == request_id,
        what="context",
        key=request_id,
    )
    prompt_ledger, prompt = _unique_row(
        segment_rows(root, "agent_invocation_prompts"),
        lambda item: str(item[1].get("request_id") or "") == request_id,
        what="prompt",
        key=request_id,
    )
    result = _unique_row(
        _rows(root, "agent-invocations/results.jsonl", "agent_invocation_results"),
        lambda row: str(row.get("claim_id") or row.get("invocation_id") or "")
        == invocation_id
        and row.get("status") == "accepted",
        what="accepted_result",
        key=invocation_id,
    )
    transcript = _unique_row(
        _rows(
            root,
            "agent-invocations/transcripts.jsonl",
            "agent_invocation_transcripts",
        ),
        lambda row: str(row.get("invocation_id") or "") == invocation_id,
        what="transcript",
        key=invocation_id,
    )
    fixture = _unique_row(
        _rows(root, "agent-evals/fixtures.jsonl", "agent_eval_fixtures"),
        lambda row: str(row.get("fixture_id") or "") == fixture_id,
        what="fixture",
        key=fixture_id,
    )
    # WHY the same key tuple verify_shadow_eval_proof uses: the bridge
    # must refuse exactly where the verifier would, only EARLIER —
    # before run_agent_eval mints an eval row for a broken suite.
    fixture_run = _unique_row(
        _rows(root, "fixture-runs.jsonl", "agent_eval_fixture_runs"),
        lambda row: any(
            str(row.get(key) or "") == fixture_run_id
            for key in ("execution_run_id", "fixture_run_id", "run_id")
        ),
        what="fixture_run",
        key=fixture_run_id,
    )
    if fixture_run.get("passed") is not True and fixture_run.get("actual_status") != "pass":
        raise GovernanceError(f"shadow_bridge_fixture_run_not_passing:{fixture_run_id}")
    operator = _unique_row(
        _rows(root, "operator-provenance/events.jsonl", "operator_provenance"),
        lambda row: operator_approval_ref
        in {
            str(row.get(key) or "")
            for key in ("operator_provenance_ref", "provenance_ref", "event_id", "ref")
            if str(row.get(key) or "").strip()
        },
        what="operator_approval",
        key=operator_approval_ref,
    )

    target_agent = str(fixture.get("target_agent") or "")
    # WHY the request check lives HERE: _validate_real_eval_provenance
    # binds transcript.target_agent to the fixture but never reads
    # request.target_agent — a cross-row lie only the assembler can see
    # whole.
    if str(request.get("target_agent") or "") != target_agent:
        raise GovernanceError(
            "shadow_bridge_target_agent_mismatch:"
            f"request={request.get('target_agent')!r}!=fixture={target_agent!r}"
        )
    # ARIA-MEDIUM-512 — an approval with no target_agent is refused, not
    # read as a wildcard; checked here so the refusal lands before the eval
    # run row (run_agent_eval applies the same rule through its validator).
    require_approval_scope(operator, target_agent=target_agent)
    # WHY here, before run_agent_eval (ARIA-HIGH-502, ex ORPHAN-HIGH-573):
    # the lifecycle precondition used to be checked only inside
    # record_transition, AFTER run_agent_eval had appended an eval run row
    # and its governance row — so re-bridging a SHADOW agent, or bridging
    # one with no genesis chain, left an orphan eval row behind a refusal.
    # Checking the entry state here makes "every refusal lands before any
    # ledger write" true for the lifecycle too, for one bridge run per
    # agent at a time: no lock spans this check, the eval and the two
    # transitions, so two concurrent runs on one DRAFT agent can both pass
    # here and the loser refuses inside record_transition after its eval
    # rows (as before this check; record_transition re-validates, so no
    # wrong promotion follows).
    require_lifecycle_state(
        entity_id=target_agent,
        allowed_states=_BRIDGE_ENTRY_STATES,
        base_dir=base_dir,
    )

    # ARIA-HIGH-238 — the bridge promotes a genesis agent out of DRAFT on the
    # strength of this ref, so it must be the operator's own GitHub act
    # naming the agent and the invocation; the act is consumed here, once,
    # at the entry point that owns the grant. The same canonical ref keys
    # the operator-provenance row joined above (the operator mints it with
    # `operator-provenance record --ref <gh:...>`). Placement: after every
    # read-only precondition, before the first write — a state-machine
    # refusal must not spend an operator act.
    from .operator_approval import require_operator_act

    approval_proof = require_operator_act(
        operator_approval_ref,
        surface="shadow_eval_bridge",
        scope={"agent": target_agent, "invocation": invocation_id},
        base_dir=root,
    )

    transcript_hash = str(transcript.get("transcript_hash") or "")
    envelope = _resolve_response_envelope(result, root)

    # --- Real-mode eval: run_agent_eval re-validates the full 8-ref
    # chain (İ1 — the bridge reuses that seam, it never re-implements
    # the row-binding checks) and persists the eval run row whose
    # run_id becomes the eval_harness_id the proof carries.
    eval_run = run_agent_eval(
        fixture_id=fixture_id,
        base_dir=base_dir,
        repo_root=repo_root,
        real_response_envelope=envelope,
        invocation_id=invocation_id,
        transcript_hash=transcript_hash,
        request_ledger_ref=_source_ref(
            "agent_invocation_requests", request_ledger, request
        ),
        claim_ledger_ref=_source_ref(
            "agent_invocation_claims", "agent-invocations/claims.jsonl", claim
        ),
        context_ledger_ref=_source_ref(
            "agent_invocation_contexts", "agent-invocations/contexts.jsonl", context
        ),
        prompt_ledger_ref=_source_ref(
            "agent_invocation_prompts", prompt_ledger, prompt
        ),
        result_ledger_ref=_source_ref(
            "agent_invocation_results", "agent-invocations/results.jsonl", result
        ),
        fixture_ledger_ref=_source_ref(
            "agent_eval_fixtures", "agent-evals/fixtures.jsonl", fixture
        ),
        transcript_ledger_ref=_source_ref(
            "agent_invocation_transcripts",
            "agent-invocations/transcripts.jsonl",
            transcript,
        ),
        operator_approval_ledger_ref=_source_ref(
            "operator_provenance", "operator-provenance/events.jsonl", operator
        ),
    )
    # WHY: verify_shadow_eval_proof checks the CHAIN, not the verdict —
    # a failing eval would still satisfy it. The bridge is the promotion
    # actor, so the pass gate lives here: a candidate that failed its
    # own fixture never advances (the failed eval row remains on the
    # ledger as the honest record of the attempt).
    if eval_run.get("passed") is not True:
        raise GovernanceError(
            "shadow_bridge_eval_run_failed:"
            f"verdict_match={eval_run.get('verdict_match')},"
            f"evidence_match={eval_run.get('evidence_match')}"
        )

    evidence = {
        "eval_harness_id": str(eval_run["run_id"]),
        "fixture_run_id": fixture_run_id,
        "transcript_hash": transcript_hash,
        "operator_provenance_ref": operator_approval_ref,
    }
    transitions = [
        record_transition(
            entity_id=target_agent,
            entity_kind="agent",
            to_state=to_state,
            evidence=evidence,
            base_dir=base_dir,
            repo_root=repo_root,
        )
        for to_state in _BRIDGE_TRANSITIONS
    ]
    return {
        "schema_version": 1,
        "target_agent": target_agent,
        "invocation_id": invocation_id,
        "fixture_id": fixture_id,
        "fixture_run_id": fixture_run_id,
        "eval_harness_id": str(eval_run["run_id"]),
        "transcript_hash": transcript_hash,
        "operator_provenance_ref": operator_approval_ref,
        "operator_approval": approval_proof,
        "eval_run": eval_run,
        "transitions": transitions,
    }


__all__ = ["bridge_shadow_eval_from_invocation"]
