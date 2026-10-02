"""ADR-0018 D5 — the one admission rule for a plan candidate that names an F finding.

WHY. Two candidate sources name one of ARIA's own F findings: the aging
F_FINDING scan, and an operator request that names a finding id (ADR-0018).
Before this module each judged "is this finding a plan ground" its own way,
and the operator path did not judge at all: its plan cited only
``aria-tools/operator-feedback.jsonl`` (ARIA's own output, unresolvable at
any SHA), so the planner mint refused it (``request_evidence_self_output_only``).
The F path trusted the producer's ``repo_verified`` label, read the frozen
mint-time ``status`` of ``F-*.json`` instead of the event fold, and could
declare a surface the implementation lane may never write.

WHAT. :func:`admit_finding` is shared by both paths, with no source-specific
fork. A finding is admitted when it is OPEN in the finding-event fold
(``finding.list_findings`` — authoritative over the frozen JSON), its own
evidence refs (``plan_synthesizer._evidence_refs_from_finding_json``) minus
ARIA's self-output (``evidence_trust.is_self_output_ref``) name at least one
file TRACKED in the cycle's checkout (observed with ``git ls-files``, not the
producer's label), and at least one of those surfaces is writable
(``implementation_safety.classify_declared_surface`` is None). Refused
surfaces are carried on the verdict so the conversion governance event lists
them; nothing is dropped silently. A refusal is a reason from
:data:`ADMISSION_REASONS`.

No field of the finding body (title, claim summary, scope, risks,
recommendation, lesson) leaves this module: only ids, refs and paths do
(ADR-0018 D6).
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .finding import FINDING_ID_RE

FINDING_ID_MISSING = "finding_id_missing"
FINDING_ID_INVALID = "finding_id_invalid"
FINDING_STORE_UNREADABLE = "finding_store_unreadable"
FINDING_UNKNOWN = "finding_unknown"
FINDING_NOT_OPEN = "finding_not_open"
FINDING_EVIDENCE_UNAVAILABLE = "finding_evidence_unavailable"
FINDING_EVIDENCE_SELF_OUTPUT_ONLY = "finding_evidence_self_output_only"
CHECKOUT_UNAVAILABLE = "checkout_unavailable"
FINDING_EVIDENCE_UNTRACKED = "finding_evidence_untracked"
FINDING_SURFACES_READONLY = "finding_surfaces_readonly"
ADMISSION_REASONS: tuple[str, ...] = (
    FINDING_ID_MISSING, FINDING_ID_INVALID, FINDING_STORE_UNREADABLE, FINDING_UNKNOWN,
    FINDING_NOT_OPEN, FINDING_EVIDENCE_UNAVAILABLE, FINDING_EVIDENCE_SELF_OUTPUT_ONLY,
    CHECKOUT_UNAVAILABLE, FINDING_EVIDENCE_UNTRACKED, FINDING_SURFACES_READONLY,
)
_LINE_SUFFIX_RE = re.compile(r":\d+$")
_GIT_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class FindingAdmission:
    """What :func:`admit_finding` decided. ``reason`` is None exactly when admitted."""

    finding_id: str | None
    reason: str | None
    evidence_refs: tuple[str, ...] = ()
    affected_surfaces: tuple[str, ...] = ()
    refused_surfaces: tuple[tuple[str, str], ...] = ()

    @property
    def admitted(self) -> bool:
        return self.reason is None

    def refused_surface_records(self) -> list[dict[str, str]]:
        return [{"surface": surface, "reason": reason} for surface, reason in self.refused_surfaces]


def _ref_path(ref: str) -> str:
    return ref.rsplit(":", 1)[0] if _LINE_SUFFIX_RE.search(ref) else ref


def _tracked_files(repo_root: Path, paths: list[str]) -> set[str] | None:
    """The subset of ``paths`` that are tracked FILES at the checkout, or None.

    ``--literal-pathspecs`` so a ref is a path, never a glob; a directory
    is listed by its files, so a bare directory ref is not a tracked file.
    """
    try:
        proc = subprocess.run(
            ["git", "--literal-pathspecs", "-C", str(repo_root), "ls-files", "-z", "--", *paths],
            stdin=subprocess.DEVNULL, capture_output=True, check=False,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    listed = {entry for entry in proc.stdout.decode("utf-8", errors="replace").split("\0") if entry}
    return {path for path in paths if path in listed}


def _finding_status(repo_root: Path, finding_id: str) -> tuple[str | None, str | None]:
    """(status, refusal) from the event fold — the authority over ``F-*.json``."""
    from .finding import list_findings
    from .tool_registry import GovernanceError

    try:
        rows = list_findings(repo_root)
    except (GovernanceError, OSError, ValueError):
        return None, FINDING_STORE_UNREADABLE
    statuses = [row.get("status") for row in rows if row.get("finding_id") == finding_id]
    if not statuses:
        return None, FINDING_UNKNOWN
    return str(statuses[-1]), None


def admit_finding(*, repo_root: str | Path, finding_id: Any) -> FindingAdmission:
    """Judge one F finding as a plan ground in the checkout at ``repo_root``."""
    from .evidence_trust import is_self_output_ref
    from .finding import findings_dir
    from .implementation_safety import classify_declared_surface
    from .plan_synthesizer import _evidence_refs_from_finding_json

    if not isinstance(finding_id, str) or not finding_id.strip():
        return FindingAdmission(None, FINDING_ID_MISSING)
    if FINDING_ID_RE.fullmatch(finding_id) is None:
        return FindingAdmission(None, FINDING_ID_INVALID)
    root = Path(repo_root).resolve()
    status, refusal = _finding_status(root, finding_id)
    if refusal is not None:
        return FindingAdmission(finding_id, refusal)
    if status != "OPEN":
        return FindingAdmission(finding_id, FINDING_NOT_OPEN)
    refs, _surfaces = _evidence_refs_from_finding_json(str(findings_dir(root) / f"{finding_id}.json"))
    if not refs:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNAVAILABLE)
    repo_refs = [ref for ref in refs if not is_self_output_ref(ref)]
    if not repo_refs:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_SELF_OUTPUT_ONLY)
    tracked = _tracked_files(root, sorted({_ref_path(ref) for ref in repo_refs}))
    if tracked is None:
        return FindingAdmission(finding_id, CHECKOUT_UNAVAILABLE)
    grounded = [ref for ref in repo_refs if _ref_path(ref) in tracked]
    if not grounded:
        return FindingAdmission(finding_id, FINDING_EVIDENCE_UNTRACKED)
    writable: list[str] = []
    refused: list[tuple[str, str]] = []
    for surface in dict.fromkeys(_ref_path(ref) for ref in grounded):
        why = classify_declared_surface(surface)
        if why is None:
            writable.append(surface)
        else:
            refused.append((surface, why))
    if not writable:
        return FindingAdmission(
            finding_id, FINDING_SURFACES_READONLY,
            evidence_refs=tuple(grounded), refused_surfaces=tuple(refused),
        )
    return FindingAdmission(
        finding_id, None, evidence_refs=tuple(grounded),
        affected_surfaces=tuple(writable), refused_surfaces=tuple(refused),
    )


def admit_candidate(candidate: Mapping[str, Any], *, repo_root: str | Path) -> FindingAdmission | None:
    """The admission a ranked candidate needs, or None for a source that names no F finding.

    An F_FINDING candidate's id IS the finding id; an operator request
    carries the finding id it signed. Both go through :func:`admit_finding`.
    """
    from .plan_candidate_source import PlanCandidateSource

    source_type = candidate.get("source_type")
    if source_type == PlanCandidateSource.F_FINDING.value:
        return admit_finding(repo_root=repo_root, finding_id=candidate.get("candidate_id"))
    if source_type == PlanCandidateSource.OPERATOR_FEEDBACK.value:
        return admit_finding(repo_root=repo_root, finding_id=candidate.get("finding_id"))
    return None


__all__ = [
    "ADMISSION_REASONS",
    "CHECKOUT_UNAVAILABLE",
    "FINDING_EVIDENCE_SELF_OUTPUT_ONLY",
    "FINDING_EVIDENCE_UNAVAILABLE",
    "FINDING_EVIDENCE_UNTRACKED",
    "FINDING_ID_INVALID",
    "FINDING_ID_MISSING",
    "FINDING_NOT_OPEN",
    "FINDING_STORE_UNREADABLE",
    "FINDING_SURFACES_READONLY",
    "FINDING_UNKNOWN",
    "FindingAdmission",
    "admit_candidate",
    "admit_finding",
]
