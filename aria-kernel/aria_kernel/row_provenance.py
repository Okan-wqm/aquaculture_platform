"""F0.9p — the provenance layer: which ledgers' rows cite which, and no learned memory row is an orphan.

WHY THIS EXISTS. A learned row (a belief, a convention, a procedural episode) is only as trustworthy as what it came
from: when a source turns out to be poisoned or mistaken, the rows that cite it have to be found too (F4.6 walks that
graph), and every memory kind a later package adds needs a gate that says "this row names a source". PLAN-v2's chain
(finding -> plan -> change -> merge -> outcome -> lesson / convention / belief -> next plan) already sits on the existing
hash-chained ledgers and their single writers; what no code said was WHICH row carries WHICH citation.

THREE DECLARATIONS, EACH ONCE.
  ``REF_FIELDS``     the closed citation vocabulary: a row field and the ledger and id field it names.
  ``LEARNED_KINDS``  what ARIA learned, by kind: its ledger (a ``state_manifest.memory_surfaces`` member: the ``memory``
                     flag is the one declaration of "what ARIA learned", there is no second list), its id field and the
                     fields that carry a row's source, in the order they are checked.
  ``ROW_SCOPES``     where each ledger's row is BUILT, in ``ownership_atlas`` (the atlas reads the code, this module
                     reads the rows).
``ownership_atlas.provenance_offenders`` keeps the code side honest: the row builders of a learned kind write every
source field the kind declares, so a writer cannot start leaving a source out.

THE CENSUS (``provenance_census``) is the data side, read-only: it counts the learned rows whose source is absent or
names nothing, and the doctor reports it every run (a store without a reader is dead code). Tamper evidence stays with
``integrity verify``: the census reads rows as written and never re-verifies a hash chain.

This module imports only dataclasses, pathlib and typing at module level: the atlas imports it, and ``docs_ssot`` must
not start loading the kernel. The owners are imported inside the functions that read them.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

PLAN_SURFACE = "plan_convergence_events"


@dataclass(frozen=True)
class Ref:
    """A row field that cites another ledger's row: the cited ledger and the field that identifies its rows."""

    surface: str
    id_field: str


@dataclass(frozen=True)
class Learned:
    """A learned memory kind: its ledger, the id field of its rows and the fields that carry a row's source."""

    surface: str
    id_field: str
    sources: tuple[str, ...]


REF_FIELDS: dict[str, Ref] = {
    "plan_id": Ref(PLAN_SURFACE, "plan_id"),
    "change_id": Ref("change_planned", "change_id"),
    # finding.py mints this id (``_allocate_finding_id``); the ``findings`` and ``raw_findings`` surfaces are other id spaces.
    "finding_id": Ref("repo_finding_events", "finding_id"),
    "commit_sha": Ref("change_committed", "commit_sha"),
    "supersedes_pattern_id": Ref("kg_conventions", "pattern_id"),
    "supersedes": Ref("memory_procedural", "episode_id"),
}

LEARNED_KINDS: dict[str, Learned] = {
    "belief": Learned("memory_beliefs", "belief_id", ("evidence_refs",)),
    "convention": Learned("kg_conventions", "pattern_id", ("plan_id",)),
    "episode": Learned("memory_procedural", "episode_id", ("plan_id", "evidence")),
}


def provenance_census(tools_root: Path) -> dict[str, dict[str, Any]]:
    """``{kind: {"rows": n, "orphans": [{"row_id", "reason"}, ...]}}`` for every learned kind, under ``tools_root``.

    An orphan is a row whose first failing source (``Learned.sources`` in order) is empty or absent
    (``source_missing:<field>``) or is a citation that names no row of the cited ledger
    (``source_unresolved:<field>``; only ``plan_id`` is joined in this slice: the plan ids of the plan ledger). Orphans
    are sorted by row id. An absent ledger is zero rows; an unreadable one raises its owner's error and is never
    counted as an orphan. READ-ONLY: nothing is created, renamed, locked or appended.
    """
    cited = {"plan_id": _plan_ids(tools_root)}
    census: dict[str, dict[str, Any]] = {}
    for kind, learned in LEARNED_KINDS.items():
        rows = _READERS[kind](tools_root)
        orphans = [{"row_id": str(row[learned.id_field]), "reason": reason}
                   for row in rows if (reason := _orphan_reason(row, learned, cited)) is not None]
        census[kind] = {"rows": len(rows), "orphans": sorted(orphans, key=lambda orphan: orphan["row_id"])}
    return census


def _orphan_reason(row: dict[str, Any], learned: Learned, cited: dict[str, set[str]]) -> str | None:
    for field in learned.sources:
        value = row.get(field)
        if not value:
            return f"source_missing:{field}"
        if field in cited and value not in cited[field]:
            return f"source_unresolved:{field}"
    return None


def _surface_file(tools_root: Path, surface: str) -> Path:
    from .state_manifest import resolve_surface_path, surface_by_name

    return resolve_surface_path(tools_root, surface_by_name(surface))


def _plan_ids(tools_root: Path) -> set[str]:
    """The ids of the plans the plan ledger holds. Not ``fold_plan_state``: that bootstraps the tools directory,
    validates every event, and answers an unknown plan with an empty state instead of failing."""
    from .ledger import load_declared_jsonl
    from .plan_convergence import events_file

    path = events_file(tools_root)
    if not path.is_file():
        return set()
    return {event["plan_id"] for event in load_declared_jsonl(path, expected_surface=PLAN_SURFACE)}


def _belief_rows(tools_root: Path) -> list[dict[str, Any]]:
    from .memory import latest_beliefs, load_jsonl

    path = _surface_file(tools_root, LEARNED_KINDS["belief"].surface)
    return latest_beliefs(load_jsonl(path)) if path.is_file() else []


def _convention_rows(tools_root: Path) -> list[dict[str, Any]]:
    from .knowledge_graph import convention_rows

    return convention_rows(tools_root)


def _episode_rows(tools_root: Path) -> list[dict[str, Any]]:
    from .agent_eval import list_performance_observations

    return list_performance_observations(base_dir=tools_root)


# One reader per learned kind, each the owner's own: a kind added to LEARNED_KINDS without one fails loudly here.
_READERS = {"belief": _belief_rows, "convention": _convention_rows, "episode": _episode_rows}
