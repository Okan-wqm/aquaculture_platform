"""Agent contract schemas + validators (Plan 016 Faz C1, CONTRACTS §0).

This module is the SCHEMA layer for ARIA's bound-agent execution. It does not
own queue lifecycle (that lives in `agent_invocations.py`); it owns the
fail-closed invariants every kernel-bound agent request and response must
satisfy before it can be enqueued, claimed, or accepted:

- `aria/agent-request/v1`  — operator-driven envelope handed to a maintenance
  or judge agent. Every must_satisfy item is a contract clause the agent
  output has to match line-by-line.
- `aria/agent-response/v1` — the agent's reply. Every field is treated as
  untrusted data until validated; the satisfaction matrix is required and
  must enumerate every must_satisfy item with one of the closed verdicts.

Distinct from `agent_invocations.py`: that module owns request/result ledger
writes, lease/heartbeat/reap-stale lifecycle, and the existing
`aria/agent-invocation-request/v1` envelope (preserved unchanged for
backward compatibility per operator instruction). The richer v1 envelope
defined here composes on top — callers wanting the strict Plan 016
contract route through this module's validators before handing rows to the
queue layer.

This file does NOT import `agent_invocations.py` (one-way dependency: the
queue layer depends on the contract layer, never the other way around).
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable

from .agent_genesis import BANNED_PHRASES
from .tool_registry import GovernanceError


# Roles a request may carry. Mirrors agent_invocations.ROLES but is the
# authoritative list — when the two diverge, this list wins because the
# strict envelope drives the convergent gate.
REQUEST_ROLES = (
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "implementation",
    "implementation_review",
    "verification",
    "gap_finding",
    "gap_closure",
    "maintenance_utility",
)

REQUEST_REQUIRED_FIELDS = (
    "$schema",
    "request_id",
    "cycle_id",
    "role",
    "target_agent",
    "evidence_refs",
    "allowed_scope",
    "forbidden_scope",
    "must_satisfy",
    "validation_commands",
    "expected_output_path",
)

REQUEST_OPTIONAL_FIELDS = (
    "pressure_event_id",
    "plan_id",
    "converged_plan_hash",
    "impact_graph_refs",
    "separation_of_duties",
    "round_number",
    "created_at",
)

RESPONSE_REQUIRED_FIELDS = (
    "$schema",
    "request_id",
    "claim_id",
    "agent_id",
    "role",
    "status",
    "satisfaction_matrix",
)

RESPONSE_STATUSES = ("submitted", "accepted", "rejected", "partial")

SATISFACTION_VERDICTS = ("satisfied", "blocked", "contradicted")

REASON_CLASSES = ("law", "scope", "evidence", "safety")

REQUEST_SCHEMA = "aria/agent-request/v1"
RESPONSE_SCHEMA = "aria/agent-response/v1"
REFUSAL_SCHEMA = "aria/agent-refusal/v1"

# Maintenance + judge agents that may receive an agent-request envelope.
# A request whose target_agent is outside this set is rejected at validation
# time — this closes the prompt-injection vector where a malicious caller
# tries to route a request to an arbitrary agent name.
DEFAULT_TARGET_AGENT_WHITELIST: tuple[str, ...] = (
    # Maintenance agents (Plan 016 §3 maintenance agents).
    "aria-prompt-writer",
    "aria-primary-planner",
    "aria-challenger-planner",
    # Existing judge agents (.claude/agents/aria-*.md).
    "aria-evidence-judge",
    "aria-adversarial-judge",
    "aria-consensus-arbiter",
    "aria-change-intelligence",
    "aria-goldset-curator",
)

REQUEST_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$")
CLAIM_ID_RE = re.compile(r"^claim_[a-zA-Z0-9._:-]{4,128}$")
AGENT_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9._:-]{2,127}$")


def _check_banned_phrases(text: str, *, field: str) -> None:
    """Reject any banned-phrase substring — applies to plan/response prose."""
    if not isinstance(text, str):
        return
    lowered = text.lower()
    for phrase in BANNED_PHRASES:
        if phrase in lowered:
            raise GovernanceError(
                f"{field} contains banned phrase '{phrase}': {text[:120]!r}"
            )


def _ensure_string_list(value: Any, *, field: str, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list):
        raise GovernanceError(f"{field} must be a list of strings")
    if not allow_empty and not value:
        raise GovernanceError(f"{field} must not be empty")
    cleaned: list[str] = []
    for idx, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            raise GovernanceError(f"{field}[{idx}] must be a non-empty string")
        cleaned.append(item)
    return cleaned


def _ensure_must_satisfy(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list) or not items:
        raise GovernanceError("must_satisfy must be a non-empty list")
    cleaned: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, raw in enumerate(items):
        if not isinstance(raw, dict):
            raise GovernanceError(f"must_satisfy[{idx}] must be an object")
        item_id = raw.get("id")
        statement = raw.get("statement")
        if not isinstance(item_id, str) or not item_id.strip():
            raise GovernanceError(f"must_satisfy[{idx}].id is required")
        if item_id in seen_ids:
            raise GovernanceError(f"must_satisfy[{idx}].id duplicate: {item_id}")
        seen_ids.add(item_id)
        if not isinstance(statement, str) or not statement.strip():
            raise GovernanceError(f"must_satisfy[{idx}].statement is required")
        _check_banned_phrases(statement, field=f"must_satisfy[{item_id}].statement")
        cleaned.append({"id": item_id, "statement": statement})
    return cleaned


def validate_request(
    envelope: dict[str, Any],
    *,
    target_agent_whitelist: Iterable[str] = DEFAULT_TARGET_AGENT_WHITELIST,
) -> None:
    """Validate an `aria/agent-request/v1` envelope. Raise GovernanceError on any defect.

    Why: every field below corresponds to a fail-closed gate Plan 016
    requires. A request that passes this validator is contractually safe to
    enqueue; one that fails must be rejected before any agent sees it.
    """
    missing = [f for f in REQUEST_REQUIRED_FIELDS if f not in envelope]
    if missing:
        raise GovernanceError(f"agent-request missing required fields: {missing}")
    if envelope["$schema"] != REQUEST_SCHEMA:
        raise GovernanceError(f"agent-request $schema must be {REQUEST_SCHEMA!r}")
    request_id = envelope["request_id"]
    if not isinstance(request_id, str) or not REQUEST_ID_RE.match(request_id):
        raise GovernanceError(f"agent-request.request_id invalid: {request_id!r}")
    cycle_id = envelope["cycle_id"]
    if not isinstance(cycle_id, str) or not cycle_id.strip():
        raise GovernanceError("agent-request.cycle_id is required")
    role = envelope["role"]
    if role not in REQUEST_ROLES:
        raise GovernanceError(f"agent-request.role unknown: {role!r}")
    target = envelope["target_agent"]
    whitelist = tuple(target_agent_whitelist)
    if target not in whitelist:
        raise GovernanceError(
            f"agent-request.target_agent {target!r} not in whitelist; "
            f"allowed: {whitelist}"
        )
    _ensure_string_list(envelope["evidence_refs"], field="agent-request.evidence_refs")
    _ensure_string_list(envelope["allowed_scope"], field="agent-request.allowed_scope")
    _ensure_string_list(
        envelope["forbidden_scope"], field="agent-request.forbidden_scope", allow_empty=True
    )
    _ensure_string_list(
        envelope["validation_commands"],
        field="agent-request.validation_commands",
        allow_empty=True,
    )
    _ensure_must_satisfy(envelope["must_satisfy"])
    if not isinstance(envelope["expected_output_path"], str) or not envelope["expected_output_path"].strip():
        raise GovernanceError("agent-request.expected_output_path is required")
    # Optional fields: light type checks only.
    if "impact_graph_refs" in envelope and not isinstance(envelope["impact_graph_refs"], list):
        raise GovernanceError("agent-request.impact_graph_refs must be a list")
    if "separation_of_duties" in envelope and not isinstance(
        envelope["separation_of_duties"], dict
    ):
        raise GovernanceError("agent-request.separation_of_duties must be an object")


def validate_response(
    envelope: dict[str, Any],
    *,
    request: dict[str, Any] | None = None,
) -> None:
    """Validate an `aria/agent-response/v1` envelope.

    `request` is optional — when provided, the response is cross-checked
    against the request's `must_satisfy` ids and `expected_output_path`.
    """
    missing = [f for f in RESPONSE_REQUIRED_FIELDS if f not in envelope]
    if missing:
        raise GovernanceError(f"agent-response missing required fields: {missing}")
    if envelope["$schema"] != RESPONSE_SCHEMA:
        raise GovernanceError(f"agent-response $schema must be {RESPONSE_SCHEMA!r}")
    if not isinstance(envelope["request_id"], str) or not REQUEST_ID_RE.match(envelope["request_id"]):
        raise GovernanceError(f"agent-response.request_id invalid: {envelope['request_id']!r}")
    claim_id = envelope["claim_id"]
    if not isinstance(claim_id, str) or not CLAIM_ID_RE.match(claim_id):
        raise GovernanceError(f"agent-response.claim_id invalid: {claim_id!r}")
    agent_id = envelope["agent_id"]
    if not isinstance(agent_id, str) or not AGENT_ID_RE.match(agent_id):
        raise GovernanceError(f"agent-response.agent_id invalid: {agent_id!r}")
    role = envelope["role"]
    if role not in REQUEST_ROLES:
        raise GovernanceError(f"agent-response.role unknown: {role!r}")
    status = envelope["status"]
    if status not in RESPONSE_STATUSES:
        raise GovernanceError(f"agent-response.status unknown: {status!r}")

    matrix = envelope["satisfaction_matrix"]
    if not isinstance(matrix, list):
        raise GovernanceError("agent-response.satisfaction_matrix must be a list")
    matrix_entries: list[dict[str, Any]] = []
    matrix_ids: set[str] = set()
    for idx, entry in enumerate(matrix):
        if not isinstance(entry, dict):
            raise GovernanceError(f"satisfaction_matrix[{idx}] must be an object")
        item_id = entry.get("id")
        verdict = entry.get("verdict")
        if not isinstance(item_id, str) or not item_id.strip():
            raise GovernanceError(f"satisfaction_matrix[{idx}].id is required")
        if item_id in matrix_ids:
            raise GovernanceError(f"satisfaction_matrix[{idx}].id duplicate: {item_id}")
        matrix_ids.add(item_id)
        if verdict not in SATISFACTION_VERDICTS:
            raise GovernanceError(
                f"satisfaction_matrix[{idx}].verdict {verdict!r} not in {SATISFACTION_VERDICTS}"
            )
        if verdict in {"blocked", "contradicted"}:
            note = entry.get("note") or entry.get("rationale") or ""
            if not isinstance(note, str) or not note.strip():
                raise GovernanceError(
                    f"satisfaction_matrix[{idx}].note required when verdict={verdict!r}"
                )
            _check_banned_phrases(note, field=f"satisfaction_matrix[{item_id}].note")
            evidence_refs = entry.get("evidence_refs", [])
            _ensure_string_list(
                evidence_refs,
                field=f"satisfaction_matrix[{item_id}].evidence_refs",
                allow_empty=False,
            )
        matrix_entries.append(entry)

    rationale = envelope.get("rationale")
    if isinstance(rationale, str) and rationale.strip():
        _check_banned_phrases(rationale, field="agent-response.rationale")

    if request is not None:
        if envelope["request_id"] != request.get("request_id"):
            raise GovernanceError(
                f"agent-response.request_id {envelope['request_id']!r} does not match request "
                f"{request.get('request_id')!r}"
            )
        # Every must_satisfy item must appear once in the matrix.
        required_ids = {item["id"] for item in request.get("must_satisfy", [])}
        unmet = required_ids - matrix_ids
        if unmet:
            raise GovernanceError(
                f"satisfaction_matrix missing entries for must_satisfy ids: {sorted(unmet)}"
            )
        extra = matrix_ids - required_ids
        if extra:
            raise GovernanceError(
                f"satisfaction_matrix contains ids not in must_satisfy: {sorted(extra)}"
            )
        if envelope.get("output_path") and request.get("expected_output_path"):
            if envelope["output_path"] != request["expected_output_path"]:
                raise GovernanceError(
                    f"agent-response.output_path {envelope['output_path']!r} differs from "
                    f"request.expected_output_path {request['expected_output_path']!r}"
                )


def enforce_separation_of_duties(
    *,
    request: dict[str, Any],
    submitter_agent_id: str,
) -> None:
    """Reject a submission whose agent_id matches the request's prior implementer.

    Plan 016 §Separation of duties: implementer != reviewer for the same
    request_id. CRITICAL packets later require >=2 independent reviewers;
    that count enforcement lives in the queue layer.
    """
    sod = request.get("separation_of_duties") or {}
    forbidden = sod.get("forbidden_agent_ids") or []
    if submitter_agent_id in forbidden:
        raise GovernanceError(
            f"separation_of_duties forbids agent_id {submitter_agent_id!r} for "
            f"request {request.get('request_id')!r}"
        )


def render_refusal(
    *,
    request_id: str,
    cycle_id: str,
    refused_by: str,
    reason_class: str,
    reason_text: str,
    evidence_refs: list[str] | None = None,
    at: str | None = None,
) -> dict[str, Any]:
    """Render a structured `aria/agent-refusal/v1` row for governance ledger.

    Refusal must itself pass the banned-phrase gate so a refusal cannot
    smuggle prohibited deferral language into the ledger.
    """
    if reason_class not in REASON_CLASSES:
        raise GovernanceError(
            f"refusal reason_class {reason_class!r} not in {REASON_CLASSES}"
        )
    if not isinstance(reason_text, str) or not reason_text.strip():
        raise GovernanceError("refusal reason_text is required")
    _check_banned_phrases(reason_text, field="refusal.reason_text")
    refs = _ensure_string_list(
        evidence_refs or [], field="refusal.evidence_refs", allow_empty=True
    )
    payload = {
        "$schema": REFUSAL_SCHEMA,
        "request_id": request_id,
        "cycle_id": cycle_id,
        "refused_by": refused_by,
        "reason_class": reason_class,
        "reason_text": reason_text,
        "evidence_refs": refs,
    }
    if at is not None:
        payload["at"] = at
    return payload


def envelope_hash(envelope: dict[str, Any]) -> str:
    """Stable SHA-256 of a request or response envelope.

    Used by callers needing a content-addressed identifier independent of
    the queue ledger's hash chain (e.g. cross-checking a submitted output's
    `output_hash` against the request fingerprint).
    """
    canonical = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
