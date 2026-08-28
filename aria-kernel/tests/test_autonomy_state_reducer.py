"""Plan 026R §F.3 — AutonomyState dataclass + reducer derive_current.

6 tests:

* Empty ledger → empty AutonomyState.
* Transition writes a hash-chained row.
* derive_current counts cycle_completed rows.
* derive_current sums planner/worker deltas.
* aria_stop_active true only when ``aria_stop`` row follows the
  most recent ``cycle_started`` row.
* derive_current uses verify-on-read (§F.4 — tampered row raises).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.autonomy_state import (
    AUTONOMY_PHASES,
    AutonomyState,
    AutonomyStateReducer,
    autonomy_state_path,
    fold_autonomy_state_rows,
)
from aria_kernel.ledger import LedgerIntegrityError
from aria_kernel.runtime_profile import set_profile


class AutonomyStateReducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f3-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="f3-t", base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_ledger_returns_default_state(self) -> None:
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertIsInstance(state, AutonomyState)
        self.assertEqual(state.transition_count, 0)
        self.assertEqual(state.cycles_completed, 0)
        self.assertIsNone(state.last_cycle_id)
        self.assertFalse(state.aria_stop_active)

    def test_transition_writes_hash_chained_row(self) -> None:
        row = AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-test-1",
            phase="cycle_started",
            status="ok",
        )
        self.assertIn("ledger_hash", row)
        self.assertEqual(row["phase"], "cycle_started")
        # Second row chains off the first.
        row2 = AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-test-1",
            phase="cycle_completed",
            status="ok",
        )
        self.assertEqual(
            row2["previous_ledger_hash"], row["ledger_hash"],
        )

    def test_derive_current_counts_cycles_completed(self) -> None:
        for i in range(3):
            AutonomyStateReducer.transition(
                self.base,
                cycle_id=f"cyc-{i}",
                phase="cycle_started",
            )
            AutonomyStateReducer.transition(
                self.base,
                cycle_id=f"cyc-{i}",
                phase="cycle_completed",
            )
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(state.cycles_completed, 3)
        self.assertEqual(state.last_cycle_id, "cyc-2")
        self.assertEqual(state.last_phase, "cycle_completed")

    def test_derive_current_sums_planner_and_worker_deltas(self) -> None:
        AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-d",
            phase="planner_dispatch_drained",
            planner_claims_delta=3,
        )
        AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-d",
            phase="worker_dispatch_drained",
            worker_assignments_delta=5,
            auto_merges_delta=2,
        )
        AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-d2",
            phase="planner_dispatch_drained",
            planner_claims_delta=1,
        )
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertEqual(state.planner_claims_dispatched, 4)
        self.assertEqual(state.worker_assignments_dispatched, 5)
        self.assertEqual(state.auto_merges_completed, 2)

    def test_pure_fold_preserves_latest_scalars_sums_and_stop_semantics(self) -> None:
        rows = [
            {
                "cycle_id": "cycle-1",
                "phase": "cycle_started",
                "status": "ok",
                "recorded_at": "2026-08-22T01:00:00Z",
                "planner_claims_delta": 2,
                "pending_bridge_count": 4,
                "profile": "observe",
            },
            {
                "cycle_id": "cycle-1",
                "phase": "cycle_completed",
                "status": "ok",
                "recorded_at": "2026-08-22T02:00:00Z",
                "worker_assignments_delta": 3,
                "auto_merges_delta": 1,
                "human_required_count": 2,
            },
            {
                "cycle_id": None,
                "phase": "aria_stop",
                "status": "degraded",
                "recorded_at": "2026-08-22T03:00:00Z",
                "planner_claims_delta": 1,
            },
        ]

        state = fold_autonomy_state_rows(rows)

        self.assertEqual(state.last_cycle_id, "cycle-1")
        self.assertEqual(state.last_phase, "aria_stop")
        self.assertEqual(state.last_phase_status, "degraded")
        self.assertEqual(state.cycles_completed, 1)
        self.assertEqual(state.planner_claims_dispatched, 3)
        self.assertEqual(state.worker_assignments_dispatched, 3)
        self.assertEqual(state.auto_merges_completed, 1)
        self.assertEqual(state.pending_bridge_count, 4)
        self.assertEqual(state.human_required_count, 2)
        self.assertEqual(state.profile, "observe")
        self.assertTrue(state.aria_stop_active)
        self.assertEqual(state.transition_count, 3)

    def test_aria_stop_active_only_after_latest_cycle_started(
        self,
    ) -> None:
        AutonomyStateReducer.transition(
            self.base, cycle_id=None, phase="aria_stop",
        )
        state = AutonomyStateReducer.derive_current(self.base)
        self.assertTrue(state.aria_stop_active)
        # New cycle_started clears the stop.
        AutonomyStateReducer.transition(
            self.base, cycle_id="cyc-new", phase="cycle_started",
        )
        state2 = AutonomyStateReducer.derive_current(self.base)
        self.assertFalse(state2.aria_stop_active)
        # Newer aria_stop re-arms.
        AutonomyStateReducer.transition(
            self.base, cycle_id=None, phase="aria_stop",
        )
        state3 = AutonomyStateReducer.derive_current(self.base)
        self.assertTrue(state3.aria_stop_active)

    def test_derive_current_uses_verify_on_read_strict(self) -> None:
        # Write a valid row, then tamper the ledger so the chain breaks.
        AutonomyStateReducer.transition(
            self.base,
            cycle_id="cyc-tamper",
            phase="cycle_started",
        )
        path = autonomy_state_path(self.base)
        text = path.read_text(encoding="utf-8")
        # Corrupt: rewrite the ledger_hash field to a bogus value.
        line = text.splitlines()[0]
        row = json.loads(line)
        row["ledger_hash"] = "sha256:" + ("0" * 64)
        path.write_text(json.dumps(row) + "\n", encoding="utf-8")
        with self.assertRaises(LedgerIntegrityError):
            AutonomyStateReducer.derive_current(self.base)

    def test_autonomy_phases_list_includes_documented_names(
        self,
    ) -> None:
        # Sanity: the constant must enumerate every phase used by §F.1.
        required = {
            "cycle_started", "cycle_completed",
            "planner_dispatch_drained", "bridge_drained",
            "worker_dispatch_drained", "aria_stop",
            "profile_frozen", "max_cycles_reached",
        }
        self.assertTrue(required.issubset(set(AUTONOMY_PHASES)))


if __name__ == "__main__":
    unittest.main()
