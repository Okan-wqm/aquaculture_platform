"""Quarantine prices the TOOL; an environment fault says nothing about one.

On 2026-08-10 the first registry-synced cycle ran six adapters into a
workspace with no node dependencies. The runner refused each one — correctly
— but recorded the refusal as `tool_unhealthy`, and `evaluate_health`
quarantines on that status unconditionally. Six tools were quarantined for a
fault that was the harness's, with `duration_ms=0`: the tools never executed.
The requeue counter's defect (ORPHAN-HIGH-605), one layer up.

The refusal now carries its own status, `environment_unavailable` (two
failures, two names — MISSION_SPEC M-2.5), and the quarantine trigger
deliberately ignores it. Repetition still escalates: the strip lands in the
uncertainty ledger, and `uncertainty_repeat` reads that back.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel.tool_health import RUN_STATUSES, immediate_quarantine_reason


def _run(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "read_paths": [],
        "evidence_validation": {},
        "runner": {},
    }


class EnvironmentFaultIsNotToolGuiltTest(unittest.TestCase):
    def test_the_status_exists_in_the_vocabulary(self) -> None:
        self.assertIn("environment_unavailable", RUN_STATUSES)

    def test_environment_unavailable_does_not_quarantine(self) -> None:
        tool = {"declared_scope": ["apps/**"]}

        self.assertIsNone(
            immediate_quarantine_reason(tool, _run("environment_unavailable"))
        )

    def test_tool_unhealthy_still_quarantines(self) -> None:
        # The guard this change must not weaken: a genuinely unhealthy tool
        # run still trips the trigger.
        tool = {"declared_scope": ["apps/**"]}

        self.assertEqual(
            immediate_quarantine_reason(tool, _run("tool_unhealthy")),
            "tool runner unhealthy",
        )

    def test_the_runner_emits_the_environment_status_for_missing_deps(self) -> None:
        # Pin the producer: the missing-node-deps branch must mint the
        # environment status, not tool guilt. Asserted on the AST so a
        # commented-out string cannot satisfy it.
        import ast
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1] / "aria_kernel" / "tool_runner.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        assigns: list[str] = []
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Assign)
                and any(
                    isinstance(t, ast.Name) and t.id == "status" for t in node.targets
                )
                and isinstance(node.value, ast.Constant)
            ):
                assigns.append(str(node.value.value))

        self.assertIn("environment_unavailable", assigns)
        # And the old pricing is gone from the refusal branch: the only
        # remaining tool_unhealthy assignments must not be the deps branch.
        self.assertNotIn(
            "missing repo-local node dependency",
            [a for a in assigns if a == "tool_unhealthy"],
        )


class UnquarantineVerbExistsTest(unittest.TestCase):
    def test_the_cli_carries_the_audited_way_back(self) -> None:
        # unquarantine_tool existed since Plan 022 and was API-only — so when
        # six tools were wrongly quarantined there was no operator-reachable
        # path to lift it. Mechanism without a caller, CLI edition.
        import ast
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1] / "aria_kernel" / "cli.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        literals = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }

        self.assertIn("unquarantine", literals)
        calls = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn("unquarantine_tool", calls)


if __name__ == "__main__":
    unittest.main()
