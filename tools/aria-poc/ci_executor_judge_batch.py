"""The batch judge child — K read-only judge requests, ONE model call.

Typed-judgment plan Phase 4b (ARIA-MEDIUM-163). Measured before it: every
process-less Z.ai judgment was one fleet probe, one admission row, one
request-ledger load and one chat completion, at ~9 judgments a night
against 322 pending adversarial judgments. This child is launched by the
drain (`ci_executor.py --judge-batch <role> <target_agent> <id>...`) for K
requests that share a role, an agent and an anchor; it admits the route
ONCE, claims each request, renders and hash-binds each prompt, asks the
vendor ONE typed question per request in ONE call, and then seals,
validates, submits and reconciles each request on its own, exactly as the
single-request child does — through the same helpers, so no kernel CLI
argv is spelled twice.

Two fault classes, by name (`release_reason`):

* the whole call failed — transport, auth, credit, an input budget the
  batch could not fit, a payload that is not the batch's JSON — every
  request is released `judge_batch_call_failed:<code>` (harness-class,
  requeue budget intact) with a refusal summary each;
* the call answered and THIS request's item was refused by the typed
  parser while its siblings folded — released
  `judge_batch_item_unanswered:<reason_code>` (request-class, budget
  charged) with a refusal summary.

The drain accounts every request from its own summary; the breaker counts
one failure per child (`ci_executor_drain`).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import ci_executor as _engine
from ci_executor_lease import HeldClaim

BATCH_SUMMARY_SCHEMA = "aria/judge-batch/v1"
JUDGE_BATCH_SYSTEM_PROMPT = (
    "You are an ARIA judge answering a batch of typed questions. Read every question's evidence "
    "excerpts; answer each question by its id. Cite evidence by index and verbatim quote only."
)


class JudgeBatchRefused(RuntimeError):
    """The batch cannot start; every request is refused under ``reason``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _BatchMember:
    request: dict[str, Any]
    request_id: str
    claim: dict[str, Any] | None = None
    envelope: dict[str, Any] | None = None
    prompt: str | None = None
    prompt_hash: str | None = None
    settled: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def claim_id(self) -> str:
        return str((self.claim or {})["claim_id"])

    @property
    def lease_token(self) -> str:
        return str((self.claim or {})["lease_token"])


def _batch_id(request_ids: list[str]) -> str:
    digest = hashlib.sha256("\n".join(sorted(request_ids)).encode("utf-8")).hexdigest()[:16]
    return f"jb-{digest}"


def _load_requests(*, tools_dir: Path, request_ids: list[str], role: str, target_agent: str) -> list[dict[str, Any]]:
    """One ledger load for the whole batch; every id present, same role,
    agent and anchor, or the batch is refused by name."""
    from aria_kernel.agent_invocations import list_agent_invocation_requests

    wanted = set(request_ids)
    rows = [row for row in list_agent_invocation_requests(base_dir=tools_dir) if row.get("request_id") in wanted]
    by_id = {str(row["request_id"]): row for row in rows}
    missing = [rid for rid in request_ids if rid not in by_id]
    if missing:
        raise JudgeBatchRefused(f"judge_batch_request_unknown:{','.join(missing)[:120]}")
    ordered = [by_id[rid] for rid in request_ids]
    if any(str(row.get("role")) != role for row in ordered):
        raise JudgeBatchRefused("judge_batch_role_mismatch")
    if any(str(row.get("target_agent")) != target_agent for row in ordered):
        raise JudgeBatchRefused("judge_batch_target_agent_mismatch")
    if len({str(row.get("target_sha") or "") for row in ordered}) != 1:
        raise JudgeBatchRefused("judge_batch_anchor_mismatch")
    return ordered


def _refuse_all(members: list[_BatchMember], *, target_agent: str, reason: str, failure_class: str = "policy_violation",
                retryable: bool = False) -> int:
    """A named refusal summary for every unsettled member (no claim held)."""
    for member in members:
        if member.settled:
            continue
        _engine._refuse_dispatch(request=member.request, request_id=member.request_id, target_agent=target_agent,
                                 reason=reason, failure_class=failure_class, retryable=retryable)
        member.settled = True
    return _engine.REFUSAL_EXIT_CODE


