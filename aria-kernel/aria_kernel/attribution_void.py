"""ARIA-HIGH-370 (review of #1829, HIGH-2) — attributions the kernel has since voided.

WHY. An attribution reads the evidence the kernel recorded at the time. When
that evidence was produced by a KERNEL defect — the kernel handed the agent
the very ref the evidence law then refused — the episode names the agent,
but the cause was the kernel's, and a fix has removed it. Teaching the
agent's next envelope that lesson, or refusing a candidate on it, punishes
the agent for a defect it could not avoid and that no longer exists.

WHAT. :data:`ATTRIBUTION_VOID` is a closed registry. Each entry names a mode,
the attributed role, the merge time of the fix and the PR. An attributed
episode with that mode and role that occurred BEFORE the fix is recorded
unattributed, with ``voided_by`` naming the PR; one after the fix stands.
Adding an entry is a reviewed code change, never a ledger write.

:func:`gate_epoch` is a digest of the GATE SEMANTICS: the normalized syntax
tree (docstrings stripped; comments are not in the tree) of every function
and table that decides whether submitted work is refused or a plan is
escalated (:data:`GATE_DEFINITIONS`) — the evaluator and the gates that
produce the allowlisted codes (``plan_convergence``,
``architecture_spine_gate``, ``plan_contract``, ``must_satisfy``), the
submission judge and the evidence law, the release vocabulary. Second review
of #1829 (M1): the first version hashed seven whole files, missed the
modules that produce the allowlisted codes, and moved on any comment edit.
An AST digest moves exactly when gate code changes, with no version constant
someone must remember to bump; ``tests/test_learning_attribution_review.py``
pins that a comment leaves it unchanged and that every listed definition
exists.

Episodes carry the epoch they were RECORDED under. The failure's own epoch
is not recoverable: the plan and invocation ledgers record no kernel commit.
The recording time is a sound bound for its purpose: the observer runs in the
reflection phase of the cycle that wrote (or first saw) the failure, so the
recorded epoch is the failure's epoch unless a deploy landed in between, and
then it is NEWER — which can only withhold an epoch probe until
``PROBE_INTERVAL``, never grant one the gate change did not earn.
"""
from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .tool_registry import parse_utc_stamp


@dataclass(frozen=True)
class VoidEntry:
    failure_mode: str
    role: str
    before: str
    fixed_by: str
    why: str


ATTRIBUTION_VOID: tuple[VoidEntry, ...] = (
    # The completeness critic cited `tools/coverage/<plan>-r1.json`, the
    # closure manifest the kernel minted into its own envelope; the evidence
    # law refuses a state-store path (plan-cyc-20261004T073028Z). #1797 hands
    # agents only citable evidence (ARIA-HIGH-354..357).
    VoidEntry("agent_evidence_path_missing", "completeness_critique", "2026-10-06T16:50:33+00:00", "#1797",
              "the kernel minted a non-citable store path into the critic's envelope"),
    # The failing_ci seed carried `gh-run-list:ci-run-*` as its only evidence
    # ref; the challenger copied it (2026-08-16, refused as malformed) or
    # refused the request for it (2026-09-29, 2026-09-30). #1731 builds those
    # plans from the workflow file and moves the run to provenance_refs.
    VoidEntry("agent_evidence_ref_malformed", "challenger_plan", "2026-10-04T06:10:37+00:00", "#1731",
              "the kernel seeded the plan with a pseudo-ref the evidence law refuses"),
    VoidEntry("agent_refused_evidence", "drafter", "2026-10-04T06:10:37+00:00", "#1731",
              "the kernel seeded the plan with a pseudo-ref the evidence law refuses"),
)

#: (module, top-level name): the functions and tables of gate semantics.
GATE_DEFINITIONS: tuple[tuple[str, str], ...] = (
    ("plan_convergence", "evaluate_plan"), ("plan_convergence", "_evaluate_state"),
    ("plan_convergence", "_evaluate_cross_review_state"), ("plan_convergence", "plan_body_refusals"),
    ("plan_convergence", "force_plan_human_required"),
    ("architecture_spine_gate", "_plan_comparison_obligation"),
    ("plan_contract", "plan_contract_gate"), ("plan_contract", "plan_contract_violations"),
    ("plan_contract", "PLAN_CONTRACT_REASONS"),
    ("must_satisfy", "ARCHITECTURE_SPINE_KIND"), ("must_satisfy", "plan_contract_obligation"),
    ("agent_invocations", "judge_claim_submission"),
    ("agent_contract", "validate_response"), ("agent_contract", "enforce_separation_of_duties"),
    ("agent_contract", "REASON_CLASSES"),
    ("evidence_validator", "validate_agent_response_evidence"),
    ("evidence_validator", "EVIDENCE_VERIFICATION_UNAVAILABLE_CODES"),
    ("release_reason", "_LITERALS"), ("release_reason", "_PREFIXES"),
    ("release_reason", "parse_release_reason"),
)


def void_for(failure_mode: str, role: str, occurred_at: Any) -> VoidEntry | None:
    at = parse_utc_stamp(str(occurred_at or ""))
    for entry in ATTRIBUTION_VOID:
        before = parse_utc_stamp(entry.before)
        if entry.failure_mode == failure_mode and entry.role == role and at is not None and before is not None \
                and at < before:
            return entry
    return None


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and body
                and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            node.body = body[1:] or [ast.Pass()]
    return tree


def definition_digest(source: str, name: str) -> str:
    """The normalized syntax of one top-level definition; KeyError when absent."""
    for node in ast.parse(source).body:
        targets = [node.name] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else [
            target.id for target in getattr(node, "targets", [getattr(node, "target", None)])
            if isinstance(target, ast.Name)]
        if name in targets:
            return ast.dump(_strip_docstrings(node), annotate_fields=True, include_attributes=False)
    raise KeyError(f"gate definition {name!r} not found")


@lru_cache(maxsize=1)
def gate_epoch() -> str:
    here = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    sources: dict[str, str] = {}
    for module, name in GATE_DEFINITIONS:
        source = sources.setdefault(module, (here / f"{module}.py").read_text(encoding="utf-8"))
        digest.update(f"{module}:{name}\0".encode("utf-8") + definition_digest(source, name).encode("utf-8"))
    return "sha256:" + digest.hexdigest()


__all__ = ["ATTRIBUTION_VOID", "GATE_DEFINITIONS", "VoidEntry", "definition_digest", "gate_epoch", "void_for"]
