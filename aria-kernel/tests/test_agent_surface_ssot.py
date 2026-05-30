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
        self.assertIn("EXTERNAL_OUTAGE", DERIVED_REQUEST_STATES)


if __name__ == "__main__":
    unittest.main()
