"""Plan 020 Phase 7 — agent compliance harness.

WHY this module exists (separate from agent_eval)
-------------------------------------------------
Operator gap #2: Plan 020 v1 conflated TWO orthogonal questions:
- EVAL  — "did the agent reach the right verdict?" (covered by agent_eval.py)
- COMPLIANCE — "did the agent follow the response contract?" (this module)

A compliant agent can produce a wrong verdict (eval miss). A non-compliant
agent can stumble onto the right verdict (compliance miss). Conflating
them masks regressions in either direction. Phase 7 separates the two
into distinct ledger surfaces (agent-evals/runs.jsonl vs agent-compliance
.jsonl) + distinct governance events (agent_eval_run_* vs agent_compliance
_violation / agent_compliance_warning).

Six checks split into two severity classes
-------------------------------------------
HARD-REJECT (any single fail → rejection_reason='compliance_rejected'):
  1. must_satisfy_completeness — request.must_satisfy ids ⊆ response
                                 .satisfaction_matrix ids. A missing
                                 must_satisfy entry is a contract violation
                                 (the response did not address something
                                 the request required).
  2. evidence_schema_valid     — every evidence_ref matches the agent_contract
                                 reference regex AND the referenced file
                                 exists. One bad ref is a single hard-reject
                                 vector.
  3. output_path_match         — response was written to the request's
                                 expected_output_path. A path mismatch is
                                 a defence-in-depth signal (separation of
                                 duties, output collision, dispatch confusion).
  4. banned_phrase_in_response_body
                               — L1 banned-phrase invariant applied to the
                                 agent response body. Pure validator.

SOFT-COMPLIANCE (single fail → warning event; 2+ kümülatif fail → reject):
  5. response_order_valid      — response.satisfaction_matrix order matches
                                 request.must_satisfy order (ECC trace
                                 gradient pattern). Order drift can hint at
                                 the agent reordering for cosmetic reasons —
                                 worth flagging, not worth rejecting alone.
  6. refusal_trigger_valid     — when response.status == 'rejected', refusal
                                 envelope conforms to aria/agent-refusal/v1.
                                 Mismatch is a soft signal; the response may
                                 be substantively correct but the refusal
                                 envelope shape is off.

10-state lifecycle preservation (operator gap correction)
---------------------------------------------------------
Plan 016 locked 10 derived states (PENDING/CLAIMED/RUNNING/SUBMITTED/
ACCEPTED/REJECTED/STALE/REQUEUED/HUMAN_REQUIRED/CANCELLED). Phase 7 does
NOT add a "COMPLIANCE_REJECTED" 11th state — that would break the
contract immutability. Instead, compliance failures funnel into the
existing REJECTED state with a NEW rejection_reason='compliance_rejected'
field carried in the result row + the agent_compliance_violation
governance event detail. The lifecycle is preserved; the rejection
TYPE is annotated.

Frozen-aware
------------
agent_compliance is in PLAN_020_WRITE_SURFACES; frozen + observe block
the persist step. The pure check math runs in memory regardless; only
the ledger write goes through the gate.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .agent_genesis import BANNED_PHRASES
from .ledger import StateTransaction, append_declared_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    tools_dir,
    utc_now,
)
from .workspace import governance_event

COMPLIANCE_LEDGER_FILENAME = ("agent-compliance.jsonl",)
COMPLIANCE_REJECTION_REASON = "compliance_rejected"
SOFT_FAIL_REJECT_THRESHOLD = 2

# Severity tags for the 6 checks. Keep the table next to the check
# implementations for transparency; a future check addition needs an
# explicit severity assignment + a Plan-021 doc note.
HARD_REJECT_CHECKS: tuple[str, ...] = (
    "must_satisfy_completeness",
    "evidence_schema_valid",
    "output_path_match",
    "banned_phrase_in_response_body",
)
SOFT_COMPLIANCE_CHECKS: tuple[str, ...] = (
    "response_order_valid",
    "refusal_trigger_valid",
)
ALL_CHECKS: tuple[str, ...] = HARD_REJECT_CHECKS + SOFT_COMPLIANCE_CHECKS

# Plan ARIA-V8.16 — single source of truth for the evidence-ref regex.
# Pre-V8.16 this module tried to import from agent_contract (where
# the regex never lived) and silently fell back to a path-with-line
# pattern that REJECTED the V7.9 `path:line:content` triplet form.
# After V8.14 made plan_synthesizer emit triplet refs from git diff
# hunks, every agent submission landed `compliance_rejected` with
# `regex_mismatch` reasons.
#
# evidence_validator._AGENT_REF_RE was fixed in V8.6 to accept all
# three canonical forms (path | path:line | path:line:content) with
# no ReDoS exposure. Importing from there gives compliance the same
# acceptance language and keeps the kernel's evidence-ref grammar
# definition in exactly one place.
try:
    from .evidence_validator import _AGENT_REF_RE as _EVIDENCE_REF_RE  # noqa: SLF001
except (ImportError, AttributeError):
    # Last-resort fallback if evidence_validator import fails — mirror
    # its V8.6 pattern verbatim rather than the looser pre-V8.16 form.
    _EVIDENCE_REF_RE = re.compile(r"^(?P<path>[^\s:]+)(?::(?P<line>\d+)(?::.*)?)?$")


def _ledger_path(tools_root: Path) -> Path:
    return tools_root.joinpath(*COMPLIANCE_LEDGER_FILENAME)


# ---------------------------------------------------------------------
# Individual check implementations.
# Each returns {"passed": bool, "severity": "hard"|"soft", "evidence": Any}.
# A check NEVER raises — it captures failure detail in the evidence field.
# ---------------------------------------------------------------------


def _check_must_satisfy_completeness(
    *, request: dict[str, Any], response: dict[str, Any],
) -> dict[str, Any]:
    must = request.get("must_satisfy") or []
    matrix = response.get("satisfaction_matrix") or []
    must_ids = {str(m.get("id") or m.get("rule_id") or m) for m in must if m}
    matrix_ids = {str(s.get("id") or s.get("rule_id") or s) for s in matrix if s}
    missing = sorted(must_ids - matrix_ids)
    return {
        "passed": not missing,
        "severity": "hard",
        "evidence": {"missing_ids": missing, "must_count": len(must_ids),
                     "matrix_count": len(matrix_ids)},
    }


def _check_evidence_schema_valid(
    *, response: dict[str, Any], workspace_root: Path | None,
) -> dict[str, Any]:
    refs = response.get("evidence_refs") or []
    bad: list[dict[str, Any]] = []
    for ref in refs:
        ref_str = str(ref)
        # ORPHAN-719 — the kernel's own ledger pointer (`human-required:<id>`)
        # is admissible evidence: the kernel MINTS it into panel scopes and
        # evidence law (#1271) admits it at every layer via the single
        # predicate below. This grader kept a SECOND, older definition of
        # "valid ref" (the file:line regex) and hard-rejected every panel
        # opinion the law had just learned to accept — the same
        # mint-vs-law contradiction, one validator further down. One
        # predicate, no second regex; what the pointer NAMES is verified
        # at fold time, not here.
        from .evidence_validator import _is_ledger_pointer_ref

        if _is_ledger_pointer_ref(ref_str):
            continue
        if not _EVIDENCE_REF_RE.match(ref_str):
            bad.append({"ref": ref_str, "reason": "regex_mismatch"})
            continue
        if workspace_root is not None:
            # Strip ":line" suffix when checking file existence.
            file_part = ref_str.split(":", 1)[0]
            path = workspace_root / file_part
            # Plan 023 v3 §A-6 — path-escape guard on evidence refs.
            # Pre-fix `path = workspace_root / file_part` accepted any
            # ref string including absolute paths and `../../etc/passwd`
            # traversals. resolve() chases symlinks too, so an in-repo
            # symlink target outside the workspace is also caught.
            try:
                resolved = path.resolve()
                workspace_resolved = workspace_root.resolve()
                resolved.relative_to(workspace_resolved)
            except ValueError:
                bad.append({
                    "ref": ref_str,
                    "reason": "path_escape_outside_workspace",
                })
                continue
            if not resolved.exists():
                bad.append({"ref": ref_str, "reason": "file_missing"})
    return {
        "passed": not bad,
        "severity": "hard",
        "evidence": {"bad_refs": bad, "total_refs": len(refs)},
    }


def _check_output_path_match(
    *, request: dict[str, Any], response_path: Path | None,
) -> dict[str, Any]:
    expected = request.get("expected_output_path")
    if not expected:
        return {"passed": True, "severity": "hard",
                "evidence": {"expected": None, "reason": "no_expected_path"}}
    if response_path is None:
        return {"passed": False, "severity": "hard",
                "evidence": {"expected": expected, "actual": None}}
    expected_resolved = Path(expected).resolve().as_posix()
    actual_resolved = response_path.resolve().as_posix()
    return {
        "passed": expected_resolved == actual_resolved,
        "severity": "hard",
        "evidence": {"expected": expected_resolved, "actual": actual_resolved},
    }


def _check_banned_phrase_in_response_body(*, response: dict[str, Any]) -> dict[str, Any]:
    body_parts: list[str] = []
    for key in ("body", "rationale", "summary", "narrative", "explanation"):
        v = response.get(key)
        if isinstance(v, str):
            body_parts.append(v)
    body = "\n".join(body_parts).lower()
    hits = [phrase for phrase in BANNED_PHRASES if phrase.lower() in body]
    return {
        "passed": not hits,
        "severity": "hard",
        "evidence": {"hits": hits, "body_chars": len(body)},
    }


def _check_response_order_valid(
    *, request: dict[str, Any], response: dict[str, Any],
) -> dict[str, Any]:
    must = request.get("must_satisfy") or []
    matrix = response.get("satisfaction_matrix") or []
    must_order = [str(m.get("id") or m.get("rule_id") or m) for m in must if m]
    matrix_order = [str(s.get("id") or s.get("rule_id") or s) for s in matrix if s]
    # Compare the order of intersection — extras in the matrix are allowed
    # (response may resolve more than required) but the relative order
    # of must_satisfy items must be preserved.
    must_set = set(must_order)
    matrix_filtered = [x for x in matrix_order if x in must_set]
    return {
        "passed": matrix_filtered == [x for x in must_order if x in set(matrix_filtered)],
        "severity": "soft",
        "evidence": {"must_order": must_order, "matrix_filtered": matrix_filtered},
    }


def _check_refusal_trigger_valid(*, response: dict[str, Any]) -> dict[str, Any]:
    if response.get("status") != "rejected":
        return {"passed": True, "severity": "soft",
                "evidence": {"status": response.get("status"), "reason": "non_refusal"}}
    refusal = response.get("refusal") or {}
    schema = refusal.get("$schema")
    has_reason = isinstance(refusal.get("reason"), str) and refusal["reason"].strip()
    valid = schema == "aria/agent-refusal/v1" and has_reason
    return {
        "passed": bool(valid),
        "severity": "soft",
        "evidence": {"refusal_schema": schema, "has_reason": bool(has_reason)},
    }


# ---------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------


def grade_response(
    *,
    request: dict[str, Any],
    response: dict[str, Any],
    response_path: Path | None = None,
    workspace_root: Path | None = None,
) -> dict[str, Any]:
    """Pure compliance grading (no ledger write). Returns the 6-check
    breakdown + summary.

    Returns:
      {
        check_results: {check_name: {passed, severity, evidence}, ...},
        hard_fail_count, soft_fail_count,
        rejection: bool,                   # any hard fail OR 2+ soft fails
        rejection_reason: str | None,      # 'compliance_rejected' if reject
      }
    """
    check_results: dict[str, dict[str, Any]] = {}
    check_results["must_satisfy_completeness"] = _check_must_satisfy_completeness(
        request=request, response=response,
    )
    check_results["evidence_schema_valid"] = _check_evidence_schema_valid(
        response=response, workspace_root=workspace_root,
    )
    check_results["output_path_match"] = _check_output_path_match(
        request=request, response_path=response_path,
    )
    check_results["banned_phrase_in_response_body"] = _check_banned_phrase_in_response_body(
        response=response,
    )
    check_results["response_order_valid"] = _check_response_order_valid(
        request=request, response=response,
    )
    check_results["refusal_trigger_valid"] = _check_refusal_trigger_valid(
        response=response,
    )

    hard_fail_count = sum(
        1 for name in HARD_REJECT_CHECKS if not check_results[name]["passed"]
    )
    soft_fail_count = sum(
        1 for name in SOFT_COMPLIANCE_CHECKS if not check_results[name]["passed"]
    )
    rejection = hard_fail_count > 0 or soft_fail_count >= SOFT_FAIL_REJECT_THRESHOLD
    return {
        "check_results": check_results,
        "hard_fail_count": hard_fail_count,
        "soft_fail_count": soft_fail_count,
        "rejection": rejection,
        "rejection_reason": COMPLIANCE_REJECTION_REASON if rejection else None,
    }


def _prepare_compliance_grade(
    *,
    claim_id: str,
    request: dict[str, Any],
    response: dict[str, Any],
    response_path: Path | None = None,
    workspace_root: Path | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Precompute the grade and any audit event without mutating ledgers."""
    enforce_profile_for_write("agent_compliance", base_dir=base_dir)
    grade = grade_response(
        request=request, response=response,
        response_path=response_path, workspace_root=workspace_root,
    )

    row: dict[str, Any] = {
        "$schema": "aria/agent-compliance-grade/v1",
        "schema_version": 1,
        "claim_id": claim_id,
        "graded_at": utc_now(),
        **grade,
    }
    if grade["rejection"]:
        kind = "agent_compliance_violation"
        kumulative = grade["hard_fail_count"] == 0 and grade["soft_fail_count"] >= SOFT_FAIL_REJECT_THRESHOLD
        details = {
            "claim_id": claim_id,
            "rejection_reason": grade["rejection_reason"],
            "hard_fail_count": grade["hard_fail_count"],
            "soft_fail_count": grade["soft_fail_count"],
            "trigger": "kumulative_soft" if kumulative else "hard_reject",
            "failed_checks": sorted([
                name for name, r in grade["check_results"].items() if not r["passed"]
            ]),
        }
    elif grade["soft_fail_count"] > 0:
        kind = "agent_compliance_warning"
        details = {
            "claim_id": claim_id,
            "soft_fail_count": grade["soft_fail_count"],
            "failed_checks": sorted([
                name for name in SOFT_COMPLIANCE_CHECKS
                if not grade["check_results"][name]["passed"]
            ]),
        }
    else:
        kind = None
        details = None

    return {
        "row": row,
        "governance_event": (
            governance_event(kind=kind, details=details)
            if kind is not None and details is not None
            else None
        ),
    }


