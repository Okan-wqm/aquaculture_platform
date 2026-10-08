"""ARIA-HIGH-369 — an F plan is seeded from the finding's own repo evidence, re-resolved at the anchor.

WHY. Admission (``finding_grounding.admit_finding``) asks only whether each
cited FILE is tracked at the anchor commit; it never reads the cited LINE. The
F plans it let through were therefore seeded from whatever the finding said
on the night it was minted, under a fixed template ("Process aging F-finding
F-NNN; verify status + land remediation if OPEN."). Measured on the aria/state
store 2026-10-06: 20 plans, 0 converged; 2 of the 19 dead plans were F
template plans (F-003, F-012), and F-007 — the finding an operator asked for —
cites ``LeavesPage.tsx:355``, a ``<select`` at its mint commit 0fb5f096b and a
placeholder attribute on main, because the filter moved to :389. PR #1759
(ARIA-HIGH-332) answered a moved line by REFUSING the finding, which would
also have spent F-007's operator request; the subject had not gone anywhere.

WHAT. :func:`seed_finding` re-grounds an ADMITTED finding at the admission's
anchor commit and returns a :class:`FindingSeed` — the evidence a plan cites
and the subject it names — or the reason there is none:

* a finding whose origin has a detector (``finding_closure.default_detectors``,
  the registry ARIA-HIGH-363 closes merged findings with) is asked that
  detector at the anchor. ``reproduces`` seeds the plan from the refs the
  detector found NOW (a moved line re-anchors, and the move is named);
  ``absent`` is :data:`SUBJECT_ABSENT` and ``unverifiable`` is
  :data:`SUBJECT_UNVERIFIABLE` — never planned, never closed here: closing is
  363's merge path, after a fix lands;
* any other finding has each ``path:line`` ref mapped through the diff from
  the commit it was verified against (the evidence envelope's ``target_sha``,
  else the mint event's ``minted_at_sha``) to the anchor
  (``finding_line_map.map_cited_line``, review H1): a line no hunk touched is
  shifted by the hunks above it; a line inside a hunk, or one with no readable
  origin, makes the finding :data:`SUBJECT_UNVERIFIABLE`. Text is never
  matched, so a trivial line elsewhere can never stand in for a deleted one.

ARIA-HIGH-381 — a seed's surfaces are split the way admission splits them
(:func:`plan_write_scope.split_surfaces`): ``affected_surfaces`` is the
write set (one key change each), ``evidence_surfaces`` the cited files the
plan reads and never writes (a drift's contract side in another module).

A detector that raises or answers a non-object is :data:`SUBJECT_UNVERIFIABLE`
with the error named (review M2): one finding's detector never aborts the
synthesis that also carries the operator's request.

Only ids, paths, lines, the severity and claim type (closed sets) and the
subject's side NAMES (identifiers, ``finding_subject.subject_sides``, checked
against :data:`_SIDE_NAME_RE`) reach a plan; no prose field of the finding
does (ADR-0018 D6). An operator request is never refused by this module: its
admission stands on the grounding the operator signed, and a seed only moves
a signed ref to its current line (:meth:`FindingSeed.signed_refs_moved`,
review M1) — it never adds a ref or a surface the operator did not sign.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping

from .finding import CLAIM_TYPES, SEVERITY_RANK
from .finding_grounding import (
    FINDING_SURFACES_READONLY,
    FINDING_WRITE_SCOPE_EMPTY,
    FindingAdmission,
    GroundingContext,
    _ref_path,
    admit_candidate,
    safe_repo_ref,
)
from .finding_subject import drift_class_of, finding_subject_key, subject_sides

SEED_CURRENT = "current"
SEED_REANCHORED = "reanchored"
SUBJECT_ABSENT = "f_finding_subject_absent"
SUBJECT_UNVERIFIABLE = "f_finding_subject_unverifiable"
SEED_REASONS: tuple[str, ...] = (SUBJECT_ABSENT, SUBJECT_UNVERIFIABLE)
_LINE_RE = re.compile(r":([0-9]+)$")
_COMMIT_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
# A side name is an identifier the scanner read from code (an option-group id,
# an enum or type name); anything else is not passed into a plan.
_SIDE_NAME_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_.$\-]{0,99}$")
_SEED_REF_CAP = 50


@dataclass(frozen=True)
class FindingSeed:
    """What an F plan is built from: the finding's evidence as it stands at ``anchor_commit``."""

    finding_id: str
    anchor_commit: str | None
    evidence_refs: tuple[str, ...]
    affected_surfaces: tuple[str, ...]
    severity: str | None = None
    claim_type: str | None = None
    drift_class: str | None = None
    sides: tuple[tuple[str, str], ...] = ()
    moved: tuple[tuple[str, str], ...] = ()
    evidence_surfaces: tuple[str, ...] = ()

    @property
    def state(self) -> str:
        return SEED_REANCHORED if self.moved else SEED_CURRENT

    def disclosure(self) -> dict[str, Any]:
        return {"state": self.state, "anchor_commit": self.anchor_commit,
                "moved": [{"recorded": old, "current": new} for old, new in self.moved]}

    def signed_refs_moved(self, signed: tuple[str, ...]) -> tuple[str, ...]:
        """``signed`` with each ref this seed moved within its own file replaced by where it is now.

        Review M1 — an operator signed a grounding digest over ``signed``; the
        plan may follow a signed line that moved, but never cite a ref or a
        file the operator did not sign.
        """
        moves = {old: new for old, new in self.moved if _ref_path(old) == _ref_path(new)}
        return tuple(dict.fromkeys(moves.get(ref, ref) for ref in signed))

    def plan_text(self) -> tuple[str, str, list[dict[str, Any]]]:
        """(title, summary, key_changes) naming only this seed's ids, paths and identifiers."""
        kind = " ".join(part for part in (self.severity, self.drift_class or self.claim_type) if part)
        at = (self.anchor_commit or "the anchor")[:12]
        named = {path: name for path, name in self.sides}
        cited = [f"`{named[_ref_path(ref)]}` at {ref}" if _ref_path(ref) in named else ref
                 for ref in self.evidence_refs]
        claim = (f"its {self.drift_class} sides {' and '.join(cited)} still diverge" if self.drift_class
                 else f"it cites {', '.join(cited)}")
        moved = "".join(f" Cited {old} moved to {new}." for old, new in self.moved)
        read_only = (f" Read-only evidence, never written: {', '.join(self.evidence_surfaces)}."
                     if self.evidence_surfaces else "")
        summary = (f"Finding {self.finding_id} ({kind}) re-grounded at {at}: {claim}.{moved}{read_only} "
                   f"Land the root-cause fix at {', '.join(self.affected_surfaces)}.")
        title = f"Remediate {self.finding_id} ({kind}) in {', '.join(self.affected_surfaces)}"
        key_changes = []
        for index, surface in enumerate(self.affected_surfaces, start=1):
            refs = [ref for ref in self.evidence_refs if _ref_path(ref) == surface]
            what = (f"change `{named[surface]}` ({', '.join(refs)}) so the {self.drift_class} sides agree"
                    if surface in named and self.drift_class else f"remediate the cited code at {', '.join(refs)}")
            key_changes.append({"id": f"{self.finding_id}-key-change-{index:03d}",
                                "description": f"{self.finding_id}: {what}", "paths": [surface]})
        return title, summary, key_changes


