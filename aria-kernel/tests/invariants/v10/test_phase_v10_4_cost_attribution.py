"""Plan ARIA-V10.4 — cost-attribution invariants.

Closes arb MED-008 (upstream invocation_role wire) + perf MED-010
(monthly shard sharding).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel import budget
from aria_kernel.tool_registry import GovernanceError


class TestV9CostInvocationRoles(unittest.TestCase):

    def test_i_v10_cost_03_roles_closed_set(self):
        self.assertIsInstance(budget.COST_INVOCATION_ROLES, frozenset)
        for required in (
            "primary_plan", "challenger_plan",
            "cross_review", "implementation",
            "judgment", "specialist",
        ):
            self.assertIn(required, budget.COST_INVOCATION_ROLES)


class TestV10RecordCostAttribution(unittest.TestCase):

    def test_basic_append_creates_shard(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = budget.record_cost_attribution(
                cycle_id="cycle-001", plan_id="plan-001",
                agent_role="primary_plan", model="claude-opus-4-7",
                input_tokens=1000, output_tokens=500,
                estimated_usd=0.25,
                pressure_source_type="orphan_finding",
                terminal_state=None,
                base_dir=tmp,
            )
            self.assertEqual(row["agent_role"], "primary_plan")
            shard_dir = Path(tmp) / "cost-attribution"
            shards = list(shard_dir.glob("*.jsonl"))
            self.assertEqual(len(shards), 1)
            self.assertRegex(shards[0].name, r"^\d{4}-\d{2}\.jsonl$")

    def test_rejects_invalid_agent_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(GovernanceError):
                budget.record_cost_attribution(
                    cycle_id="c", plan_id="p",
                    agent_role="totally_invented_role",
                    model="m", input_tokens=0, output_tokens=0,
                    estimated_usd=0, base_dir=tmp,
                )

    def test_rejects_empty_cycle_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(GovernanceError):
                budget.record_cost_attribution(
                    cycle_id="", plan_id="p",
                    agent_role="primary_plan",
                    model="m", input_tokens=0, output_tokens=0,
                    estimated_usd=0, base_dir=tmp,
                )

    def test_row_schema_canonical(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="implementation",
                model="claude-opus-4-7",
                input_tokens=2000, output_tokens=800,
                estimated_usd=0.45,
                pressure_source_type="failing_ci",
                terminal_state="IMPLEMENTATION_MERGED",
                base_dir=tmp,
            )
            for field in (
                "recorded_at", "cycle_id", "plan_id", "agent_role",
                "model", "input_tokens", "output_tokens",
                "estimated_usd", "pressure_source_type",
                "terminal_state", "schema_version",
            ):
                self.assertIn(field, row, f"row missing {field}")
            self.assertEqual(row["schema_version"], 1)


class TestV10ReadCostAttribution(unittest.TestCase):

    def test_read_returns_empty_when_no_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(budget.read_cost_attribution(base_dir=tmp), [])

    def test_read_picks_up_appended_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="primary_plan", model="m",
                input_tokens=10, output_tokens=5,
                estimated_usd=0.01, base_dir=tmp,
            )
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="challenger_plan", model="m",
                input_tokens=10, output_tokens=5,
                estimated_usd=0.02, base_dir=tmp,
            )
            rows = budget.read_cost_attribution(base_dir=tmp)
            self.assertEqual(len(rows), 2)


class TestV10Aggregate(unittest.TestCase):

    def test_aggregate_buckets_by_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="primary_plan", model="opus",
                input_tokens=100, output_tokens=50,
                estimated_usd=0.20, base_dir=tmp,
            )
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="challenger_plan", model="opus",
                input_tokens=100, output_tokens=50,
                estimated_usd=0.25, base_dir=tmp,
            )
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="implementation", model="opus",
                input_tokens=200, output_tokens=80,
                estimated_usd=0.40, base_dir=tmp,
            )
            summary = budget.aggregate_cost_attribution(base_dir=tmp)
            self.assertEqual(summary["row_count"], 3)
            self.assertAlmostEqual(summary["total_usd"], 0.85, places=2)
            self.assertAlmostEqual(
                summary["by_agent_role"]["implementation"], 0.40, places=2,
            )
            self.assertAlmostEqual(
                summary["by_agent_role"]["primary_plan"], 0.20, places=2,
            )

    def test_aggregate_buckets_by_pressure_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            budget.record_cost_attribution(
                cycle_id="c1", plan_id="p1",
                agent_role="primary_plan", model="m",
                input_tokens=10, output_tokens=5,
                estimated_usd=0.10,
                pressure_source_type="orphan_finding",
                base_dir=tmp,
            )
            budget.record_cost_attribution(
                cycle_id="c2", plan_id="p2",
                agent_role="primary_plan", model="m",
                input_tokens=10, output_tokens=5,
                estimated_usd=0.30,
                pressure_source_type="failing_ci",
                base_dir=tmp,
            )
            summary = budget.aggregate_cost_attribution(base_dir=tmp)
            self.assertAlmostEqual(
                summary["by_pressure_source"]["orphan_finding"], 0.10, places=2,
            )
            self.assertAlmostEqual(
                summary["by_pressure_source"]["failing_ci"], 0.30, places=2,
            )


if __name__ == "__main__":
    unittest.main()