def _persist_prepared_compliance_grade(
    prepared: dict[str, Any],
    *,
    base_dir: str | Path | None,
    transaction: StateTransaction | None = None,
) -> dict[str, Any]:
    """Persist a prevalidated grade through an optional encompassing lock."""
    row = prepared["row"]
    root = tools_dir(base_dir) if transaction is not None else ensure_tools_dir(base_dir)
    if transaction is not None:
        transaction.append_declared_jsonl(
            _ledger_path(root),
            row,
            expected_surface="agent_compliance",
        )
    else:
        append_declared_jsonl(
            _ledger_path(root),
            row,
            expected_surface="agent_compliance",
        )

    event = prepared.get("governance_event")
    if isinstance(event, dict):
        append_tools_governance(
            root,
            str(event["kind"]),
            dict(event["details"]),
            transaction=transaction,
            prepared_event=event,
        )

    return row


def record_compliance_grade(
    *,
    claim_id: str,
    request: dict[str, Any],
    response: dict[str, Any],
    response_path: Path | None = None,
    workspace_root: Path | None = None,
    base_dir: str | Path | None = None,
    transaction: StateTransaction | None = None,
) -> dict[str, Any]:
    """Grade + persist + emit the appropriate governance event.

    Hard reject → agent_compliance_violation event + result row 'rejected'
    + rejection_reason='compliance_rejected'.

    Soft fail (single) → agent_compliance_warning event; not a rejection.

    2+ soft fails → falls through to hard-reject path (kümülatif rule);
    agent_compliance_violation event emitted with severity='kumulative_soft'
    detail to disambiguate from a hard-check-driven reject in audit.
    """
    prepared = _prepare_compliance_grade(
        claim_id=claim_id,
        request=request,
        response=response,
        response_path=response_path,
        workspace_root=workspace_root,
        base_dir=base_dir,
    )
    return _persist_prepared_compliance_grade(
        prepared,
        base_dir=base_dir,
        transaction=transaction,
    )


def list_compliance_grades(
    *,
    base_dir: str | Path | None = None,
    claim_id: str | None = None,
    rejected_only: bool = False,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = _ledger_path(root)
    if not path.exists():
        return []
    # Plan 026R §A.3 — strict JSONL reader (was silent-skip). The
    # agent-compliance ledger feeds the operator's
    # claim-rejection audit dashboard; silently dropping a corrupt row
    # would understate compliance failures.
    from .strict_jsonl_reader import read_strict_jsonl
    rows: list[dict[str, Any]] = []
    for row in read_strict_jsonl(path, base_dir=root):
        if claim_id is not None and row.get("claim_id") != claim_id:
            continue
        if rejected_only and not row.get("rejection"):
            continue
        rows.append(row)
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


__all__ = [
    "COMPLIANCE_REJECTION_REASON",
    "HARD_REJECT_CHECKS",
    "SOFT_COMPLIANCE_CHECKS",
    "ALL_CHECKS",
    "SOFT_FAIL_REJECT_THRESHOLD",
    "grade_response",
    "record_compliance_grade",
    "list_compliance_grades",
]
