"""Bridge between bound-agent submissions and the existing consensus engine.

Plan 016 Faz C5/C6: when an envelope-routed judge submits an ACCEPTED
response, the kernel must record the verdict in `feedback_store`'s
`operator-feedback.jsonl` ledger as an `ai_judge` row so the existing
`generate_ai_consensus` engine can compute consensus over multiple judge
verdicts. Without this bridge, the lease lifecycle ACCEPT terminal state
is decoupled from the consensus pipeline and a finding can never be
promoted from raw -> consensus -> operator-facing.

Per operator instruction: `feedback_store.generate_ai_consensus` and
`plan_convergence` are NOT replaced. This module is a one-way adapter
that translates an `aria/agent-response/v1` envelope into the
`record_operator_feedback` shape — no judgment logic is duplicated.

Goldset and Change-Intelligence wire-up (C6) routes through the same
hook: when role is `goldset_curation` or `change_intelligence`, the
bridge extracts `details.proposal` / `details.impact_map` and persists
them under `aria-tools/judgment-pipeline/<role>/<request_id>.json` so
operator commands (`aria-kernel goldset propose`, change-intelligence
revalidation queues) can consume them without re-reading the response
envelope themselves.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .agent_surface import JUDGE_ROLES, SUPPORTING_ROLES
from .feedback_store import (
    CONSENSUS_MIN_CONFIDENCE,
    FEEDBACK_SEVERITIES,
    FEEDBACK_VERDICTS,
    generate_ai_consensus,
    record_operator_feedback,
)
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


def is_judge_role(role: str | None) -> bool:
    return role in JUDGE_ROLES


def is_supporting_role(role: str | None) -> bool:
    return role in SUPPORTING_ROLES


def _coerce_severity(value: Any, *, fallback: str = "medium") -> str:
    """feedback_store accepts {low, medium, high, critical}; agent envelope
    may use uppercase per finding schema. Normalize without rejecting."""
    if not isinstance(value, str):
        return fallback
    normalized = value.strip().lower()
    if normalized in FEEDBACK_SEVERITIES:
        return normalized
    if normalized == "informational":
        return "low"
    return fallback


def _verdict_field(details: dict[str, Any]) -> dict[str, Any]:
    """The judge .md prompts shape verdicts under details.verdict (evidence,
    adversarial) or details.consensus (arbiter). Return whichever exists.
    """
    if isinstance(details.get("verdict"), dict):
        return dict(details["verdict"])
    if isinstance(details.get("consensus"), dict):
        return dict(details["consensus"])
    if isinstance(details.get("verdict"), str):
        # Flat shape (ORPHAN-HIGH-629 sibling): the judge contract file says
        # BOTH "Return JSON with: verdict, judge_id, confidence..." and
        # "details.verdict.rationale". The first live judge run answered
        # flat, was ACCEPTED by the envelope gate, and dropped HERE with
        # "expected verdict ..., got None" — a verdict lost between two
        # halves of one document. Honour both spellings; the envelope gate
        # stays the only authority on validity.
        return {
            key: details.get(key)
            for key in (
                "verdict", "tool_id", "run_id", "finding_id", "judge_id",
                "model", "prompt_hash", "confidence", "rationale",
                "evidence_refs", "judgment_group_id", "severity",
            )
            if details.get(key) is not None
        }
    return {}


def record_judge_verdict_from_response(
    *,
    request: dict[str, Any],
    response: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Translate an ACCEPTED judge response into an ai_judge feedback row.

    Returns the persisted row, or None when the envelope role is not a
    judge role (the bridge is a no-op for non-judge submissions).

    Raises GovernanceError when the response is missing the data the
    consensus engine requires (tool_id / run_id / finding_id come from
    the request envelope's optional fields; verdict + severity from
    the response.details).
    """
    role = response.get("role")
    if not is_judge_role(role):
        return None

    details = response.get("details") or {}
    if not isinstance(details, dict):
        details = {}
    verdict_block = _verdict_field(details)

    tool_id = request.get("tool_id") or verdict_block.get("tool_id")
    run_id = request.get("run_id") or verdict_block.get("run_id")
    finding_id = request.get("finding_id") or verdict_block.get("finding_id")
    if not (tool_id and run_id and finding_id):
        raise GovernanceError(
            "judge bridge requires tool_id, run_id, finding_id in request or response.details.verdict; "
            f"got tool_id={tool_id!r}, run_id={run_id!r}, finding_id={finding_id!r}"
        )

    verdict = verdict_block.get("verdict")
    if verdict not in FEEDBACK_VERDICTS:
        raise GovernanceError(
            f"judge bridge expected verdict in {FEEDBACK_VERDICTS}, got {verdict!r}"
        )
    severity = _coerce_severity(verdict_block.get("severity") or details.get("severity"))
    # D1 (Kapalı Döngü) — judge identity. `response["agent_id"]` is the
    # EXECUTOR's identity (`ci-executor:gha-<run>`), not the judge's: reading
    # it collapsed every judge drained by one workflow run into a single
    # voter (consensus structurally impossible) while judges drained by
    # DIFFERENT runs counted as distinct voters with meaningless identity.
    # The judge's real identity is the subagent the executor invoked
    # (`details.agent_subagent_type`, force-stamped by ci_executor); the
    # mock lane and legacy envelopes carry it as `verdict.judge_id`.
    judge_id = details.get("agent_subagent_type") or verdict_block.get("judge_id")
    if not judge_id:
        raise GovernanceError(
            "judge bridge requires details.agent_subagent_type "
            "(or details.verdict.judge_id)"
        )
    if str(judge_id).startswith("ci-executor:"):
        # Refuse loudly instead of silently repairing: an executor-shaped
        # identity means the producer regressed, and a repaired row would
        # hide that while still poisoning per-judge calibration.
        raise GovernanceError(
            f"judge bridge refuses executor-shaped judge identity: {judge_id!r}"
        )

    confidence = verdict_block.get("confidence")
    if confidence is not None and not isinstance(confidence, (int, float)):
        confidence = None

    note = (
        verdict_block.get("rationale")
        or verdict_block.get("note")
        or response.get("rationale")
        or "envelope-routed judge submission"
    )
    if not isinstance(note, str) or not note.strip():
        note = "envelope-routed judge submission"

    raw_evidence_refs = verdict_block.get("evidence_refs") or response.get("evidence_refs") or []
    evidence_refs = [str(r) for r in raw_evidence_refs if isinstance(r, str) and r.strip()]

    row = record_operator_feedback(
        tool_id=str(tool_id),
        run_id=str(run_id),
        finding_id=str(finding_id),
        verdict=verdict,
        severity=severity,
        note=note,
        source_type="ai_judge",
        judge_id=str(judge_id),
        model=verdict_block.get("model"),
        prompt_hash=verdict_block.get("prompt_hash"),
        confidence=float(confidence) if confidence is not None else None,
        rationale=str(note),
        evidence_refs=evidence_refs,
        # D1 — group identity comes from the MINT (judge_fanout's canonical
        # `judge:<tool>:<run>:<finding>`), never from the judge's own payload:
        # a judge echoing its request id as group id split one finding's two
        # verdicts across two groups-of-one, so the real disagreement on
        # anthropic.provider.ts:3 never met itself and never escalated.
        judgment_group_id=request.get("judgment_group_id") or verdict_block.get("judgment_group_id"),
        finding_fingerprint=verdict_block.get("finding_fingerprint"),
        base_dir=base_dir,
    )
    return row


