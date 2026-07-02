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
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel.agent_routing import (  # noqa: E402
    ROUTING_TABLE_REL,
    load_routing_table,
    recommended_agents_for_project,
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


def _repo_with_table(td: Path) -> Path:
    root = td / "repo"
    (root / ".claude" / "shared").mkdir(parents=True)
    (root / ".claude" / "shared" / "orchestrator-routing-table.md").write_text(_TABLE, encoding="utf-8")
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

    def test_missing_table_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(load_routing_table(Path(td)), [])
            self.assertTrue(ROUTING_TABLE_REL.endswith("orchestrator-routing-table.md"))


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
