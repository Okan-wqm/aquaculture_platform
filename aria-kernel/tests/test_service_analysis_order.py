"""Per-service impact-graph analysis order (ORPHAN-MEDIUM-257).

discovery scans the whole repo once; the examination stage should then walk
services in DEPENDENCY (topological) order so a downstream service is analysed
with its upstream already understood and an upstream change's ripple reaches its
dependents. These invariants lock the order's correctness.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel.impact_graph import (  # noqa: E402
    build_service_analysis_order,
    plan_service_analysis_order,
)


def _is_topological(plan: dict) -> bool:
    pos = {e["project"]: i for i, e in enumerate(plan["order"])}
    return all(pos[d] < pos[e["project"]] for e in plan["order"] for d in e["depends_on"])


class BuildOrderTests(unittest.TestCase):
    GRAPH = {
        "graph_source": "test",
        "dependencies": {
            "event-bus": [],
            "backend-common": ["event-bus"],
            "farm-service": ["backend-common", "event-bus"],
            "alert-service": ["farm-service", "backend-common"],
            "web-dashboard": ["farm-service"],
        },
    }

    def test_order_is_valid_topological_and_complete(self) -> None:
        plan = build_service_analysis_order(self.GRAPH)
        self.assertEqual(plan["project_count"], 5)
        self.assertEqual(len(plan["order"]), 5)
        self.assertTrue(_is_topological(plan), "a project appears before one of its deps")
        # foundational first, downstream last
        order = [e["project"] for e in plan["order"]]
        self.assertEqual(order[0], "event-bus")
        self.assertLess(order.index("backend-common"), order.index("farm-service"))

    def test_dependents_ripple_is_recorded(self) -> None:
        plan = build_service_analysis_order(self.GRAPH)
        by = {e["project"]: e for e in plan["order"]}
        self.assertIn("farm-service", by["backend-common"]["dependents"])
        self.assertIn("alert-service", by["farm-service"]["dependents"])
        self.assertEqual(by["alert-service"]["dependents"], [])

    def test_deterministic(self) -> None:
        a = build_service_analysis_order(self.GRAPH)
        b = build_service_analysis_order(self.GRAPH)
        self.assertEqual(a, b)

    def test_cycle_is_broken_into_a_total_stable_order(self) -> None:
        plan = build_service_analysis_order(
            {"graph_source": "t", "dependencies": {"a": ["b"], "b": ["a"], "c": ["a"]}}
        )
        self.assertEqual(plan["project_count"], 3)
        self.assertEqual(len(plan["order"]), 3)
        self.assertTrue(plan["cycle_broken_projects"], "cycle was not recorded")

    def test_self_edges_and_unknown_deps_ignored(self) -> None:
        plan = build_service_analysis_order(
            {"graph_source": "t", "dependencies": {"x": ["x", "ghost"], "y": ["x"]}}
        )
        by = {e["project"]: e for e in plan["order"]}
        self.assertEqual(by["x"]["depends_on"], [])
        self.assertEqual(by["y"]["depends_on"], ["x"])


class PlanFromRepoTests(unittest.TestCase):
    def test_plan_orders_real_project_layout_and_annotates_changes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "libs" / "shared" / "src").mkdir(parents=True)
            (root / "libs" / "shared" / "package.json").write_text('{"name":"shared"}\n', encoding="utf-8")
            (root / "libs" / "shared" / "src" / "index.ts").write_text("export const x = 1;\n", encoding="utf-8")
            (root / "apps" / "svc" / "src").mkdir(parents=True)
            (root / "apps" / "svc" / "package.json").write_text('{"name":"svc"}\n', encoding="utf-8")
            # svc imports libs/shared → dependency edge svc -> shared
            (root / "apps" / "svc" / "src" / "main.ts").write_text(
                "import { x } from 'libs/shared/src/index';\n", encoding="utf-8"
            )

            plan = plan_service_analysis_order(
                workspace_root=root,
                changed_files=["libs/shared/src/index.ts"],
            )
            order = [e["project"] for e in plan["order"]]
            self.assertIn("shared", order)
            self.assertIn("svc", order)
            # shared is upstream → examined BEFORE svc
            self.assertLess(order.index("shared"), order.index("svc"))
            by = {e["project"]: e for e in plan["order"]}
            self.assertIn("svc", by["shared"]["dependents"])  # ripple
            self.assertEqual(by["shared"]["changed_files"], 1)
            # the change in shared ripples to its dependent svc
            self.assertIn("svc", plan["impacted_projects"])


if __name__ == "__main__":
    unittest.main()
