"""Plan 026R §F.2 — next_cycle_queue bounded scheduler queue.

4 tests:

* append + read_pending round-trip.
* depth cap blocks above ARIA_NEXT_CYCLE_QUEUE_DEPTH.
* mark_consumed excludes from read_pending.
* read_pending limit honored.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from aria_kernel.next_cycle_queue import (
    DEFAULT_QUEUE_DEPTH,
    QUEUE_DEPTH_ENV,
    append_pending,
    mark_consumed,
    queue_depth,
    read_pending,
)
from aria_kernel.runtime_profile import set_profile


class NextCycleQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f2-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f2-t", base_dir=self.base,
        )
        # Reset any prior env override.
        self._prior_env = os.environ.pop(QUEUE_DEPTH_ENV, None)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._prior_env is not None:
            os.environ[QUEUE_DEPTH_ENV] = self._prior_env
        else:
            os.environ.pop(QUEUE_DEPTH_ENV, None)

    def test_append_and_read_pending_round_trip(self) -> None:
        row = append_pending(
            self.base,
            source_cycle_id="cyc-2026-05-11",
            pressure_id="pe-1",
            recommended_action="run-tool-X",
            candidate_tools=["tool-a", "tool-b"],
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["state"], "pending")
        self.assertIn("queue_item_id", row)
        pending = read_pending(self.base)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["pressure_id"], "pe-1")
        self.assertEqual(
            pending[0]["candidate_tools"], ["tool-a", "tool-b"],
        )

    def test_depth_cap_blocks_excess_appends(self) -> None:
        os.environ[QUEUE_DEPTH_ENV] = "3"
        self.assertEqual(queue_depth(), 3)
        for i in range(3):
            row = append_pending(
                self.base,
                source_cycle_id="cyc-c",
                pressure_id=f"pe-{i}",
            )
            self.assertIsNotNone(row)
        # 4th append must hit the cap.
        overflow = append_pending(
            self.base,
            source_cycle_id="cyc-c",
            pressure_id="pe-overflow",
        )
        self.assertIsNone(overflow)
        self.assertEqual(len(read_pending(self.base)), 3)

    def test_mark_consumed_excludes_from_pending(self) -> None:
        row = append_pending(
            self.base,
            source_cycle_id="cyc-c",
            pressure_id="pe-x",
        )
        assert row is not None
        qid = row["queue_item_id"]
        self.assertEqual(len(read_pending(self.base)), 1)
        mark_consumed(
            self.base,
            queue_item_id=qid,
            consumed_by="test-consumer",
        )
        self.assertEqual(read_pending(self.base), [])

    def test_read_pending_limit_truncates(self) -> None:
        for i in range(5):
            append_pending(
                self.base,
                source_cycle_id="cyc-c",
                pressure_id=f"pe-{i}",
            )
        self.assertEqual(len(read_pending(self.base, limit=2)), 2)
        self.assertEqual(len(read_pending(self.base, limit=10)), 5)


if __name__ == "__main__":
    unittest.main()
