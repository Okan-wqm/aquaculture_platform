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
``web/apps/<app>``). H-2 — EVERY OTHER SURFACE THE REPOSITORY OWNS is
named from the routing SSoT instead of being dropped: the same
``.claude/shared/orchestrator-routing-table.md`` the orchestrator
dispatches from, parsed by ``agent_routing.load_routing_table`` (which
CI already forces to cover every top-level surface, via
``tests/invariants/orchestrator-routing-coverage.spec.ts``), plus
``implementation_safety.READONLY_PATHS`` for the kernel/governance
surface the product implementation lane is forbidden to touch. Before
H-2 those 2,600+ files — ``sens-api-gateway/`` (450), ``aria-kernel/``
(802), ``tests/`` (261), ``infrastructure/`` (166), ``infra/`` (122),
``e2e/`` (102), ``scripts/`` (98), ``mcp/`` (65) — returned None and
vanished from prioritisation, service missions and the fitness charter.
A path that matches NOTHING still returns None, but that residue is now
measurable through ``unmapped_surfaces`` rather than silent.

THE VOCABULARY IS ONE, NOT TWO. A colon-free dimension names a product
microservice under ``apps/`` and nothing else; every routing-derived or
kernel surface carries a ``<kind>:`` prefix, so ``is_product_service``
is the single test an implementation lane needs to ask before targeting
a dimension — and a kernel-pathed finding can never answer yes.

The specialist ownership map is NOT copied here — it is imported from
``specialist_review_runner`` (the Lane-A touch-map SSoT) to name the
reviewing agents for a path set.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

# Every routing-derived surface is ``<kind>:<name>``; a product microservice
# under ``apps/`` is the ONLY dimension without one. Consumers that may only
# act on a product service (``experiment_author`` builds an ``nx`` command out
# of the dimension) ask ``is_product_service`` rather than re-deriving the rule
# from a list of known prefixes — a list is exactly what goes stale when a new
# surface kind appears.
DIMENSION_KIND_SEPARATOR = ":"

# The kind for surfaces named by ``implementation_safety.READONLY_PATHS`` —
# the closed set the product implementation lane is forbidden to mutate
# (I-V9-IMPL-04). Their dimension exists so kernel findings are counted and
# prioritised, and carries a kind so they can never be mistaken for a product
# service to run an nx target against.
KERNEL_SURFACE_KIND = "kernel"

# Agent names encode a role suffix; the surface kind is the agent minus its
# role (``edge-expert`` → ``edge``, ``test-runner`` → ``test``). Derived, not
# tabulated, so a new owner in the routing table needs no second registration
# here to name its surface.
_AGENT_ROLE_SUFFIXES = (
    "-expert",
    "-auditor",
    "-reviewer",
    "-runner",
    "-writer",
    "-manager",
    "-arbiter",
    "-executor",
    "-enforcer",
    "-planner",
    "-orchestrator",
)

# The File Pattern column also carries prose rows (``destructive action paths
# (cross-cutting)``) that name a review trigger, not a path. A surface literal
# is a path literal.
_SURFACE_PREFIX_RE = re.compile(r"^[A-Za-z0-9._@/-]+$")


def _default_repo_root() -> Path:
    """The checkout this kernel is running out of — the tree whose routing
    table describes the paths its findings cite. A worktree gets its own
    ``__file__`` and therefore its own table."""
    return Path(__file__).resolve().parents[2]


def _kind_for_agent(agent: str) -> str:
    """The surface kind an owning agent names (``edge-expert`` -> ``edge``)."""
    for suffix in _AGENT_ROLE_SUFFIXES:
        if agent.endswith(suffix) and len(agent) > len(suffix):
            return agent[: -len(suffix)]
    return agent


def _surface_name(prefix: str) -> str:
    """The readable half of the dimension: the last segment of the surface
    literal (``infrastructure/monitoring`` -> ``monitoring``;
    ``aria-kernel/aria_kernel`` -> ``aria_kernel``). Trailing punctuation left
    by a glob literal (``jest.config.*`` -> ``jest.config.``) is dropped."""
    name = prefix.rstrip("/").rsplit("/", 1)[-1].rstrip(".-")
    return name or prefix


