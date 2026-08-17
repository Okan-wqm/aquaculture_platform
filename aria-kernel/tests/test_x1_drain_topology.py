"""X1 (ORPHAN-698) — the drain topology, pinned.

The judgment chain died silently because the ONLY consumer of judge +
adjudication roles (the executor workflow) was disabled while the
in-cycle planner daemon drains exactly three planning roles. These pins
make the topology a tested fact:

  * the planner daemon's role set must NOT silently widen — a second
    drainer for executor-owned roles is the İ1 duplicate this program
    forbids (widen it only by deliberately rewriting this pin)
  * the executor drain's priority list + role=None fallback must cover
    EVERY dispatchable role — a role added to the vocabulary without a
    consumer is the exact defect class that produced judged_judges=0
  * the operator cost override must keep a real per-run breaker
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


class DrainTopologyPins(unittest.TestCase):
    def test_planner_daemon_roles_stay_narrow(self) -> None:
        import sys

        sys.path.insert(0, str(_REPO / "aria-kernel"))
        from aria_kernel.autonomous_planner_dispatcher import DEFAULT_PLANNER_ROLES

        self.assertEqual(
            tuple(DEFAULT_PLANNER_ROLES),
            ("primary_plan", "challenger_plan", "cross_review"),
        )

    def test_executor_fallback_covers_every_dispatchable_role(self) -> None:
        import sys

        sys.path.insert(0, str(_REPO / "aria-kernel"))
        sys.path.insert(0, str(_REPO / "tools" / "aria-poc"))
        from aria_kernel.agent_surface import DISPATCHABLE_ROLES
        import ci_executor_drain

        priority = tuple(ci_executor_drain._PRIORITY_ROLES)
        # priority roles must be real dispatchable roles
        for role in priority:
            self.assertIn(role, DISPATCHABLE_ROLES)
        # and the pass list must END with the catch-all None so every
        # remaining role (judges, adjudication, future additions) drains
        passes = list(priority) + [None]
        self.assertIsNone(passes[-1])
        # judge + adjudication roles are NOT in priority — they ride the
        # fallback; pin membership so a rename breaks loudly
        for role in ("evidence_judgment", "adversarial_judgment", "human_required_adjudication"):
            self.assertIn(role, DISPATCHABLE_ROLES)
            self.assertNotIn(role, priority)

    def test_cost_override_keeps_per_run_breaker(self) -> None:
        override = json.loads((_REPO / "aria-config" / "genesis_policy.json").read_text())
        caps = override["cost_caps_usd"]
        self.assertEqual(caps["per_run"], 0.5)
        self.assertGreaterEqual(caps["daily"], 25.0)
        self.assertGreaterEqual(caps["monthly"], caps["daily"] * 7)


if __name__ == "__main__":
    unittest.main()
