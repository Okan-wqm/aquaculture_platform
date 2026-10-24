"""Per-service agent routing (ORPHAN-MEDIUM-260, slice 4).

The per-service examination plan recommends WHICH domain agent(s) examine each
impacted service, read from the Lane-A routing SSoT
(.claude/shared/orchestrator-routing-table.md) — the same table the orchestrator
dispatches from. A service with no primary owner is a coverage gap (an
agent-genesis candidate).
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
_REPO_ROOT = _KERNEL.parent
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel.agent_routing import (  # noqa: E402
    ROUTING_TABLE_REL,
    load_routing_table,
    owning_agents_for_paths,
    recommended_agents_for_project,
    reviewing_agents_for_paths,
    routing_domain_for_path,
)
import aria_kernel.impact_graph as ig  # noqa: E402

_TABLE = """# Routing
| File Pattern | Primary Agent | Also Notify |
|---|---|---|
| `apps/farm-service/**` | farm-expert | |
| `apps/billing-service/**` | billing-expert | multi-tenant-saas-expert, security-reviewer (revenue) |
| `libs/backend-common/src/auth/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/database/**` | data-expert | database-reviewer |
| `apps/*/src/**/entities/*.entity.ts` | {respective domain expert} | database-reviewer |
| `libs/event-contracts/**` | data-expert | *all consumers* |
"""


# The live table's cross-cutting prose rows (no code span) and a brace glob
# whose comma is part of ONE pattern, next to two ordinary glob rows.
_PROSE_AND_BRACE_TABLE = """# Routing
| File Pattern | Primary Agent | Also Notify |
|---|---|---|
| `apps/farm-service/**` | farm-expert | |
| `apps/*/src/gdpr/**` (handler implementations) | gdpr-erasure-executor | compliance-expert (review) |
| destructive action paths (cross-cutting) | legal-hold-auditor | *primary destructive handler owner* |
| every CQRS COMMAND handler audit capture | audit-trail-completeness-auditor | *respective domain expert* |
| Performance / N+1 / EXPLAIN evidence reviews (cross-cutting) | performance-expert | *primary domain expert* |
| Supply-chain CVE / license / SLSA (cross-cutting on package.json, Cargo.toml, Dockerfile) | supply-chain-auditor | infra-expert, security-reviewer |
| Memory-leak pattern reviews (cross-cutting) | memory-leak-auditor | performance-expert |
| `apps/auth-service/src/{privacy,modules/gdpr}/**` | compliance-expert | auth-security-expert |
"""


def _repo_with_table(td: Path, table: str = _TABLE) -> Path:
    root = td / "repo"
    (root / ".claude" / "shared").mkdir(parents=True)
    (root / ".claude" / "shared" / "orchestrator-routing-table.md").write_text(table, encoding="utf-8")
    return root


class RoutingParseTests(unittest.TestCase):
    def test_table_parses_and_skips_placeholders(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = _repo_with_table(Path(td))
            rows = load_routing_table(root)
            self.assertEqual(len(rows), 6)
            # the entity row's primary is a placeholder → dropped, also-notify kept
            entity_row = next(r for r in rows if r["prefixes"] == ["apps"])
            self.assertEqual(entity_row["primary"], [])
            self.assertEqual(entity_row["also_notify"], ["database-reviewer"])
            # italic ``*all consumers*`` is not an agent
            ec_row = next(r for r in rows if r["prefixes"] == ["libs/event-contracts"])
            self.assertEqual(ec_row["also_notify"], [])

    def test_only_code_span_globs_yield_prefixes(self) -> None:
        # A prose row names no path, and a comma inside a brace glob does not
        # start a second pattern; neither may surface as a path prefix.
        with tempfile.TemporaryDirectory() as td:
            root = _repo_with_table(Path(td), _PROSE_AND_BRACE_TABLE)
            rows = load_routing_table(root)
            self.assertEqual(
                [row["prefixes"] for row in rows],
                [["apps/farm-service"], ["apps"], ["apps/auth-service/src"]],
            )

    def test_missing_table_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(load_routing_table(Path(td)), [])
            self.assertTrue(ROUTING_TABLE_REL.endswith("orchestrator-routing-table.md"))


class LiveRoutingTableTests(unittest.TestCase):
    """The parser over the real SSoT table, not a fixture copy of it."""

    def test_every_live_prefix_is_a_path(self) -> None:
        rows = load_routing_table(_REPO_ROOT)
        self.assertGreater(len(rows), 40)
        prefixes = [prefix for row in rows for prefix in row["prefixes"]]
        not_paths = [
            prefix for prefix in prefixes
            if any(ch.isspace() or ch in "(){}" for ch in prefix)
        ]
        self.assertEqual(not_paths, [])
        self.assertIn("apps/farm-service", prefixes)
        self.assertIn("infrastructure", prefixes)


class RecommendTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.routing = load_routing_table(_repo_with_table(Path(self._td.name)))

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_service_maps_to_its_owner_and_also_notify(self) -> None:
        rec = recommended_agents_for_project("apps/billing-service", self.routing)
        self.assertEqual(rec["primary"], ["billing-expert"])
        self.assertIn("multi-tenant-saas-expert", rec["also_notify"])
        self.assertIn("security-reviewer", rec["also_notify"])  # parenthetical stripped

    def test_sub_area_patterns_attribute_to_the_owning_project(self) -> None:
        # backend-common owns both an auth sub-area and a database sub-area
        rec = recommended_agents_for_project("libs/backend-common", self.routing)
        self.assertEqual(rec["primary"], ["auth-security-expert", "data-expert"])

    def test_unowned_project_is_a_coverage_gap(self) -> None:
        rec = recommended_agents_for_project("apps/mystery-service", self.routing)
        self.assertEqual(rec["primary"], [])


class ReviewingAgentsForPathsTests(unittest.TestCase):
    """SE-2 — the one path -> reviewing agents answer (moved here from
    service_dimension.owning_agent_domains_for_paths)."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.routing = load_routing_table(_repo_with_table(Path(self._td.name)))

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_a_file_gets_its_owning_rows_primary_and_also_notify(self) -> None:
        self.assertEqual(
            reviewing_agents_for_paths(["apps/billing-service/src/invoice.ts"], self.routing),
            ["billing-expert", "database-reviewer", "multi-tenant-saas-expert", "security-reviewer"])

    def test_the_union_over_paths_and_line_refs(self) -> None:
        agents = reviewing_agents_for_paths(
            ["./apps/farm-service/src/batch.ts:12", "libs/backend-common/src/auth/jwt.ts"], self.routing)
        self.assertIn("farm-expert", agents)
        self.assertIn("auth-security-expert", agents)

    def test_a_path_no_row_reaches_names_no_agent(self) -> None:
        self.assertEqual(reviewing_agents_for_paths(["cycle/c-1", "docs/x.md"], self.routing), [])

    def test_a_dot_prefixed_path_keeps_its_dot(self) -> None:
        # The normalizer strips ``./`` and never the dot of ``.github``.
        routing = [{"prefixes": [".github/workflows"], "primary": ["infra-expert"], "also_notify": []}]
        self.assertEqual(reviewing_agents_for_paths(["./.github/workflows/x.yml"], routing), ["infra-expert"])

    def test_the_live_table_routes_a_farm_file_to_farm_expert(self) -> None:
        self.assertIn("farm-expert", reviewing_agents_for_paths(
            ["apps/farm-service/src/batch/batch.service.ts"], load_routing_table(_REPO_ROOT)))

    def test_the_domain_of_a_path_is_its_most_specific_owning_prefix(self) -> None:
        self.assertEqual(routing_domain_for_path("apps/farm-service/src/x.ts", self.routing), "apps/farm-service")
        self.assertEqual(routing_domain_for_path("libs/backend-common/src/auth/a.ts", self.routing),
                         "libs/backend-common/src/auth")
        self.assertIsNone(routing_domain_for_path("docs/x.md", self.routing))


