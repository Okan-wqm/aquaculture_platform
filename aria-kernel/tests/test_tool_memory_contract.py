"""A tool's memory budget is a contract, not an accident of the host.

The first cycle in which the adapters ever executed, the two widest-scope
ones (tenant-scoping, test-gap: apps/** + libs/**) crashed at Node's default
~1 GB old-space — a resource the manifest never declared, enforced by a
runtime the manifest never chose. The budget is now explicit:
`runner.node_max_old_space_mb`, default 2048, composed into NODE_OPTIONS
without clobbering an operator's own flags.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.tool_registry import GovernanceError, validate_tool_definition


class ManifestFieldTest(unittest.TestCase):
    def _manifest(self, **runner_extra):
        import json
        from pathlib import Path

        base = json.loads(
            (Path(__file__).resolve().parents[2] / "tools" / "aria-adapters" /
             "typeorm-entity-schema-adapter.tool.json").read_text()
        )
        base["runner"].update(runner_extra)
        return base

    def test_a_positive_budget_is_accepted(self) -> None:
        tool = validate_tool_definition(self._manifest(node_max_old_space_mb=3072))

        self.assertEqual(tool["runner"]["node_max_old_space_mb"], 3072)

    def test_a_nonpositive_budget_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_tool_definition(self._manifest(node_max_old_space_mb=0))

    def test_absence_is_allowed_and_defaults_at_run_time(self) -> None:
        tool = validate_tool_definition(self._manifest())

        self.assertNotIn("node_max_old_space_mb", tool["runner"])

    def test_the_wide_scope_adapters_declare_their_ceiling(self) -> None:
        # The two that crashed carry 3072 in their shipped manifests.
        import json
        from pathlib import Path

        adapters = Path(__file__).resolve().parents[2] / "tools" / "aria-adapters"
        for tid in ("tenant-scoping-adapter", "test-gap-adapter"):
            d = json.loads((adapters / f"{tid}.tool.json").read_text())
            self.assertEqual(d["runner"]["node_max_old_space_mb"], 3072, tid)


class RunnerCompositionTest(unittest.TestCase):
    def test_node_options_is_composed_not_clobbered(self) -> None:
        # AST-level pin on the runner: the env the subprocess receives must
        # carry --max-old-space-size AND preserve pre-existing NODE_OPTIONS.
        import ast
        import inspect
        import textwrap

        from aria_kernel import tool_runner

        src = textwrap.dedent(inspect.getsource(tool_runner.run_tool))
        self.assertIn("max-old-space-size", src)
        self.assertIn('run_env.get("NODE_OPTIONS", "")', src)
        tree = ast.parse(src)
        run_calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute) and node.func.attr == "run"
        ]
        self.assertTrue(
            any(any(kw.arg == "env" for kw in call.keywords) for call in run_calls),
            "the tool subprocess must receive the composed environment",
        )


if __name__ == "__main__":
    unittest.main()