def persist_supporting_payload(
    *,
    request: dict[str, Any],
    response: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Plan 016 Faz C6 — persist Goldset / Change-Intelligence outputs.

    `goldset_curation` responses carry `details.proposal` (consumed by
    `aria-kernel goldset propose`); `change_intelligence` responses carry
    `details.impact_map`. Both are persisted under
    `aria-tools/judgment-pipeline/<role>/<request_id>.json` so the
    consuming kernel command does not have to re-read the raw envelope.

    Returns the persisted-payload row metadata, or None when the role is
    not a supporting role.
    """
    role = response.get("role")
    if not is_supporting_role(role):
        return None
    request_id = request.get("request_id") or response.get("request_id")
    if not request_id:
        raise GovernanceError("supporting bridge requires request_id")
    details = response.get("details") or {}
    if not isinstance(details, dict):
        raise GovernanceError("supporting bridge expects response.details to be an object")
    payload_key = "proposal" if role == "goldset_curation" else "impact_map"
    payload = details.get(payload_key)
    if payload is None:
        raise GovernanceError(
            f"supporting bridge expects response.details.{payload_key} for role {role!r}"
        )

    root = ensure_tools_dir(base_dir)
    out_dir = root / "judgment-pipeline" / role
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{request_id}.json"
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    append_tools_governance(
        root,
        f"agent_supporting_payload_persisted",
        {
            "role": role,
            "request_id": request_id,
            "path": out_path.relative_to(root).as_posix(),
            "at": utc_now(),
        },
    )
    return {"role": role, "request_id": request_id, "path": str(out_path)}


def run_consensus(
    *,
    tool_id: str,
    cycle_id: str | None = None,
    min_confidence: float = CONSENSUS_MIN_CONFIDENCE,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Thin wrapper over feedback_store.generate_ai_consensus.

    Why a wrapper: Plan 016 wants the consensus invocation to be reachable
    via a stable kernel CLI (`aria-kernel consensus run`) without
    callers having to import feedback_store directly. The wrapper also
    emits a governance event so a consensus run lands in the same
    audit trail as the lease lifecycle events.
    """
    result = generate_ai_consensus(
        tool_id=tool_id,
        cycle_id=cycle_id,
        min_confidence=min_confidence,
        base_dir=base_dir,
    )
    root = ensure_tools_dir(base_dir)
    append_tools_governance(
        root,
        "agent_consensus_computed",
        {
            "tool_id": tool_id,
            "cycle_id": cycle_id,
            "consensus_count": len(result.get("consensus", [])) if isinstance(result, dict) else 0,
            "uncertainty_count": len(result.get("uncertainties", [])) if isinstance(result, dict) else 0,
            "min_confidence": min_confidence,
        },
    )
    return result
