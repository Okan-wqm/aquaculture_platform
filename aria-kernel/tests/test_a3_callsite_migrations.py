"""Plan 026R §A.3 — verify the 10 callsites migrate to strict readers.

3 invariants (one test class each):

* Governance.jsonl readers (spine_orchestrator, plan_016_metrics,
  reflection) route through ``governance_reader.read_governance_rows``.
* Runs.jsonl readers (spine_orchestrator, architecture_spine_gate)
  route through ``runs_reader.latest_run_for_tool``.
* Generic-JSONL readers (context_budget_gate, agent_compliance,
  agent_eval) route through ``strict_jsonl_reader.read_strict_jsonl``.
"""
from __future__ import annotations

import unittest
from pathlib import Path


ARIA_KERNEL = Path(__file__).resolve().parent.parent / "aria_kernel"


def _src(name: str) -> str:
    return (ARIA_KERNEL / name).read_text(encoding="utf-8")


class GovernanceMigrationTests(unittest.TestCase):
    def test_governance_readers_use_read_governance_rows(self) -> None:
        # spine_orchestrator.py — latest_orchestrator_refresh
        spine = _src("spine_orchestrator.py")
        self.assertIn("from .governance_reader import read_governance_rows", spine)
        self.assertIn("read_governance_rows(gov, base_dir=root)", spine)

        # plan_016_metrics.py — _latest_unknown_count + kind-counts widget
        metrics = _src("plan_016_metrics.py")
        self.assertIn(
            "from .governance_reader import read_governance_rows", metrics,
        )
        self.assertIn(
            "read_governance_rows(governance, base_dir=tools_root)", metrics,
        )

        # reflection.py — _gate_activity_summary
        reflection = _src("reflection.py")
        self.assertIn("from .governance_reader import read_governance_rows", reflection)
        self.assertIn(
            "read_governance_rows(governance, base_dir=tools_root)", reflection,
        )


class RunsMigrationTests(unittest.TestCase):
    def test_runs_readers_use_runs_reader_latest_run_for_tool(self) -> None:
        spine = _src("spine_orchestrator.py")
        self.assertIn("from .runs_reader import latest_run_for_tool", spine)
        self.assertIn(
            "latest_run_for_tool(runs_path, tool_id=adapter_id)", spine,
        )

        gate = _src("architecture_spine_gate.py")
        self.assertIn("from .runs_reader import latest_run_for_tool", gate)
        self.assertIn(
            'latest_run_for_tool(runs_path, tool_id="security-boundary-adapter")',
            gate,
        )
        self.assertIn(
            'latest_run_for_tool(runs_path, tool_id="agent-harness-security-adapter")',
            gate,
        )


class GenericJsonlMigrationTests(unittest.TestCase):
    def test_generic_jsonl_readers_use_read_strict_jsonl(self) -> None:
        for module_name in (
            "context_budget_gate.py",
            "agent_compliance.py",
            "agent_eval.py",
        ):
            src = _src(module_name)
            self.assertIn(
                "from .strict_jsonl_reader import read_strict_jsonl",
                src,
                f"{module_name} missing strict_jsonl_reader import",
            )
            self.assertIn(
                "read_strict_jsonl(",
                src,
                f"{module_name} missing read_strict_jsonl callsite",
            )


if __name__ == "__main__":
    unittest.main()
