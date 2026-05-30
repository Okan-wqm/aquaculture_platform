from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.registry_compiler import compile_registry
from aria_kernel.tool_registry import GovernanceError


def _manifest(tool_id: str, argv: list[str] | None = None) -> dict[str, object]:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": f"tools/aria-adapters/fixtures/{tool_id}",
        "health_thresholds": {"max_cost_units": 100},
        "allowed_read_globs": ["apps/**/*.ts"],
        "forbidden_read_globs": [".git/**", "node_modules/**"],
        "claim_types": ["test_claim"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": argv or ["python3", "real_adapter.py"],
            "cwd": "tools/aria-poc",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


class RegistryCompilerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-registry-compiler-"))
        self.adapters = self.tmp / "tools" / "aria-adapters"
        self.adapters.mkdir(parents=True)
        self.output = self.tmp / "aria-tools" / "registry.json"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_manifest(self, tool_id: str, argv: list[str] | None = None) -> None:
        (self.adapters / f"{tool_id}.tool.json").write_text(
            json.dumps(_manifest(tool_id, argv), indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def test_compiles_manifests_deterministically(self) -> None:
        self._write_manifest("b-adapter")
        self._write_manifest("a-adapter")
        registry = compile_registry(self.adapters, self.output)
        self.assertEqual([tool["tool_id"] for tool in registry["tools"]], ["a-adapter", "b-adapter"])
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), registry)
        checked = compile_registry(self.adapters, self.output, check=True)
        self.assertEqual(checked, registry)

    def test_normalizes_ts_node_runner(self) -> None:
        self._write_manifest(
            "ts-adapter",
            ["npx", "ts-node", "--project", "tools/gates/tsconfig.json", "tools/aria-adapters/x.ts"],
        )
        registry = compile_registry(self.adapters, self.output)
        argv = registry["tools"][0]["runner"]["argv"]
        self.assertEqual(argv[:2], ["node", "./node_modules/ts-node/dist/bin.js"])

    def test_check_detects_registry_drift(self) -> None:
        self._write_manifest("real-adapter")
        compile_registry(self.adapters, self.output)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        payload["tools"][0]["owner"] = "drifted"
        self.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "registry_drift"):
            compile_registry(self.adapters, self.output, check=True)

    def test_stub_runner_rejected(self) -> None:
        self._write_manifest("stub-adapter", ["python3", "shadow_runner.py", "stub-adapter"])
        with self.assertRaisesRegex(GovernanceError, "stub_runner_rejected"):
            compile_registry(self.adapters, self.output)


if __name__ == "__main__":
    unittest.main()
