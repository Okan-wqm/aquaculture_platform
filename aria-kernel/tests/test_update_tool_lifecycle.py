"""Plan 022 C-2b — update_tool lifecycle bypass closure tests.

Pre-Plan-022 update_tool(tool_id, updates) merged the updates dict
directly without revalidating, without enforcing the status transition
matrix, and without auditing runner/scope changes. A caller could:
- Promote a tool to ACTIVE bypassing precision/evidence/approval.
- Silently swap runner.argv to an attacker-controlled script.
- Widen allowed_read_globs to read forbidden paths.

This suite pins the C-2b fix:
1. update_tool with status field -> reject; must route through transition_tool.
2. update_tool touching runner / allowed_read_globs / forbidden_read_globs
   / declared_scope without operator_approval_ref -> reject.
3. update_tool touching gated fields with approval_ref + reason -> accepted.
4. runner.argv swap emits tool_runner_replaced governance event.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import (
    GovernanceError,
    ensure_tools_dir,
    get_tool,
    register_tool,
    update_tool,
)

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _seed_tools() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-c2b-update-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _manifest(*, tool_id: str = "fake-adapter") -> dict:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "0.1.0",
        "status": "DRAFT",
        "declared_scope": ["**/*.ts"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {"precision_min": 0.85, "non_critical_false_positives_30d": 3, "critical_false_positives": 0, "crash_rate_last_10": 0.2},
        "allowed_read_globs": ["**/*.ts"],
        "forbidden_read_globs": [".git/**", "node_modules/**"],
        "claim_types": ["fake_claim"],
        "owner": "platform",
        "schema_version": 2,
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix()],
            "cwd": ".", "timeout_ms": 60000, "stdin_json": True,
        },
    }


def _changed_runner(tag: str = "--invalid-json") -> dict:
    return {
        "type": "subprocess",
        "argv": ["python3", FAKE_RUNNER.as_posix(), tag],
        "cwd": ".",
        "timeout_ms": 60000,
        "stdin_json": True,
    }


class _UpdateToolTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        register_tool(_manifest(), base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)


class UpdateToolStatusGuardTests(_UpdateToolTestCase):
    def test_status_change_via_update_tool_blocked(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            update_tool("fake-adapter", {"status": "ACTIVE"}, base_dir=self.tools)
        self.assertIn("status_change_must_route_through_transition_tool", str(cm.exception))


class UpdateToolScopeGuardTests(_UpdateToolTestCase):
    def test_runner_change_without_approval_blocked(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            update_tool(
                "fake-adapter",
                {"runner": _changed_runner()},
                base_dir=self.tools,
            )
        self.assertIn("runner_or_scope_change_requires_operator_approval", str(cm.exception))

    def test_runner_change_without_reason_blocked(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            update_tool(
                "fake-adapter",
                {"runner": _changed_runner()},
                base_dir=self.tools,
                operator_approval_ref="ops-1",
                reason="",
            )
        self.assertIn("requires reason", str(cm.exception))

    def test_runner_change_with_approval_and_reason_succeeds(self) -> None:
        result = update_tool(
            "fake-adapter",
            {"runner": _changed_runner("--echo-input")},
            base_dir=self.tools,
            operator_approval_ref="ops-2026-05-08-002",
            reason="parser refactor; argv split into separate file",
        )
        self.assertEqual(result["runner"]["argv"], ["python3", FAKE_RUNNER.as_posix(), "--echo-input"])

    def test_allowed_read_globs_change_requires_approval(self) -> None:
        with self.assertRaises(GovernanceError):
            update_tool(
                "fake-adapter",
                {"allowed_read_globs": ["**/*.ts", "**/*.env"]},
                base_dir=self.tools,
            )

    def test_runner_argv_swap_emits_governance_event(self) -> None:
        update_tool(
            "fake-adapter",
            {"runner": _changed_runner("--invalid-json")},
            base_dir=self.tools,
            operator_approval_ref="ops-2026-05-08-003",
            reason="parser v2 promotion",
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("tool_runner_replaced", kinds)


class UpdateToolNonGatedFieldsTests(_UpdateToolTestCase):
    def test_non_gated_metadata_update_allowed(self) -> None:
        # version + owner are not in _OPERATOR_APPROVAL_GATED_FIELDS or the
        # status guard, so a plain update is permitted.
        result = update_tool(
            "fake-adapter",
            {"version": "0.2.0", "owner": "platform-data"},
            base_dir=self.tools,
        )
        self.assertEqual(result["version"], "0.2.0")
        self.assertEqual(result["owner"], "platform-data")


if __name__ == "__main__":
    unittest.main()
