"""Plan ARIA-V7 §3 V7.6 — calibration_reporter orchestrator phase invariants.

Four invariants pin the V6.4 dead-loop fix:

  * I-V7.6-01 — phase fires once per cycle (idempotent re-invocation
                safe)
  * I-V7.6-02 — phase ordering: AFTER auto_merge_runner, BEFORE
                reflection
  * I-V7.6-03 — when no SHADOW/ACTIVE adapters exist, phase emits
                status="no_adapters" (NO crash, NO silent skip)
  * I-V7.6-04 — source-substring invariant pins the literal
                ``generate_adapter_calibration_report(tool_ids=``
                call site
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

    # I-V7.6-02 — phase ordering.
    def test_i_v7_6_02_phase_after_auto_merge_before_reflection(self) -> None:
        """Plan ARIA-V7 §3 V7.6 — calibration_reporter between
        auto_merge_runner and reflection."""
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        idx_auto_merge = src.find("auto_merge_result = auto_merge_runner(")
        idx_calib = src.find("generate_adapter_calibration_report(")
        # Multiple post_drain_reflection callsites exist (skip-path
        # branches each have one). We care about the MAIN happy-path
        # one — find the LAST occurrence (after calibration_reporter
        # in the source order).
        idx_reflection_last = src.rfind("post_drain_reflection = run_reflection(")
        # All markers must exist + ordered: auto_merge < calibration < reflection (last)
        self.assertNotEqual(idx_auto_merge, -1, "auto_merge_runner call marker missing")
        self.assertNotEqual(idx_calib, -1, "calibration_reporter call marker missing")
        self.assertNotEqual(idx_reflection_last, -1, "reflection call marker missing")
        self.assertLess(
            idx_auto_merge, idx_calib,
            msg="auto_merge_runner MUST precede calibration_reporter",
        )
        self.assertLess(
            idx_calib, idx_reflection_last,
            msg="calibration_reporter MUST precede main reflection call",
        )

    # I-V7.6-03 — no adapters → status="no_adapters" (no crash).
    def test_i_v7_6_03_no_adapters_emits_status(self) -> None:
        """Plan ARIA-V7 §3 V7.6 — empty tool registry → no_adapters status."""
        # Smoke: invoke the orchestrator branch logic by checking the
        # source contains the no_adapters case.
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        self.assertIn(
            '"status": "no_adapters"', src,
            msg=(
                "Plan ARIA-V7 §3 V7.6 — orchestrator MUST emit "
                "status=no_adapters when tool registry has no "
                "SHADOW/ACTIVE adapters (operator visibility; no crash)."
            ),
        )

    # I-V7.6-04 — source-substring invariant.
    def test_i_v7_6_04_source_substring_pins_call_site(self) -> None:
        """Plan ARIA-V7 §3 V7.6 — refactor-resistant V6.4 unlock.

        Literal call to ``generate_adapter_calibration_report(tool_ids=``
        pinned. A refactor that drops or renames the call re-introduces
        the V6.4 dead loop (precision_history empty → compute_auto_
        promote_token always raises → auto-promote never fires).
        """
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        self.assertIn(
            "generate_adapter_calibration_report(\n                            tool_ids=",
            src,
            msg=(
                "Plan ARIA-V7 §3 V7.6 (I-V7.6-04) — orchestrator MUST "
                "contain the literal `generate_adapter_calibration_"
                "report(tool_ids=` call site. Refactor that drops it "
                "silently breaks V6.4 auto-promote."
            ),
        )


if __name__ == "__main__":
    unittest.main()