@dataclass(frozen=True)
class SeedVerdict:
    """A seed, or why there is none (``reason`` in :data:`SEED_REASONS` or a readonly refusal)."""

    seed: FindingSeed | None
    reason: str | None = None
    detail: Mapping[str, Any] = field(default_factory=dict)

    def disclosure(self) -> dict[str, Any]:
        if self.seed is not None:
            return self.seed.disclosure()
        return {"state": "unseeded", "reason": self.reason, **dict(self.detail)}


class SubjectProbe:
    """The finding's own detector at one commit, asked at most once per subject per synthesis.

    A drift recheck is a full scan in a detached worktree (17 s measured
    2026-10-06 plus the checkout), so duplicates of one subject never pay twice.
    """

    def __init__(self, detectors: Mapping[str, Any] | None = None) -> None:
        if detectors is None:
            from .finding_closure import default_detectors

            detectors = default_detectors()
        self._detectors = detectors
        self._memo: dict[tuple[str, str], dict[str, Any]] = {}

    def recheck(self, record: Mapping[str, Any], *, commit: str, repo_root: Path) -> dict[str, Any] | None:
        """The detector's verdict at ``commit``; None when the finding's origin has no detector."""
        detector = self._detectors.get(str(record.get("originating_skill") or ""))
        if detector is None:
            return None
        key = (finding_subject_key(record) or str(record.get("finding_id")), commit)
        if key not in self._memo:
            self._memo[key] = _guarded_recheck(detector, record, commit=commit, repo_root=repo_root)
        return self._memo[key]


