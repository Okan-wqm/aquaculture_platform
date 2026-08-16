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
`run_agent_eval(mock_mode=False)` and `record_transition`.

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
from typing import Any

from .agent_eval import run_agent_eval
from .genesis_lifecycle import record_transition
from .ledger import load_declared_jsonl
from .ledger_refs import ledger_ref_for_row
from .tool_registry import GovernanceError, ensure_tools_dir


def _rows(root: Path, ledger_path: str, surface: str) -> list[dict[str, Any]]:
    return load_declared_jsonl(root / ledger_path, expected_surface=surface)


def _unique_row(
    rows: list[dict[str, Any]],
    predicate: Any,
    *,
    what: str,
    key: str,
) -> dict[str, Any]:
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


def _resolve_response_envelope(result: dict[str, Any]) -> dict[str, Any]:
    # WHAT: the accepted result row's output file IS the agent response
    # envelope (submit_claim_result validated it before writing the
    # row). Rows recorded with an inline envelope are honored second.
    output_path = str(result.get("output_path") or "")
    if output_path:
        path = Path(output_path)
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
    source identity, a non-passing fixture suite, or a target-agent
    mismatch across the chain.
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
    request = _unique_row(
        _rows(root, "agent-invocations/requests.jsonl", "agent_invocation_requests"),
        lambda row: str(row.get("request_id") or "") == request_id,
        what="request",
        key=request_id,
    )
    context = _unique_row(
        _rows(root, "agent-invocations/contexts.jsonl", "agent_invocation_contexts"),
        lambda row: str(row.get("request_id") or "") == request_id,
        what="context",
        key=request_id,
    )
    prompt = _unique_row(
        _rows(root, "agent-invocations/prompts.jsonl", "agent_invocation_prompts"),
        lambda row: str(row.get("request_id") or "") == request_id,
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
    # WHY these two mismatch checks live HERE: _validate_real_eval_
    # provenance binds transcript.target_agent to the fixture but never
    # reads request.target_agent, and a C4-a approval scoped to another
    # agent would otherwise promote this one — both are cross-row lies
    # only the assembler can see whole.
    if str(request.get("target_agent") or "") != target_agent:
        raise GovernanceError(
            "shadow_bridge_target_agent_mismatch:"
            f"request={request.get('target_agent')!r}!=fixture={target_agent!r}"
        )
    approval_scope = str(operator.get("target_agent") or "")
    if approval_scope and approval_scope != target_agent:
        raise GovernanceError(
            "shadow_bridge_operator_approval_scope_mismatch:"
            f"approval={approval_scope!r}!=fixture={target_agent!r}"
        )

    transcript_hash = str(transcript.get("transcript_hash") or "")
    envelope = _resolve_response_envelope(result)

    # --- Real-mode eval: run_agent_eval re-validates the full 8-ref
    # chain (İ1 — the bridge reuses that seam, it never re-implements
    # the row-binding checks) and persists the eval run row whose
    # run_id becomes the eval_harness_id the proof carries.
    eval_run = run_agent_eval(
        fixture_id=fixture_id,
        base_dir=base_dir,
        repo_root=repo_root,
        mock_mode=False,
        real_response_envelope=envelope,
        invocation_id=invocation_id,
        transcript_hash=transcript_hash,
        request_ledger_ref=_source_ref(
            "agent_invocation_requests", "agent-invocations/requests.jsonl", request
        ),
        claim_ledger_ref=_source_ref(
            "agent_invocation_claims", "agent-invocations/claims.jsonl", claim
        ),
        context_ledger_ref=_source_ref(
            "agent_invocation_contexts", "agent-invocations/contexts.jsonl", context
        ),
        prompt_ledger_ref=_source_ref(
            "agent_invocation_prompts", "agent-invocations/prompts.jsonl", prompt
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
        operator_approval_ref=operator_approval_ref,
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
            operator_approval_ref=operator_approval_ref,
        )
        for to_state in ("REAL_SANDBOX", "SHADOW")
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
        "eval_run": eval_run,
        "transitions": transitions,
    }


__all__ = ["bridge_shadow_eval_from_invocation"]
