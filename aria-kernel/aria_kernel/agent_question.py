"""Plan ARIA-V4 §2e — inter-agent question envelope.

The 6-agent narrative-pedagogy audit surfaced an operator requirement:
when an ARIA planner-agent is uncertain whether a rule is genuinely
Tier-1 safety or merely stylistic, it should be able to ASK ANOTHER
agent. Native Claude Code subagents cannot spawn nested subagents
(``docs/sub-agents.md:739`` — Anthropic structural constraint), so
the question protocol is KERNEL-MEDIATED via this envelope.

Architecture:

  * Asker emits ``aria/agent-question/v1`` row to
    ``aria-tools/agent-questions.jsonl`` (hash-chained, gitignored
    per V2 I-23 update — written-but-never-tracked surface).
  * Kernel routes the question to the target (by recording it in
    the target's pending-queue; the target picks it up on its next
    invocation).
  * Target emits ``aria/agent-question-response/v1`` row carrying
    answered_tier + rationale + counter_evidence_refs OR a
    ``verdict: refused`` with reason_class per
    ``aria/agent-refusal/v1`` semantics.
  * Asker's plan MUST cite ``question_id`` in its satisfaction
    matrix when the answer changed its tier choice (invariant
    I-V4-12).

Anti-coupling (Plan §2e — challenger-planner §7 mitigation):
  * A target answers ≤1 OPEN question per cycle. The cycle counter
    is the ARIA cycle_id; multiple cycles can interleave but each
    cycle bounds the per-target question budget (prevents
    back-channel chatter that would collapse consensus-arbiter
    independence).
  * Free-form chat outside this envelope is FORBIDDEN.

Refusal discipline:
  * A target that can't ground its answer in SPEC / IDENTITY /
    CONTRACTS emits ``verdict: refused`` with ``reason_class:
    evidence``. The asker treats refusal as "no signal" — does NOT
    interpret silence as agreement (challenger-planner §4
    "consequence-as-cost-benefit" mitigation).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_QUESTIONS_FILENAME = "agent-questions.jsonl"

# Plan ARIA-V4 §2e — closed enum for question_kind (caller must
# pick one; typo-class kinds fail at envelope construction).
QUESTION_KINDS: frozenset[str] = frozenset({
    "tier_classification",
    "extrapolation_check",
    "invariant_grounding",
})

# Plan ARIA-V4 §2e — closed enum for response verdict.
RESPONSE_VERDICTS: frozenset[str] = frozenset({
    "agreed",
    "disagreed",
    "refused",
})

# Plan ARIA-V4 §2e — closed enum for refusal reason_class
# (mirrors aria/agent-refusal/v1 vocabulary).
REFUSAL_REASON_CLASSES: frozenset[str] = frozenset({
    "scope",
    "evidence",
    "envelope",
    "operator_required",
})


@dataclass(frozen=True)
class AgentQuestion:
    """Plan ARIA-V4 §2e — frozen envelope for one inter-agent
    question.
    """

    question_id: str
    asker_agent_id: str
    target_agent_id: str
    question_kind: str
    rule_text: str
    hypothesised_tier: int
    evidence_refs: tuple[str, ...]
    cycle_id: str
    asked_at: str
    schema_version: int = 1
    schema_uri: str = "aria/agent-question/v1"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["evidence_refs"] = list(d.get("evidence_refs", ()))
        return d


@dataclass(frozen=True)
class AgentQuestionResponse:
    """Plan ARIA-V4 §2e — frozen envelope for one response."""

    question_id: str
    answerer_agent_id: str
    answered_tier: int | None
    rationale: str
    counter_evidence_refs: tuple[str, ...]
    verdict: str
    refusal_reason: str | None
    cycle_id: str
    answered_at: str
    schema_version: int = 1
    schema_uri: str = "aria/agent-question-response/v1"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["counter_evidence_refs"] = list(d.get("counter_evidence_refs", ()))
        return d


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _questions_path(base_dir: str | Path) -> Path:
    return Path(base_dir) / _QUESTIONS_FILENAME


def _validate_question_inputs(
    *,
    question_kind: str,
    hypothesised_tier: int,
    evidence_refs: list[str] | tuple[str, ...],
    rule_text: str,
) -> None:
    """Plan ARIA-V4 §2e — validate envelope shape at construction.
    Raises ValueError on any malformed field; the caller routes
    that to ``aria/agent-refusal/v1`` (envelope reason_class).
    """
    if question_kind not in QUESTION_KINDS:
        raise ValueError(
            f"agent_question_unknown_kind: {question_kind!r} "
            f"(allowed: {sorted(QUESTION_KINDS)})"
        )
    if hypothesised_tier not in {1, 2, 3}:
        raise ValueError(
            f"agent_question_hypothesised_tier_out_of_range: "
            f"{hypothesised_tier!r} (allowed: 1 | 2 | 3)"
        )
    if not (rule_text or "").strip():
        raise ValueError("agent_question_empty_rule_text")
    if not evidence_refs:
        raise ValueError(
            "agent_question_requires_at_least_one_evidence_ref "
            "(Plan ARIA-V4 §2e — refusal-without-evidence path)"
        )


def ask(
    *,
    base_dir: str | Path,
    asker_agent_id: str,
    target_agent_id: str,
    question_kind: str,
    rule_text: str,
    hypothesised_tier: int,
    evidence_refs: list[str] | tuple[str, ...],
    cycle_id: str,
) -> AgentQuestion:
    """Plan ARIA-V4 §2e — append one ``aria/agent-question/v1`` row
    to ``aria-tools/agent-questions.jsonl``.

    Anti-coupling: caller MUST honor the ≤1-open-question-per-target
    -per-cycle bound. The kernel enforces via
    ``count_open_questions_for_target``; callers that try to mint a
    second question hit ``GovernanceError`` from that helper.
    """
    from .ledger import append_jsonl
    from .tool_registry import GovernanceError, ensure_tools_dir

    _validate_question_inputs(
        question_kind=question_kind,
        hypothesised_tier=hypothesised_tier,
        evidence_refs=evidence_refs,
        rule_text=rule_text,
    )
    root = ensure_tools_dir(base_dir)
    # Anti-coupling check.
    open_count = count_open_questions_for_target(
        base_dir=root,
        target_agent_id=target_agent_id,
        cycle_id=cycle_id,
    )
    if open_count >= 1:
        raise GovernanceError(
            f"agent_question_target_busy: "
            f"target={target_agent_id!r} already has {open_count} "
            f"open question(s) in cycle {cycle_id!r} (Plan ARIA-V4 "
            f"§2e anti-coupling — one question per target per cycle)"
        )
    question = AgentQuestion(
        question_id=str(uuid.uuid4()),
        asker_agent_id=asker_agent_id,
        target_agent_id=target_agent_id,
        question_kind=question_kind,
        rule_text=rule_text,
        hypothesised_tier=hypothesised_tier,
        evidence_refs=tuple(evidence_refs),
        cycle_id=cycle_id,
        asked_at=_utc_now(),
    )
    append_jsonl(_questions_path(root), question.to_dict())
    return question


def answer(
    *,
    base_dir: str | Path,
    question_id: str,
    answerer_agent_id: str,
    answered_tier: int | None,
    rationale: str,
    counter_evidence_refs: list[str] | tuple[str, ...],
    verdict: str,
    refusal_reason: str | None = None,
    cycle_id: str,
) -> AgentQuestionResponse:
    """Plan ARIA-V4 §2e — append one
    ``aria/agent-question-response/v1`` row.

    Refusal discipline: ``verdict='refused'`` REQUIRES a
    ``refusal_reason`` in the closed enum
    ``REFUSAL_REASON_CLASSES``. Non-refused verdicts REQUIRE
    ``answered_tier`` in {1, 2, 3} AND non-empty rationale AND
    ≥1 counter_evidence_ref (Plan ARIA-V4 §2e — "answer must cite
    evidence or refuse").
    """
    from .ledger import append_jsonl
    from .tool_registry import GovernanceError, ensure_tools_dir

    if verdict not in RESPONSE_VERDICTS:
        raise ValueError(
            f"agent_question_response_unknown_verdict: {verdict!r} "
            f"(allowed: {sorted(RESPONSE_VERDICTS)})"
        )
    if verdict == "refused":
        if not refusal_reason or refusal_reason not in REFUSAL_REASON_CLASSES:
            raise ValueError(
                f"agent_question_response_refusal_requires_reason_class: "
                f"refusal_reason={refusal_reason!r} (allowed: "
                f"{sorted(REFUSAL_REASON_CLASSES)})"
            )
    else:
        # Non-refused responses MUST carry evidence.
        if answered_tier not in {1, 2, 3}:
            raise ValueError(
                f"agent_question_response_tier_out_of_range: "
                f"{answered_tier!r} (allowed: 1 | 2 | 3)"
            )
        if not (rationale or "").strip():
            raise ValueError(
                "agent_question_response_empty_rationale"
            )
        if not counter_evidence_refs:
            raise ValueError(
                "agent_question_response_requires_evidence_or_refuse "
                "(Plan ARIA-V4 §2e — silence-is-not-agreement)"
            )

    root = ensure_tools_dir(base_dir)
    # Sanity: the question_id must exist as an OPEN question (i.e.,
    # an unanswered ``aria/agent-question/v1`` row).
    question = find_question(base_dir=root, question_id=question_id)
    if question is None:
        raise GovernanceError(
            f"agent_question_response_unknown_question_id: "
            f"{question_id!r}"
        )
    existing_response = find_response(
        base_dir=root, question_id=question_id,
    )
    if existing_response is not None:
        raise GovernanceError(
            f"agent_question_response_already_answered: "
            f"question_id={question_id!r}"
        )

    response = AgentQuestionResponse(
        question_id=question_id,
        answerer_agent_id=answerer_agent_id,
        answered_tier=answered_tier if verdict != "refused" else None,
        rationale=rationale,
        counter_evidence_refs=tuple(counter_evidence_refs),
        verdict=verdict,
        refusal_reason=refusal_reason,
        cycle_id=cycle_id,
        answered_at=_utc_now(),
    )
    append_jsonl(_questions_path(root), response.to_dict())
    return response


def _read_all_rows(base_dir: str | Path) -> list[dict[str, Any]]:
    """Plan ARIA-V4 §2e — strict-jsonl read of agent-questions.jsonl.

    Routes through ``strict_jsonl_reader.read_strict_jsonl`` per
    Plan 026R §A.3 invariant — the bare ``except
    json.JSONDecodeError: continue`` pattern is forbidden on JSONL
    reads in the kernel. ``tolerant`` mode is correct here because
    a corrupt row in the question ledger should not block the
    anti-coupling check (the strict reader still emits
    ``ledger_corruption_diagnostic`` for forensic audit).
    """
    from .strict_jsonl_reader import read_strict_jsonl

    path = _questions_path(base_dir)
    if not path.exists():
        return []
    return list(
        read_strict_jsonl(
            path, on_corruption="tolerant",
            base_dir=Path(base_dir),
        )
    )


def find_question(
    *,
    base_dir: str | Path,
    question_id: str,
) -> dict[str, Any] | None:
    for row in _read_all_rows(base_dir):
        if (
            row.get("schema_uri") == "aria/agent-question/v1"
            and row.get("question_id") == question_id
        ):
            return row
    return None


def find_response(
    *,
    base_dir: str | Path,
    question_id: str,
) -> dict[str, Any] | None:
    for row in _read_all_rows(base_dir):
        if (
            row.get("schema_uri") == "aria/agent-question-response/v1"
            and row.get("question_id") == question_id
        ):
            return row
    return None


def count_open_questions_for_target(
    *,
    base_dir: str | Path,
    target_agent_id: str,
    cycle_id: str,
) -> int:
    """Plan ARIA-V4 §2e — count questions addressed to a target in
    the given cycle that have NO matching response yet. Used by
    ``ask`` to enforce the ≤1-open-per-target-per-cycle bound.
    """
    rows = _read_all_rows(base_dir)
    answered_ids = {
        row.get("question_id")
        for row in rows
        if row.get("schema_uri") == "aria/agent-question-response/v1"
    }
    open_count = 0
    for row in rows:
        if row.get("schema_uri") != "aria/agent-question/v1":
            continue
        if row.get("target_agent_id") != target_agent_id:
            continue
        if row.get("cycle_id") != cycle_id:
            continue
        if row.get("question_id") in answered_ids:
            continue
        open_count += 1
    return open_count


def list_questions(
    *,
    base_dir: str | Path,
    cycle_id: str | None = None,
    asker_agent_id: str | None = None,
    target_agent_id: str | None = None,
) -> list[dict[str, Any]]:
    """Plan ARIA-V4 §2e — list questions with optional filters.
    Returns the raw row dicts (NOT dataclass instances) so the CLI
    can render JSON directly.
    """
    out: list[dict[str, Any]] = []
    for row in _read_all_rows(base_dir):
        if row.get("schema_uri") != "aria/agent-question/v1":
            continue
        if cycle_id is not None and row.get("cycle_id") != cycle_id:
            continue
        if asker_agent_id is not None and row.get("asker_agent_id") != asker_agent_id:
            continue
        if target_agent_id is not None and row.get("target_agent_id") != target_agent_id:
            continue
        out.append(row)
    return out


__all__ = [
    "AgentQuestion",
    "AgentQuestionResponse",
    "QUESTION_KINDS",
    "REFUSAL_REASON_CLASSES",
    "RESPONSE_VERDICTS",
    "answer",
    "ask",
    "count_open_questions_for_target",
    "find_question",
    "find_response",
    "list_questions",
]
