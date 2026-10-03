"""ADR-0018 D5 — the one admission rule for a plan candidate that names an F finding.

WHY. Two candidate sources name one of ARIA's own F findings: the aging
F_FINDING scan, and an operator request that names a finding id (ADR-0018).
Before this module each judged "is this finding a plan ground" its own way,
and the operator path did not judge at all: its plan cited only
``aria-tools/operator-feedback.jsonl`` (ARIA's own output), so the planner
mint refused it. Review round 2 (ai-safety AISAFETY-HIGH-002, security
GSEC-MEDIUM-002/LOW-007/LOW-008) found the first version still read the
finding's refs from the plain ``F-*.json`` while the event fold is the
authority, filtered only one of the two ref shapes, trusted the index for
"tracked", let a malformed ref fail the whole admission, and bound nothing
of the grounding into the operator's signature.

WHAT. :func:`load_grounding_context` resolves the trusted anchor commit
(:mod:`main_anchor`) and folds the finding ledger ONCE per synthesis;
:func:`admit_finding` judges one finding against it, with no source-specific
fork:

* status AND evidence come from the fold record (``finding.fold_findings``);
* both ref shapes (``evidences[].evidence_envelope`` and
  ``evidence_chain[].reference``) pass the same trust and self-output filter;
* every ref must match a closed safe path charset — a bad ref is a per-ref
  refusal named in the verdict (by hash, never echoed), not a crash;
* a ref must name a file in the anchor commit's TREE (``git ls-tree``);
* at least one surface must be writable
  (``implementation_safety.classify_declared_surface`` is None);
* :func:`grounding_digest` hashes the admitted ref list; an operator request
  signs it at record time and admission refuses a mismatch, so refs that
  changed after signing never ground the request.

Refusals split in two (ADR-0018, arbiter ruling iii): request-intrinsic
reasons spend an operator request; :data:`RUNNER_FAULT_REASONS` (no anchor,
no finding store) never do. No field of the finding body (title, claim
summary, scope, risks, recommendation, facts) leaves this module: only ids,
refs and paths do (ADR-0018 D6).
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .finding import FINDING_ID_RE
from .main_anchor import MainAnchor

FINDING_ID_MISSING = "finding_id_missing"
FINDING_ID_INVALID = "finding_id_invalid"
FINDING_STORE_UNAVAILABLE = "finding_store_unavailable"
FINDING_STORE_UNREADABLE = "finding_store_unreadable"
FINDING_UNKNOWN = "finding_unknown"
FINDING_NOT_OPEN = "finding_not_open"
FINDING_EVIDENCE_UNAVAILABLE = "finding_evidence_unavailable"
FINDING_EVIDENCE_UNSAFE = "finding_evidence_unsafe"
FINDING_EVIDENCE_SELF_OUTPUT_ONLY = "finding_evidence_self_output_only"
CHECKOUT_UNAVAILABLE = "checkout_unavailable"
FINDING_EVIDENCE_UNTRACKED = "finding_evidence_untracked"
FINDING_SURFACES_READONLY = "finding_surfaces_readonly"
GROUNDING_DIGEST_MISMATCH = "grounding_digest_mismatch"
ADMISSION_REASONS: tuple[str, ...] = (
    FINDING_ID_MISSING, FINDING_ID_INVALID, FINDING_STORE_UNAVAILABLE, FINDING_STORE_UNREADABLE,
    FINDING_UNKNOWN, FINDING_NOT_OPEN, FINDING_EVIDENCE_UNAVAILABLE, FINDING_EVIDENCE_UNSAFE,
    FINDING_EVIDENCE_SELF_OUTPUT_ONLY, CHECKOUT_UNAVAILABLE, FINDING_EVIDENCE_UNTRACKED,
    FINDING_SURFACES_READONLY, GROUNDING_DIGEST_MISMATCH,
)
# The runner, not the request, failed: never spends an operator request.
RUNNER_FAULT_REASONS: frozenset[str] = frozenset({
    FINDING_STORE_UNAVAILABLE, FINDING_STORE_UNREADABLE, CHECKOUT_UNAVAILABLE,
})
INTRINSIC_ADMISSION_REASONS: tuple[str, ...] = tuple(
    reason for reason in ADMISSION_REASONS if reason not in RUNNER_FAULT_REASONS
)

REF_UNSAFE = "ref_unsafe"
REF_SELF_OUTPUT = "ref_self_output"
REF_UNTRACKED = "ref_untracked"
_MAX_REF_CHARS = 512
_FINDING_REF_CAP = 50
# A closed path charset: no NUL, no whitespace, no control or bidi code
# points, no glob or shell metacharacters, no absolute path, optional
# ``:<line>``. ``.``/``..`` segments are refused separately.
_SAFE_REF_RE = re.compile(r"^(?P<path>[A-Za-z0-9._@+\-]+(?:/[A-Za-z0-9._@+\-]+)*)(?::[0-9]{1,7})?$")


@dataclass(frozen=True)
class GroundingContext:
    """One synthesis' view: the trusted commit and the finding fold, each read once."""

    repo_root: Path
    anchor: MainAnchor
    findings: Mapping[str, dict[str, Any]] | None
    fold_fault: str | None


