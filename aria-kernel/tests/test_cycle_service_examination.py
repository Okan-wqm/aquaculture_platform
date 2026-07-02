"""Per-service cycle examination + cached order (ORPHAN-MEDIUM-258).

The cycle's examination stage consumes the topological service order (slice 1)
to present THIS cycle's changed services + their downstream ripple in dependency
order. The order is cached by a cheap graph fingerprint so the expensive import
scan runs only when the project layout / tsconfig aliases change.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
import unittest

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

import aria_kernel.impact_graph as ig  # noqa: E402


def _mini_repo(td: Path) -> Path:
    root = td / "repo"
    (root / "libs" / "shared" / "src").mkdir(parents=True)
    (root / "libs" / "shared" / "package.json").write_text("{}", encoding="utf-8")
    (root / "libs" / "shared" / "src" / "i.ts").write_text("export const x = 1;", encoding="utf-8")
    (root / "apps" / "svc" / "src").mkdir(parents=True)
    (root / "apps" / "svc" / "package.json").write_text("{}", encoding="utf-8")
    (root / "apps" / "svc" / "src" / "m.ts").write_text(
        "import { x } from '@platform/shared';", encoding="utf-8"
    )
    (root / "tsconfig.base.json").write_text(
        '{"compilerOptions":{"paths":{"@platform/shared":["libs/shared/src/i.ts"]}}}',
        encoding="utf-8",
    )
    return root


class CachedOrderTests(unittest.TestCase):
    def test_cache_hit_skips_the_rescan(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            tools = tdp / "tools"
            calls = {"n": 0}
            real = ig._project_graph

            def spy(**kw: object) -> object:
                calls["n"] += 1
                return real(**kw)  # type: ignore[arg-type]

            with patch.object(ig, "_project_graph", side_effect=spy):
                ig.cached_service_analysis_order(workspace_root=root, base_dir=tools)
                ig.cached_service_analysis_order(workspace_root=root, base_dir=tools)
            self.assertEqual(calls["n"], 1, "second call must hit the cache, not re-scan")
            self.assertTrue((tools / "impact" / "service-order-cache.json").exists())

    def test_cache_invalidates_when_a_project_is_added(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            tools = tdp / "tools"
            first = ig.cached_service_analysis_order(workspace_root=root, base_dir=tools)
            (root / "apps" / "newsvc" / "src").mkdir(parents=True)
            (root / "apps" / "newsvc" / "package.json").write_text("{}", encoding="utf-8")
            second = ig.cached_service_analysis_order(workspace_root=root, base_dir=tools)
            self.assertNotEqual(first["graph_fingerprint"], second["graph_fingerprint"])
            self.assertGreater(second["project_count"], first["project_count"])


class ExaminationTests(unittest.TestCase):
    def test_changed_service_ripples_to_dependents_in_dependency_order(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            tools = tdp / "tools"
            ex = ig.cycle_service_examination(
                workspace_root=root, base_dir=tools, changed_files=["libs/shared/src/i.ts"]
            )
            self.assertEqual(ex["changed_projects"], ["shared"])
            self.assertEqual(ex["impacted_projects"], ["shared", "svc"])  # ripple
            order = [e["project"] for e in ex["examination_order"]]
            self.assertEqual(order, ["shared", "svc"])  # upstream examined first
            by = {e["project"]: e for e in ex["examination_order"]}
            self.assertEqual(by["shared"]["reason"], "changed")
            self.assertEqual(by["svc"]["reason"], "downstream_impact")

    def test_no_change_yields_empty_examination(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            tools = tdp / "tools"
            ex = ig.cycle_service_examination(workspace_root=root, base_dir=tools, changed_files=[])
            self.assertEqual(ex["examination_order"], [])
            self.assertEqual(ex["changed_projects"], [])


if __name__ == "__main__":
    unittest.main()
