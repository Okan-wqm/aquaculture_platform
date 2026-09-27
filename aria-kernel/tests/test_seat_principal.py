"""ARIA-HIGH-193 — a seat's principal is the agent, not the executor run.

The executor claims and submits every request as
``ci-executor:gha-<GITHUB_RUN_ID>``; reading that as the principal made 35/35
live panels "not independent" and recorded the run as every duel combatant.
These pin the two readers the kernel now uses: the request's ``target_agent``
for a dispatched seat, the executor-stamped ``details.agent_subagent_type``
for a sealed response — and that an executor-shaped identity is neither.
"""
from __future__ import annotations

import unittest

from aria_kernel.independence_check import (
    is_executor_identity,
    response_principal,
    seat_principal,
)


class SeatPrincipalTests(unittest.TestCase):
    def test_request_target_is_the_principal(self) -> None:
        self.assertEqual(seat_principal({"target_agent": "aria-evidence-judge"}), "aria-evidence-judge")

    def test_executor_shaped_or_absent_target_names_no_principal(self) -> None:
        self.assertIsNone(seat_principal({"target_agent": "ci-executor:gha-1"}))
        self.assertIsNone(seat_principal({}))


class ResponsePrincipalTests(unittest.TestCase):
    def test_stamped_subagent_wins_over_the_envelope_agent_id(self) -> None:
        response = {"agent_id": "ci-executor:gha-9", "details": {"agent_subagent_type": "aria-challenger-planner"}}
        self.assertEqual(response_principal(response), "aria-challenger-planner")

    def test_no_stamp_or_executor_stamp_is_no_principal(self) -> None:
        self.assertIsNone(response_principal({"agent_id": "ci-executor:gha-9"}))
        self.assertIsNone(response_principal({"details": {"agent_subagent_type": "ci-executor:gha-9"}}))
        self.assertIsNone(response_principal({"details": "not-an-object"}))

    def test_executor_identity_predicate(self) -> None:
        self.assertTrue(is_executor_identity("ci-executor:gha-1"))
        self.assertFalse(is_executor_identity("aria-evidence-judge"))
        self.assertFalse(is_executor_identity(None))


if __name__ == "__main__":
    unittest.main()