def _release_and_refuse(member: _BatchMember, *, tools_dir: Path, repo: Path, agent_id: str, target_agent: str,
                        reason: str, failure_class: str, retryable: bool) -> None:
    """Release one held claim under ``reason`` and write its refusal summary."""
    if member.claim is not None:
        _engine._release_claim(tools_dir=tools_dir, repo=repo, claim_id=member.claim_id, agent_id=agent_id,
                               lease_token=member.lease_token, reason=reason)
    _engine._refuse_dispatch(request=member.request, request_id=member.request_id, target_agent=target_agent,
                             reason=reason.split(":", 1)[0], failure_class=failure_class, retryable=retryable)
    member.settled = True


def build_envelope_from_typed_answer(
    *, question: Any, answer: Any, request: dict[str, Any], claim_id: str, agent_id: str, role: str,
    subagent_type: str, must_satisfy: list[dict[str, Any]], dispatch_model: str, confidence_source: str,
    contract_hash: str, attempt_ledger_hash: str,
) -> dict[str, Any]:
    """The kernel-valid envelope for one typed answer — built from the
    answer's fields only (no vendor payload passes through), the identity
    stamps written by this route, never by the model."""
    from aria_kernel.typed_judgment import materialize_evidence_refs

    refs = materialize_evidence_refs(question, answer)
    verdict_is_positive = answer.value == "true_positive"
    matrix = []
    for item in must_satisfy or [{"id": "verdict", "description": "verdict"}]:
        entry: dict[str, Any] = {
            "id": str(item.get("id") or "verdict"),
            "verdict": "satisfied" if verdict_is_positive else "contradicted",
            "evidence_refs": list(refs),
        }
        if not verdict_is_positive:
            entry["note"] = answer.rationale[:500]
        matrix.append(entry)
    verdict_block = {
        "primitive": answer.primitive, "value": answer.value,
        "probabilities": dict(answer.probabilities) if answer.probabilities else None,
        "confidence": answer.confidence,
        "evidence": [{"index": c.index, "quote": c.quote, "verified": c.verified} for c in answer.evidence],
        "rationale": answer.rationale,
        "tool_id": request.get("tool_id"), "run_id": request.get("run_id"), "finding_id": request.get("finding_id"),
        "judgment_group_id": request.get("judgment_group_id"),
        "finding_fingerprint": request.get("finding_fingerprint"),
        "judge_id": subagent_type,
    }
    return {
        "$schema": "aria/agent-response/v1",
        "request_id": str(request["request_id"]),
        "claim_id": claim_id,
        "agent_id": agent_id,
        "role": role,
        "status": "submitted",
        "satisfaction_matrix": matrix,
        "evidence_refs": list(refs),
        "details": {
            "verdict": verdict_block,
            "agent_subagent_type": subagent_type,
            "agent_dispatch_model": dispatch_model,
            "agent_confidence_source": confidence_source,
            "agent_contract_hash": contract_hash,
            "runtime_attempt_ledger_hash": attempt_ledger_hash,
            "judge_batch": True,
        },
    }


def run_judge_batch(
    *, tools_dir: Path, repo: Path, role: str, target_agent: str, request_ids: list[str],
    _runtime_stack: Any,
) -> int:
    """Serve K judge requests with one typed call; exit 0 when every member
    was settled (accepted or refused by name), 1 on a harness fault that
    left the batch unsettled. A batch that cannot start (`JudgeBatchRefused`)
    claims nothing: every request stays pending and the drain reads one
    named refusal per request."""
    try:
        return _run_judge_batch(tools_dir=tools_dir, repo=repo, role=role, target_agent=target_agent,
                                request_ids=request_ids, _runtime_stack=_runtime_stack)
    except JudgeBatchRefused as exc:
        sys.stderr.write(f"judge_batch_refused: {exc.reason}\n")
        for request_id in request_ids:
            _engine._refuse_dispatch(request={"role": role}, request_id=request_id, target_agent=target_agent,
                                     reason=exc.reason.split(":", 1)[0])
        return _engine.REFUSAL_EXIT_CODE


