from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import register_tool, run_tool


class TypeOrmAdapterIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        self.repo_root = Path(__file__).resolve().parents[2]
        if not (self.repo_root / "node_modules" / ".bin" / "ts-node").exists():
            self.skipTest("TS adapter integration requires local node_modules/.bin/ts-node")

    def tearDown(self):
        self.tmp.cleanup()

    def test_typeorm_entity_schema_adapter_runs_in_shadow_without_mutation(self):
        register_tool(
            {
                "tool_id": "typeorm-entity-schema-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": [
                    "apps/farm-service/src/**/*.ts",
                    "libs/backend-common/src/database/schema-manager.service.ts",
                ],
                "output_schema": {
                    "type": "object",
                    "required": ["observations", "findings", "read_paths", "evidence_sources"],
                },
                "fixture_set": "fixtures/typeorm-entity-schema-adapter",
                "health_thresholds": {"max_cost_units": 250},
                "allowed_read_globs": [
                    "apps/farm-service/src/**/*.ts",
                    "libs/backend-common/src/database/schema-manager.service.ts",
                ],
                "forbidden_read_globs": ["dist/**"],
                "claim_types": ["schema_drift"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess",
                    "argv": [
                        "npx",
                        "ts-node",
                        "--project",
                        "tools/gates/tsconfig.json",
                        "tools/aria-adapters/typeorm-entity-schema-adapter.ts",
                    ],
                    "cwd": ".",
                    "timeout_ms": 180000,
                    "stdin_json": True,
                },
                "schema_version": 1,
            },
            base_dir=self.tools_dir,
        )

        decision = run_tool(
            "typeorm-entity-schema-adapter",
            {
                "target": "farm-service",
                "root": "apps/farm-service/src",
                "serviceName": "farm",
                "allowlist": [
                    "apps/farm-service/src/database/entities/code-sequence.entity.ts",
                    "apps/farm-service/src/batch/entities/batch.entity.ts",
                ],
            },
            "cycle-integration",
            run_id="typeorm-adapter-shadow",
            workspace_root=self.repo_root,
            base_dir=self.tools_dir,
        )

        self.assertIn(decision["action"], {"none", "quarantine"})
        run = self.latest_run()
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["emitted_counts"]["observations"], 0)
        self.assertEqual(run["emitted_counts"]["findings"], 0)
        self.assertFalse(run["evidence_validation"]["repository_mutation_attempt"])
        self.assertGreater(run["runner"]["raw_observations_count"], 0)
        self.assertIn("apps/farm-service/src/batch/entities/batch.entity.ts", run["read_paths"])
        self.assertIn("libs/backend-common/src/database/schema-manager.service.ts", run["read_paths"])

    def latest_run(self):
        rows = (self.tools_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
        return json.loads(rows[-1])


if __name__ == "__main__":
    unittest.main()
