"""Plan 032 Faz 032b-3 — release reasons as a structured envelope.

WHY: a claim release carries a free string (``submit_timeout_120s``,
``plan_content_invalid:plan_content:absent_or_not_object``) and the fault
ownership that decides whether the request's requeue budget burns was
derived by prefix-matching that string. The second review of 2026-09-02
called the strings what they are — an open vocabulary pretending to be a
closed one.

WHAT: :class:`ReleaseReason` is ``{reason_code, reason_detail, fault_domain}``
with a CLOSED code vocabulary. :func:`parse_release_reason` maps every string
the executors emit today (literal or parameterised) onto it, so the ledger
row can carry the structured fields NEXT TO the legacy string — the string
stays for every reader that exists, the structure is what new readers use.
``fault_domain`` is the same ownership ``agent_invocations.classify_release_reason``
computes, expressed on the row instead of re-derived by every consumer.
"""
from __future__ import annotations

from dataclasses import dataclass

# Closed vocabulary. Adding a code is a one-way door (ledger-anchored).
RELEASE_REASON_CODES: tuple[str, ...] = (
    "CLAUDE_CLI_AUTH_FAILURE", "CLAUDE_SPAWN_REFUSED", "CLAUDE_CLI_EXIT", "DISPATCH_BUDGET_REFUSED",
    "JUDGE_VERDICT_CONTRACT_VIOLATION", "KERNEL_PROMPT_RENDERER_UNAVAILABLE",
    "PLANNER_DISPATCH_EXECUTOR_TIMEOUT", "PLANNER_DISPATCH_EXECUTOR_EXIT_NONZERO",
    "PROMPT_HASH_BINDING_MISMATCH", "SUBMIT_TIMEOUT",
    "LEASE_EXPIRED", "REQUEST_ENVELOPE_MISSING_EXPECTED_OUTPUT_PATH", "REQUEST_ENVELOPE_MISSING_ROLE",
    "SUBMIT_REJECTED", "PLAN_CONTENT_INVALID", "AGENT_REFUSED",
    "OPERATOR_CANCELLED", "RECOVERY_UNRESOLVED_EXTERNAL_EFFECT",
    "UNCLASSIFIED",
)
FAULT_DOMAINS: tuple[str, ...] = ("harness", "request", "operator", "unclassified")

_LITERALS: dict[str, tuple[str, str]] = {
    "claude_cli_auth_failure": ("CLAUDE_CLI_AUTH_FAILURE", "harness"),
    "claude_spawn_refused": ("CLAUDE_SPAWN_REFUSED", "harness"),
    "dispatch_budget_refused": ("DISPATCH_BUDGET_REFUSED", "harness"),
    "judge_verdict_contract_violation": ("JUDGE_VERDICT_CONTRACT_VIOLATION", "harness"),
    "kernel_prompt_renderer_unavailable": ("KERNEL_PROMPT_RENDERER_UNAVAILABLE", "harness"),
    "planner_dispatch_executor_timeout": ("PLANNER_DISPATCH_EXECUTOR_TIMEOUT", "harness"),
    "planner_dispatch_executor_exit_nonzero": ("PLANNER_DISPATCH_EXECUTOR_EXIT_NONZERO", "harness"),
    "prompt_hash_binding_mismatch": ("PROMPT_HASH_BINDING_MISMATCH", "harness"),
    "lease_expired": ("LEASE_EXPIRED", "request"),
    "request_envelope_missing_expected_output_path": ("REQUEST_ENVELOPE_MISSING_EXPECTED_OUTPUT_PATH", "request"),
    "request_envelope_missing_role": ("REQUEST_ENVELOPE_MISSING_ROLE", "request"),
    "submit_rejected": ("SUBMIT_REJECTED", "request"),
    "operator_cancelled": ("OPERATOR_CANCELLED", "operator"),
    "recovery_unresolved_external_effect": ("RECOVERY_UNRESOLVED_EXTERNAL_EFFECT", "request"),
}
_PREFIXES: tuple[tuple[str, str, str], ...] = (
    ("claude_cli_exit_", "CLAUDE_CLI_EXIT", "harness"),
    ("submit_timeout_", "SUBMIT_TIMEOUT", "harness"),
    ("plan_content_invalid:", "PLAN_CONTENT_INVALID", "request"),
    ("agent_refused:", "AGENT_REFUSED", "request"),
)


@dataclass(frozen=True)
class ReleaseReason:
    reason_code: str
    reason_detail: str
    fault_domain: str

    def to_row_fields(self) -> dict[str, str]:
        return {
            "reason_code": self.reason_code,
            "reason_detail": self.reason_detail,
            "fault_domain": self.fault_domain,
        }


def parse_release_reason(reason: str | None) -> ReleaseReason:
    """Map a legacy/free release string onto the closed envelope."""
    text = str(reason or "").strip()
    if text in _LITERALS:
        code, domain = _LITERALS[text]
        return ReleaseReason(code, "", domain)
    for prefix, code, domain in _PREFIXES:
        if text.startswith(prefix):
            return ReleaseReason(code, text[len(prefix):][:200], domain)
    return ReleaseReason("UNCLASSIFIED", text[:200], "unclassified")


__all__ = ["FAULT_DOMAINS", "RELEASE_REASON_CODES", "ReleaseReason", "parse_release_reason"]
