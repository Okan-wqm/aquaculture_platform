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

    def test_quota_arc_covers_every_dispatchable_role(self) -> None:
        # Y4 (ORPHAN-705) — DELIBERATE REWRITE of the X1 pin. The four-role
        # priority prefix was itself a starvation topology: every role it
        # omitted queued behind judge volume at ~9 drains/night. The arc now
        # names every role explicitly (quota round guarantees each waiting
        # role one slot per run), judges LAST by design, planning lane first.
        import sys

        sys.path.insert(0, str(_REPO / "aria-kernel"))
        sys.path.insert(0, str(_REPO / "tools" / "aria-poc"))
        from aria_kernel.agent_surface import DISPATCHABLE_ROLES
        import ci_executor_drain

        arc = tuple(ci_executor_drain._ROLE_QUOTA_ORDER)
        # Every dispatchable role has an explicit place in the arc — a role
        # added to the vocabulary without a consumer is the judged_judges=0
        # defect class. maintenance_utility is minted by the autonomy
        # orchestrator without joining DISPATCHABLE_ROLES; it rides the arc
        # by name.
        for role in DISPATCHABLE_ROLES:
            if role in ("primary_authoring", "challenger_authoring"):
                # drafter roles are consumed by the skill-genesis lane,
                # not the executor drain
                continue
            self.assertIn(role, arc)
        self.assertIn("maintenance_utility", arc)
        # Planning lane opens the arc; judges close it.
        self.assertEqual(arc[0], "implementation")
        self.assertEqual(arc[-2:], ("evidence_judgment", "adversarial_judgment"))
        # The old narrow prefix is GONE — resurrecting it must break here.
        self.assertFalse(hasattr(ci_executor_drain, "_PRIORITY_ROLES"))

    def test_cost_override_keeps_per_run_breaker(self) -> None:
        override = json.loads((_REPO / "aria-config" / "genesis_policy.json").read_text())
        caps = override["cost_caps_usd"]
        self.assertEqual(caps["per_run"], 0.5)
        self.assertGreaterEqual(caps["daily"], 25.0)
        self.assertGreaterEqual(caps["monthly"], caps["daily"] * 7)


if __name__ == "__main__":
    unittest.main()