def _run_judge_batch(
    *, tools_dir: Path, repo: Path, role: str, target_agent: str, request_ids: list[str],
    _runtime_stack: Any,
) -> int:
    from aria_kernel.agent_invocations import derive_request_states
    from aria_kernel.agent_surface import JUDGE_ROLES
    from aria_kernel.budget import _reserve_native_runtime_attempt, price_tokens, record_cost_attribution
    from aria_kernel.feedback_store import FEEDBACK_VERDICTS
    from aria_kernel.genesis_policy import _adaptive_runtime_policy, judgment_pipeline_policy
    from aria_kernel.native_admission import AdmissionOutcome
    from aria_kernel.tool_registry import GovernanceError, append_tools_governance
    from aria_kernel.typed_judgment import (
        ChoiceQuestion, JudgmentBatch, estimate_batch_input_tokens, parse_batch_answers,
        render_batch_system_turn, render_batch_user_turn,
    )
    from zai_runtime import ZaiTransportUnavailable, resolve_zai_max_tokens, run_zai_chat

    agent_id = f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"
    batch_id = _batch_id(request_ids)
    _engine._stage(f"judge_batch_begin batch_id={batch_id} role={role} target={target_agent} k={len(request_ids)}")
    if role not in JUDGE_ROLES:
        raise JudgeBatchRefused("judge_batch_role_not_judge")
    if len(request_ids) != len(set(request_ids)) or not request_ids:
        raise JudgeBatchRefused("judge_batch_request_ids_invalid")

    pipeline = judgment_pipeline_policy(_engine._operator_policy_root(tools_dir))
    max_input_tokens = int(pipeline["judge_batch_max_input_tokens"])
    policy_root = _engine._operator_policy_root(tools_dir)
    policy = _adaptive_runtime_policy(policy_root)
    if policy is None:
        raise JudgeBatchRefused("judge_batch_requires_adaptive_policy")

    rows = _load_requests(tools_dir=tools_dir, request_ids=request_ids, role=role, target_agent=target_agent)
    members = [_BatchMember(request=row, request_id=str(row["request_id"])) for row in rows]
    states = derive_request_states(base_dir=tools_dir)
    not_pending = [m.request_id for m in members if states.get(m.request_id) not in ("PENDING", "REQUEUED")]
    if not_pending:
        raise JudgeBatchRefused(f"judge_batch_request_not_pending:{','.join(not_pending)[:120]}")

    # Task binding: one anchor for the whole batch (same target_sha by
    # construction), so one git probe answers for every member.
    if policy.monetary_admission == "managed_subscription":
        binding_refusal = _engine._native_task_binding_refusal(repo_root=repo, tools_dir=tools_dir, request=rows[0])
        if binding_refusal is not None:
            for member in members:
                _engine._refuse_native_admission(request=member.request, reason=binding_refusal,
                                                 kind=_engine.TASK_BINDING_REFUSAL)
                member.settled = True
            return _engine.REFUSAL_EXIT_CODE

    # The fleet probe, once. The managed Claude context records usage under
    # the batch's identity; only the route that answers is charged.
    batch_identity = {**rows[0], "request_id": batch_id}
    admission, contexts = _engine._admit_native_route(
        repo_root=repo, tools_dir=tools_dir, request_id=batch_id, request=batch_identity,
        target_agent=target_agent, policy=policy, policy_root=policy_root, _runtime_stack=_runtime_stack,
    )
    if admission.outcome is not AdmissionOutcome.ADMITTED:
        for member in members:
            _engine._bind_request_to_route(tools_dir=tools_dir, request_id=member.request_id, request=member.request,
                                           policy=policy, admission=admission, contexts=contexts)
            member.settled = True
        return _engine.REFUSAL_EXIT_CODE
    route = admission.eligible_routes[0]
    observation = next(row for row in admission.candidate_observations if row["provider"] == route["provider"])
    if route["runtime"] not in tuple(pipeline["judge_batch_runtimes"]):
        raise JudgeBatchRefused(f"judge_batch_route_not_batchable:{route['runtime']}")
    context = contexts[route["provider"]]
    contract = _engine._deliver_agent_contract(target_agent, repo)

    # Claims: every member, one lease each, priced for the whole batch.
    lease_seconds = _engine._batch_worst_case_seconds(len(members))
    for member in members:
        claim = _engine._claim_request_via_cli(request_id=member.request_id, agent_id=agent_id,
                                               lease_seconds=lease_seconds, tools_dir=tools_dir)
        if claim is None or not claim.get("lease_token") or not claim.get("claim_id"):
            # A member the kernel would not lease is left pending, by name;
            # the batch continues with the members it holds.
            _engine._refuse_dispatch(request=member.request, request_id=member.request_id, target_agent=target_agent,
                                     reason="judge_batch_claim_unavailable", failure_class="harness_unavailable",
                                     retryable=True)
            member.settled = True
            continue
        member.claim = claim
        _runtime_stack.enter_context(HeldClaim(
            tools_dir=tools_dir, repo=repo, request_id=member.request_id, claim_id=member.claim_id,
            agent_id=agent_id, lease_token=member.lease_token, release=_engine._release_claim,
            derive_state=_engine._held_request_state if _engine._derive_request_state is not None else None,
            log=_engine._stage,
        ))
    held = [m for m in members if m.claim is not None]
    if not held:
        return _engine.REFUSAL_EXIT_CODE

    # Envelopes and prompts: the fused claim response is the envelope the
    # mint sealed; the render must reproduce the sealed hash.
    if _engine._fuse_prompt_envelope is None or _engine._render_invocation_prompt is None:
        for member in held:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="kernel_prompt_renderer_unavailable", failure_class="harness_unavailable",
                                retryable=True)
        return _engine.REFUSAL_EXIT_CODE
    questions = []
    for member in held:
        envelope = _engine._fuse_prompt_envelope(member.claim)
        if member.request["ledger_hash"] != member.claim["request_ledger_hash"]:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="native_runtime_task_binding_unavailable", failure_class="harness_unavailable",
                                retryable=True)
            continue
        envelope["target_sha"] = member.request["target_sha"]
        envelope.setdefault("request_id", member.request_id)
        for anchor in ("claim_ledger_hash", "request_ledger_hash"):
            if member.claim.get(anchor) is not None:
                envelope[anchor] = member.claim[anchor]
        if not envelope.get("expected_output_path") or not envelope.get("role"):
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="request_envelope_missing_expected_output_path", failure_class="policy_violation",
                                retryable=False)
            continue
        bound = _engine._render_and_bind_prompt(request_envelope=envelope, request_id=member.request_id)
        if bound is None:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="prompt_hash_binding_mismatch", failure_class="harness_unavailable", retryable=True)
            continue
        member.envelope = envelope
        member.prompt, member.prompt_hash = bound
        prompt_file = tools_dir / "agent-invocations" / "prompts" / f"{member.request_id}.md"
        prompt_file.parent.mkdir(parents=True, exist_ok=True)
        prompt_file.write_text(member.prompt, encoding="utf-8")
        excerpts = envelope.get("evidence_excerpts")
        questions.append(ChoiceQuestion(
            question_id=member.request_id, prompt=member.prompt, options=tuple(FEEDBACK_VERDICTS),
            evidence_refs=tuple(str(r) for r in (envelope.get("evidence_refs") or [])),
            evidence_excerpts=tuple(excerpts) if isinstance(excerpts, list) else None,
        ))
    live = [m for m in held if m.envelope is not None]
    if not live:
        return _engine.REFUSAL_EXIT_CODE

    # The input budget: shrink from the tail until the batch fits; the
    # members left out are released without an attempt (harness-class).
    batch = JudgmentBatch(batch_id=batch_id, questions=tuple(questions))
    while len(batch.questions) > 1 and estimate_batch_input_tokens(batch) > max_input_tokens:
        dropped = live.pop()
        _release_and_refuse(dropped, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                            reason="judge_batch_call_failed:input_budget", failure_class="harness_unavailable",
                            retryable=True)
        batch = JudgmentBatch(batch_id=batch_id, questions=tuple(q for q in batch.questions if q.question_id != dropped.request_id))
    if estimate_batch_input_tokens(batch) > max_input_tokens:
        for member in live:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="judge_batch_call_failed:input_budget", failure_class="harness_unavailable",
                                retryable=True)
        return _engine.REFUSAL_EXIT_CODE

    # Attempt reservations: one per member, before the call.
    session_id = str(uuid.uuid4())
    attempts: dict[str, dict[str, Any]] = {}
    for member in list(live):
        try:
            attempts[member.request_id] = _reserve_native_runtime_attempt(
                repo_root=repo, base_dir=tools_dir, request_id=member.request_id,
                request_ledger_hash=member.envelope["request_ledger_hash"], claim_id=member.claim_id,
                claim_ledger_hash=member.envelope["claim_ledger_hash"], session_id=session_id,
                agent_id=agent_id, lease_token=member.lease_token, attempt_id=str(uuid.uuid4()),
                provider=route["provider"], runtime=route["runtime"], model=route["model"],
                requested_effort=route["effort"], auth_method=observation["auth_method"],
                expected_policy_digest=policy.policy_digest, settings_hash=context.settings_hash,
                pricing=observation["pricing"], admission=admission.as_row(),
            )
        except GovernanceError as exc:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="native_runtime_execution_unavailable", failure_class="harness_unavailable",
                                retryable=True)
            live.remove(member)
            batch = JudgmentBatch(batch_id=batch_id, questions=tuple(q for q in batch.questions if q.question_id != member.request_id))
            sys.stderr.write(f"native_runtime_reservation_unavailable:{exc}\n")
    if not live:
        return _engine.REFUSAL_EXIT_CODE

    # ONE call.
    system_turn = render_batch_system_turn(JUDGE_BATCH_SYSTEM_PROMPT + "\n\n" + contract.text)
    user_turn = render_batch_user_turn(batch)
    completed = None
    call_failure: str | None = None
    try:
        completed = run_zai_chat(
            context.credential, base_url=context.base_url, model=route["model"], system=system_turn,
            user=user_turn, timeout_seconds=_engine._max_timeout_seconds(),
            max_tokens=resolve_zai_max_tokens(dict(os.environ)), reasoning_effort=route["effort"],
            json_object=True,
        )
        if completed.auth_failure is not None:
            call_failure = "auth_failed"
        elif completed.credit_exhaustion is not None:
            call_failure = "credit_exhausted"
            from aria_kernel.provider_cooldown import record_provider_cooldown
            record_provider_cooldown(
                tools_dir, provider=route["provider"], model=route["model"],
                cooldown_seconds=policy.provider_cooldown_seconds, request_id=batch_id, claim_id=batch_id,
                detection={"marker": completed.credit_exhaustion, "vendor_error_code": completed.error_code,
                           "vendor_error_message": completed.error_message, "http_status": completed.http_status},
            )
        elif completed.returncode != 0:
            call_failure = "output_budget_exhausted" if completed.finish_reason == "length" else f"http_{completed.http_status}"
        elif completed.usage is None:
            call_failure = "usage_unavailable"
    except ZaiTransportUnavailable as exc:
        call_failure = "transport_unavailable"
        sys.stderr.write(f"zai_transport_unavailable: {exc}\n")

    payload_hash = ("sha256:" + hashlib.sha256(completed.raw_body).hexdigest()) if completed is not None else None
    parsed = None
    if call_failure is None:
        parsed = parse_batch_answers(batch, completed.final_message)
        # A payload the parser could not read as this batch's JSON fails
        # every question under one payload-level code: the call's fault.
        payload_codes = {"payload_not_json", "payload_not_object", "payload_schema_mismatch", "answers_not_list"}
        if not parsed.answers and parsed.failures and all(f.reason_code in payload_codes for f in parsed.failures.values()):
            call_failure = next(iter(parsed.failures.values())).reason_code

    def _finish_attempt(member: _BatchMember, *, result_admission: str, usage_hash: str | None) -> None:
        append_tools_governance(tools_dir, "runtime_attempt_finished", {
            "schema_version": 1, "attempt_ledger_hash": attempts[member.request_id]["ledger_hash"],
            "request_id": member.request_id, "claim_id": member.claim_id, "session_id": session_id,
            "provider_session_ids": ([] if completed is None or completed.response_id is None else [completed.response_id]),
            "provider_session_provenance": "http_response_id",
            "exit_code": completed.http_status if completed is not None else None,
            "observed_effort": None, "usage_ledger_hash": usage_hash, "result_admission": result_admission,
            "agent_contract": contract.as_row(), "batch_id": batch_id, "batch_size": len(live),
            "usage_apportioned": usage_hash is not None,
        })

    if call_failure is not None:
        for member in live:
            _finish_attempt(member, result_admission=call_failure, usage_hash=None)
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason=f"judge_batch_call_failed:{call_failure}", failure_class="harness_unavailable",
                                retryable=True)
        _engine._stage(f"judge_batch_call_failed batch_id={batch_id} code={call_failure} k={len(live)}")
        return _engine.REFUSAL_EXIT_CODE

    # ONE cost row for the call; each attempt row carries its share.
    usage_row = None
    input_tokens, output_tokens = completed.usage["input_tokens"], completed.usage["output_tokens"]
    price = price_tokens(model=route["model"], input_tokens=input_tokens, output_tokens=output_tokens)
    if price.source == "unknown":
        append_tools_governance(tools_dir, "runtime_usage_pricing_unavailable", {
            "batch_id": batch_id, "model": route["model"], "input_tokens": input_tokens, "output_tokens": output_tokens,
            "request_count": len(live),
        })
    else:
        usage_row = record_cost_attribution(
            cycle_id=str(live[0].envelope.get("cycle_id") or ""), plan_id=str(live[0].envelope.get("convergence_id") or batch_id),
            agent_role=role, model=route["model"], input_tokens=input_tokens, output_tokens=output_tokens,
            estimated_usd=price.usd, base_dir=tools_dir,
        )
    prompt_bytes = {m.request_id: len((m.prompt or "").encode("utf-8")) for m in live}
    total_bytes = max(1, sum(prompt_bytes.values()))

    # Per member: envelope, transcript, gate, submit, reconcile, summary.
    question_by_id = {q.question_id: q for q in batch.questions}
    exit_code = 0
    for member in live:
        share = round(prompt_bytes[member.request_id] / total_bytes, 4)
        failure = parsed.failures.get(member.request_id)
        if failure is not None:
            _finish_attempt(member, result_admission=f"item_unanswered:{failure.reason_code}",
                            usage_hash=usage_row["ledger_hash"] if usage_row else None)
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason=f"judge_batch_item_unanswered:{failure.reason_code}",
                                failure_class="response_schema_rejected", retryable=False)
            continue
        answer = parsed.answers[member.request_id]
        envelope = member.envelope
        expected_output_path = Path(envelope["expected_output_path"])
        transcript_path = expected_output_path.with_suffix(".transcript.jsonl")
        sealed = build_envelope_from_typed_answer(
            question=question_by_id[member.request_id], answer=answer, request=envelope, claim_id=member.claim_id,
            agent_id=agent_id, role=role, subagent_type=target_agent, must_satisfy=envelope.get("must_satisfy") or [],
            dispatch_model=str(route["model"]), confidence_source="self_reported",
            contract_hash=contract.contract_hash, attempt_ledger_hash=attempts[member.request_id]["ledger_hash"],
        )
        expected_output_path.parent.mkdir(parents=True, exist_ok=True)
        _engine._write_sanitized_envelope(expected_output_path, sealed)
        transcript_path.write_text(json.dumps({
            "schema_version": BATCH_SUMMARY_SCHEMA, "batch_id": batch_id, "payload_hash": payload_hash,
            "request_id": member.request_id, "answer": json.loads(json.dumps(sealed["details"]["verdict"])),
            "usage_share": share,
        }, sort_keys=True) + "\n", encoding="utf-8")
        _engine._publish_artifact_paths(expected_output_path, transcript_path)
        errors = _engine._pre_submit_validate_envelope(sealed, role=role, request=envelope, tools_dir=tools_dir)
        if errors:
            _finish_attempt(member, result_admission="judge_verdict_contract_violation",
                            usage_hash=usage_row["ledger_hash"] if usage_row else None)
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason="judge_verdict_contract_violation", failure_class="response_schema_rejected",
                                retryable=False)
            continue
        _finish_attempt(member, result_admission="pending_native_submit",
                        usage_hash=usage_row["ledger_hash"] if usage_row else None)
        transcript_hash = "sha256:" + hashlib.sha256(transcript_path.read_bytes()).hexdigest()
        try:
            submit_proc = _engine._submit_via_cli(
                claim_id=member.claim_id, agent_id=agent_id, lease_token=member.lease_token,
                expected_output_path=expected_output_path, repo=repo, tools_dir=tools_dir,
                request_envelope=envelope, transcript_hash=transcript_hash, transcript_output_path=transcript_path,
            )
        except _engine.subprocess.TimeoutExpired:
            _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                reason=f"submit_timeout_{_engine.SUBMIT_RESULT_TIMEOUT_SECONDS}s",
                                failure_class="timeout", retryable=True)
            exit_code = 1
            continue
        if submit_proc.returncode != 0:
            detail = "\n".join(part for part in (submit_proc.stdout or "", submit_proc.stderr or "") if part.strip())
            sys.stderr.write("::error::aria executor could not submit the batch member result: "
                             + _engine._redact_lease_in_message(detail, member.lease_token) + "\n")
            if _engine._rejected_only_for_verification_unavailable(submit_proc.stdout or ""):
                _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                    reason="evidence_verification_unavailable", failure_class="harness_unavailable",
                                    retryable=True)
            elif _engine._rejected_result_recorded(submit_proc.stdout):
                _engine._fail_submit_dispatch(request=envelope, request_id=member.request_id, target_agent=target_agent,
                                              failure_class="response_schema_rejected", retryable=False,
                                              detail_code="agent_result_rejected")
                member.settled = True
            else:
                _release_and_refuse(member, tools_dir=tools_dir, repo=repo, agent_id=agent_id, target_agent=target_agent,
                                    reason="submit_rejected", failure_class="response_schema_rejected", retryable=False)
            continue
        if not _engine._reconcile_native_result(
            tools_dir=tools_dir, request_id=member.request_id, claim_id=member.claim_id, agent_id=agent_id,
            session_id=session_id, policy_digest=policy.policy_digest, request_envelope=envelope,
        ):
            exit_code = 1
            member.settled = True
            continue
        _engine._write_dispatch_summary(
            route=_engine._dispatch_route_for(envelope, target_agent=target_agent), request_id=member.request_id,
            outcome="succeeded", failure=None, exit_code=0,
        )
        member.settled = True
    _engine._stage(
        f"judge_batch_done batch_id={batch_id} k={len(live)} "
        f"answered={len(parsed.answers)} unanswered={len(parsed.failures)} unexpected={len(parsed.unexpected)}"
    )
    return exit_code


__all__ = ["BATCH_SUMMARY_SCHEMA", "JudgeBatchRefused", "build_envelope_from_typed_answer", "run_judge_batch"]
