"""Plan ARIA-V7 §3 V7.6 — calibration_reporter orchestrator phase invariants.

Four invariants pin the V6.4 dead-loop fix:

  * I-V7.6-01 — phase fires once per cycle (idempotent re-invocation
                safe)
  * I-V7.6-02 — phase ordering on the converged path: AFTER
                auto_merge_runner, BEFORE reflection; AND since
                ORPHAN-HIGH-782 the phase also runs on the
                convergence-BLOCKED path (most nights), before its
                reflection
  * I-V7.6-03 — when no SHADOW/ACTIVE adapters exist, phase emits
                status="no_adapters" (NO crash, NO silent skip)
  * I-V7.6-04 — source-substring invariant pins the literal
                ``generate_adapter_calibration_report(`` call site in
                the extracted helper

ORPHAN-HIGH-782 rewrote 02/03/04: the block moved out of the converged-only
tail into `_calibration_reporter_and_auto_promotion`, because a reporter
gated on plan convergence left precision_history structurally empty
(zero rows on aria/state; non-converged nights skipped it entirely).
"""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV7_6CalibrationReporter(unittest.TestCase):
    # I-V7.6-01 — phase exists in AUTONOMY_PHASES.
    def test_i_v7_6_01_phase_registered(self) -> None:
        """Plan ARIA-V7 §3 V7.6 — calibration_reporter_completed phase."""
        from aria_kernel.autonomy_state import AUTONOMY_PHASES
        self.assertIn(
            "calibration_reporter_completed", AUTONOMY_PHASES,
            msg=(
                "Plan ARIA-V7 §3 V7.6 — calibration_reporter_completed "
                "MUST be in AUTONOMY_PHASES (discoverability hint)."
            ),
        )

    # I-V7.6-02 — phase ordering + the ORPHAN-HIGH-782 every-exit rule.
    def test_i_v7_6_02_runs_on_every_completed_cycle_before_reflection(self) -> None:
        """Every cycle-exit path runs the reporter before its reflection:
        converged, convergence-blocked, no-pressure and invalid-plan.
        A reporter gated on any single path starves precision_history on
        the others — the exact defect ORPHAN-HIGH-782 closed (the
        converged-only tail left adapter-calibration-reports.jsonl at
        zero rows on aria/state). The structural form: one helper call
        per reflection exit — a new exit branch that forgets the helper
        fails the count by construction."""
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        helper_calls = src.count("_calibration_reporter_and_auto_promotion(")
        reflection_exits = src.count("post_drain_reflection = run_reflection(")
        self.assertEqual(
            helper_calls, reflection_exits,
            msg=f"every cycle-exit reflection ({reflection_exits}) must be "
                f"preceded by its own calibration reporter call "
                f"(found {helper_calls}) — ORPHAN-HIGH-782",
        )
        idx_auto_merge = src.find("auto_merge_result = auto_merge_runner(")
        idx_calib_converged = src.rfind("_calibration_reporter_and_auto_promotion(")
        idx_reflection_last = src.rfind("post_drain_reflection = run_reflection(")
        self.assertNotEqual(idx_auto_merge, -1, "auto_merge_runner call marker missing")
        self.assertNotEqual(idx_calib_converged, -1, "calibration helper call marker missing")
        self.assertNotEqual(idx_reflection_last, -1, "reflection call marker missing")
        # Converged path order: auto_merge < helper(last) < reflection(last).
        self.assertLess(idx_auto_merge, idx_calib_converged)
        self.assertLess(idx_calib_converged, idx_reflection_last)

    # I-V7.6-03 — no adapters → status="no_adapters" (no crash).
    def test_i_v7_6_03_no_adapters_emits_status(self) -> None:
        """Empty tool registry → no_adapters status, in the helper that
        owns the block since ORPHAN-HIGH-782."""
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod._calibration_reporter_and_auto_promotion)
        self.assertIn(
            '"status": "no_adapters"', src,
            msg=(
                "Plan ARIA-V7 §3 V7.6 — the helper MUST emit "
                "status=no_adapters when tool registry has no "
                "SHADOW/ACTIVE adapters (operator visibility; no crash)."
            ),
        )

    # I-V7.6-04 — source-substring invariant.
    def test_i_v7_6_04_source_substring_pins_call_site(self) -> None:
        """Refactor-resistant V6.4 unlock.

        Literal call to ``generate_adapter_calibration_report(`` pinned
        inside the extracted helper. A refactor that drops or renames the
        call re-introduces the V6.4 dead loop (precision_history empty →
        compute_auto_promote_token always raises → auto-promote never
        fires).
        """
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod._calibration_reporter_and_auto_promotion)
        self.assertIn(
            "generate_adapter_calibration_report(",
            src,
            msg=(
                "Plan ARIA-V7 §3 V7.6 (I-V7.6-04) — the helper MUST "
                "contain the literal `generate_adapter_calibration_"
                "report(` call site. A refactor that drops it silently "
                "breaks V6.4 auto-promote."
            ),
        )


if __name__ == "__main__":
    unittest.main()
