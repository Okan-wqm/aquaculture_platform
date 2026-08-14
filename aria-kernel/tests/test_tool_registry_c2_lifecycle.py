"""Plan 022 C-2 — register_tool lifecycle transition gate tests.

Pre-Plan-022 register_tool blindly overwrote any tool with the same
tool_id (line 362-371), bypassing the transition matrix that
transition_tool() enforces. A QUARANTINED tool could be silently
promoted back to ACTIVE just by reloading the manifest.

This suite pins the C-2 fix:
- QUARANTINED on disk + non-QUARANTINED candidate -> reject.
- SHADOW/CALIBRATE on disk + ACTIVE candidate -> reject (must route
  through transition_tool with precision/evidence/operator approval).
- ACTIVE/CALIBRATE on disk + SHADOW/SANDBOX/DRAFT candidate -> reject
  (demotion requires explicit transition_tool reason).
- Same status (manifest hash drift, parser update) -> allow.
- DRAFT/SANDBOX -> SHADOW forward progression -> allow.
- unquarantine_tool() routes QUARANTINED -> CALIBRATE with audit
  trail.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import (
    DEFAULT_FRESHNESS_WINDOW_HOURS,
    GovernanceError,
    ensure_tools_dir,
    get_tool,
    parse_window_signature,
    register_tool,
    transition_tool,
    unquarantine_tool,
    update_tool,
)
from aria_kernel.tool_registry import _update_tool_internal  # noqa: PLC2701 — test fixture only

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _seed_tools() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-c2-lifecycle-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _manifest(*, tool_id: str = "fake-adapter", status: str = "DRAFT", version: str = "0.1.0") -> dict:
    """Minimal valid tool manifest covering REQUIRED_TOOL_FIELDS."""
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": version,
        "status": status,
        "declared_scope": ["**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "allowed_read_globs": ["**/*.ts"],
        "forbidden_read_globs": [".git/**", "node_modules/**"],
        "claim_types": ["fake_claim"],
        "owner": "platform",
        "schema_version": 2,
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix()],
            "cwd": ".",
            "timeout_ms": 60000,
            "stdin_json": True,
        },
    }


class _LifecycleTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)


class RegisterToolLifecycleGateTests(_LifecycleTestCase):
    def test_quarantined_to_active_re_register_blocked(self) -> None:
        # Arrange: tool exists on disk as QUARANTINED.
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        # Force QUARANTINED status via direct update_tool (this is what a
        # tool_health quarantine action does on the disk row).
        _update_tool_internal("fake-adapter", {"status": "QUARANTINED"}, base_dir=self.tools)
        # Act + Assert: bare re-register as ACTIVE blocked.
        with self.assertRaises(GovernanceError) as cm:
            register_tool(_manifest(status="ACTIVE"), base_dir=self.tools)
        self.assertIn("QUARANTINED", str(cm.exception))
        self.assertIn("unquarantine_tool", str(cm.exception))

    def test_shadow_to_active_re_register_blocked(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        _update_tool_internal("fake-adapter", {"status": "SHADOW"}, base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            register_tool(_manifest(status="ACTIVE"), base_dir=self.tools)
        self.assertIn("transition_tool", str(cm.exception))

    def test_active_to_shadow_re_register_blocked(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        _update_tool_internal("fake-adapter", {"status": "ACTIVE"}, base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            register_tool(_manifest(status="SHADOW"), base_dir=self.tools)
        self.assertIn("demotion", str(cm.exception))

    def test_same_status_manifest_hash_drift_allowed(self) -> None:
        # Parser update path: same status, different version → OK.
        register_tool(_manifest(status="SHADOW", version="0.1.0"), base_dir=self.tools)
        result = register_tool(_manifest(status="SHADOW", version="0.2.0"), base_dir=self.tools)
        self.assertEqual(result["version"], "0.2.0")
        on_disk = get_tool("fake-adapter", self.tools)
        self.assertEqual(on_disk["version"], "0.2.0")
        self.assertEqual(on_disk["status"], "SHADOW")

    def test_draft_to_sandbox_forward_progression_allowed(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        # Forward progression DRAFT -> SANDBOX is permitted via
        # re-registration (still earlier in the lifecycle than ACTIVE).
        result = register_tool(_manifest(status="SANDBOX"), base_dir=self.tools)
        self.assertEqual(result["status"], "SANDBOX")


class UnquarantineToolTests(_LifecycleTestCase):
    def test_unquarantine_routes_to_calibrate_with_audit_trail(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        _update_tool_internal("fake-adapter", {"status": "QUARANTINED"}, base_dir=self.tools)
        result = unquarantine_tool(
            "fake-adapter",
            operator_approval_ref="ops-2026-05-08-001",
            reason="root cause fixed in fixture update",
            root_cause_note="parser regex was too greedy",
            fixture_update_ref="commit:abc1234",
            base_dir=self.tools,
        )
        self.assertEqual(result["status"], "CALIBRATE")
        self.assertEqual(result["last_transition"]["from"], "QUARANTINED")
        self.assertEqual(result["last_transition"]["to"], "CALIBRATE")
        self.assertIn("ops-2026-05-08-001", result["last_transition"]["reason"])

    def test_unquarantine_requires_operator_approval_ref(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        _update_tool_internal("fake-adapter", {"status": "QUARANTINED"}, base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            unquarantine_tool(
                "fake-adapter",
                operator_approval_ref="",
                reason="r", root_cause_note="rc", fixture_update_ref="ref",
                base_dir=self.tools,
            )
        self.assertIn("operator_approval_ref", str(cm.exception))

    def test_unquarantine_rejects_non_quarantined_tool(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            unquarantine_tool(
                "fake-adapter",
                operator_approval_ref="ops-1",
                reason="r", root_cause_note="rc", fixture_update_ref="ref",
                base_dir=self.tools,
            )
        self.assertIn("not QUARANTINED", str(cm.exception))


class ParseWindowSignatureLifecycleTests(_LifecycleTestCase):
    """E13-C11 — the derived parse_window_signature stays true through
    the audited mutation paths (register + update_tool)."""

    def test_register_derives_signature_and_default_freshness(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        row = get_tool("fake-adapter", self.tools)
        self.assertEqual(row["parse_window_signature"], parse_window_signature(row))
        self.assertEqual(row["freshness_window_hours"], DEFAULT_FRESHNESS_WINDOW_HOURS)

    def test_update_tool_scope_change_recomputes_signature(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        before = get_tool("fake-adapter", self.tools)["parse_window_signature"]
        update_tool(
            "fake-adapter",
            {"declared_scope": ["apps/**/*.ts", "libs/**/*.ts"]},
            base_dir=self.tools,
            operator_approval_ref="ops-e13-c11",
            reason="widen parse window",
        )
        after = get_tool("fake-adapter", self.tools)
        self.assertNotEqual(after["parse_window_signature"], before)
        self.assertEqual(after["parse_window_signature"], parse_window_signature(after))

    def test_update_tool_with_explicitly_stale_signature_rejected(self) -> None:
        register_tool(_manifest(status="DRAFT"), base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "parse_window_signature_mismatch"):
            update_tool(
                "fake-adapter",
                {
                    "declared_scope": ["apps/**/*.ts", "libs/**/*.ts"],
                    "parse_window_signature": "sha256:" + "0" * 64,
                },
                base_dir=self.tools,
                operator_approval_ref="ops-e13-c11",
                reason="widen parse window with stale sig",
            )


if __name__ == "__main__":
    unittest.main()