def _guarded_recheck(detector: Any, record: Mapping[str, Any], *, commit: str, repo_root: Path) -> dict[str, Any]:
    """The detector's verdict, or ``unverifiable`` naming why it could not give one (review M2).

    A detector runs a subprocess scan; ``OSError`` (no interpreter, no fork),
    a subprocess failure or an unreadable answer is that detector's fault, so
    it is this finding's ``unverifiable``, never the synthesis' crash.
    """
    from .finding_closure import VERDICT_UNVERIFIABLE

    try:
        verdict = detector.recheck(record, merge_sha=commit, workspace_root=repo_root)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return {"verdict": VERDICT_UNVERIFIABLE, "reason": f"detector_error:{type(exc).__name__}"}
    if not isinstance(verdict, Mapping):
        return {"verdict": VERDICT_UNVERIFIABLE, "reason": "detector_verdict_not_an_object"}
    return dict(verdict)


def _ref_origins(record: Mapping[str, Any]) -> dict[str, str]:
    """ref -> the commit its evidence was verified against (the envelope's), first wins."""
    origins: dict[str, str] = {}
    evidences = record.get("evidences")
    for entry in evidences if isinstance(evidences, list) else []:
        envelope = entry.get("evidence_envelope") if isinstance(entry, dict) else None
        if not isinstance(envelope, dict):
            continue
        ref, sha, line = envelope.get("canonical_ref") or entry.get("ref"), envelope.get("target_sha"), \
            envelope.get("line")
        if isinstance(ref, str) and isinstance(line, int) and not isinstance(line, bool) and not _LINE_RE.search(ref):
            ref = f"{ref}:{line}"
        if isinstance(ref, str) and isinstance(sha, str):
            origins.setdefault(ref.strip(), sha)
    return origins


def _reread_lines(
    context: GroundingContext, record: Mapping[str, Any], refs: tuple[str, ...], anchor: str,
) -> tuple[list[str] | None, Any]:
    """(refs at the anchor, moves) or (None, why) — each cited line mapped through the diff (review H1)."""
    from .finding_line_map import map_cited_line

    origins, minted = _ref_origins(record), record.get("minted_at_sha")
    current: list[str] = []
    moved: list[tuple[str, str]] = []
    for ref in refs:
        match = _LINE_RE.search(ref)
        if match is None:
            current.append(ref)  # a file ref: admission already found it tracked at the anchor
            continue
        origin = origins.get(ref) or minted
        if not isinstance(origin, str) or _COMMIT_RE.fullmatch(origin) is None:
            return None, {"cause": "ref_origin_unrecorded", "ref": ref}
        if origin == anchor:
            current.append(ref)
            continue
        path = _ref_path(ref)
        line, why = map_cited_line(context.repo_root, origin=origin, anchor=anchor, path=path,
                                   line=int(match.group(1)))
        if line is None:
            return None, {"cause": why, "ref": ref, "origin": origin}
        current.append(f"{path}:{line}")
        if current[-1] != ref:
            moved.append((ref, current[-1]))
    return current, moved


def _seed(record: Mapping[str, Any], admission: FindingAdmission, refs: list[str],
          moved: list[tuple[str, str]], repo_root: Path, fix_target: str | None = None) -> SeedVerdict:
    from .implementation_safety import classify_declared_surface
    from .plan_write_scope import WRITE_BASIS_DEFERRED, split_surfaces

    refs = list(dict.fromkeys(refs))[:_SEED_REF_CAP]
    # An F plan is unattended: no operator boundary, so the finding's own fix
    # target decides — where the detector found the copy NOW when it was asked.
    split = split_surfaces([_ref_path(ref) for ref in refs], record=record, write_roots=None,
                           repo_root=repo_root, fix_target=fix_target)
    if split.basis == WRITE_BASIS_DEFERRED:
        # The copy side is defined but none of these refs is it: re-reading the
        # cited lines cannot follow a renamed file, and only a detector can.
        return SeedVerdict(None, SUBJECT_UNVERIFIABLE, {"cause": "fix_target_ungrounded", "refs": refs})
    if not split.write:
        return SeedVerdict(None, FINDING_WRITE_SCOPE_EMPTY, {"refs": refs, "write_basis": split.basis})
    surfaces = tuple(path for path in split.write if classify_declared_surface(path) is None)
    if not surfaces:
        return SeedVerdict(None, FINDING_SURFACES_READONLY, {"refs": refs})
    severity, claim_type = record.get("severity"), record.get("claim_type")
    return SeedVerdict(FindingSeed(
        finding_id=str(admission.finding_id), anchor_commit=admission.anchor_commit,
        evidence_refs=tuple(refs), affected_surfaces=surfaces,
        severity=severity if severity in SEVERITY_RANK else None,
        claim_type=claim_type if claim_type in CLAIM_TYPES else None,
        drift_class=drift_class_of(record),
        sides=tuple((path, name) for path, name in subject_sides(record) if _SIDE_NAME_RE.fullmatch(name)),
        moved=tuple(moved), evidence_surfaces=split.evidence,
    ))


