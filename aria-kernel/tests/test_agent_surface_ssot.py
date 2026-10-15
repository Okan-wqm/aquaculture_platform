from __future__ import annotations

import unittest

from aria_kernel import agent_contract, agent_invocations, bridge_status_ledger
from aria_kernel.agent_surface import (
    BRIDGE_REQUIRED_ROLES,
    DEFAULT_TARGET_AGENT_WHITELIST,
    DERIVED_REQUEST_STATES,
    DISPATCHABLE_ROLES,
    INVOCATION_ROLES,
    PLANNER_BRIDGE_ROLES,
    REQUEST_ROLES,
    ROLE_TARGET_PAIRING,
)
from aria_kernel.dispatcher_factory import SUPPORTED_ROLES


class AgentSurfaceSsotTests(unittest.TestCase):
    def test_contract_exports_are_aliases_to_agent_surface(self) -> None:
        self.assertIs(agent_contract.REQUEST_ROLES, REQUEST_ROLES)
        self.assertIs(
            agent_contract.DEFAULT_TARGET_AGENT_WHITELIST,
            DEFAULT_TARGET_AGENT_WHITELIST,
        )
        self.assertIs(agent_contract.ROLE_TARGET_PAIRING, ROLE_TARGET_PAIRING)

    def test_invocation_dispatch_and_bridge_roles_are_covered(self) -> None:
        self.assertIs(agent_invocations.ROLES, INVOCATION_ROLES)
        self.assertEqual(SUPPORTED_ROLES, DISPATCHABLE_ROLES)
        self.assertIs(bridge_status_ledger.BRIDGE_REQUIRED_ROLES, BRIDGE_REQUIRED_ROLES)
        self.assertIn("implementation", BRIDGE_REQUIRED_ROLES)
        self.assertIn("implementation", PLANNER_BRIDGE_ROLES)
        self.assertIn("implementation", DISPATCHABLE_ROLES)

    def test_lifecycle_states_are_aliases_to_agent_surface(self) -> None:
        self.assertIs(agent_invocations.DERIVED_STATES, DERIVED_REQUEST_STATES)
        self.assertIn("ACCEPTED_PENDING_BRIDGE", DERIVED_REQUEST_STATES)
        # ARIA-HIGH-366 — retired with its dead reaper: no producer wrote it.
        self.assertNotIn("EXTERNAL_OUTAGE", DERIVED_REQUEST_STATES)

    def test_dead_state_sets_name_only_derivable_states(self) -> None:
        # ARIA-MEDIUM-462 — a dead-state set that names a state derive_request_state can
        # never return matches nothing; EXPIRED was such a name (a lease
        # expiry derives STALE).
        from aria_kernel import human_required_adjudication
        from aria_kernel.agent_surface import REMINT_ELIGIBLE_DEAD_STATES

        self.assertLessEqual(set(REMINT_ELIGIBLE_DEAD_STATES), set(DERIVED_REQUEST_STATES))
        self.assertLessEqual(
            set(human_required_adjudication._TERMINALLY_DEAD_STATES), set(DERIVED_REQUEST_STATES),
        )

    def test_genesis_lifecycle_states_have_one_owner(self) -> None:
        # ARIA-MEDIUM-462 — agent_surface carried a 9-state copy (no REJECTED) that
        # nothing read; genesis_lifecycle owns the vocabulary.
        from aria_kernel import agent_surface, genesis_lifecycle

        self.assertFalse(hasattr(agent_surface, "GENESIS_LIFECYCLE_STATES"))
        self.assertIn("REJECTED", genesis_lifecycle.GENESIS_LIFECYCLE_STATES)

    def test_every_kernel_minted_planner_target_is_whitelisted(self) -> None:
        # ARIA-MEDIUM-462 — every target the kernel itself mints must be on the
        # whitelist, so the surface validator checks its prompt file exists.
        from aria_kernel import cross_review_bridge, plan_round_controller

        minted = set(plan_round_controller.DEFAULT_PLANNER_AGENTS.values()) | {
            cross_review_bridge.CROSS_REVIEW_ROLE[0],
            cross_review_bridge.PRIMARY_REVISION_ROLE[0],
            cross_review_bridge.IMPLEMENTATION_ROLE[0],
            cross_review_bridge.COMPLETENESS_CRITIC_ROLE[0],
        }
        self.assertEqual(minted - set(DEFAULT_TARGET_AGENT_WHITELIST), set())


if __name__ == "__main__":
    unittest.main()
