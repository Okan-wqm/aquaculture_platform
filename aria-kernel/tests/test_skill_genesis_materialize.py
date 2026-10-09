"""ORPHAN-HIGH-573 (skill-genesis trio) — the kernel-side materializer.

validate_generated_adapter, verify_adapter_imports, and
verify_adapter_signature existed as gates with no lane: the drainer
dispatches authoring but never passed a materialize_fn, so an authored
adapter was never written, verified, or registered. This pins the one
materializer that runs all three in order — imports BEFORE the file
exists, signature on the written artifact, manifest validation BEFORE
register_tool — and the drainer wiring that puts it on the authoring
path.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.skill_genesis import materialize_generated_adapter
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, list_tools

REPO_ROOT = Path(__file__).resolve().parents[2]
DRAINER_SOURCE = (
    REPO_ROOT / "aria-kernel" / "aria_kernel" / "skill_genesis_drainer.py"
).read_text(encoding="utf-8")

SAFE_SOURCE = (
    "import json\n"
    "import re\n\n\n"
    "def run(payload):\n"
    "    return {\"observations\": [], \"findings\": [],\n"
    "            \"read_paths\": [\"src/app.ts\"],\n"
    "            \"evidence_sources\": [\"src/app.ts\"], \"cost_units\": 1}\n"
)

UNSAFE_SOURCE = (
    "import subprocess\n\n\n"
    "def run(payload):\n"
    "    return {}\n"
)


def manifest_definition(**overrides) -> dict:
    payload = {
        "tool_id": "genesis-fixture-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["src/app.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/genesis-fixture-adapter",
        "health_thresholds": {"max_cost_units": {"min": 0, "max": 10}},
        "allowed_read_globs": ["src/app.ts"],
        "forbidden_read_globs": [],
        "claim_types": ["learning"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            # Placeholder: the materializer rebinds argv to the adapter
            # path it writes (it owns the path binding).
            "argv": ["python3", "placeholder.py"],
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
        "read_paths": ["src/app.ts"],
    }
    payload.update(overrides)
    return payload


SEED = {
    "seed_id": "seed-fixture",
    "declared_scope": ["src/app.ts"],
    "claim_types": ["learning"],
}


class MaterializeGeneratedAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        # The adapter is a REPO artifact: the materializer writes it under
        # the workspace's tools/aria-adapters/ (the one prefix the argv
        # trust policy names), not under the tools root.
        self.workspace = Path(self._tmp.name) / "workspace"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _draft(self, source: str = SAFE_SOURCE, manifest: dict | None = None) -> dict:
        return {
            "draft_id": "draft-fixture-1",
            "adapter_source": source,
            "adapter_manifest": manifest or manifest_definition(),
            "_workspace_root": str(self.workspace),
        }

    def test_happy_path_writes_verifies_and_registers(self) -> None:
        result = materialize_generated_adapter(
            primary_draft=self._draft(), seed=SEED, base_dir=self.tools,
        )
        self.assertEqual(result["status"], "ok")
        adapter_path = Path(result["adapter_path"])
        bundle_path = Path(result["manifest_path"])
        self.assertTrue(adapter_path.exists())
        self.assertEqual(
            adapter_path, self.workspace / "tools" / "aria-adapters" / "genesis-fixture-adapter.py"
        )
        self.assertTrue(bundle_path.exists())
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        self.assertIn("source_sha256", bundle)
        rows = list_tools(base_dir=self.tools)
        registered = {str(t.get("tool_id")) for t in rows}
        self.assertIn("genesis-fixture-adapter", registered)
        argv = next(
            t.get("runner", {}).get("argv") for t in rows
            if str(t.get("tool_id")) == "genesis-fixture-adapter"
        )
        self.assertEqual(
            argv, ["python3", "tools/aria-adapters/genesis-fixture-adapter.py"]
        )

    def test_unsafe_import_refused_before_any_file_exists(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            materialize_generated_adapter(
                primary_draft=self._draft(source=UNSAFE_SOURCE),
                seed=SEED, base_dir=self.tools,
            )
        self.assertIn("unsafe_adapter_import", str(ctx.exception))
        adapters_dir = self.workspace / "tools" / "aria-adapters"
        self.assertFalse(adapters_dir.exists())

    def test_manifest_outside_seed_scope_refused_and_not_registered(self) -> None:
        bad = manifest_definition(allowed_read_globs=["**"], read_paths=["secrets/env.ts"])
        with self.assertRaises(GovernanceError) as ctx:
            materialize_generated_adapter(
                primary_draft=self._draft(manifest=bad), seed=SEED, base_dir=self.tools,
            )
        self.assertIn("validate_generated_adapter_failed", str(ctx.exception))
        registered = {
            str(t.get("tool_id")) for t in list_tools(base_dir=self.tools)
        }
        self.assertNotIn("genesis-fixture-adapter", registered)

    def test_missing_source_or_manifest_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            materialize_generated_adapter(
                primary_draft={"draft_id": "x"}, seed=SEED, base_dir=self.tools,
            )

    def test_drainer_passes_the_materializer_to_the_authoring(self) -> None:
        self.assertIn(
            "materialize_fn=materialize_generated_adapter", DRAINER_SOURCE
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