@dataclass(frozen=True)
class FindingAdmission:
    """What :func:`admit_finding` decided. ``reason`` is None exactly when admitted."""

    finding_id: str | None
    reason: str | None
    evidence_refs: tuple[str, ...] = ()
    affected_surfaces: tuple[str, ...] = ()
    refused_surfaces: tuple[tuple[str, str], ...] = ()
    refused_refs: tuple[tuple[str, str], ...] = ()
    grounding_digest: str | None = None
    anchor_commit: str | None = None

    @property
    def admitted(self) -> bool:
        return self.reason is None

    @property
    def runner_fault(self) -> bool:
        return self.reason in RUNNER_FAULT_REASONS

    def refused_surface_records(self) -> list[dict[str, str]]:
        return [{"surface": surface, "reason": reason} for surface, reason in self.refused_surfaces]

    def refused_ref_records(self) -> list[dict[str, str]]:
        return [{"ref": ref, "reason": reason} for ref, reason in self.refused_refs]


def safe_repo_ref(ref: Any) -> bool:
    """True when ``ref`` is a repository path (optionally ``:line``) in the closed charset."""
    if not isinstance(ref, str) or not ref or len(ref) > _MAX_REF_CHARS:
        return False
    match = _SAFE_REF_RE.fullmatch(ref)
    if match is None:
        return False
    return all(segment not in {".", ".."} for segment in match.group("path").split("/"))


def _ref_path(ref: str) -> str:
    return ref.rsplit(":", 1)[0] if re.search(r":[0-9]+$", ref) else ref


def _ref_label(ref: str) -> str:
    """How a refused ref is named in governance: itself when safe, else its hash.

    A ref that fails the charset may carry delimiter, bidi or control
    payloads; it is never echoed into a ledger a prompt may later read.
    """
    if safe_repo_ref(ref):
        return ref
    return "sha256:" + hashlib.sha256(ref.encode("utf-8", errors="replace")).hexdigest()


def _trusted_entry(entry: Mapping[str, Any]) -> bool:
    envelope = entry.get("evidence_envelope") if isinstance(entry.get("evidence_envelope"), dict) else entry
    return envelope.get("trust_grade") in (None, "repo_verified") and not envelope.get("self_output_class")


