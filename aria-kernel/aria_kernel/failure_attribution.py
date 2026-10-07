"""ARIA-HIGH-370 — kernel attribution of a failed episode to the work that failed.

WHY. ARIA-HIGH-285 records every finished drafter / implementer episode and
ARIA-HIGH-309 (#1773) turns a failure mode recurring
``LESSON_EPISODE_THRESHOLD`` times into a binding lesson, but only for
episodes marked ``attributable``. Measured on the runner store 2026-10-06:
19 drafter failure episodes, 18 of them ``attributable=false`` and the 19th
(``operator_withdrawn``) attributable although it records an operator's act,
so the lesson reader never fired. The episode took the first token of the
plan's terminal reason, and that token names the LANE (``stalled``,
``convergence_envelope_dead:<role>``), never the cause. The cause was on the
record all along, one join away: the dead envelope's request, its terminal
claim release (``release_reason``'s closed code) and its refused result
(the evidence law's ``agent_evidence_*`` codes). Nothing read them.

WHAT. :func:`attribute_plan_failure` and :func:`attribute_implementation_failure`
attribute a failure only when the failure's own evidence names the work:

* ``evidence_law`` — the agent's result was refused by the evidence law
  (``agent_invocation_results`` row, status ``rejected``, ``agent_evidence_*``);
* ``gate_refusal`` — a named kernel gate refused the work: the plan-content
  validator on a claim release (``PLAN_CONTENT_INVALID``), a rejected result
  under a non-evidence code, or an evaluation gate's reason code;
* ``cross_review_rejection`` — the evaluation ended on material cross-review
  risks the revisions never resolved;
* ``agent_refusal`` — the agent refused the REQUEST (``AGENT_REFUSED:<class>``):
  the refusal is a verdict on what the plan handed it, so it is the plan's
  (role ``drafter``), not the refusing agent's;
* ``apply_gate`` — the implementer's change failed an apply-gate or CI check;
* ``post_merge_revert`` — an attributed self-revert of the merged change.

Everything else — a lease or poll that ran out, a provider or runtime that
was unavailable (``release_reason`` fault domain ``harness``), an operator's
act, a request nobody claimed — is never attributed: it says nothing about
the work, and lane 365 owns that fault domain. Unknown is unattributed: the
rule is an allowlist of evidence, so a new failure shape teaches nothing
until its evidence is named here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .release_reason import parse_release_reason

EVIDENCE_LAW = "evidence_law"
GATE_REFUSAL = "gate_refusal"
CROSS_REVIEW_REJECTION = "cross_review_rejection"
AGENT_REFUSAL = "agent_refusal"
APPLY_GATE = "apply_gate"
POST_MERGE_REVERT = "post_merge_revert"
#: A plan abandoned under a reason no lane rule names: the abandon writer's
#: own words (the stall reaper is the only production writer, and its
#: ``stalled`` is a lane code).
ABANDON_REASON = "abandon_reason"

#: The plan's own role: the seed or revision the planners were handed.
DRAFTER_ROLE = "drafter"
IMPLEMENTER_ROLE = "implementer"
ENVELOPE_DEAD = "convergence_envelope_dead"

#: Evaluation reason codes that name the lane, the operator or a budget —
#: never the plan's content. ``max_rounds_reached`` rides with the cause
#: (``unresolved_material_risk``, ``coverage_gaps_present``); alone it is a
#: budget. ``implementation_delivery_exhausted`` is the implementer lane's
#: (its rejections are implementer episodes of their own).
LANE_REASON_CODES: frozenset[str] = frozenset({
    "stalled", ENVELOPE_DEAD, "human_required", "operator_withdrawn", "max_rounds_reached",
    "pending_tasks_present", "partial_cross_review_coverage", "partial_coverage",
    "coverage_missing", "coverage_environment_unable", "cycle_budget_exhausted",
    "implementation_delivery_exhausted",
})
#: Evaluation reason codes that are the cross-review's rejection of the plan.
CROSS_REVIEW_REASON_CODES: frozenset[str] = frozenset({
    "material_cross_review_risks_present", "unresolved_material_risk",
})
#: Claim-release codes whose evidence names the agent's output (the plan
#: validator refused it) or the request it was handed (the agent refused it).
_RELEASE_ATTRIBUTION: Mapping[str, str] = {
    "PLAN_CONTENT_INVALID": GATE_REFUSAL,
    "AGENT_REFUSED": AGENT_REFUSAL,
}
#: Implementation rejection classes judged against the implementer's own
#: change (``implementation_rejections``). The rest name the lane, the host
#: or the plan: a poll deadline, a branch collision, a file lock, a missing
#: signing identity, a profile precondition, drift of the base under it.
APPLY_GATE_REJECTION_CLASSES: frozenset[str] = frozenset({
    "ci_check_red", "merge_policy_violation", "content_hash_mismatch", "secret_leak_detected",
    "kernel_self_modification_attempted", "bash_command_denylist_hit",
    "path_escape_outside_workspace", "validation_failed", "forbidden_scope_violation",
    "prompt_injection_detected", "dependency_pinning_unsafe", "implementer_turn_budget_exhausted",
    "gh_api_scope_violation",
})

_TOKEN_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_CODE_IN_REASON_RE = re.compile(r"'code': '([a-z][a-z0-9_]*)'")
_MAX_MODE = 64


def mode_token(*parts: str) -> str:
    """A kernel token (``must_satisfy._REASON_CODE_RE``) naming the mode, so
    the lesson rides as readable data; the first part alone when the joined
    form would not be one."""
    joined = re.sub(r"[^a-z0-9]+", "_", "_".join(parts).lower()).strip("_")
    if _TOKEN_RE.match(joined) and len(joined) <= _MAX_MODE:
        return joined
    return re.sub(r"[^a-z0-9]+", "_", parts[0].lower()).strip("_")


@dataclass(frozen=True)
class Attribution:
    role: str
    agent: str
    evidence_type: str
    failure_mode: str
    detail: str = ""
    evidence: tuple[Mapping[str, str], ...] = field(default=())

    def as_row(self) -> dict[str, Any]:
        return {"role": self.role, "agent": self.agent, "evidence_type": self.evidence_type,
                "detail": self.detail, "evidence": [dict(ref) for ref in self.evidence]}


@dataclass
class InvocationLedgers:
    """The three agent-invocation ledgers, read once and only when a dead
    envelope needs resolving (25 MB on the runner store, 2026-10-07)."""

    requests: list[dict[str, Any]]
    claims: list[dict[str, Any]]
    results: list[dict[str, Any]]

    @classmethod
    def load(cls, root: Path) -> "InvocationLedgers":
        from .ledger import load_declared_jsonl, load_segments

        def ledger(name: str, surface: str) -> list[dict[str, Any]]:
            path = root / "agent-invocations" / name
            return load_declared_jsonl(path, expected_surface=surface) if path.is_file() else []

        return cls(
            requests=load_segments(root, "agent_invocation_requests"),
            claims=ledger("claims.jsonl", "agent_invocation_claims"),
            results=ledger("results.jsonl", "agent_invocation_results"),
        )


def _result_codes(row: Mapping[str, Any]) -> list[str]:
    codes = row.get("rejection_codes")
    if isinstance(codes, list) and codes:
        return [str(code) for code in codes if _TOKEN_RE.match(str(code))]
    # Rows written before the structured field carry the kernel's own
    # rendering of the code (`evidence: {'code': '<token>', ...}`).
    found: list[str] = []
    for reason in row.get("rejection_reasons") or []:
        found.extend(_CODE_IN_REASON_RE.findall(str(reason)))
    return found


def _dead_step_attribution(
    ledgers: InvocationLedgers, *, plan_id: str, role: str, round_number: int | None, drafter: str,
) -> Attribution | None:
    """The cause of one dead envelope: the latest request minted for the step,
    then its refused result, else its last claim release."""
    requests = [row for row in ledgers.requests
                if row.get("convergence_id") == plan_id and row.get("role") == role
                and (round_number is None or row.get("round_number") == round_number)]
    if not requests:
        return None
    request = requests[-1]
    request_id = str(request.get("request_id"))
    agent = str(request.get("target_agent") or role)
    results = [row for row in ledgers.results if row.get("request_id") == request_id]
    if results and results[-1].get("status") == "rejected":
        codes = _result_codes(results[-1])
        if codes:
            kind = EVIDENCE_LAW if codes[0].startswith("agent_evidence_") else GATE_REFUSAL
            ref = {"surface": "agent_invocation_results", "id": str(results[-1].get("row_id") or request_id)}
            return Attribution(role, agent, kind, mode_token(codes[0]), ",".join(dict.fromkeys(codes)), (ref,))
    releases = [row for row in ledgers.claims
                if row.get("request_id") == request_id and row.get("event") in ("released", "human_required")]
    if not releases:
        return None
    reason = parse_release_reason(str(releases[-1].get("reason") or ""))
    kind = _RELEASE_ATTRIBUTION.get(reason.reason_code)
    if kind is None:
        return None
    ref = {"surface": "agent_invocation_claims", "id": f"{request_id}:{releases[-1].get('event')}"}
    mode = mode_token(reason.reason_code, reason.reason_detail)
    if kind == AGENT_REFUSAL:
        # The refusing agent judged the request; the plan it was handed failed.
        return Attribution(DRAFTER_ROLE, drafter, kind, mode, f"refused_by={agent}", (ref,))
    return Attribution(role, agent, kind, mode, reason.reason_detail, (ref,))


def attribute_plan_failure(
    reason_codes: list[str], *, plan_id: str, round_number: int | None, drafter: str,
    ledgers: "InvocationLedgersSource", named_by: str = GATE_REFUSAL,
) -> Attribution | None:
    """The attribution of a drafter episode that ended HUMAN_REQUIRED or
    abandoned, or None when no reason's evidence names the work."""
    for raw in reason_codes:
        code, _, suffix = str(raw).partition(":")
        code = code.strip()
        if code == ENVELOPE_DEAD and suffix.strip():
            found = _dead_step_attribution(ledgers.get(), plan_id=plan_id, role=suffix.strip(),
                                           round_number=round_number, drafter=drafter)
            if found is not None:
                return found
            continue
        if code in LANE_REASON_CODES or not code:
            continue
        kind = CROSS_REVIEW_REJECTION if code in CROSS_REVIEW_REASON_CODES else named_by
        return Attribution(DRAFTER_ROLE, drafter, kind, code)
    return None


