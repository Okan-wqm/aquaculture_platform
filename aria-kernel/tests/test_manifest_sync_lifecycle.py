"""Re-registration must carry the LIVE status, or contract updates die silently.

The live defect (ORPHAN-HIGH-625): tenant-scoping-adapter's manifest raised
`runner.timeout_ms` 180000→420000 (#1173) after the tool's live registry
status had advanced SHADOW→CALIBRATE. The sync phase re-registered with the
manifest's BIRTH status verbatim, the transition matrix read that as an
attempted demotion (CALIBRATE→SHADOW) and refused — so the runtime kept
running the stale 180-second contract and the nightly kept failing with
`budget_exceeded` two cycles after the fix "merged". The refusal was silent
from the operator's seat: the manifest said one thing, the runtime did
another, and nothing said why.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel import cycle as cycle_mod
from aria_kernel.tool_registry import ensure_tools_dir, list_tools, transition_tool


def _manifest(timeout_ms: int) -> dict:
    return {
        "tool_id": "sync-lifecycle-probe",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "tools/aria-adapters/fixtures/sync-lifecycle-probe",
        "health_thresholds": {"max_cost_units": 100},
        "allowed_read_globs": ["apps/**/*.ts"],
        "forbidden_read_globs": [".git/**"],
        "claim_types": ["test_gap"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": ["npx", "ts-node", "probe.ts"],
            "cwd": ".",
            "timeout_ms": timeout_ms,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


class ManifestSyncPreservesLifecycleTest(unittest.TestCase):
    def _sync(self, workspace: Path, tools: Path) -> dict:
        ctx = cycle_mod.build_phase_context(
            cycle_id="cyc-sync",
            workspace_root=workspace,
            base_dir=tools,
        )
        return cycle_mod._phase_tool_manifest_sync(ctx)

    def test_a_runner_update_reaches_a_lifecycle_advanced_tool(self) -> None:
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            tools = workspace / "aria-tools"
            ensure_tools_dir(tools)
            adapters = workspace / "tools" / "aria-adapters"
            adapters.mkdir(parents=True)
            path = adapters / "sync-lifecycle-probe.tool.json"
            path.write_text(json.dumps(_manifest(180000)), encoding="utf-8")

            first = self._sync(workspace, tools)
            self.assertIn("sync-lifecycle-probe", first["synced_tool_ids"])

            # The lifecycle advances the LIVE status past the birth status.
            transition_tool(
                "sync-lifecycle-probe",
                target_status="CALIBRATE",
                reason="test: lifecycle advanced past birth status",
                base_dir=tools,
            )

            # The operator ships a runner-contract fix; the manifest still
            # (correctly) carries the birth status.
            path.write_text(json.dumps(_manifest(420000)), encoding="utf-8")
            second = self._sync(workspace, tools)

            self.assertEqual(second["refused"], [])
            self.assertIn("sync-lifecycle-probe", second["synced_tool_ids"])
            tool = next(
                t for t in list_tools(base_dir=tools)
                if t["tool_id"] == "sync-lifecycle-probe"
            )
            # The contract update landed AND the live status survived.
            self.assertEqual(tool["runner"]["timeout_ms"], 420000)
            self.assertEqual(tool["status"], "CALIBRATE")

    def test_a_quarantined_tool_still_cannot_be_revived_by_sync(self) -> None:
        # The guard this fix must not weaken: carrying the live status means
        # a QUARANTINED tool re-registers as QUARANTINED — never silently
        # back to its birth status.
        with TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            tools = workspace / "aria-tools"
            ensure_tools_dir(tools)
            adapters = workspace / "tools" / "aria-adapters"
            adapters.mkdir(parents=True)
            path = adapters / "sync-lifecycle-probe.tool.json"
            path.write_text(json.dumps(_manifest(180000)), encoding="utf-8")
            self._sync(workspace, tools)
            transition_tool(
                "sync-lifecycle-probe",
                target_status="QUARANTINED",
                reason="test: quarantined stays quarantined",
                base_dir=tools,
            )

            path.write_text(json.dumps(_manifest(420000)), encoding="utf-8")
            self._sync(workspace, tools)

            tool = next(
                t for t in list_tools(base_dir=tools)
                if t["tool_id"] == "sync-lifecycle-probe"
            )
            self.assertEqual(tool["status"], "QUARANTINED")


if __name__ == "__main__":
    unittest.main()
