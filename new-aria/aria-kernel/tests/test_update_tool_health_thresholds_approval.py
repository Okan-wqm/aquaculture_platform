"""Plan 023 v3 §C-4 — health_thresholds approval gate + range invariants.

Pre-Plan-023 update_tool's _OPERATOR_APPROVAL_GATED_FIELDS tuple
covered runner / allowed_read_globs / forbidden_read_globs /
declared_scope but NOT health_thresholds. A caller could rewrite the
precision_min, critical_false_positives, crash_rate_last_10, or
non_critical_false_positives_30d fields without operator approval —
silently disabling the demotion / quarantine triggers that gate ACTIVE
behavior.

Plus there was no range invariant on the threshold values: a caller
could set precision_min=0.0 (everything passes) or critical_false_
positives=999 (nothing ever quarantines) at registration time.

Plan 023 v3 §C-4 closes both:
1. health_thresholds added to _OPERATOR_APPROVAL_GATED_FIELDS — any
   update_tool() touching the field requires operator_approval_ref +
   reason and emits tool_health_thresholds_updated governance event.
2. Per-field range invariant enforced in validate_tool_definition AND
   on update_tool() merge:
     precision_min: float in [0.5, 1.0]
     critical_false_positives: int == 0
     crash_rate_last_10: float in [0.0, 0.5]
     non_critical_false_positives_30d: int in [1, 100]
   Out-of-range → GovernanceError('health_thresholds_out_of_range').

Tests:
1. update_tool with health_thresholds without operator_approval_ref → reject.
2. update_tool with valid approval + valid thresholds → accept +
   tool_health_thresholds_updated event emitted.
3. precision_min=0.4 (below floor) → reject `health_thresholds_out_of_range`.
4. precision_min=1.1 (above ceiling) → reject.
5. critical_false_positives=1 → reject (must be exactly 0).
6. crash_rate_last_10=0.6 (above ceiling) → reject.
7. registration with valid thresholds → accept (regression).
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import (
    GovernanceError,
    get_tool,
    register_tool,
    transition_tool,
    update_tool,
)


def _make_tool(tool_id: str = "alpha", health_overrides: dict | None = None) -> dict:
    health = {
        "precision_min": 0.85,
        "non_critical_false_positives_30d": 3,
        "critical_false_positives": 0,
        "crash_rate_last_10": 0.2,
    }
    if health_overrides:
        health.update(health_overrides)
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "owner": "platform",
        "schema_version": 2,
        "claim_types": ["fake"],
        "declared_scope": ["apps/**"],
        "allowed_read_globs": ["apps/**"],
        "forbidden_read_globs": [".git/**"],
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": health,
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


class HealthThresholdsApprovalGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c4-"))
        self.base = self.tmp / "aria-tools"
        self.base.mkdir()
        register_tool(_make_tool(), base_dir=self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _governance_lines(self) -> list[dict]:
        path = self.base / "governance.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().strip().splitlines() if line]

    def test_update_health_thresholds_without_approval_rejects(self) -> None:
        """Pre-Plan-023 this slipped through: update_tool({health_thresholds: ...})
        bypassed _OPERATOR_APPROVAL_GATED_FIELDS because the field was
        not in the tuple. Plan 023 §C-4 adds it; missing approval ref
        now hits the same gate as runner / scope changes."""
        with self.assertRaises(GovernanceError) as ctx:
            update_tool(
                "alpha",
                {"health_thresholds": {
                    "precision_min": 0.85,
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 0,
                    "crash_rate_last_10": 0.2,
                }},
                base_dir=self.base,
            )
        self.assertIn("operator_approval", str(ctx.exception))

    def test_update_health_thresholds_with_approval_accepts_and_emits_event(self) -> None:
        update_tool(
            "alpha",
            {"health_thresholds": {
                "precision_min": 0.90,
                "non_critical_false_positives_30d": 5,
                "critical_false_positives": 0,
                "crash_rate_last_10": 0.1,
            }},
            base_dir=self.base,
            operator_approval_ref="docs/operator/approval/123",
            reason="raise precision floor for ACTIVE-eligibility",
        )
        result = get_tool("alpha", base_dir=self.base)
        self.assertEqual(result["health_thresholds"]["precision_min"], 0.90)
        events = [e for e in self._governance_lines()
                  if e.get("kind") == "tool_health_thresholds_updated"]
        self.assertEqual(len(events), 1)
        details = events[0].get("details") or {}
        self.assertEqual(details.get("tool_id"), "alpha")

    def test_precision_min_below_floor_rejects(self) -> None:
        """precision_min < 0.5 effectively disables the demotion trigger
        — set the floor at 0.5 so the threshold remains meaningful."""
        with self.assertRaises(GovernanceError) as ctx:
            update_tool(
                "alpha",
                {"health_thresholds": {
                    "precision_min": 0.4,  # below 0.5 floor
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 0,
                    "crash_rate_last_10": 0.2,
                }},
                base_dir=self.base,
                operator_approval_ref="docs/operator/approval/123",
                reason="weaken precision",
            )
        self.assertIn("health_thresholds_out_of_range", str(ctx.exception))

    def test_precision_min_above_ceiling_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            update_tool(
                "alpha",
                {"health_thresholds": {
                    "precision_min": 1.1,  # above 1.0 ceiling
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 0,
                    "crash_rate_last_10": 0.2,
                }},
                base_dir=self.base,
                operator_approval_ref="docs/operator/approval/123",
                reason="impossible threshold",
            )
        self.assertIn("health_thresholds_out_of_range", str(ctx.exception))

    def test_critical_false_positives_nonzero_rejects(self) -> None:
        """critical_false_positives MUST be 0; even one critical FP must
        trigger immediate quarantine. A non-zero threshold disables that
        invariant."""
        with self.assertRaises(GovernanceError) as ctx:
            update_tool(
                "alpha",
                {"health_thresholds": {
                    "precision_min": 0.85,
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 1,  # MUST be 0
                    "crash_rate_last_10": 0.2,
                }},
                base_dir=self.base,
                operator_approval_ref="docs/operator/approval/123",
                reason="allow critical FP",
            )
        self.assertIn("health_thresholds_out_of_range", str(ctx.exception))

    def test_crash_rate_above_ceiling_rejects(self) -> None:
        """crash_rate_last_10 > 0.5 means more than half of recent runs
        crashed without the calibrate trigger firing — a runtime that
        broken should be QUARANTINED, not silently ACTIVE."""
        with self.assertRaises(GovernanceError) as ctx:
            update_tool(
                "alpha",
                {"health_thresholds": {
                    "precision_min": 0.85,
                    "non_critical_false_positives_30d": 3,
                    "critical_false_positives": 0,
                    "crash_rate_last_10": 0.6,  # above 0.5 ceiling
                }},
                base_dir=self.base,
                operator_approval_ref="docs/operator/approval/123",
                reason="weaken crash rate",
            )
        self.assertIn("health_thresholds_out_of_range", str(ctx.exception))

    def test_registration_with_invalid_thresholds_rejects(self) -> None:
        """Registration-time enforcement: the same range invariant fires
        on first register_tool call. Out-of-range thresholds at the
        manifest layer are caught before the row hits the registry."""
        bad = _make_tool(tool_id="beta", health_overrides={"critical_false_positives": 5})
        with self.assertRaises(GovernanceError) as ctx:
            register_tool(bad, base_dir=self.base)
        self.assertIn("health_thresholds_out_of_range", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