def attribute_implementation_failure(rejection_class: str, *, implementer: str) -> Attribution | None:
    if rejection_class not in APPLY_GATE_REJECTION_CLASSES:
        return None
    return Attribution(IMPLEMENTER_ROLE, implementer, APPLY_GATE, rejection_class)


def attribute_self_revert(trigger: str, *, implementer: str) -> Attribution:
    return Attribution(IMPLEMENTER_ROLE, implementer, POST_MERGE_REVERT, f"self_revert:{trigger}")


class InvocationLedgersSource:
    """Loads :class:`InvocationLedgers` on first use: a history with no dead
    envelope never reads them."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._ledgers: InvocationLedgers | None = None

    def get(self) -> InvocationLedgers:
        if self._ledgers is None:
            self._ledgers = InvocationLedgers.load(self._root)
        return self._ledgers


__all__ = [
    "ABANDON_REASON", "AGENT_REFUSAL", "APPLY_GATE", "APPLY_GATE_REJECTION_CLASSES", "Attribution",
    "CROSS_REVIEW_REJECTION", "CROSS_REVIEW_REASON_CODES", "DRAFTER_ROLE", "EVIDENCE_LAW",
    "GATE_REFUSAL", "InvocationLedgers", "InvocationLedgersSource", "LANE_REASON_CODES",
    "POST_MERGE_REVERT", "attribute_implementation_failure", "attribute_plan_failure",
    "attribute_self_revert", "mode_token",
]
