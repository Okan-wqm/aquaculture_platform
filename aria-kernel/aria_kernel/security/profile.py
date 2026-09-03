"""Plan 033 Faz 033a — the Repository Security Profile compiler.

WHY: today security knowledge about the repo lives as prose in removable Lane-B
agent Markdown. A security lane needs a MACHINE artifact: what languages,
frameworks, endpoints, auth model, tenant-isolation strategy, data classes,
secret sources, brokers and environments the repo actually has — each claim
tagged with how it was learned (OBSERVED from a file, INFERRED from a pattern,
OPERATOR_ASSERTED). The profile compiles this deterministically, content-
addresses it (repo SHA + digest), and stores a snapshot on a declared ledger.

WHAT IT IS NOT: the profile answers "what exists", never "where may I attack".
Attack authorization (targets, never_touch, budgets) is a SEPARATE signed
contract (CampaignGrant / scope policy, later phases). Nothing here grants a
pentest action; a compiled profile is inert.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now

PROFILE_SURFACE = "security_profile"
PROFILE_RELPATH: tuple[str, ...] = ("security", "profile.jsonl")
PROVENANCE = ("OBSERVED", "INFERRED", "OPERATOR_ASSERTED")
ISOLATION_STRATEGIES = ("schema_per_tenant", "row_level_security", "database_per_tenant", "hybrid", "unknown")
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Claim:
    """One profile fact + how it was learned. Never a permission."""

    key: str
    value: Any
    provenance: str
    evidence: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.provenance not in PROVENANCE:
            raise ValueError(f"unknown provenance {self.provenance!r}")


@dataclass(frozen=True)
class SecurityProfileSnapshot:
    repo_sha: str
    isolation_strategy: str
    claims: tuple[Claim, ...]
    profile_digest: str
    compiled_at: str
    schema_version: int = SCHEMA_VERSION

    def to_row(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "recorded_at": self.compiled_at,
            "repo_sha": self.repo_sha,
            "isolation_strategy": self.isolation_strategy,
            "profile_digest": self.profile_digest,
            "claims": [asdict(c) for c in self.claims],
        }

    def claim(self, key: str) -> Claim | None:
        return next((c for c in self.claims if c.key == key), None)


def _exists(root: Path, rel: str) -> bool:
    return (root / rel).exists()


def _read(root: Path, rel: str, limit: int = 200_000) -> str:
    path = root / rel
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:limit]
    except OSError:
        return ""


def _glob_any(root: Path, pattern: str, needle: str, cap: int = 400) -> list[str]:
    hits: list[str] = []
    for i, path in enumerate(sorted(root.glob(pattern))):
        if i > cap:
            break
        try:
            if needle in path.read_text(encoding="utf-8", errors="replace"):
                hits.append(path.relative_to(root).as_posix())
        except OSError:
            continue
    return hits


def _detect_frameworks(root: Path) -> list[Claim]:
    claims: list[Claim] = []
    pkg = _read(root, "package.json")
    root_pkgs = {p.name: _read(root, p.name) for p in [root / "package.json"] if p.exists()}
    combined = pkg + "".join(root_pkgs.values())
    fw_markers = {
        "nestjs": ("@nestjs/core", "NestJS"),
        "apollo_federation": ("@apollo/subgraph", "Apollo GraphQL federation"),
        "graphql": ("graphql", "GraphQL"),
        "nx": ("nx", "Nx monorepo"),
        "react": ("react-dom", "React"),
        "typeorm": ("typeorm", "TypeORM"),
    }
    present = []
    for key, (marker, label) in fw_markers.items():
        found = marker in combined or bool(_glob_any(root, "apps/*/package.json", marker, cap=60))
        if found:
            present.append(label)
            claims.append(Claim(f"framework.{key}", True, "OBSERVED", ("package.json",)))
    if _exists(root, "Cargo.toml") or _glob_any(root, "**/Cargo.toml", "edition", cap=30):
        present.append("Rust (edge)")
        claims.append(Claim("framework.rust_edge", True, "OBSERVED", ("Cargo.toml",)))
    claims.append(Claim("frameworks", present, "OBSERVED"))
    # Django check — explicitly record ABSENCE so a django-drf pack is never selected here.
    django = bool(_glob_any(root, "**/requirements*.txt", "Django", cap=40)) or _glob_any(root, "**/manage.py", "django", cap=20)
    claims.append(Claim("framework.django", bool(django), "OBSERVED"))
    return claims


def _detect_services(root: Path) -> list[Claim]:
    apps_dir = root / "apps"
    services = sorted(p.name for p in apps_dir.iterdir() if p.is_dir()) if apps_dir.is_dir() else []
    claims = [Claim("services", services, "OBSERVED", ("apps/",))]
    brokers = []
    for key, needle in (("redis", "redis"), ("nats", "nats"), ("mqtt", "mqtt"), ("postgres", "postgres")):
        if _glob_any(root, "apps/*/package.json", needle, cap=60) or needle in _read(root, "docker-compose.yml") + _read(root, "docker-compose.yaml"):
            brokers.append(key)
    claims.append(Claim("datastores_and_brokers", brokers, "INFERRED", ("apps/*/package.json", "docker-compose.yml")))
    return claims


def _detect_isolation(root: Path) -> tuple[str, list[Claim]]:
    """schema_per_tenant + RLS defense-in-depth = hybrid; RLS-only vs schema-only distinguished."""
    sql = "".join(_read(root, p.relative_to(root).as_posix()) for p in sorted((root / "apps").glob("**/*.sql"))[:200]) if (root / "apps").is_dir() else ""
    has_rls = "ROW LEVEL SECURITY" in sql.upper() or bool(_glob_any(root, "apps/**/*.sql", "ROW LEVEL SECURITY", cap=200))
    has_schema_per_tenant = bool(re.search(r"search_path|CREATE SCHEMA|MODULE_SCHEMAS", sql)) or bool(
        _glob_any(root, "apps/**/*.ts", "getScopedRepository", cap=200)) or bool(
        _glob_any(root, "apps/**/*.ts", "search_path", cap=200))
    if has_rls and has_schema_per_tenant:
        strategy = "hybrid"
    elif has_schema_per_tenant:
        strategy = "schema_per_tenant"
    elif has_rls:
        strategy = "row_level_security"
    else:
        strategy = "unknown"
    claims = [
        Claim("isolation.row_level_security", has_rls, "OBSERVED"),
        Claim("isolation.schema_per_tenant", has_schema_per_tenant, "OBSERVED"),
        Claim("isolation_strategy", strategy, "INFERRED"),
    ]
    return strategy, claims


def _detect_integrations(root: Path) -> list[Claim]:
    mcp = _exists(root, ".mcp.json")
    workflows = sorted(p.name for p in (root / ".github" / "workflows").glob("*.yml")) if (root / ".github" / "workflows").is_dir() else []
    iac = _exists(root, "infrastructure") or _exists(root, "terraform")
    return [
        Claim("mcp_configured", mcp, "OBSERVED", (".mcp.json",) if mcp else ()),
        Claim("ci_workflow_count", len(workflows), "OBSERVED", (".github/workflows/",)),
        Claim("iac_present", bool(iac), "OBSERVED"),
    ]


def _canonical_digest(claims: list[Claim], repo_sha: str, isolation: str) -> str:
    payload = {"repo_sha": repo_sha, "isolation_strategy": isolation,
               "claims": sorted(([c.key, json.dumps(c.value, sort_keys=True, default=str), c.provenance] for c in claims))}
    return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def compile_profile(*, workspace_root: str | Path, repo_sha: str | None = None) -> SecurityProfileSnapshot:
    """Deterministic, content-addressed profile of the repo. No authorization."""
    root = Path(workspace_root).resolve()
    if repo_sha is None:
        import subprocess

        try:
            repo_sha = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip() or "unknown"
        except Exception:  # noqa: BLE001
            repo_sha = "unknown"
    claims: list[Claim] = []
    claims += _detect_frameworks(root)
    claims += _detect_services(root)
    isolation, iso_claims = _detect_isolation(root)
    claims += iso_claims
    claims += _detect_integrations(root)
    digest = _canonical_digest(claims, repo_sha, isolation)
    return SecurityProfileSnapshot(
        repo_sha=repo_sha, isolation_strategy=isolation, claims=tuple(claims),
        profile_digest=digest, compiled_at=utc_now(),
    )


def record_profile(snapshot: SecurityProfileSnapshot, *, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    path = root.joinpath(*PROFILE_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, snapshot.to_row(), expected_surface=PROFILE_SURFACE)


def latest_profile(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    path = ensure_tools_dir(base_dir).joinpath(*PROFILE_RELPATH)
    if not path.exists():
        return None
    rows = load_declared_jsonl(path, expected_surface=PROFILE_SURFACE)
    return rows[-1] if rows else None


def render_profile_text(snapshot: SecurityProfileSnapshot) -> str:
    lines = [f"security profile {snapshot.profile_digest} @ {snapshot.repo_sha[:12]}",
             f"  isolation_strategy: {snapshot.isolation_strategy}"]
    for c in snapshot.claims:
        if c.key in ("frameworks", "services", "datastores_and_brokers"):
            lines.append(f"  {c.key} [{c.provenance}]: {c.value}")
    return "\n".join(lines)


__all__ = [
    "ISOLATION_STRATEGIES", "PROFILE_RELPATH", "PROFILE_SURFACE", "PROVENANCE", "Claim",
    "SecurityProfileSnapshot", "compile_profile", "latest_profile", "record_profile",
    "render_profile_text",
]
