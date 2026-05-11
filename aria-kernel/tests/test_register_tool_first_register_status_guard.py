"""Plan 023 v3 §C-3 — register_tool first-write status guard.

Pre-Plan-023 register_tool's else branch (no existing row for tool_id)
appended `candidate` to the registry without any status validation:

    else:
        registry["tools"].append(candidate)

A first-time `register_tool({tool_id: "x", status: "ACTIVE"})` therefore
landed ACTIVE without going through the `transition_tool()` matrix that
otherwise enforces precision + evidence_chains_valid + operator
approval. Plan 022 §C-2 + §C-2b had added the overwrite-path guard
(existing row + downgrade rejected, etc.) but the new-tool path was
left wide open.

Plan 023 v3 §C-3 fix: enforce that any first-time registration has its
status in the initial-lifecycle set (DRAFT / SANDBOX / SHADOW). Any
direct-to-ACTIVE / -CALIBRATE / -QUARANTINED first registration must
fail; the only path to those states is `transition_tool()` after a
prior initial-lifecycle registration.

Tests:
1. DRAFT first-register passes.
2. SANDBOX first-register passes.
3. SHADOW first-register passes.
4. ACTIVE first-register rejects.
5. CALIBRATE first-register rejects.
6. QUARANTINED first-register rejects.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import GovernanceError, get_tool, register_tool


def _make_tool(tool_id: str, status: str) -> dict:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "0.1.0",
        "status": status,
        "owner": "platform",
        "schema_version": 2,
        "claim_types": ["fake"],
        "declared_scope": ["apps/**"],
        "allowed_read_globs": ["apps/**"],
        "forbidden_read_globs": [".git/**"],
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "runner": {
            "type": "subprocess",
            "argv": ["python3", "fake.py"],
            "cwd": "tools/aria-poc",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
    }


class FirstRegisterStatusGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c3-"))
        self.base = self.tmp / "aria-tools"
        self.base.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_first_register_draft_accepts(self) -> None:
        register_tool(_make_tool("alpha", "DRAFT"), base_dir=self.base)
        self.assertEqual(get_tool("alpha", base_dir=self.base)["status"], "DRAFT")

    def test_first_register_sandbox_accepts(self) -> None:
        register_tool(_make_tool("alpha", "SANDBOX"), base_dir=self.base)
        self.assertEqual(get_tool("alpha", base_dir=self.base)["status"], "SANDBOX")

    def test_first_register_shadow_accepts(self) -> None:
        register_tool(_make_tool("alpha", "SHADOW"), base_dir=self.base)
        self.assertEqual(get_tool("alpha", base_dir=self.base)["status"], "SHADOW")

    def test_first_register_active_rejects(self) -> None:
        """Pre-Plan-023 this slipped through: register_tool's else branch
        appended candidate with status=ACTIVE bypassing transition_tool."""
        with self.assertRaises(GovernanceError) as ctx:
            register_tool(_make_tool("alpha", "ACTIVE"), base_dir=self.base)
        self.assertIn("first_register_status_must_be_initial_lifecycle_state", str(ctx.exception))

    def test_first_register_calibrate_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            register_tool(_make_tool("alpha", "CALIBRATE"), base_dir=self.base)
        self.assertIn("first_register_status_must_be_initial_lifecycle_state", str(ctx.exception))

    def test_first_register_quarantined_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            register_tool(_make_tool("alpha", "QUARANTINED"), base_dir=self.base)
        self.assertIn("first_register_status_must_be_initial_lifecycle_state", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
