"""ARIA-HIGH-344 — the drain arc, the dispatchable set and the routing table are one contract.

WHY this file exists: executor runs 37192561282 and 37205463513 (2026-10-04)
each dispatched a `maintenance_utility` request
(`AIR-aria-autonomy-planner-9290f4732576`) because the drain's quota round
(`ci_executor_drain._ROLE_QUOTA_ORDER`) gives that role one slot per run. The
child died in admission with
`provider_routing_role_unrouted:maintenance_utility`: the routing loader
(`runtime_profiles._validate_routing`) checks the table against
`agent_surface.DISPATCHABLE_ROLES`, and `maintenance_utility` was minted
(autonomy_orchestrator, self_change_bridge) and drained, but never in that
set. Three role lists, and only two of them were compared.

WHAT these tests pin, in the order a request travels:

* a role a request may name (`REQUEST_ROLES`) is a role the executor may
  claim (`DISPATCHABLE_ROLES`) — minting and draining are one contract (E14);
* every role the drain arc names is dispatchable, and the drain refuses to
  load when it is not, so the arc cannot reach a role the loader never
  routes;
* every arc role resolves a non-empty provider ladder for each target its
  pairing admits — the exact call that refused in admission;
* `maintenance_utility` itself is paired with the one agent both kernel
  minters address, and routed glm-first like the other high-volume
  read-only roles.
"""
from __future__ import annotations

import ast

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor_drain  # noqa: E402

from aria_kernel.agent_surface import (  # noqa: E402
    DISPATCHABLE_ROLES,
    REQUEST_ROLES,
    ROLE_TARGET_PAIRING,
)
from aria_kernel.runtime_profiles import load_provider_routing  # noqa: E402
from aria_kernel.self_change_bridge import SELF_CHANGE_ROLE, SELF_CHANGE_TARGET_AGENT  # noqa: E402

# An unpaired role (the planners, the cross reviewer, the specialist touch-map)
# is routed by role alone, so any target resolves the same ladder.
_UNPAIRED_TARGET = "aria-any"


class TheDrainArcIsDispatchableAndRouted(unittest.TestCase):
    def test_every_role_a_request_may_name_can_be_claimed(self) -> None:
        self.assertEqual(sorted(set(REQUEST_ROLES) - DISPATCHABLE_ROLES), [])

    def test_every_arc_role_is_dispatchable(self) -> None:
        arc = ci_executor_drain._ROLE_QUOTA_ORDER
        self.assertEqual(sorted(set(arc) - DISPATCHABLE_ROLES), [])

    def test_every_arc_role_resolves_a_ladder_for_each_paired_target(self) -> None:
        routing = load_provider_routing()
        for role in ci_executor_drain._ROLE_QUOTA_ORDER:
            for target in ROLE_TARGET_PAIRING.get(role, (_UNPAIRED_TARGET,)):
                with self.subTest(role=role, target=target):
                    self.assertTrue(routing.ladder_for(role, target))

    def test_the_drain_refuses_to_load_an_arc_naming_an_undispatchable_role(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "drain_arc_role_not_dispatchable:.*'not_a_role'"):
            ci_executor_drain.require_dispatchable_arc(
                ("implementation", "not_a_role"), frozenset({"implementation"}),
            )
        # The real arc against the real set is the import-time call.
        ci_executor_drain.require_dispatchable_arc(
            ci_executor_drain._ROLE_QUOTA_ORDER, ci_executor_drain._engine.SUPPORTED_ROLES,
        )


class MaintenanceUtilityIsOneContract(unittest.TestCase):
    def test_both_minters_address_the_paired_agent(self) -> None:
        # autonomy_orchestrator mints the queue projection with the same
        # literal pair; self_change_bridge names it as constants.
        self.assertEqual(SELF_CHANGE_ROLE, "maintenance_utility")
        self.assertEqual(ROLE_TARGET_PAIRING["maintenance_utility"], (SELF_CHANGE_TARGET_AGENT,))
        # The orchestrator's mint call, read as a call node (Plan 026R §H.1:
        # node shape, never a source substring): every call that names
        # role="maintenance_utility" must address the paired agent.
        tree = ast.parse(
            (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "autonomy_orchestrator.py").read_text(encoding="utf-8"),
        )
        pairs = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
            role = kwargs.get("role")
            if isinstance(role, ast.Constant) and role.value == "maintenance_utility":
                target = kwargs.get("target_agent")
                pairs.append(target.value if isinstance(target, ast.Constant) else None)
        self.assertTrue(pairs, "autonomy_orchestrator mints no maintenance_utility request")
        self.assertEqual(set(pairs), {SELF_CHANGE_TARGET_AGENT})

    def test_it_routes_glm_first_like_the_other_high_volume_read_only_roles(self) -> None:
        routing = load_provider_routing()
        self.assertEqual(routing.roles["maintenance_utility"], "glm_first")
        self.assertEqual(
            routing.ladder_for("maintenance_utility", SELF_CHANGE_TARGET_AGENT),
            routing.ladder_for("change_intelligence", "aria-change-intelligence"),
        )


if __name__ == "__main__":
    unittest.main()
