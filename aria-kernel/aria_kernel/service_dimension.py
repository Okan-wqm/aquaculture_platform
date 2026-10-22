"""The service dimension of a finding (E15-a, operator direction 2026-08-13).

WHY: findings were organised by TOOL (which adapter fired), never by
SERVICE (which microservice is sick). Per-service audits, service agents
and mission linkage all need a finding to carry its service axis.

WHAT: the axis is the nx project key. A path is attributed by
`impact_graph.project_for_path` — the kernel's ONE path -> project
function — over the ``project_roots`` map of the impact cache
(`impact_graph.cached_project_roots` for a caller holding the workspace,
`impact_graph.published_project_roots` for one holding only a store), so a finding is filed under the
same names the impacted set, missions and routing use. This module owns
only the FINDING side of that: which paths a finding cites
(`finding_dimension_paths`), the fields a mint writes
(`finding_service_fields`), and the one row reader
(`services_for_finding_row`).

Until SE-1 (service-expertise plan, owner decision Q9) this module also
attributed paths itself, in a string vocabulary (``apps/<dir>``,
``shared:<lib>``, ``web:<app>``) that could not produce 54 of the
repository's 71 nx names and merged ``libs/X`` with ``platform/libs/X``.
That second implementation is gone. A row minted under the nx key says so
(``service_vocabulary: "nx_project/v1"``); a row without that stamp —
every row minted before SE-1 — is re-derived from its own paths when it
is read. Its stored ``services`` are not trusted and not translated: a
string mapping from the old names would carry the merge forward.

The specialist ownership map is NOT copied here — it is imported from
``specialist_review_runner`` (the Lane-A touch-map SSoT) to name the
reviewing agents for a path set.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

from .canonical_path import lexical_repo_path
from .impact_graph import project_for_path

# The stamp a mint writes beside ``services``: the stored names were
# attributed by `impact_graph.project_for_path` over the published map.
SERVICE_VOCABULARY = "nx_project/v1"


def _attributed(paths: Iterable[object], project_roots: Mapping[str, str]) -> list[str]:
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


def finding_service_fields(
    paths: Iterable[object], project_roots: Mapping[str, str] | None
) -> dict[str, Any]:
    """The dimension fields a mint writes for a finding citing ``paths``.

    ``services`` always, ``service`` only when the finding is unambiguously
    single-service: a multi-service finding deliberately has
    ``service=None`` — collapsing it to the first entry would misfile
    cross-service defects. ``service_vocabulary`` marks the names as
    attributed by the one owner.

    ``project_roots=None`` is a store with no map to attribute against
    (`impact_graph.published_project_roots`): the mint writes NO dimension
    rather than an empty one stamped as measured, and the row reader
    derives it from the row's paths once a map exists.
    """
    if project_roots is None:
        return {}
    services = _attributed(paths, project_roots)
    return {
        "service": services[0] if len(services) == 1 else None,
        "services": services,
        "service_vocabulary": SERVICE_VOCABULARY,
    }


def services_for_finding_row(
    row: dict[str, Any], project_roots: Mapping[str, str] | None
) -> list[str]:
    """Service dimension of one finding row — THE row reader.

    ``row`` is either a findings-ledger row (the tool finding nested under
    ``finding``) or a committed finding document (its paths at top level);
    the paths come from `finding_dimension_paths` either way. A row stamped
    with `SERVICE_VOCABULARY` carries names the one owner attributed at mint
    and is read as stored. Any other row is re-derived from its paths over
    ``project_roots`` (None: no map, so nothing is attributable yet). Every
    filter, report and trigger reads a row's dimension here, so no two
    readers can disagree about it.
    """
    stored = row.get("services")
    if row.get("service_vocabulary") == SERVICE_VOCABULARY and isinstance(stored, list):
        return [service for service in stored if isinstance(service, str)]
    if project_roots is None:
        return []
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
