"""Per-service pressure scoping (ORPHAN-MEDIUM-259, slice 3).

cycle_service_examination now scopes each pressure to the service(s) its
evidence touches and groups them per-service in dependency (topological) order;
pressures whose evidence maps to no project are global (cross-cutting).
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

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


class PressureScopeTests(unittest.TestCase):
    def _examine(self, root: Path, tools: Path, pressures: list[dict]) -> dict:
        return ig.cycle_service_examination(
            workspace_root=root, base_dir=tools,
            changed_files=["libs/shared/src/i.ts"], pressures=pressures,
        )

    def test_pressures_scope_to_evidence_service_and_order_by_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            ex = self._examine(
                root, tdp / "tools",
                [
                    {"pressure_id": "p_svc", "source": "s1", "severity": "medium", "evidence": ["apps/svc/src/db.ts"]},
                    {"pressure_id": "p_shared", "source": "s2", "severity": "low", "evidence": ["libs/shared/src/i.ts"]},
                ],
            )
            grouped = ex["per_service_pressures"]
            order = [g["service"] for g in grouped]
            self.assertEqual(order, ["shared", "svc"], "pressures not grouped in dependency order")
            by = {g["service"]: g["pressures"] for g in grouped}
            self.assertEqual([p["pressure_id"] for p in by["shared"]], ["p_shared"])
            self.assertEqual([p["pressure_id"] for p in by["svc"]], ["p_svc"])
            self.assertEqual(by["svc"][0]["affected_services"], ["svc"])

    def test_pressure_with_no_project_evidence_is_global(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            ex = self._examine(
                root, tdp / "tools",
                [{"pressure_id": "p_global", "source": "discovery_incomplete", "severity": "high",
                  "evidence": ["aria-tools/x.json"]}],
            )
            self.assertEqual(ex["per_service_pressures"], [])
            self.assertEqual([p["pressure_id"] for p in ex["global_pressures"]], ["p_global"])

    def test_no_pressures_yields_empty_scope(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            ex = self._examine(root, tdp / "tools", [])
            self.assertEqual(ex["per_service_pressures"], [])
            self.assertEqual(ex["global_pressures"], [])

    def test_pressure_touching_two_services_appears_under_both(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            root = _mini_repo(tdp)
            ex = self._examine(
                root, tdp / "tools",
                [{"pressure_id": "p_both", "source": "s", "severity": "medium",
                  "evidence": ["libs/shared/src/a.ts", "apps/svc/src/b.ts"]}],
            )
            services_with_p = [g["service"] for g in ex["per_service_pressures"]
                               if any(p["pressure_id"] == "p_both" for p in g["pressures"])]
            self.assertEqual(sorted(services_with_p), ["shared", "svc"])


if __name__ == "__main__":
    unittest.main()
