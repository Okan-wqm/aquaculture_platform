"""ARIA-HIGH-381 — a finding's WRITE surfaces and its EVIDENCE surfaces are two sets, split at admission.

WHY. Admission (``finding_grounding._judge_finding``) turned every grounded
evidence file that is not kernel-readonly into an ``affected_surface``; the
plan converter wrote those surfaces into ``affected_surfaces`` AND into
key-change-0's ``paths``; ``plan_round_scope`` minted the key-change
obligation over those paths; and staging
(``apply_engine._intended_files_from_plan``) handed the same set to the
change ledger's scope verdict (``change_ledger.verify_change_scope``), which
refuses an intended file the diff leaves untouched unless the implementer
declares a disposition. A file a finding CITES was therefore a file the plan
had to WRITE. Measured on plan ``plan-cyc-20261007T081056Z-auto`` (F-015,
operator request OP-F015-20261007-1): the operator signed "keep every change
inside hr-module (the contracts in shared-ui and hr-service are read-only
evidence)", the finding cites the hr-module filter (the drifting copy) and
the hr-service ``LeaveRequestStatus`` entity (the contract it drifted from),
and the obligation pinned the entity as a path of key-change-0. Both planners
narrowed the paths to honour the operator, the cross-reviewer flagged the
narrowing in both rounds (CR-006, "if the conformance gate reads path-set
equality ... the converged body fails"), and the plan ended HUMAN_REQUIRED.

WHAT. :func:`split_surfaces` partitions a finding's grounded surfaces once,
on one of three recorded bases:

* :data:`WRITE_BASIS_DECLARED` — the operator signed ``write_roots`` on the
  request (:func:`write_roots_violation` is the one shape check, run by the
  recorder and by ingestion). A surface equal to or under a root is written;
  every other cited surface is evidence.
* :data:`WRITE_BASIS_FIX_TARGET` — no declared roots (every request signed
  before this field existed, OP-F015 among them, and every unattended F
  finding), and the finding's drift class has a copy side in
  :data:`DRIFT_COPY_SIDES`, the one table of that rule. ``ui_option_drift``
  is there: the scanner judges the UI's options against the wire contract
  (``ui_value_not_on_wire`` = the UI sends values the wire does not carry), so
  the UI is the copy. The surfaces in the copy's project (``impact_graph``
  attribution) are written; a cited surface in any other project is evidence.
* :data:`WRITE_BASIS_UNDIVIDED` — a finding with no defined copy side: not a
  drift record, or a drift class absent from :data:`DRIFT_COPY_SIDES`.
  ``enum_drift`` is absent on purpose (review MEDIUM-1): a TS enum against a
  SQL enum is often fixed by a migration on the SQL side, so neither side is
  evidence-only; every cited surface stays writable, as before.
* :data:`WRITE_BASIS_DEFERRED` — the copy side is defined but none of the
  surfaces handed in is it (its file was renamed or moved after the finding
  was minted). The split cannot be made from these refs, so it is not made:
  admission of an unattended F finding defers to the seed, which re-grounds
  the copy through the finding's detector and splits there (review
  MEDIUM-3). An operator request, whose signed refs cannot follow a moved
  file, is refused instead.

Why a signed field AND a derivation: the signature covers every field of a
request row (``operator_request_signature.subject_signing_bytes``), so an
optional field is signed whenever it is present and a row without it keeps
its exact signed bytes; but a row already signed cannot gain one, and the
operator's prose is never parsed for scope. The derivation is what makes
OP-F015 plannable as the operator asked; the field is how a later operator
says something the derivation would not (a backend-side fix, say).

The split reaches the plan through admission only: ``affected_surfaces`` and
key-change paths are the write set, ``evidence_refs`` still cite every
surface, and ``plan_origin.compute_admission_scope`` records the evidence
surfaces as read-only (ADR-0021 D9's evidence scope), so no revision can put
one back into a body and the change ledger never intends to write one.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

WRITE_BASIS_DECLARED = "operator_declared"
WRITE_BASIS_FIX_TARGET = "fix_target_module"
WRITE_BASIS_UNDIVIDED = "undivided"
WRITE_BASIS_DEFERRED = "fix_target_ungrounded"
# The side order ``tools/aria-poc/seed_drift_findings.drift_evidences`` writes
# (its ``SIDE_KEYS``), and the sides each drift class the seeder mints carries
# in that order (``select_candidates``); ``tests/test_plan_write_scope.py``
# pins both against the seeder.
DRIFT_SIDE_ORDER: tuple[str, ...] = ("ts", "sql", "ui", "source")
DRIFT_CLASS_SIDES: dict[str, tuple[str, ...]] = {"enum_drift": ("ts", "sql"), "ui_option_drift": ("ui", "source")}
# THE rule: the drift classes whose copy side is defined, and which side it is.
# A class absent here (``enum_drift``) names no fix target and stays undivided.
DRIFT_COPY_SIDES: dict[str, str] = {"ui_option_drift": "ui"}
# The signed request field, and its bound: a boundary is a handful of module
# roots, never a file list long enough to smuggle a scope past review.
WRITE_ROOTS_FIELD = "write_roots"
MAX_WRITE_ROOTS = 20


@dataclass(frozen=True)
class SurfaceSplit:
    """``write`` may be changed by the plan; ``evidence`` is cited and read only."""

    write: tuple[str, ...]
    evidence: tuple[str, ...]
    basis: str


def write_roots_violation(value: Any) -> str | None:
    """Why ``value`` is not a signed ``write_roots`` list, or None.

    Each root is a canonical repo-relative path (the spelling
    ``canonical_path.resolve_repo_relpath`` returns), carries no glob, and is
    writable at all (``implementation_safety.classify_declared_surface``):
    a boundary that names a kernel-readonly root declares nothing a plan may do.
    """
    from .canonical_path import resolve_repo_relpath
    from .implementation_safety import classify_declared_surface
    from .tool_registry import GovernanceError

    if not isinstance(value, list) or not value or len(value) > MAX_WRITE_ROOTS:
        return f"{WRITE_ROOTS_FIELD} must be a list of 1 to {MAX_WRITE_ROOTS} repository paths"
    for item in value:
        if not isinstance(item, str):
            return f"{WRITE_ROOTS_FIELD} entries must be strings"
        try:
            canonical = resolve_repo_relpath(item)
        except GovernanceError:
            return f"{WRITE_ROOTS_FIELD} entry is not a repository path"
        if canonical != item or any(ch in item for ch in "*?["):
            return f"{WRITE_ROOTS_FIELD} entry is not canonical: {item!r}"
        if classify_declared_surface(item) is not None:
            return f"{WRITE_ROOTS_FIELD} entry is not writable: {item!r}"
    if len(set(value)) != len(value):
        return f"{WRITE_ROOTS_FIELD} entries must be distinct"
    return None


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _ref_path(ref: str) -> str:
    head, sep, tail = ref.rpartition(":")
    return head if sep and tail.isdigit() else ref


def _copy_index(record: Mapping[str, Any]) -> tuple[int, int] | None:
    """(the copy side's position, the side count) for a drift record with a defined copy side, else None."""
    from .finding_subject import DRIFT_ORIGIN, drift_class_of, finding_subject_key

    if record.get("originating_skill") != DRIFT_ORIGIN or finding_subject_key(record) is None:
        return None
    drift_class = drift_class_of(record)
    copy = DRIFT_COPY_SIDES.get(drift_class or "")
    if copy is None:
        return None
    sides = DRIFT_CLASS_SIDES[str(drift_class)]
    evidences = record.get("evidences")
    if not isinstance(evidences, list) or len(evidences) != len(sides):
        return None
    return sides.index(copy), len(sides)


def drift_fix_target(record: Mapping[str, Any], refs: list[str] | tuple[str, ...] | None = None) -> str | None:
    """The path of a drift finding's copy side, or None when its class defines none.

    ``refs`` are the side refs as the finding's detector found them NOW, in
    the seeder's writing order (``seed_drift_findings.judge_subject``); without
    them the record's own evidence is read. The position comes from
    :data:`DRIFT_CLASS_SIDES` and :data:`DRIFT_COPY_SIDES`, never assumed.
    """
    located = _copy_index(record)
    if located is None:
        return None
    index, count = located
    if refs is not None:
        return _ref_path(str(refs[index]).strip()) if len(refs) >= count else None
    entry = record["evidences"][index]
    ref = entry.get("ref") if isinstance(entry, dict) else None
    return _ref_path(ref.strip()) if isinstance(ref, str) and ref.strip() else None


def _module_root(path: str, repo_root: Path) -> str:
    """The project root ``path`` belongs to (``impact_graph`` attribution), else its own directory."""
    from .impact_graph import _discover_projects, project_for_path

    roots = {name: meta["root"] for name, meta in _discover_projects(repo_root).items()}
    project = project_for_path(path, roots)
    if project is not None:
        return roots[project]
    parent = path.rpartition("/")[0]
    return parent or path


def split_surfaces(
    surfaces: tuple[str, ...] | list[str],
    *,
    record: Mapping[str, Any],
    write_roots: list[str] | tuple[str, ...] | None,
    repo_root: str | Path,
    fix_target: str | None = None,
) -> SurfaceSplit:
    """Partition ``surfaces`` (in order) into the write set and the evidence set; see the module docstring.

    ``fix_target`` is the copy side's path as re-grounded by the seed; None
    reads it from the record.
    """
    ordered = tuple(dict.fromkeys(surfaces))
    if write_roots:
        write = tuple(path for path in ordered if any(_under(path, root) for root in write_roots))
        return SurfaceSplit(write, tuple(p for p in ordered if p not in write), WRITE_BASIS_DECLARED)
    target = fix_target if fix_target is not None else drift_fix_target(record)
    if target is None:
        if _copy_index(record) is not None:
            # A defined copy side that no ref names any more: not "no fix target".
            return SurfaceSplit((), ordered, WRITE_BASIS_DEFERRED)
        return SurfaceSplit(ordered, (), WRITE_BASIS_UNDIVIDED)
    if target not in ordered:
        return SurfaceSplit((), ordered, WRITE_BASIS_DEFERRED)
    module = _module_root(target, Path(repo_root))
    write = tuple(path for path in ordered if _under(path, module))
    return SurfaceSplit(write, tuple(p for p in ordered if p not in write), WRITE_BASIS_FIX_TARGET)


__all__ = [
    "DRIFT_CLASS_SIDES",
    "DRIFT_COPY_SIDES",
    "DRIFT_SIDE_ORDER",
    "MAX_WRITE_ROOTS",
    "WRITE_BASIS_DECLARED",
    "WRITE_BASIS_DEFERRED",
    "WRITE_BASIS_FIX_TARGET",
    "WRITE_BASIS_UNDIVIDED",
    "WRITE_ROOTS_FIELD",
    "SurfaceSplit",
    "drift_fix_target",
    "split_surfaces",
    "write_roots_violation",
]
