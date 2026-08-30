from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import register_tool, run_tool


class Phase007cAdaptersIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        self.repo_root = Path(__file__).resolve().parents[2]
        if not (self.repo_root / "node_modules" / ".bin" / "ts-node").exists():
            self.skipTest("TS adapter integration requires local node_modules/.bin/ts-node")

    def tearDown(self):
        self.tmp.cleanup()

    def test_tenant_scoping_adapter_runs_in_shadow_without_mutation(self):
        self.register_tool_from_file("tenant-scoping-adapter")
        decision = run_tool(
            "tenant-scoping-adapter",
            {"roots": ["apps/farm-service/src", "libs/backend-common/src/database"]},
            "cycle-integration",
            run_id="tenant-scoping-adapter-shadow",
            workspace_root=self.repo_root,
            base_dir=self.tools_dir,
        )

        self.assert_shadow_run_contract(decision)
        run = self.latest_run()
        self.assertGreater(run["runner"]["raw_observations_count"], 0)
        self.assertIn("apps/farm-service/src/app.module.ts", run["read_paths"])

    def test_security_boundary_adapter_runs_in_shadow_without_mutation(self):
        self.register_tool_from_file("security-boundary-adapter")
        decision = run_tool(
            "security-boundary-adapter",
            {"roots": ["apps/ai-service/src", "web/shell/src", "tools/eslint-rules"]},
            "cycle-integration",
            run_id="security-boundary-adapter-shadow",
            workspace_root=self.repo_root,
            base_dir=self.tools_dir,
        )

        self.assert_shadow_run_contract(decision)
        run = self.latest_run()
        self.assertGreater(run["runner"]["raw_observations_count"], 0)
        self.assertTrue(any(path.startswith("apps/ai-service/src/") for path in run["read_paths"]))

    def test_test_gap_adapter_runs_in_shadow_without_mutation(self):
        self.register_tool_from_file("test-gap-adapter")
        decision = run_tool(
            "test-gap-adapter",
            {"roots": ["apps/farm-service/src", "libs/backend-common/src"]},
            "cycle-integration",
            run_id="test-gap-adapter-shadow",
            workspace_root=self.repo_root,
            base_dir=self.tools_dir,
        )

        self.assert_shadow_run_contract(decision)
        run = self.latest_run()
        self.assertGreater(run["runner"]["raw_observations_count"], 0)
        self.assertTrue(any(path.endswith(".spec.ts") for path in run["read_paths"]))

    def register_tool_from_file(self, tool_id: str):
        path = self.repo_root / "tools" / "aria-adapters" / f"{tool_id}.tool.json"
        register_tool(json.loads(path.read_text(encoding="utf-8")), base_dir=self.tools_dir)

    def assert_shadow_run_contract(self, decision):
        self.assertIn(decision["action"], {"none", "quarantine"})
        self.assertEqual(decision["metrics"]["budget_exceeded_7d"], 0)
        run = self.latest_run()
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["emitted_counts"]["observations"], 0)
        self.assertEqual(run["emitted_counts"]["findings"], 0)
        self.assertFalse(run["evidence_validation"]["repository_mutation_attempt"])

    def latest_run(self):
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        return json.loads(rows[-1])


if __name__ == "__main__":
    unittest.main()
