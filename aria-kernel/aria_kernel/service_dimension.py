"""The service dimension of a finding (E15-a, operator direction 2026-08-13).

WHY: findings were organised by TOOL (which adapter fired), never by
SERVICE (which microservice is sick). Per-service audits, service agents
and mission linkage all need a finding to carry its service axis.

WHAT: the axis is the nx project key. A path is attributed by
`impact_graph.project_for_path` — the kernel's ONE path -> project
function — over the map `impact_graph.project_map` returns (the impact
cache's ``project_roots``, fingerprint-checked against the workspace), so a
finding is filed under the same names the impacted set, missions and routing
use. This module owns only the FINDING side of that: which paths a finding
cites (`finding_dimension_paths`), the fields a mint writes
(`finding_service_fields`), and the one row reader
(`services_for_finding_row`).

Until SE-1 (service-expertise plan, owner decision Q9) this module also
attributed paths itself, in a string vocabulary (``apps/<dir>``,
``shared:<lib>``, ``web:<app>``) that could not produce 54 of the
repository's 71 nx names and merged ``libs/X`` with ``platform/libs/X``.
That second implementation is gone. A row minted under the nx key says so
(``service_vocabulary: "nx_project/v1"``) and names the map its names
came from (``service_map_fingerprint``, `ProjectMap.fingerprint`, a digest of
the map's own name=root pairs). A row is read as stored only while that map
is the current one; any other row — every row minted before SE-1, every
stamp that names no map, and every row minted before a ``project.json``
rename or a new project changed the map — is re-derived from its own paths
when it is read. Stored names of another layout are
not trusted and not translated: a string mapping from old names would
carry the old answer forward (SE-1 round 2, review-r1 B1).

The specialist ownership map is NOT copied here — it is imported from
``specialist_review_runner`` (the Lane-A touch-map SSoT) to name the
reviewing agents for a path set.
"""
from __future__ import annotations

from typing import Any, Iterable

from .canonical_path import lexical_repo_path
from .impact_graph import ProjectMap, project_for_path

# The stamp a mint writes beside ``services``: the stored names were
# attributed by `impact_graph.project_for_path` over `impact_graph.project_map`.
SERVICE_VOCABULARY = "nx_project/v1"

# The fingerprint (`ProjectMap.fingerprint`) of the map a stamped row was
# attributed against.
SERVICE_MAP_FINGERPRINT = "service_map_fingerprint"


def _require_project_map(project_roots: object) -> ProjectMap:
    """``project_roots`` itself, refused unless it is a `ProjectMap`.

    SE-1-R2 appellate R1 (a): a stamp is only as trustworthy as the identity
    of the map it names. A plain mapping names no map, so it can neither
    stamp a row nor be compared with one; the round-2 code stamped nothing
    for it and then read every fingerprint-less stamp as current (None ==
    None).
    """
    if not isinstance(project_roots, ProjectMap):
        raise TypeError(
            "service attribution takes an impact_graph.ProjectMap (from impact_graph.project_map), "
            f"got {type(project_roots).__name__}"
        )
    return project_roots


def _attributed(paths: Iterable[object], project_roots: ProjectMap) -> list[str]:
    """Sorted unique nx projects a path set lies in (unattributable paths drop out)."""
    return sorted(
        {
            project
            for project in (
                project_for_path(path, project_roots) for path in paths if isinstance(path, str)
            )
            if project is not None
        }
    )


def finding_service_fields(paths: Iterable[object], project_roots: ProjectMap) -> dict[str, Any]:
    """The dimension fields a mint writes for a finding citing ``paths``.

    ``services`` always, ``service`` only when the finding is unambiguously
    single-service: a multi-service finding deliberately has
    ``service=None`` — collapsing it to the first entry would misfile
    cross-service defects. ``service_vocabulary`` marks the names as
    attributed by the one owner, and ``service_map_fingerprint`` names the
    map they belong to, so a reader can tell a current stamp from one a
    later rename made stale.

    There is no "no map" input: a store that cannot produce one is refused
    by `impact_graph.project_map` (``service_key_map_unavailable``) before
    anything is minted, never written as an empty dimension.
    """
    project_roots = _require_project_map(project_roots)
    services = _attributed(paths, project_roots)
    return {
        "service": services[0] if len(services) == 1 else None,
        "services": services,
        "service_vocabulary": SERVICE_VOCABULARY,
        SERVICE_MAP_FINGERPRINT: project_roots.fingerprint,
    }


def services_for_finding_row(row: dict[str, Any], project_roots: ProjectMap) -> list[str]:
    """Service dimension of one finding row — THE row reader.

    ``row`` is either a findings-ledger row (the tool finding nested under
    ``finding``) or a committed finding document (its paths at top level);
    the paths come from `finding_dimension_paths` either way. A row stamped
    with `SERVICE_VOCABULARY` against the very map ``project_roots`` is (same
    ``service_map_fingerprint``) carries names the one owner attributed at
    mint and is read as stored. Any other row — a stamp of another map, or a
    stamp that names no map at all — is re-derived from its paths over
    ``project_roots``. Every filter, report and trigger reads a row's
    dimension here, so no two readers can disagree about it.
    """
    project_roots = _require_project_map(project_roots)
    stored = row.get("services")
    if (
        row.get("service_vocabulary") == SERVICE_VOCABULARY
        and row.get(SERVICE_MAP_FINGERPRINT) == project_roots.fingerprint
        and isinstance(stored, list)
    ):
        return [service for service in stored if isinstance(service, str)]
    document = row.get("finding") if isinstance(row.get("finding"), dict) else row
    return _attributed(finding_dimension_paths(document), project_roots)


def owning_agent_domains_for_paths(paths: Iterable[object]) -> list[str]:
    """Reviewing specialist agents for a path set — imported from the
    Lane-A domain touch-map SSoT, never copied."""
    from .specialist_review_runner import domain_touch_map

    touch_map = domain_touch_map()
    owners: set[str] = set()
    for path in paths:
        if not isinstance(path, str):
            continue
        clean = lexical_repo_path(path)
        for prefix, agents in touch_map.items():
            if clean.startswith(prefix):
                owners.update(agents)
    return sorted(owners)


def finding_dimension_paths(doc: dict[str, Any]) -> list[str]:
    """Every path a finding cites, across both finding shapes.

    Committed findings (aria/finding/v1) carry ``evidences[].ref`` +
    ``scope.files``; tool findings carry ``path`` and/or
    ``evidence_refs``. Read-time derivation for legacy rows uses the
    same collector as mint-time, so old and new findings can never
    disagree about their own dimension.
    """
    paths: list[str] = []
    for ev in doc.get("evidences") or []:
        if isinstance(ev, dict) and isinstance(ev.get("ref"), str):
            paths.append(ev["ref"])
    scope = doc.get("scope")
    if isinstance(scope, dict):
        paths.extend(f for f in scope.get("files") or [] if isinstance(f, str))
    if isinstance(doc.get("path"), str) and doc["path"]:
        paths.append(doc["path"])
    paths.extend(r for r in doc.get("evidence_refs") or [] if isinstance(r, str))
    return paths
