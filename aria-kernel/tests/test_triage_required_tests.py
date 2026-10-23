"""SE-1-R2 appellate R3 — the test commands for a pressure are named through
the one path -> project owner, over a map resolved at most once per pass.

WHY. SE-1 folded ``triage._nearest_nx_project`` (a second ``project.json``
name reader) into ``impact_graph.project_for_path``. The fold put
``impact_graph.project_map`` — a full discovery walk to check the cache's
graph fingerprint — inside ``derive_required_tests``, which
``triage_policy_apply`` calls for every effective pressure, before the
decision dedup, every cycle. Reviewer probe arch p4/p5: 20 pressures on a
no-op pass took 12.9 s at the SE-1 head against 0.4 s on main. The fold had
no test of its own.

WHAT THIS PINS.
  * ``derive_required_tests`` names ``npx nx test <project.json name>`` for a
    path under an nx root, nothing for a path outside every project or under a
    conventional root without ``project.json``, and the kernel suite for a
    kernel path; it asks for the map only when a path needs one.
  * ``triage_policy_apply`` over N >= 2 pressures citing product paths
    computes the graph fingerprint at most once.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel import impact_graph, triage
from aria_kernel.impact_graph import ProjectMap, project_map
from aria_kernel.tool_registry import ensure_tools_binding, ensure_tools_dir
from aria_kernel.triage import derive_required_tests, lazy_project_map


def _source(workspace: Path, rel: str) -> None:
    path = workspace / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("export const x = 1;\n", encoding="utf-8")


class _Workspace(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.workspace = tmp / "repo"
        _source(self.workspace, "apps/farm-service/src/main.ts")
        (self.workspace / "apps/farm-service/project.json").write_text(
            json.dumps({"name": "farm-api"}), encoding="utf-8"
        )
        _source(self.workspace, "apps/no-manifest/src/main.ts")
        self.tools = ensure_tools_binding(ensure_tools_dir(tmp / "aria-tools"), workspace_root=self.workspace)


class DeriveRequiredTests(_Workspace):
    def setUp(self) -> None:
        super().setUp()
        self.roots = project_map(base_dir=self.tools)
        self.asked = 0

    def _resolver(self) -> ProjectMap:
        self.asked += 1
        return self.roots

    def test_an_nx_root_is_tested_by_its_project_json_name(self) -> None:
        self.assertEqual(
            derive_required_tests(
                ["apps/farm-service/src/main.ts:3"], self._resolver, workspace_root=self.workspace
            ),
            ["npx nx test farm-api"],
        )

    def test_a_path_outside_every_project_gets_no_command(self) -> None:
        self.assertEqual(
            derive_required_tests(["docs/adr/ADR-011.md"], self._resolver, workspace_root=self.workspace), []
        )

    def test_a_conventional_root_without_project_json_gets_no_command(self) -> None:
        self.assertIn("no-manifest", self.roots)
        self.assertEqual(
            derive_required_tests(
                ["apps/no-manifest/src/main.ts"], self._resolver, workspace_root=self.workspace
            ),
            [],
        )

    def test_kernel_paths_do_not_ask_for_the_map(self) -> None:
        self.assertEqual(
            derive_required_tests(
                ["aria-kernel/aria_kernel/triage.py", "tools/aria-poc/poc.py"],
                self._resolver,
                workspace_root=self.workspace,
            ),
            ["python -m pytest tools/aria-poc/poc.py", "python -m unittest discover aria-kernel -p '*test*.py'"],
        )
        self.assertEqual(self.asked, 0)


class TriageResolvesTheMapOncePerPass(_Workspace):
    def _pressures(self, n: int) -> list[dict[str, object]]:
        return [
            {
                "event_id": f"p-{i}",
                "effective_state": "active",
                "evidence_refs": [f"apps/farm-service/src/file{i}.ts:1"],
            }
            for i in range(n)
        ]

    def _fingerprints_computed(self, pressures: list[dict[str, object]], cycle_id: str) -> tuple[int, dict]:
        calls = {"n": 0}
        real = impact_graph._graph_fingerprint

        def counting(root: Path) -> str:
            calls["n"] += 1
            return real(root)

        paths = SimpleNamespace(repo_root=self.workspace)
        with patch.object(triage, "effective_workspace_pressures", return_value=pressures), patch.object(
            impact_graph, "_graph_fingerprint", side_effect=counting
        ):
            result = triage.triage_policy_apply(paths, cycle_id=cycle_id, tools_root=self.tools)
        return calls["n"], result

    def test_many_product_path_pressures_compute_the_fingerprint_at_most_once(self) -> None:
        computed, result = self._fingerprints_computed(self._pressures(5), "c1")
        self.assertEqual(result["triaged_count"], 5)
        self.assertTrue(
            all(d["required_tests"] == ["npx nx test farm-api"] for d in result["decisions"]),
            result["decisions"],
        )
        self.assertLessEqual(computed, 1)

    def test_a_pass_whose_decisions_all_exist_still_computes_it_at_most_once(self) -> None:
        self._fingerprints_computed(self._pressures(5), "c1")
        computed, result = self._fingerprints_computed(self._pressures(5), "c2")
        self.assertEqual(result["triaged_count"], 0)
        # The dedup runs before the test commands are derived, so a pass with
        # nothing new to decide resolves no map at all.
        self.assertEqual(computed, 0)

    def test_a_pass_that_cites_only_kernel_paths_resolves_no_map(self) -> None:
        pressures = [
            {"event_id": f"k-{i}", "effective_state": "active", "evidence_refs": [f"aria-kernel/aria_kernel/m{i}.py"]}
            for i in range(3)
        ]
        computed, _ = self._fingerprints_computed(pressures, "c3")
        self.assertEqual(computed, 0)


class LazyProjectMap(_Workspace):
    def test_it_resolves_on_first_use_and_reuses_the_map(self) -> None:
        with patch.object(triage, "project_map", wraps=triage.project_map) as accessor:
            resolve = lazy_project_map(workspace_root=self.workspace, base_dir=self.tools)
            self.assertEqual(accessor.call_count, 0)
            first = resolve()
            second = resolve()
        self.assertIs(first, second)
        self.assertEqual(accessor.call_count, 1)


if __name__ == "__main__":
    unittest.main()
