"""ARIA-HIGH-370 — kernel attribution of a failed episode to the work that failed.

WHY. ARIA-HIGH-285 records every finished drafter / implementer episode and
ARIA-HIGH-309 (#1773) turns a failure mode recurring
``LESSON_EPISODE_THRESHOLD`` times into a binding lesson, but only for
episodes marked ``attributable``. Measured on the runner store 2026-10-06:
19 drafter failure episodes, 18 of them ``attributable=false`` and the 19th
(``operator_withdrawn``) attributable although it records an operator's act.
The episode took the first token of the plan's terminal reason, and that
token names the LANE (``stalled``, ``convergence_envelope_dead:<role>``),
never the cause, which sat one join away on the agent-invocation ledgers.

WHAT. Attribution is a CLOSED ALLOWLIST of evidence (review of #1829, HIGH-1
and HIGH-2: the first version attributed every code not on a lane denylist,
so an environment fault such as ``architecture_spine_unavailable:*`` and any
code an operator typed into ``plan force-human-required`` became the
drafter's lesson). A failure is attributed only when:

* ``gate_refusal`` / ``cross_review_rejection`` — the evaluator's own row
  (``plan_convergence.evaluate_plan``) names a code in
  :data:`ATTRIBUTABLE_GATE_CODES`. A FORCED escalation (gate decision
  ``human_escalation``) is the kernel's only when every code it carries is in
  :data:`KERNEL_FORCED_CODES`; any other forced row is an operator's or an
  unknown writer's act and is never attributed.
* ``evidence_law`` — the dead step's latest request ended on a result the
  evidence law refused for the AGENT's citation (``agent_evidence_*``, minus
  the validator's own "could not verify" codes, which are harness class:
  ``evidence_validator.EVIDENCE_VERIFICATION_UNAVAILABLE_CODES`` and
  ``*_evidence_baseline_unavailable``), the request's last release is of
  fault domain ``request``, and no harness release came after the result.
* ``gate_refusal`` (release) — the last release is ``PLAN_CONTENT_INVALID``
  for a body the validator refused; ``plan_content:absent_or_not_object`` is
  the kernel's EXTRACTION failing to find a body and is not attributed.
* ``agent_refusal`` — the last release is ``AGENT_REFUSED:<class>`` with a
  class in ``agent_contract.REASON_CLASSES``; the refusal judges the request,
  so the failure is the plan's (role ``drafter``).
* ``apply_gate`` / ``post_merge_revert`` — the implementer's change failed a
  check judged against its own diff, or was reverted by attribution.

Kernel-owned rejection codes (``response_schema``, ``separation_of_duties``,
``plan_contract``: the kernel's parse, the kernel's duty table, the kernel's
rendered contract) are never the agent's. Every release whose fault domain is
not ``request`` — every provider outage (quota, auth, unreachable, logged
out), runtime unavailability, lease expiry, an unclassified string — is never
attributed: this module's rule is the single place lane 365's fault domain
meets the learning loop, and it admits only ``request``.

A historical episode whose cause the kernel has since fixed is voided by
:mod:`attribution_void` (applied by ``agent_eval``).
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

DRAFTER_ROLE = "drafter"
IMPLEMENTER_ROLE = "implementer"
ENVELOPE_DEAD = "convergence_envelope_dead"
HUMAN_ESCALATION = "human_escalation"

#: The evaluator's codes that judge the plan body (``evaluate_plan``,
#: ``_evaluate_state``, ``_evaluate_cross_review_state``, the plan-contract and
#: architecture-spine gates). Closed: a code absent here is never attributed.
CROSS_REVIEW_REASON_CODES: frozenset[str] = frozenset({
    "material_cross_review_risks_present", "unresolved_material_risk",
})
ATTRIBUTABLE_GATE_CODES: frozenset[str] = CROSS_REVIEW_REASON_CODES | frozenset({
    "plan_contract_incomplete", "critical_risks_present", "high_risks_present", "unknown_risks_present",
    "new_risk_category_round_3", "coverage_gaps_present", "architecture_spine_regression",
})
#: The codes the kernel's own ``force_plan_human_required`` callers write
#: (convergence_drainer, plan_round_controller, converged_delivery). A forced
#: row carrying any other code was written by ``plan force-human-required``.
KERNEL_FORCED_CODES: frozenset[str] = frozenset({
    ENVELOPE_DEAD, "max_rounds_reached", "unresolved_material_risk", "implementation_delivery_exhausted",
})
#: Result rejection codes that are the kernel's own judgement of its own
#: artefacts, never the agent's work.
KERNEL_OWNED_REJECTION_CODES: frozenset[str] = frozenset({
    "response_schema", "separation_of_duties", "plan_contract",
})
#: PLAN_CONTENT_INVALID details that are the kernel's extraction failing.
EXTRACTION_FAILURE_DETAILS: frozenset[str] = frozenset({"plan_content:absent_or_not_object"})
#: Implementation rejection classes judged against the implementer's own
#: change (``implementation_rejections``). The rest name the lane, the host
#: or the plan.
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
    """A kernel token (``must_satisfy._REASON_CODE_RE``) naming the mode."""
    joined = re.sub(r"[^a-z0-9]+", "_", "_".join(parts).lower()).strip("_")
    if _TOKEN_RE.match(joined) and len(joined) <= _MAX_MODE:
        return joined
    return re.sub(r"[^a-z0-9]+", "_", parts[0].lower()).strip("_")


def harness_rejection_code(code: str) -> bool:
    """A rejection code that says the kernel could not verify, never what the agent did."""
    from .evidence_validator import EVIDENCE_VERIFICATION_UNAVAILABLE_CODES

    return code in EVIDENCE_VERIFICATION_UNAVAILABLE_CODES or code.endswith("_evidence_baseline_unavailable")


def attributable_rejection_code(code: str) -> bool:
    return (code.startswith("agent_evidence_") and not harness_rejection_code(code)
            and code not in KERNEL_OWNED_REJECTION_CODES)


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


def _stamp(row: Mapping[str, Any], *fields: str) -> Any:
    from .tool_registry import parse_utc_stamp

    for name in fields:
        value = row.get(name)
        if isinstance(value, str) and (parsed := parse_utc_stamp(value)) is not None:
            return parsed
    return None


def _not_before(stamp: Any, reference: Any) -> bool:
    return stamp is None or reference is None or stamp >= reference


def _fault_domain(row: Mapping[str, Any]) -> str:
    recorded = row.get("fault_domain")
    return str(recorded) if recorded else parse_release_reason(str(row.get("reason") or "")).fault_domain


def _dead_step_attribution(
    ledgers: InvocationLedgers, *, plan_id: str, role: str, round_number: int | None, drafter: str,
) -> Attribution | None:
    """The cause of one dead envelope, when its last word is the request's.

    The latest request minted for the step is read. Its last release must be
    of fault domain ``request`` (an outage, an unavailable runtime, a lease
    that ran out, an unclassified string end the analysis). A rejected result
    is the cause only when no harness release followed it: a rejection on
    attempt one followed by provider outages died of the outages.
    """
    requests = [row for row in ledgers.requests
                if row.get("convergence_id") == plan_id and row.get("role") == role
                and (round_number is None or row.get("round_number") == round_number)]
    if not requests:
        return None
    request_id = str(requests[-1].get("request_id"))
    agent = str(requests[-1].get("target_agent") or role)
    releases = [row for row in ledgers.claims
                if row.get("request_id") == request_id and row.get("event") in ("released", "human_required")]
    if releases and _fault_domain(releases[-1]) != "request":
        return None
    results = [row for row in ledgers.results if row.get("request_id") == request_id]
    if results and results[-1].get("status") == "rejected":
        rejected_at = _stamp(results[-1], "submitted_at", "recorded_at")
        # A release whose time (or the result's) cannot be read is counted as
        # after it: an unplaceable outage never leaves the agent blamed.
        later_harness = [row for row in releases if _fault_domain(row) != "request"
                         and _not_before(_stamp(row, "released_at", "at"), rejected_at)]
        codes = [code for code in _result_codes(results[-1]) if attributable_rejection_code(code)]
        if later_harness or not codes:
            return None
        ref = {"surface": "agent_invocation_results", "id": str(results[-1].get("row_id") or request_id)}
        return Attribution(role, agent, EVIDENCE_LAW, mode_token(codes[0]), ",".join(dict.fromkeys(codes)), (ref,))
    if not releases:
        return None
    reason = parse_release_reason(str(releases[-1].get("reason") or ""))
    ref = {"surface": "agent_invocation_claims", "id": f"{request_id}:{releases[-1].get('event')}"}
    if reason.reason_code == "PLAN_CONTENT_INVALID" and reason.reason_detail not in EXTRACTION_FAILURE_DETAILS:
        return Attribution(role, agent, GATE_REFUSAL, mode_token(reason.reason_code, reason.reason_detail),
                           reason.reason_detail, (ref,))
    if reason.reason_code == "AGENT_REFUSED":
        from .agent_contract import REASON_CLASSES

        if reason.reason_detail not in REASON_CLASSES:
            return None  # an agent-written class outside the contract teaches nothing
        # The refusing agent judged the request; the plan it was handed failed.
        return Attribution(DRAFTER_ROLE, drafter, AGENT_REFUSAL, mode_token("agent_refused", reason.reason_detail),
                           f"refused_by={agent}", (ref,))
    return None


def _forced(payload: Mapping[str, Any]) -> bool:
    decisions = payload.get("gate_decisions") or []
    return any(isinstance(d, Mapping) and d.get("decision") == HUMAN_ESCALATION for d in decisions)


def attribute_evaluation(
    payload: Mapping[str, Any], *, plan_id: str, drafter: str, ledgers: InvocationLedgersSource,
) -> Attribution | None:
    """The attribution of a drafter episode that ended HUMAN_REQUIRED, or None."""
    codes = [str(raw) for raw in payload.get("reason_codes") or []]
    heads = [code.partition(":")[0].strip() for code in codes]
    if _forced(payload) and not set(heads) <= KERNEL_FORCED_CODES:
        return None  # an operator's (or any non-kernel writer's) escalation
    for code, head in zip(codes, heads):
        if head == ENVELOPE_DEAD and code.partition(":")[2].strip():
            found = _dead_step_attribution(ledgers.get(), plan_id=plan_id, role=code.partition(":")[2].strip(),
                                           round_number=payload.get("round_number"), drafter=drafter)
            if found is not None:
                return found
        elif code in ATTRIBUTABLE_GATE_CODES:
            kind = CROSS_REVIEW_REJECTION if code in CROSS_REVIEW_REASON_CODES else GATE_REFUSAL
            return Attribution(DRAFTER_ROLE, drafter, kind, code)
    return None


def attribute_implementation_failure(rejection_class: str, *, implementer: str) -> Attribution | None:
    if rejection_class not in APPLY_GATE_REJECTION_CLASSES:
        return None
    return Attribution(IMPLEMENTER_ROLE, implementer, APPLY_GATE, rejection_class)


def attribute_self_revert(trigger: str, *, implementer: str) -> Attribution:
    return Attribution(IMPLEMENTER_ROLE, implementer, POST_MERGE_REVERT, f"self_revert:{trigger}")


__all__ = [
    "AGENT_REFUSAL", "APPLY_GATE", "APPLY_GATE_REJECTION_CLASSES", "ATTRIBUTABLE_GATE_CODES", "Attribution",
    "CROSS_REVIEW_REJECTION", "CROSS_REVIEW_REASON_CODES", "DRAFTER_ROLE", "EVIDENCE_LAW", "GATE_REFUSAL",
    "InvocationLedgers", "InvocationLedgersSource", "KERNEL_FORCED_CODES", "KERNEL_OWNED_REJECTION_CODES",
    "POST_MERGE_REVERT", "attributable_rejection_code", "attribute_evaluation",
    "attribute_implementation_failure", "attribute_self_revert", "harness_rejection_code", "mode_token",
]
