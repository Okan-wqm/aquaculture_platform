"""Plan 031 Gate B — oscillation (ping-pong) guard tests.

What this suite pins:
- reopen_streak counts consecutive finding_reopened events and resets on a
  clean resolution (streak semantics, newest-first tail-scan).
- record_reopen is a pure counter (no HUMAN_REQUIRED side-effect).
- guard_fix_dispatch passes below the threshold and, at the threshold,
  escalates to HUMAN_REQUIRED + emits oscillation_escalated + raises to block
  the autonomous fix dispatch.
- record_resolution resets the streak so a later dispatch is allowed again.
- assert_fix_dispatch_allowed raises once oscillating, without escalating.
- The HUMAN_REQUIRED escalation is idempotent across repeated guard calls.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.human_required import list_human_required
from aria_kernel.oscillation_guard import (
    DEFAULT_OSCILLATION_THRESHOLD,
    assert_fix_dispatch_allowed,
    guard_fix_dispatch,
    record_reopen,
    record_resolution,
    reopen_streak,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


FP = "finding:abc123"


class OscillationGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-osc-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_streak_counts_and_resets(self) -> None:
        self.assertEqual(reopen_streak(fingerprint=FP, base_dir=self.tools), 0)
        record_reopen(fingerprint=FP, cycle_id="c1", base_dir=self.tools)
        record_reopen(fingerprint=FP, cycle_id="c2", base_dir=self.tools)
        self.assertEqual(reopen_streak(fingerprint=FP, base_dir=self.tools), 2)
        record_resolution(fingerprint=FP, cycle_id="c3", base_dir=self.tools)
        self.assertEqual(reopen_streak(fingerprint=FP, base_dir=self.tools), 0)

    def test_streak_is_per_fingerprint(self) -> None:
        record_reopen(fingerprint=FP, cycle_id="c1", base_dir=self.tools)
        record_reopen(fingerprint="finding:other", cycle_id="c1", base_dir=self.tools)
        self.assertEqual(reopen_streak(fingerprint=FP, base_dir=self.tools), 1)
        self.assertEqual(
            reopen_streak(fingerprint="finding:other", base_dir=self.tools), 1
        )

    def test_record_reopen_has_no_human_required_side_effect(self) -> None:
        record_reopen(fingerprint=FP, cycle_id="c1", base_dir=self.tools)
        self.assertEqual(list_human_required(base_dir=self.tools), [])

    def test_guard_passes_below_threshold(self) -> None:
        record_reopen(fingerprint=FP, cycle_id="c1", base_dir=self.tools)
        result = guard_fix_dispatch(
            fingerprint=FP, cycle_id="c2", base_dir=self.tools,
        )
        self.assertFalse(result["blocked"])
        self.assertEqual(result["streak"], 1)

    def test_three_reopens_escalate_and_block(self) -> None:
        for i in range(DEFAULT_OSCILLATION_THRESHOLD):
            record_reopen(fingerprint=FP, cycle_id=f"c{i}", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            guard_fix_dispatch(fingerprint=FP, cycle_id="c-final", base_dir=self.tools)
        self.assertIn("oscillation_fix_dispatch_blocked", str(cm.exception))

        # HUMAN_REQUIRED record was created with the oscillation context.
        pending = list_human_required(base_dir=self.tools)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["severity"], "HIGH")
        self.assertEqual(pending[0]["context"]["kind"], "oscillation")
        self.assertEqual(
            pending[0]["context"]["reopen_count"], DEFAULT_OSCILLATION_THRESHOLD
        )

        # An oscillation_escalated governance event was emitted.
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        kinds = [json.loads(line)["kind"] for line in governance.splitlines() if line.strip()]
        self.assertIn("oscillation_escalated", kinds)

    def test_assert_blocks_when_oscillating_without_escalating(self) -> None:
        for i in range(DEFAULT_OSCILLATION_THRESHOLD):
            record_reopen(fingerprint=FP, cycle_id=f"c{i}", base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            assert_fix_dispatch_allowed(fingerprint=FP, base_dir=self.tools)
        # Read-only: no escalation written.
        self.assertEqual(list_human_required(base_dir=self.tools), [])

    def test_resolution_unblocks_dispatch(self) -> None:
        for i in range(DEFAULT_OSCILLATION_THRESHOLD):
            record_reopen(fingerprint=FP, cycle_id=f"c{i}", base_dir=self.tools)
        record_resolution(fingerprint=FP, cycle_id="c-fix", base_dir=self.tools)
        # Streak reset → dispatch allowed again, no raise.
        assert_fix_dispatch_allowed(fingerprint=FP, base_dir=self.tools)
        result = guard_fix_dispatch(fingerprint=FP, cycle_id="c-next", base_dir=self.tools)
        self.assertFalse(result["blocked"])

    def test_escalation_is_idempotent(self) -> None:
        for i in range(DEFAULT_OSCILLATION_THRESHOLD):
            record_reopen(fingerprint=FP, cycle_id=f"c{i}", base_dir=self.tools)
        for _ in range(2):
            with self.assertRaises(GovernanceError):
                guard_fix_dispatch(fingerprint=FP, cycle_id="c-final", base_dir=self.tools)
        # Still exactly one HUMAN_REQUIRED record.
        self.assertEqual(len(list_human_required(base_dir=self.tools)), 1)


if __name__ == "__main__":
    unittest.main()