class OwningAgentsForPathsTests(unittest.TestCase):
    """SE-2-C B1 — a path's owners are the primaries of the rows that claim the
    whole subtree it sits in. A row whose glob a wildcard cuts earlier
    (``apps/*/src/gdpr/**``, a brace group) reaches only some paths under its
    prefix, so it reviews the path but does not own it."""

    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.routing = load_routing_table(_repo_with_table(Path(self._td.name), _PROSE_AND_BRACE_TABLE))

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_a_service_file_is_owned_by_its_service_row_only(self) -> None:
        path = "apps/farm-service/src/batch.ts"
        self.assertEqual(owning_agents_for_paths([path], self.routing), ["farm-expert"])
        self.assertIn("gdpr-erasure-executor", reviewing_agents_for_paths([path], self.routing))

    def test_a_wildcard_or_brace_row_owns_nothing(self) -> None:
        self.assertEqual(owning_agents_for_paths(
            ["apps/auth-service/src/privacy/p.ts", "apps/hr-service/src/gdpr/h.ts"], self.routing), [])

    def test_a_directory_and_a_line_ref_resolve_to_the_same_owner(self) -> None:
        self.assertEqual(owning_agents_for_paths(
            ["apps/farm-service/", "./apps/farm-service/src/a.ts:3"], self.routing), ["farm-expert"])


class ExaminationIntegrationTests(unittest.TestCase):
    def test_examination_carries_recommended_agents_and_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _repo_with_table(tdp)
            # two real projects; farm-service is owned, ghost-lib is not
            (root / "apps" / "farm-service" / "src").mkdir(parents=True)
            (root / "apps" / "farm-service" / "package.json").write_text("{}", encoding="utf-8")
            (root / "apps" / "farm-service" / "src" / "m.ts").write_text("export const a=1;", encoding="utf-8")
            (root / "libs" / "ghost-lib" / "src").mkdir(parents=True)
            (root / "libs" / "ghost-lib" / "package.json").write_text("{}", encoding="utf-8")
            (root / "libs" / "ghost-lib" / "src" / "g.ts").write_text("export const b=1;", encoding="utf-8")
            ex = ig.cycle_service_examination(
                workspace_root=root, base_dir=tdp / "tools",
                changed_files=["apps/farm-service/src/m.ts", "libs/ghost-lib/src/g.ts"],
            )
            by = {e["project"]: e for e in ex["examination_order"]}
            self.assertEqual(by["farm-service"]["recommended_agents"]["primary"], ["farm-expert"])
            self.assertEqual(by["ghost-lib"]["recommended_agents"]["primary"], [])
            self.assertIn("ghost-lib", ex["agent_coverage_gaps"])
            self.assertNotIn("farm-service", ex["agent_coverage_gaps"])


if __name__ == "__main__":
    unittest.main()
