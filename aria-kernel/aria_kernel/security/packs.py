"""Plan 033 Faz 033b — kernel-owned security packs (repo-adaptive, passive).

WHY: security expertise today lives in removable Lane-B agent Markdown. A pack is
ARIA's OWN, kernel-owned bundle of deterministic rules that runs passively over the
repo tree and emits UNVERIFIED leads (never canonical findings — those need active
reproduction later). Packs are selected from the compiled SecurityProfile, so a repo
without a given surface never runs an inapplicable pack.

WHAT: closed pack names (`api`, `multi_tenant`); each pack is a set of `PackRule`s
with an applicability predicate over the profile and a bounded static `run`. Two
native rules fill gaps ARIA lacked (agent audit 2026-09-03): an RLS-coverage prover
(no such prover existed) and a NestJS public-write guard check. Leads flow to the
existing `runtime_signal_bridge` as `external_scanner` — no new finding authority.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

PACK_NAMES = ("api", "multi_tenant")
# tenant-scoped tables that legitimately do NOT carry a per-row policy (schema-per-tenant
# isolation or shared reference data) — agent audit: identity/Timescale exceptions.
RLS_EXCEPTION_TABLES = ("schema_migrations", "typeorm_metadata", "tenants", "users", "identities")
_TABLE_RE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"']?([A-Za-z0-9_.]+)", re.I)
_TENANT_COL_RE = re.compile(r"\btenant_id\b", re.I)
_WRITE_DECORATOR_RE = re.compile(r"@(Post|Put|Patch|Delete|Mutation)\b")
_GUARD_RE = re.compile(r"@(UseGuards|Roles|RequirePermissions|Public)\b")


@dataclass(frozen=True)
class Lead:
    rule_id: str
    severity: str
    summary: str
    code_refs: tuple[str, ...]


@dataclass(frozen=True)
class PackRule:
    rule_id: str
    severity: str
    applies_when: Callable[[dict[str, Any]], bool]
    run: Callable[[Path], list[Lead]]


def _iter_files(root: Path, pattern: str, cap: int = 400) -> list[Path]:
    return list(itertools.islice(root.glob(pattern), cap))


def _profile_claim(profile_row: dict[str, Any], key: str) -> Any:
    for c in profile_row.get("claims", []):
        if c.get("key") == key:
            return c.get("value")
    return None


# ---- native rule: RLS coverage prover (multi_tenant) ----
def _rule_rls_coverage(root: Path) -> list[Lead]:
    leads: list[Lead] = []
    for path in _iter_files(root, "apps/**/*.sql", cap=300):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:400_000]
        except OSError:
            continue
        upper = text.upper()
        # per CREATE TABLE with a tenant_id column, require a policy/RLS enablement in the same file
        for m in _TABLE_RE.finditer(text):
            table = m.group(1).split(".")[-1].lower()
            block = text[m.start(): m.start() + 4000]
            if not _TENANT_COL_RE.search(block):
                continue
            if table in RLS_EXCEPTION_TABLES:
                continue
            if "ROW LEVEL SECURITY" in upper or "CREATE POLICY" in upper:
                continue
            leads.append(Lead(
                "rls_coverage.tenant_table_without_policy", "high",
                f"tenant-scoped table {table!r} has a tenant_id column but no RLS policy in {path.name}",
                (path.relative_to(root).as_posix(),),
            ))
    return leads


# ---- native rule: NestJS public write without guard (api) ----
def _rule_public_write_guard(root: Path) -> list[Lead]:
    leads: list[Lead] = []
    for path in itertools.chain(_iter_files(root, "apps/**/*.controller.ts", cap=300),
                                _iter_files(root, "apps/**/*.resolver.ts", cap=300)):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:400_000]
        except OSError:
            continue
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if _WRITE_DECORATOR_RE.search(line):
                window = "\n".join(lines[max(0, i - 6): i + 2])
                if not _GUARD_RE.search(window):
                    leads.append(Lead(
                        "public_write_guard.write_without_guard", "high",
                        f"write endpoint at {path.name}:{i + 1} has no guard/roles decorator in scope",
                        (f"{path.relative_to(root).as_posix()}:{i + 1}",),
                    ))
    return leads


PACK_RULES: dict[str, tuple[PackRule, ...]] = {
    "multi_tenant": (
        PackRule("rls_coverage", "high",
                 lambda p: _profile_claim(p, "isolation_strategy") in ("row_level_security", "hybrid"),
                 _rule_rls_coverage),
    ),
    "api": (
        PackRule("public_write_guard", "high",
                 lambda p: bool(_profile_claim(p, "framework.nestjs")),
                 _rule_public_write_guard),
    ),
}


@dataclass(frozen=True)
class PackManifest:
    name: str
    rule_ids: tuple[str, ...]
    digest: str
    applicable: bool
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "rule_ids": list(self.rule_ids), "digest": self.digest, "applicable": self.applicable, **self.extra}


def _pack_digest(name: str, rules: tuple[PackRule, ...]) -> str:
    payload = {"name": name, "rules": [[r.rule_id, r.severity] for r in rules]}
    return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:24]


def select_packs(profile_row: dict[str, Any]) -> list[PackManifest]:
    """Which packs apply to this repo, from its profile. Closed name set."""
    out: list[PackManifest] = []
    for name in PACK_NAMES:
        rules = PACK_RULES.get(name, ())
        applicable = any(r.applies_when(profile_row) for r in rules)
        out.append(PackManifest(name=name, rule_ids=tuple(r.rule_id for r in rules),
                                digest=_pack_digest(name, rules), applicable=applicable))
    return out


def run_pack(name: str, *, workspace_root: str | Path, profile_row: dict[str, Any]) -> list[Lead]:
    """Run every applicable rule of a pack. Passive; returns UNVERIFIED leads."""
    if name not in PACK_NAMES:
        raise ValueError(f"unknown pack {name!r}; closed set is {PACK_NAMES}")
    root = Path(workspace_root).resolve()
    leads: list[Lead] = []
    for rule in PACK_RULES.get(name, ()):
        if rule.applies_when(profile_row):
            leads.extend(rule.run(root))
    return leads


def record_pack_leads(name: str, leads: list[Lead], *, service: str, base_dir: str | Path | None) -> list[dict[str, Any]]:
    """Emit leads to the existing external_scanner signal lane — UNVERIFIED, not canonical."""
    from ..runtime_signal_bridge import ingest_runtime_signal

    rows = []
    for lead in leads:
        rows.append(ingest_runtime_signal(
            source="external_scanner", service=service,
            summary=f"[{name}/{lead.rule_id}] {lead.summary}"[:300],
            code_refs=list(lead.code_refs), severity=lead.severity, base_dir=base_dir,
        ))
    return rows


__all__ = [
    "PACK_NAMES", "PACK_RULES", "RLS_EXCEPTION_TABLES", "Lead", "PackManifest", "PackRule",
    "record_pack_leads", "run_pack", "select_packs",
]
