"""C9/E8 — a blocked task candidate must NOT become a persistent mission.

Live proof of the defect: all three `shadow_run_summary` missions standing on
the store originated from task candidates carrying
`blocked_by=["operator_feedback_required"]`. `adopt_task_candidates` read the
candidate's `source`/`source_id` but never its `blocked_by`, so it opened a
mission for work that cannot run — and a mission mints an agent request. The
pressure path already refuses a blocked item (reflection.py: "A blocked
pressure is operator-facing work, not schedulable work"); the mission path had
re-opened the same door. This pins the guard so it cannot regress: a blocked
candidate is REFUSED and recorded, never adopted; an identical-but-unblocked
candidate still adopts.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import load_jsonl
from aria_kernel.mission import adopt_task_candidates, list_open_missions
from aria_kernel.tool_registry import ensure_tools_dir

REPO_HASH = "repohash0001"


class AdoptBlockedGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = ensure_tools_dir(self.base)

    def _write_pressures(self, cycle_id: str, pressures: list[dict]) -> None:
        pdir = self.root / "pressure"
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / f"{cycle_id}.json").write_text(
            json.dumps({"schema_version": 1, "pressures": pressures})
        )

    def test_blocked_candidate_is_refused_not_adopted(self) -> None:
        cycle_id = "cyc-2026-08-12"
        self._write_pressures(
            cycle_id,
            [
                {
                    "pressure_id": "pe-blocked",
                    "score": 90,
                    "reason": "needs operator",
                    "blocked_by": ["operator_feedback_required"],
                },
                {
                    "pressure_id": "pe-open",
                    "score": 80,
                    "reason": "schedulable",
                    "blocked_by": [],
                },
            ],
        )
        result = adopt_task_candidates(
            cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
        )
        # The blocked candidate is refused; only the unblocked one adopts.
        self.assertEqual(result["adopted"], 1)
        self.assertGreaterEqual(result["refused"], 1)

        # No mission exists for the blocked source_id.
        open_ids = {m.get("source_id") for m in list_open_missions(base_dir=self.base)}
        self.assertIn("pe-open", open_ids)
        self.assertNotIn("pe-blocked", open_ids)

        # The refusal is RECORDED, never dropped in silence.
        reasons = [
            row.get("details", {}).get("reason")
            for row in load_jsonl(self.root / "governance.jsonl")
            if row.get("kind") == "mission_candidate_refused"
        ]
        self.assertIn("candidate_blocked", reasons)

    def test_unblocked_candidate_still_adopts(self) -> None:
        cycle_id = "cyc-2026-08-12b"
        self._write_pressures(
            cycle_id,
            [{"pressure_id": "pe-solo", "score": 70, "reason": "go", "blocked_by": []}],
        )
        result = adopt_task_candidates(
            cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
        )
        self.assertEqual(result["adopted"], 1)


if __name__ == "__main__":
    unittest.main()
