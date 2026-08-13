"""E15-a — the service dimension of a finding (operator direction 2026-08-13).

WHY: findings were organised by TOOL (which adapter fired), never by
SERVICE (which microservice is sick). The operator runs a 17-service
platform and wants per-service audits, service-specific agents and
mission linkage — none of which can exist while the finding itself
carries no service axis. This module is the single derivation seam:
every writer (tool-finding mint, committed-finding emission) and every
reader (list filters, daily-report grouping) derives the dimension HERE,
so the mapping can never fork.

WHAT: a repo-relative path names a service when it lives under
``apps/<service>/``; a shared library surfaces as ``shared:<lib>``
(``libs/<lib>/`` or ``platform/libs/<lib>/``); web surfaces as
``web:<module>`` (``web/modules/<m>/``, ``web/shell``, ``web/shared-ui``,
``web/apps/<app>``); anything else contributes no dimension. The
specialist ownership map is NOT copied here — it is imported from
``specialist_review_runner`` (the Lane-A touch-map SSoT) to name the
reviewing agents for a path set.
"""
from __future__ import annotations

from typing import Any, Iterable


def service_for_path(path: object) -> str | None:
    """Derive the service dimension of one repo-relative path.

    Line suffixes (``file.ts:42`` / ``:42-60``) are tolerated because
    finding evidence refs carry them. Absolute paths contribute nothing:
    the dimension is defined over the repo tree, and an absolute path's
    leading segments name a machine, not a service.
    """
    if not isinstance(path, str) or not path.strip():
        return None
    clean = path.replace("\\", "/").strip()
    if clean.startswith("/"):
        return None
    while clean.startswith("./"):
        clean = clean[2:]
    # Strip a trailing :line[-line] evidence suffix, never a drive colon
    # (absolute Windows paths were already rejected as absolute above).
    head, sep, tail = clean.rpartition(":")
    if sep and tail and all(ch.isdigit() or ch == "-" for ch in tail):
        clean = head
    parts = [p for p in clean.split("/") if p]
    if len(parts) >= 2 and parts[0] == "apps":
        return parts[1]
    if len(parts) >= 2 and parts[0] == "libs":
        return f"shared:{parts[1]}"
    if len(parts) >= 3 and parts[0] == "platform" and parts[1] == "libs":
        return f"shared:{parts[2]}"
    if len(parts) >= 3 and parts[0] == "web" and parts[1] == "modules":
        return f"web:{parts[2]}"
    if len(parts) >= 3 and parts[0] == "web" and parts[1] == "apps":
        return f"web:{parts[2]}"
    if len(parts) >= 2 and parts[0] == "web":
        return f"web:{parts[1]}"
    return None


def services_for_paths(paths: Iterable[object]) -> list[str]:
    """Sorted unique service dimensions across a path set."""
    found = {service_for_path(path) for path in paths}
    found.discard(None)
    return sorted(found)  # type: ignore[arg-type]


def service_dimension(paths: Iterable[object]) -> dict[str, Any]:
    """The mint-time envelope: ``services`` always, ``service`` only
    when the finding is unambiguously single-service. A multi-service
    finding deliberately has ``service=None`` — collapsing it to the
    first entry would misfile cross-service defects (the exact class
    E15's relation work later builds on)."""
    services = services_for_paths(paths)
    return {
        "service": services[0] if len(services) == 1 else None,
        "services": services,
    }


def owning_agent_domains_for_paths(paths: Iterable[object]) -> list[str]:
    """Reviewing specialist agents for a path set — imported from the
    Lane-A domain touch-map SSoT, never copied."""
    from .specialist_review_runner import domain_touch_map

    touch_map = domain_touch_map()
    owners: set[str] = set()
    for path in paths:
        if not isinstance(path, str):
            continue
        clean = path.replace("\\", "/").lstrip("./")
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