@lru_cache(maxsize=8)
def _surface_index(repo_root: str) -> tuple[tuple[str, str, str], ...]:
    """``(literal, match mode, dimension)`` for every surface the repository's
    own SSoTs name, LONGEST LITERAL FIRST so the most specific owner wins
    (``infrastructure/monitoring`` beats ``infrastructure``).

    Two sources, no third vocabulary:

    * the Lane-A routing table — the map CI already forces to cover every
      top-level surface (``orchestrator-routing-coverage.spec.ts``), read
      through ``agent_routing`` so this module never parses a glob itself;
    * ``implementation_safety.READONLY_PATHS`` — the closed set the product
      implementation lane may not mutate, which is where ``aria-kernel/`` and
      the rest of the governance surface are named. The routing table
      describes who REVIEWS a path; READONLY_PATHS describes what the
      implementer may not TOUCH. A path named by both is named by the
      routing table (it has an owner; readonly only knows a prohibition).

    Cached per checkout: this runs once per path set, not once per path, and
    the table is a repository file that changes at commit granularity.
    """
    from .agent_routing import load_routing_table, pattern_surface

    surfaces: dict[str, tuple[str, str]] = {}

    def offer(literal: str, mode: str, dimension: str) -> None:
        if not literal or not _SURFACE_PREFIX_RE.match(literal):
            return
        surfaces.setdefault(literal, (mode, dimension))

    for row in load_routing_table(repo_root):
        primary = row.get("primary") or []
        if not primary:
            # An also-notify-only row (``{respective domain expert}``) names
            # no owner, so it cannot name a surface either.
            continue
        kind = _kind_for_agent(primary[0])
        for glob in row.get("globs") or []:
            literal, mode = pattern_surface(glob)
            offer(
                literal,
                mode,
                f"{kind}{DIMENSION_KIND_SEPARATOR}{_surface_name(literal)}",
            )

    from .implementation_safety import READONLY_PATHS

    for entry in READONLY_PATHS:
        literal = entry.rstrip("/")
        mode = "dir" if entry.endswith("/") else "exact"
        offer(
            literal,
            mode,
            f"{KERNEL_SURFACE_KIND}{DIMENSION_KIND_SEPARATOR}{_surface_name(literal)}",
        )

    ordered = sorted(surfaces.items(), key=lambda item: (-len(item[0]), item[0]))
    return tuple((literal, mode, dimension) for literal, (mode, dimension) in ordered)


def _surface_match(literal: str, mode: str, path: str) -> bool:
    """Does ``path`` belong to the surface ``literal`` names, under the match
    mode its glob declared? ``stem`` matches a SIBLING FILE only — raw string
    prefixing would let ``infra`` claim ``infrastructure/nats/nats.conf``."""
    if mode == "exact":
        return path == literal
    if path == literal or path.startswith(literal + "/"):
        return True
    if mode == "stem":
        head, _, stem = literal.rpartition("/")
        path_head, _, name = path.rpartition("/")
        return head == path_head and name.startswith(stem)
    return False


