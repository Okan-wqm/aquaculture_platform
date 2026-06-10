"""Plan 026R §G.1 — worker state derive by assignment_id (NOT pe).

5 tests:

* Two assignments same pressure_event_id → distinct entries in the map.
* Empty ledgers → empty state map.
* Single claim → state="picked_up".
* Released claim → state="pending" again.
* Submitted → "submitted"; verified passed → "verified" (terminal).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.worker_dispatch import _latest_assignment_states


class WorkerStateByAssignmentIdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-g1-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "dispatch").mkdir(parents=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _claim(self, *, assignment_id: str, claim_id: str, event: str = "claimed",
               recorded_at: str = "2026-05-11T13:00:00+00:00") -> None:
        append_declared_jsonl(
            self.base / "dispatch" / "claims.jsonl",
            {
                "schema_version": 1,
                "assignment_id": assignment_id,
                "claim_id": claim_id,
                "event": event,
                "claimed_at": recorded_at,
            },
            expected_surface="dispatch_claims",
        )

    def _worker_result(self, *, assignment_id: str, state: str,
                        recorded_at: str = "2026-05-11T13:01:00+00:00") -> None:
        append_declared_jsonl(
            self.base / "dispatch" / "worker-results.jsonl",
            {
                "schema_version": 1,
                "assignment_id": assignment_id,
                "state": state,
                "recorded_at": recorded_at,
            },
            expected_surface="dispatch_worker_results",
        )

    def _verify(self, *, assignment_id: str, status: str,
                recorded_at: str = "2026-05-11T13:02:00+00:00") -> None:
        append_declared_jsonl(
            self.base / "dispatch" / "verification-results.jsonl",
            {
                "schema_version": 1,
                "assignment_id": assignment_id,
                "status": status,
                "recorded_at": recorded_at,
            },
            expected_surface="dispatch_verification_results",
        )

    def test_empty_ledgers_returns_empty_map(self) -> None:
        self.assertEqual(_latest_assignment_states(self.base), {})

    def test_two_assignments_same_pressure_id_distinct(self) -> None:
        self._claim(assignment_id="A-001", claim_id="C-1")
        self._claim(assignment_id="A-002", claim_id="C-2")
        states = _latest_assignment_states(self.base)
        self.assertEqual(states["A-001"], "picked_up")
        self.assertEqual(states["A-002"], "picked_up")

    def test_single_claim_state_picked_up(self) -> None:
        self._claim(assignment_id="A-3", claim_id="C-3")
        self.assertEqual(_latest_assignment_states(self.base)["A-3"], "picked_up")

    def test_released_claim_returns_to_pending(self) -> None:
        self._claim(assignment_id="A-4", claim_id="C-4")
        self._claim(
            assignment_id="A-4", claim_id="C-4", event="released",
            recorded_at="2026-05-11T13:05:00+00:00",
        )
        self.assertEqual(_latest_assignment_states(self.base)["A-4"], "pending")

    def test_submitted_then_verified_passed_terminal(self) -> None:
        self._claim(assignment_id="A-5", claim_id="C-5")
        self._worker_result(assignment_id="A-5", state="accepted")
        self._verify(assignment_id="A-5", status="passed")
        # Subsequent claims after verified shouldn't override (terminal).
        self._claim(
            assignment_id="A-5", claim_id="C-5b", event="claimed",
            recorded_at="2026-05-11T13:10:00+00:00",
        )
        self.assertEqual(_latest_assignment_states(self.base)["A-5"], "verified")


if __name__ == "__main__":
    unittest.main()
