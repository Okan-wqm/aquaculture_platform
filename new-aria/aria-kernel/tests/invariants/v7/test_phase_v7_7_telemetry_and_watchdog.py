"""Plan ARIA-V7 §3 V7.7 — reflection v3 + analyzer + watchdog invariants.

Five invariants pin the V7.7 surfaces:

  * I-V7.7-01 — reflection v3 carries skill_genesis + calibration +
                cycle_runner sub-objects when orchestrator-path
                supplies them
  * I-V7.7-02 — direct CLI emits null sentinels for all 3 sub-objects
  * I-V7.7-03 — schema_version >= 3 emitted (additive bump)
  * I-V7.7-04 — source-substring invariant pins the literal
                ``_cycle_started_at = time.monotonic()`` watchdog
                marker
  * I-V7.7-05 — cycle_deadline_seconds default is 1800 (operator-
                tunable; non-Optional, has default per Tier-2)
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


class PhaseV7_7TelemetryAndWatchdog(unittest.TestCase):
    # I-V7.7-01 — reflection v3 carries V7 sub-objects.
    def test_i_v7_7_01_reflection_carries_v7_sub_objects(self) -> None:
        """Plan ARIA-V7 §3 V7.7 — orchestrator-path populates sub-objects."""
        import tempfile, shutil
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_3._helpers import clear_aria_tools_env, restore_aria_tools_env
        env = clear_aria_tools_env()
        tmp = Path(tempfile.mkdtemp(prefix="aria-v7_7-01-"))
        base = tmp / "aria-tools"
        try:
            set_profile("standard", operator_approval_ref="v7_7-test", base_dir=base)
            reflection = run_reflection(
                cycle_id="cyc-v7-7-01",
                base_dir=base,
                skill_genesis_result={"aggregate_verdict": "no_requests"},
                calibration_result={"status": "ok"},
                cycle_runner_result={"status": "synthesized"},
            )
            self.assertIsNotNone(reflection.get("skill_genesis"))
            self.assertIsNotNone(reflection.get("calibration"))
            self.assertIsNotNone(reflection.get("cycle_runner"))
        finally:
            restore_aria_tools_env(env)
            shutil.rmtree(tmp, ignore_errors=True)

    # I-V7.7-02 — null sentinels on direct CLI path.
    def test_i_v7_7_02_null_sentinels_direct_cli(self) -> None:
        """Plan ARIA-V7 §3 V7.7 — None kwargs → null sub-objects."""
        import tempfile, shutil
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_3._helpers import clear_aria_tools_env, restore_aria_tools_env
        env = clear_aria_tools_env()
        tmp = Path(tempfile.mkdtemp(prefix="aria-v7_7-02-"))
        base = tmp / "aria-tools"
        try:
            set_profile("standard", operator_approval_ref="v7_7-test", base_dir=base)
            reflection = run_reflection(
                cycle_id="cyc-v7-7-02",
                base_dir=base,
            )
            self.assertIsNone(reflection.get("skill_genesis"))
            self.assertIsNone(reflection.get("calibration"))
            self.assertIsNone(reflection.get("cycle_runner"))
        finally:
            restore_aria_tools_env(env)
            shutil.rmtree(tmp, ignore_errors=True)

    # I-V7.7-03 — schema_version >= 3.
    def test_i_v7_7_03_schema_version_v3(self) -> None:
        """Plan ARIA-V7 §3 V7.7 — schema 2 → 3 (additive bump)."""
        import tempfile, shutil
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_3._helpers import clear_aria_tools_env, restore_aria_tools_env
        env = clear_aria_tools_env()
        tmp = Path(tempfile.mkdtemp(prefix="aria-v7_7-03-"))
        base = tmp / "aria-tools"
        try:
            set_profile("standard", operator_approval_ref="v7_7-test", base_dir=base)
            reflection = run_reflection(cycle_id="cyc-v7-7-03", base_dir=base)
            self.assertGreaterEqual(
                reflection.get("schema_version"), 3,
                msg="Plan ARIA-V7 §3 V7.7 — schema_version MUST be >=3",
            )
        finally:
            restore_aria_tools_env(env)
            shutil.rmtree(tmp, ignore_errors=True)

    # I-V7.7-04 — source-substring invariant pins watchdog.
    def test_i_v7_7_04_source_substring_pins_watchdog(self) -> None:
        """Plan ARIA-V7 §3 V7.7 — refactor-resistant deadline watchdog."""
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        # The literal time.monotonic() pair must appear.
        self.assertIn(
            "_cycle_started_at = time.monotonic()", src,
            msg=(
                "Plan ARIA-V7 §3 V7.7 (I-V7.7-04) — orchestrator MUST "
                "contain the literal `_cycle_started_at = time.monotonic()` "
                "marker. Refactor that drops it breaks per-cycle "
                "deadline watchdog and re-introduces silent-hang risk."
            ),
        )
        self.assertIn(
            "_deadline_hit = (time.monotonic() - _cycle_started_at) >= cycle_deadline_seconds",
            src,
            msg=(
                "Plan ARIA-V7 §3 V7.7 (I-V7.7-04) — orchestrator MUST "
                "contain the literal deadline-check predicate."
            ),
        )

    # I-V7.7-05 — cycle_deadline_seconds default.
    def test_i_v7_7_05_cycle_deadline_seconds_default(self) -> None:
        """Plan ARIA-V7 §3 V7.7 — operator-tunable default."""
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn("cycle_deadline_seconds", sig.parameters)
        param = sig.parameters["cycle_deadline_seconds"]
        self.assertEqual(
            param.default, 1800.0,
            msg=(
                "Plan ARIA-V7 §3 V7.7 — cycle_deadline_seconds default "
                "MUST be 1800.0 (30 min). Operator-tunable via CLI flag "
                "or policy override."
            ),
        )


if __name__ == "__main__":
    unittest.main()