def seed_finding(context: GroundingContext, admission: FindingAdmission, *, probe: SubjectProbe) -> SeedVerdict:
    """Re-ground an admitted finding at its anchor commit; see the module docstring."""
    from .evidence_trust import is_self_output_ref
    from .finding_closure import VERDICT_ABSENT, VERDICT_REPRODUCES

    record = (context.findings or {}).get(str(admission.finding_id))
    anchor = admission.anchor_commit
    if record is None or not isinstance(anchor, str):
        return SeedVerdict(None, SUBJECT_UNVERIFIABLE, {"cause": "no_record_or_anchor"})
    verdict = probe.recheck(record, commit=anchor, repo_root=context.repo_root)
    if verdict is None:
        refs, moved = _reread_lines(context, record, admission.evidence_refs, anchor)
        if refs is None:
            return SeedVerdict(None, SUBJECT_UNVERIFIABLE, moved)
        return _seed(record, admission, refs, moved, context.repo_root)
    detail = {"detector": record.get("originating_skill"), "detector_reason": verdict.get("reason"), "at": anchor}
    if verdict.get("verdict") == VERDICT_ABSENT:
        return SeedVerdict(None, SUBJECT_ABSENT, detail)
    if verdict.get("verdict") != VERDICT_REPRODUCES:
        return SeedVerdict(None, SUBJECT_UNVERIFIABLE, detail)
    matches = verdict.get("matches") if isinstance(verdict.get("matches"), list) else []
    # Only strings are refs; an unhashable item (a dict, a list) from a
    # malformed scan must not abort the synthesis that carries an operator turn.
    textual = [ref for ref in matches if isinstance(ref, str)]
    refs = [ref for ref in dict.fromkeys(textual) if safe_repo_ref(ref) and not is_self_output_ref(ref)]
    if not refs:
        return SeedVerdict(None, SUBJECT_UNVERIFIABLE, {**detail, "cause": "detector_matches_unusable"})
    by_path = {_ref_path(ref): ref for ref in refs}
    moved = [(old, by_path[_ref_path(old)]) for old in admission.evidence_refs
             if _ref_path(old) in by_path and by_path[_ref_path(old)] != old and _LINE_RE.search(old)]
    from .plan_write_scope import drift_fix_target

    # The detector's matches are in the seeder's side order, so the copy is
    # read from them: a renamed copy file is followed, never refused (review MEDIUM-3).
    return _seed(record, admission, refs, moved, context.repo_root, fix_target=drift_fix_target(record, textual))


def admit_and_seed(
    candidate: Mapping[str, Any], context: GroundingContext, probe: SubjectProbe,
) -> tuple[FindingAdmission | None, SeedVerdict | None]:
    """Admission, then the seed, for one ranked candidate (None, None for a source naming no finding).

    An unattended F finding without a seed is refused with the seed's reason.
    An operator request keeps its signed admission whatever the seed says: the
    seed is used only when there is one, and its absence is disclosed.
    """
    from .plan_candidate_source import PlanCandidateSource

    admission = admit_candidate(candidate, context)
    if admission is None or not admission.admitted:
        return admission, None
    verdict = seed_finding(context, admission, probe=probe)
    if verdict.seed is None and candidate.get("source_type") == PlanCandidateSource.F_FINDING.value:
        admission = replace(admission, reason=verdict.reason, affected_surfaces=())
    return admission, verdict


__all__ = [
    "SEED_CURRENT",
    "SEED_REANCHORED",
    "SEED_REASONS",
    "SUBJECT_ABSENT",
    "SUBJECT_UNVERIFIABLE",
    "FindingSeed",
    "SeedVerdict",
    "SubjectProbe",
    "admit_and_seed",
    "seed_finding",
]
