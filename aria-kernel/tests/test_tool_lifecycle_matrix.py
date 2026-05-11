"""Plan 026R §E.10 — tool lifecycle matrix: forbidden-to-ACTIVE sources.

6 tests:

* _FORBIDDEN_ACTIVE_SOURCES constant shape (5 entries).
* DRAFT → ACTIVE raises.
* SANDBOX → ACTIVE raises.
* ARCHIVED → ACTIVE raises.
* QUARANTINED → ACTIVE raises.
* SHADOW → ACTIVE still permitted (existing gate path with precision +
  operator approval requirements).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import (
    _FORBIDDEN_ACTIVE_SOURCES,
    GovernanceError,
    register_tool,
    transition_tool,
)


def _tool_fixture(**overrides) -> dict:
    base = {
        "tool_id": overrides.pop("tool_id", "tool-e10"),
        "kind": "adapter",
        "version": "0.1.0",
        "status": "DRAFT",
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
    base.update(overrides)
    return base


class ToolLifecycleMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-e10-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_forbidden_active_sources_constant_shape(self) -> None:
        self.assertEqual(
            _FORBIDDEN_ACTIVE_SOURCES,
            frozenset({
                "DRAFT", "SANDBOX", "ARCHIVED", "QUARANTINED", "CALIBRATE",
            }),
        )
        self.assertEqual(len(_FORBIDDEN_ACTIVE_SOURCES), 5)

    def _assert_forbidden(self, source_status: str) -> None:
        register_tool(_tool_fixture(tool_id=f"tool-{source_status.lower()}"), base_dir=self.base)
        with patch(
            "aria_kernel.tool_registry.get_tool",
            return_value={
                **_tool_fixture(tool_id=f"tool-{source_status.lower()}"),
                "status": source_status,
            },
        ):
            with self.assertRaises(GovernanceError) as ctx:
                transition_tool(
                    f"tool-{source_status.lower()}",
                    "ACTIVE",
                    reason="test forbidden source",
                    base_dir=self.base,
                )
            self.assertIn(
                "tool_lifecycle_forbidden_active_promotion",
                str(ctx.exception),
            )

    def test_draft_to_active_raises(self) -> None:
        self._assert_forbidden("DRAFT")

    def test_sandbox_to_active_raises(self) -> None:
        self._assert_forbidden("SANDBOX")

    def test_archived_to_active_raises(self) -> None:
        self._assert_forbidden("ARCHIVED")

    def test_quarantined_to_active_raises(self) -> None:
        self._assert_forbidden("QUARANTINED")

    def test_shadow_to_active_still_permitted_with_evidence(self) -> None:
        # SHADOW → ACTIVE remains the documented promotion path. The
        # gate STILL requires precision threshold + operator approval
        # + evidence chains — we assert only that the §E.10 forbidden-
        # source raise does NOT fire (a precision-fail raise IS valid
        # because that's a different gate).
        register_tool(_tool_fixture(tool_id="tool-shadow"), base_dir=self.base)
        with patch(
            "aria_kernel.tool_registry.get_tool",
            return_value={
                **_tool_fixture(tool_id="tool-shadow"),
                "status": "SHADOW",
            },
        ):
            try:
                transition_tool(
                    "tool-shadow",
                    "ACTIVE",
                    reason="promotion test",
                    base_dir=self.base,
                    precision=0.9,
                    critical_false_positives=0,
                    evidence_chains_valid=True,
                    operator_approval=True,
                )
            except GovernanceError as exc:
                self.assertNotIn(
                    "tool_lifecycle_forbidden_active_promotion",
                    str(exc),
                    f"SHADOW → ACTIVE should NOT trigger forbidden-source "
                    f"raise; got {exc}",
                )


if __name__ == "__main__":
    unittest.main()