def _normalized_repo_path(path: object) -> str | None:
    """The repo-relative path a dimension is defined over, or None.

    Line suffixes (``file.ts:42`` / ``:42-60``) are tolerated because finding
    evidence refs carry them. Absolute paths contribute nothing: the dimension
    is defined over the repo tree, and an absolute path's leading segments
    name a machine, not a service.
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
    clean = clean.strip("/")
    return clean or None


def is_product_service(dimension: object) -> bool:
    """Does this dimension name a product microservice under ``apps/``?

    THE test for "may an implementation lane act on this dimension" — the
    only dimensions without a ``<kind>:`` prefix are ``apps/<service>``
    names, so a kernel, infrastructure, test or edge surface can never be
    handed to a product target by a caller that asks here instead of
    listing the prefixes it happens to know about.
    """
    return (
        isinstance(dimension, str)
        and bool(dimension.strip())
        and DIMENSION_KIND_SEPARATOR not in dimension
    )


def service_for_path(
    path: object, *, repo_root: str | Path | None = None
) -> str | None:
    """Derive the service dimension of one repo-relative path.

    The product vocabulary (``apps``/``libs``/``platform/libs``/``web``) is
    answered FIRST and unchanged — those names are consumed as ledger filter
    values and experiment targets, so they are byte-identical by
    construction, not by coincidence. Everything else is named from the
    repository's own surface SSoTs (see ``_surface_index``); a path no SSoT
    names still returns None, and ``unmapped_surfaces`` reports it.
    """
    clean = _normalized_repo_path(path)
    if clean is None:
        return None
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
    root = str(Path(repo_root) if repo_root is not None else _default_repo_root())
    for literal, mode, dimension in _surface_index(root):
        if _surface_match(literal, mode, clean):
            return dimension
    return None


def services_for_paths(
    paths: Iterable[object], *, repo_root: str | Path | None = None
) -> list[str]:
    """Sorted unique service dimensions across a path set."""
    found = {service_for_path(path, repo_root=repo_root) for path in paths}
    found.discard(None)
    return sorted(found)  # type: ignore[arg-type]


def unmapped_surfaces(
    paths: Iterable[object], *, repo_root: str | Path | None = None
) -> list[str]:
    """The top-level surfaces in ``paths`` that NO SSoT names — the residue
    behind every remaining None, as data.

    H-2: dropping a path used to be indistinguishable from a path that had no
    dimension to begin with. A surface listed here is a routing-table coverage
    gap (``crates/`` is the live example: 153 tracked files, no row in the
    routing table and no entry in that spec's REQUIRED_SURFACES), and the fix
    is a routing row — not a second vocabulary here.
    """
    residue: set[str] = set()
    for path in paths:
        clean = _normalized_repo_path(path)
        if clean is None:
            continue
        if service_for_path(clean, repo_root=repo_root) is not None:
            continue
        residue.add(clean.split("/")[0])
    return sorted(residue)


def service_dimension(
    paths: Iterable[object], *, repo_root: str | Path | None = None
) -> dict[str, Any]:
    """The mint-time envelope: ``services`` always, ``service`` only
    when the finding is unambiguously single-service. A multi-service
    finding deliberately has ``service=None`` — collapsing it to the
    first entry would misfile cross-service defects (the exact class
    E15's relation work later builds on). ``unmapped_surfaces`` carries the
    residue, so an unnamed surface is a reading rather than a silence.

    ``paths`` is walked ONCE — the named half and the residue come out of the
    same pass, so passing a generator cannot leave one of them empty."""
    named: set[str] = set()
    residue: set[str] = set()
    for path in paths:
        clean = _normalized_repo_path(path)
        if clean is None:
            continue
        dimension = service_for_path(clean, repo_root=repo_root)
        if dimension is None:
            residue.add(clean.split("/")[0])
        else:
            named.add(dimension)
    services = sorted(named)
    return {
        "service": services[0] if len(services) == 1 else None,
        "services": services,
        "unmapped_surfaces": sorted(residue),
    }


def services_for_finding_row(row: dict[str, Any]) -> list[str]:
    """Service dimensions of one findings-ledger row.

    E15-c extracted this from ``feedback_store.list_findings`` so the
    list filter and the service-auditor targeting trigger share ONE
    reading of a row's dimension: stored mint-time ``services`` when
    present, read-time derivation for legacy rows via the same collector
    mint-time uses — old and new rows can never disagree, and neither
    can two readers.
    """
    stored = row.get("services")
    if isinstance(stored, list) and stored:
        return [service for service in stored if isinstance(service, str)]
    return services_for_paths(finding_dimension_paths(row.get("finding") or {}))


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
