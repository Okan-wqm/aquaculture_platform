"""Plan ARIA-V3 Phase B0 — cost circuit breaker.

Closes INFRA-CRITICAL-001. Locked invariants (5 cases):

  * I-V3-B0a — daily cap exceeded trips the breaker.
  * I-V3-B0b — monthly cap exceeded trips the breaker.
  * I-V3-B0c — per-run cap exceeded trips the breaker.
  * I-V3-B0d — tripped breaker emits ``cost_budget_breaker_tripped``
    governance event with cap_name + amounts.
  * I-V3-B0e — breaker state survives kernel restart (cold-start
    reads disk).
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _write_policy(base_dir: Path, caps: dict[str, float]) -> None:
    # Plan ARIA-V3 §B0 — operator override at
    # ``<workspace_root>/aria-config/genesis_policy.json`` (underscore;
    # OVERRIDE_RELPATH in aria_kernel/genesis_policy.py).
    policy_path = base_dir.parent / "aria-config" / "genesis_policy.json"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(
        json.dumps(
            {
                "enable_request_generation": True,
                "max_requests_per_cycle": 5,
                "materialization_requires_acknowledge": True,
                "fitness_staleness_threshold_days": 14,
                "cost_caps_usd": caps,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


class PhaseB0CostBudget(unittest.TestCase):
    def test_i_v3_b0a_daily_cap_exceeded_trips(self) -> None:
        from aria_kernel.cost_budget import (
            assert_within_budget,
            current_state,
            record_actual_usage,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0a-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1.0, "monthly": 100.0, "per_run": 0.5})
            # Burn down most of the daily cap legitimately.
            record_actual_usage(base, actual_usd=0.9)
            self.assertEqual(current_state(base), "ok")
            with self.assertRaises(GovernanceError) as ctx:
                assert_within_budget(base, estimated_run_usd=0.5)
            self.assertIn("daily_cap_exceeded", str(ctx.exception))
            self.assertEqual(current_state(base), "tripped")

    def test_i_v3_b0b_monthly_cap_exceeded_trips(self) -> None:
        from aria_kernel.cost_budget import (
            assert_within_budget,
            current_state,
            record_actual_usage,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0b-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1000.0, "monthly": 1.0, "per_run": 0.5})
            record_actual_usage(base, actual_usd=0.9)
            with self.assertRaises(GovernanceError) as ctx:
                assert_within_budget(base, estimated_run_usd=0.5)
            self.assertIn("monthly_cap_exceeded", str(ctx.exception))
            self.assertEqual(current_state(base), "tripped")

    def test_i_v3_b0c_per_run_cap_exceeded_trips(self) -> None:
        from aria_kernel.cost_budget import (
            assert_within_budget,
            current_state,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0c-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1000.0, "monthly": 1000.0, "per_run": 0.10})
            with self.assertRaises(GovernanceError) as ctx:
                assert_within_budget(base, estimated_run_usd=0.50)
            self.assertIn("per_run_cap_exceeded", str(ctx.exception))
            self.assertEqual(current_state(base), "tripped")

    def test_i_v3_b0d_tripped_breaker_emits_audit_row(self) -> None:
        from aria_kernel.cost_budget import assert_within_budget
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0d-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1000.0, "monthly": 1000.0, "per_run": 0.10})
            try:
                assert_within_budget(base, estimated_run_usd=0.99)
            except GovernanceError:
                pass
            gov_path = base / "governance.jsonl"
            self.assertTrue(gov_path.exists())
            kinds = [
                json.loads(line).get("kind")
                for line in gov_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertIn("cost_budget_breaker_tripped", kinds)
            trip_rows = [
                json.loads(line)
                for line in gov_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
                and json.loads(line).get("kind") == "cost_budget_breaker_tripped"
            ]
            self.assertEqual(len(trip_rows), 1)
            details = trip_rows[0]["details"]
            self.assertIn("cap_name", details)
            self.assertIn("amount_usd", details)
            self.assertIn("cap_usd", details)

    def test_i_v3_b0e_breaker_state_survives_kernel_restart(self) -> None:
        """Plan ARIA-V3 §B0 — kernel restart simulates by clearing
        the in-memory state (no in-memory state to clear in the
        first place; state is disk-only). Just re-read after a
        trip and confirm ``current_state`` still says ``tripped``.
        """
        from aria_kernel.cost_budget import (
            assert_within_budget,
            current_state,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0e-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1.0, "monthly": 100.0, "per_run": 0.5})
            try:
                assert_within_budget(base, estimated_run_usd=0.99)
                # Try again to push over the daily cap (already 0.99
                # estimated, so the next probe with 0.5 trips). The
                # first call may or may not raise depending on
                # current_state implementation; force the trip.
            except GovernanceError:
                pass
            try:
                assert_within_budget(base, estimated_run_usd=0.99)
            except GovernanceError:
                pass
            self.assertEqual(current_state(base), "tripped")
            # Simulate restart: drop Python references, re-import.
            import importlib
            import aria_kernel.cost_budget as cb
            importlib.reload(cb)
            self.assertEqual(cb.current_state(base), "tripped")

    def test_reset_breaker_clears_state(self) -> None:
        from aria_kernel.cost_budget import (
            assert_within_budget,
            current_state,
            reset_breaker,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-b0f-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_policy(base, {"daily": 1.0, "monthly": 100.0, "per_run": 0.5})
            try:
                assert_within_budget(base, estimated_run_usd=0.99)
            except GovernanceError:
                pass
            try:
                assert_within_budget(base, estimated_run_usd=0.99)
            except GovernanceError:
                pass
            self.assertEqual(current_state(base), "tripped")
            reset_breaker(
                base_dir=base,
                reason="invariant b0 reset test",
                operator_approval_ref="RFC-RST",
            )
            self.assertEqual(current_state(base), "ok")


if __name__ == "__main__":
    unittest.main()