def refs_from_finding_record(record: Mapping[str, Any]) -> list[str]:
    """The code references a finding record cites, both shapes through one trust filter.

    ``evidence_chain[].reference`` (the adapter-era shape) and
    ``evidences[].evidence_envelope`` (``aria/finding/v1``, ARIA-HIGH-183)
    both carry ``path[:line]`` refs; an entry graded other than
    ``repo_verified`` or classed as self-output is skipped in either shape.
    """
    refs: list[str] = []
    chain = record.get("evidence_chain")
    for entry in chain if isinstance(chain, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("reference"), str) and _trusted_entry(entry):
            refs.append(entry["reference"].strip())
    evidences = record.get("evidences")
    for entry in evidences if isinstance(evidences, list) else []:
        if not isinstance(entry, dict) or not _trusted_entry(entry):
            continue
        envelope = entry.get("evidence_envelope") if isinstance(entry.get("evidence_envelope"), dict) else {}
        canonical = envelope.get("canonical_ref") or entry.get("ref")
        if not isinstance(canonical, str) or not canonical.strip():
            continue
        canonical = canonical.strip()
        line = envelope.get("line")
        if isinstance(line, int) and not isinstance(line, bool) and line > 0 and not re.search(r":[0-9]+$", canonical):
            canonical = f"{canonical}:{line}"
        refs.append(canonical)
    return list(dict.fromkeys(ref for ref in refs if ref))[:_FINDING_REF_CAP]


def grounding_digest(evidence_refs: tuple[str, ...] | list[str]) -> str:
    """``sha256:`` of the admitted ref list as canonical JSON — what an operator signs."""
    encoded = json.dumps(list(evidence_refs), separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(encoded.encode("ascii")).hexdigest()


def load_grounding_context(repo_root: str | Path) -> GroundingContext:
    """Resolve the anchor and fold the finding ledger once for a whole synthesis."""
    from .finding import fold_findings
    from .main_anchor import resolve_main_anchor
    from .tool_registry import GovernanceError

    root = Path(repo_root).resolve()
    try:
        findings = fold_findings(root)
    except (GovernanceError, OSError, ValueError):
        return GroundingContext(root, resolve_main_anchor(root), None, FINDING_STORE_UNREADABLE)
    fault = FINDING_STORE_UNAVAILABLE if findings is None else None
    return GroundingContext(root, resolve_main_anchor(root), findings, fault)


def admit_finding(
    context: GroundingContext, finding_id: Any, *, expected_digest: str | None = None,
) -> FindingAdmission:
    """Judge one F finding as a plan ground at the context's anchor commit."""
    return _judge_finding(context, finding_id, frozenset({"OPEN"}), expected_digest)


def closure_blocker(context: GroundingContext, finding_id: str) -> str | None:
    """Wall #7 — why ARIA's own plan lane could not close this backlog finding; None when it could.

    The ONE closability rule, and it is this module's admission: the same
    refs, trust filter, anchor tree and writable-surface test
    (``implementation_safety.classify_declared_surface``) a plan candidate
    must pass, with the status gate widened from OPEN to the whole backlog
    (``finding.BACKLOG_STATUSES``) — an IN_PROGRESS finding is unfinished
    work too, and whether ARIA can finish it is a property of its evidence
    and surfaces, not of who started it. A reason in RUNNER_FAULT_REASONS
    means the runner could not judge: undecided, never operator-only.
    """
    from .finding import BACKLOG_STATUSES

    return _judge_finding(context, finding_id, BACKLOG_STATUSES, None).reason


def _judge_finding(
    context: GroundingContext, finding_id: Any, statuses: frozenset[str], expected_digest: str | None,
) -> FindingAdmission:
    from .evidence_trust import is_self_output_ref
    from .implementation_safety import classify_declared_surface
    from .main_anchor import tracked_files_at

    if not isinstance(finding_id, str) or not finding_id.strip():
        return FindingAdmission(None, FINDING_ID_MISSING)
    if FINDING_ID_RE.fullmatch(finding_id) is None:
        return FindingAdmission(None, FINDING_ID_INVALID)
    if context.fold_fault is not None or context.findings is None:
        return FindingAdmission(finding_id, context.fold_fault or FINDING_STORE_UNAVAILABLE)
    record = context.findings.get(finding_id)
    if record is None:
        return FindingAdmission(finding_id, FINDING_UNKNOWN)
    if record.get("status") not in statuses:
        return FindingAdmission(finding_id, FINDING_NOT_OPEN)
    refs = refs_from_finding_record(record)
    if not refs:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNAVAILABLE)
    refused_refs: list[tuple[str, str]] = []
    candidates: list[str] = []
    for ref in refs:
        if not safe_repo_ref(ref):
            refused_refs.append((_ref_label(ref), REF_UNSAFE))
        elif is_self_output_ref(ref):
            refused_refs.append((ref, REF_SELF_OUTPUT))
        else:
            candidates.append(ref)
    if not candidates:
        reason = (FINDING_EVIDENCE_SELF_OUTPUT_ONLY
                  if any(why == REF_SELF_OUTPUT for _ref, why in refused_refs) else FINDING_EVIDENCE_UNSAFE)
        return FindingAdmission(finding_id, reason, refused_refs=tuple(refused_refs))
    commit = context.anchor.commit
    tracked = (tracked_files_at(context.repo_root, commit=commit, paths=sorted({_ref_path(r) for r in candidates}))
               if commit is not None else None)
    if tracked is None:
        return FindingAdmission(finding_id, CHECKOUT_UNAVAILABLE, refused_refs=tuple(refused_refs))
    grounded = []
    for ref in candidates:
        if _ref_path(ref) in tracked:
            grounded.append(ref)
        else:
            refused_refs.append((ref, REF_UNTRACKED))
    if not grounded:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNTRACKED,
                                refused_refs=tuple(refused_refs), anchor_commit=commit)
    writable: list[str] = []
    refused_surfaces: list[tuple[str, str]] = []
    for surface in dict.fromkeys(_ref_path(ref) for ref in grounded):
        why = classify_declared_surface(surface)
        if why is None:
            writable.append(surface)
        else:
            refused_surfaces.append((surface, why))
    digest = grounding_digest(grounded)
    verdict = dict(
        evidence_refs=tuple(grounded), refused_surfaces=tuple(refused_surfaces),
        refused_refs=tuple(refused_refs), grounding_digest=digest, anchor_commit=commit,
    )
    if not writable:
        return FindingAdmission(finding_id, FINDING_SURFACES_READONLY, **verdict)
    if expected_digest is not None and expected_digest != digest:
        return FindingAdmission(finding_id, GROUNDING_DIGEST_MISMATCH, **verdict)
    return FindingAdmission(finding_id, None, affected_surfaces=tuple(writable), **verdict)


