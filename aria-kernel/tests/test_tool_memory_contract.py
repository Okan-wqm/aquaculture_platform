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
        # The adapter's environment is BUILT in one place since
        # ARIA-CRITICAL-399 (`adapter_room.adapter_environment`); the heap
        # ceiling must ride it and an operator's own NODE_OPTIONS must survive.
        import tempfile

        from aria_kernel.adapter_room import adapter_environment

        with tempfile.TemporaryDirectory() as workspace:
            built = adapter_environment(
                {"PATH": "/usr/bin", "NODE_OPTIONS": "--enable-source-maps"},
                workspace_root=workspace, node_heap_mb=3072,
            )
        self.assertEqual(built.env["NODE_OPTIONS"], "--enable-source-maps --max-old-space-size=3072")

    def test_the_runner_hands_the_manifest_ceiling_to_the_room(self) -> None:
        # AST-level pin: run_tool passes `runner.node_max_old_space_mb` to the
        # one spawn builder, so a manifest's ceiling reaches the adapter.
        import ast
        import inspect
        import textwrap

        from aria_kernel import tool_runner

        tree = ast.parse(textwrap.dedent(inspect.getsource(tool_runner.run_tool)))
        spawns = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "prepare_adapter_spawn"
        ]
        self.assertEqual(len(spawns), 1)
        heap = next(kw.value for kw in spawns[0].keywords if kw.arg == "node_heap_mb")
        self.assertIn("node_max_old_space_mb", ast.unparse(heap))

if __name__ == "__main__":
    unittest.main()
