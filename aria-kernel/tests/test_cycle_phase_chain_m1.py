"""Plan 022 M-1 — cycle phase chain (run_phases kwarg).

Pre-Plan-022 run_enterprise_cycle ran a fixed pipeline (discover ->
tools -> memory -> pressure -> reflection). Architecture spine gate,
validation matrix, and PR lifecycle were separate CLI surfaces;
operators had to invoke each manually.

Fix: run_enterprise_cycle accepts run_phases=tuple(...) opt-in
extension list. Default (None) preserves Plan 016 behaviour;
operators can opt into architecture_baseline / architecture_postcheck
/ validation_matrix / pr_lifecycle.
"""
from __future__ import annotations

import unittest

from aria_kernel.cycle import (
    DEFAULT_CYCLE_PHASES,
    SUPPORTED_CYCLE_PHASES,
    _run_extended_phases,
)


class CyclePhaseTaxonomyTests(unittest.TestCase):
    def test_default_phases_locked(self) -> None:
        self.assertEqual(DEFAULT_CYCLE_PHASES, (
            "discover", "tools", "memory", "pressure", "reflection",
        ))

    def test_extended_phases_locked(self) -> None:
        # Default + the 4 extension phases.
        self.assertEqual(set(SUPPORTED_CYCLE_PHASES) - set(DEFAULT_CYCLE_PHASES), {
            "architecture_baseline",
            "architecture_postcheck",
            "validation_matrix",
            "pr_lifecycle",
        })


class ExtendedPhaseDispatchTests(unittest.TestCase):
    def test_architecture_baseline_without_plan_id_skipped(self) -> None:
        from pathlib import Path
        result = _run_extended_phases(
            phases=("architecture_baseline",),
            workspace_root=Path("."),
            cycle_id="cyc-test",
            base_dir=Path("aria-tools"),
            plan_id=None,
        )
        self.assertEqual(result["architecture_baseline"]["status"], "skipped")
        self.assertEqual(result["architecture_baseline"]["reason"], "plan_id_required")

    def test_validation_matrix_phase_legacy_caller_no_op(self) -> None:
        # Plan 025 §C — pre-Plan-025 the phase returned an
        # "informational" notice; post-fix the phase invokes the real
        # gate per change_id but legacy callers without
        # cycle_started_at degrade to no_op (closed-loop wiring is
        # opt-in via the cycle-level run_enterprise_cycle path which
        # always passes the kwarg).
        from pathlib import Path
        result = _run_extended_phases(
            phases=("validation_matrix",),
            workspace_root=Path("."),
            cycle_id="cyc-test",
            base_dir=Path("aria-tools"),
            plan_id=None,
        )
        self.assertEqual(result["validation_matrix"]["status"], "no_op")
        self.assertEqual(result["validation_matrix"]["total"], 0)
        self.assertEqual(
            result["validation_matrix"].get("reason"),
            "cycle_started_at_required",
        )

    def test_pr_lifecycle_phase_no_eligible_proposals_no_op(self) -> None:
        # Plan 025 §C — pre-Plan-025 the phase returned an
        # "informational" notice; post-fix the phase iterates the
        # approved-for-apply proposals (none in this test fixture)
        # and returns no_op.
        from pathlib import Path
        result = _run_extended_phases(
            phases=("pr_lifecycle",),
            workspace_root=Path("."),
            cycle_id="cyc-test",
            base_dir=Path("aria-tools"),
            plan_id=None,
        )
        self.assertEqual(result["pr_lifecycle"]["status"], "no_op")
        self.assertEqual(result["pr_lifecycle"]["total"], 0)


class CycleRunPhasesUnknownTests(unittest.TestCase):
    def test_unknown_phase_raises_value_error(self) -> None:
        from aria_kernel.cycle import run_enterprise_cycle
        # Call with no real workspace; we only need the early phase-name
        # validation to fire.
        with self.assertRaises(ValueError) as cm:
            run_enterprise_cycle(
                workspace_root="/tmp/nonexistent-aria-m1",
                cycle_id="cyc-1",
                base_dir="/tmp/nonexistent-aria-m1/aria-tools",
                run_phases=("teleport",),
            )
        self.assertIn("teleport", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