def admit_candidate(candidate: Mapping[str, Any], context: GroundingContext) -> FindingAdmission | None:
    """The admission a ranked candidate needs, or None for a source that names no F finding.

    An F_FINDING candidate's id IS the finding id; an operator request
    carries the finding id and the grounding digest it signed. Both go
    through :func:`admit_finding`.
    """
    from .plan_candidate_source import PlanCandidateSource

    source_type = candidate.get("source_type")
    if source_type == PlanCandidateSource.F_FINDING.value:
        return admit_finding(context, candidate.get("candidate_id"))
    if source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        digest = candidate.get("grounding_digest")
        return admit_finding(context, candidate.get("finding_id"),
                             expected_digest=digest if isinstance(digest, str) else "")
    return None


__all__ = [
    "ADMISSION_REASONS",
    "CHECKOUT_UNAVAILABLE",
    "FINDING_EVIDENCE_SELF_OUTPUT_ONLY",
    "FINDING_EVIDENCE_UNAVAILABLE",
    "FINDING_EVIDENCE_UNSAFE",
    "FINDING_EVIDENCE_UNTRACKED",
    "FINDING_ID_INVALID",
    "FINDING_ID_MISSING",
    "FINDING_NOT_OPEN",
    "FINDING_STORE_UNAVAILABLE",
    "FINDING_STORE_UNREADABLE",
    "FINDING_SURFACES_READONLY",
    "FINDING_UNKNOWN",
    "GROUNDING_DIGEST_MISMATCH",
    "INTRINSIC_ADMISSION_REASONS",
    "REF_SELF_OUTPUT",
    "REF_UNSAFE",
    "REF_UNTRACKED",
    "RUNNER_FAULT_REASONS",
    "FindingAdmission",
    "GroundingContext",
    "admit_candidate",
    "admit_finding",
    "closure_blocker",
    "grounding_digest",
    "load_grounding_context",
    "refs_from_finding_record",
    "safe_repo_ref",
]
