"""ARIA-HIGH-193 — a seat's principal is the agent, not the executor run.

The executor claims and submits every request as
``ci-executor:gha-<GITHUB_RUN_ID>``; reading that as the principal made 35/35
live panels "not independent" and recorded the run as every duel combatant.
These pin the two readers the kernel now uses: the request's ``target_agent``
for a dispatched seat, the executor-stamped ``details.agent_subagent_type``
for a sealed response — and that an executor-shaped identity is neither.

ARIA-MEDIUM-225 — the agent name is half a principal. One executor run on
one model answering three seats is one model thinking three times, so the
principal is the agent AND the route that executed it: the native
``runtime_attempt_started`` row the sealed envelope names, or on the legacy
spawn path the executor-stamped ``details.agent_dispatch_model``.
"""
from __future__ import annotations

import unittest

from aria_kernel.independence_check import (
    Principal,
    executed_route,
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


def _response(**details: object) -> dict:
    return {
        "request_id": "AIR-1",
        "claim_id": "claim-1",
        "details": {"agent_subagent_type": "aria-evidence-judge", **details},
    }


def _attempt(
    *,
    ledger_hash: str = "sha256:attempt",
    provider: str = "openai",
    model: str = "gpt-5.2-codex",
    request_id: str = "AIR-1",
    claim_id: str = "claim-1",
) -> dict:
    return {
        "kind": "runtime_attempt_started",
        "ledger_hash": ledger_hash,
        "details": {
            "request_id": request_id,
            "claim_id": claim_id,
            "provider": provider,
            "model": model,
        },
    }


class ExecutedRouteTests(unittest.TestCase):
    def test_the_stamped_dispatch_model_names_the_spawn_route(self) -> None:
        self.assertEqual(
            executed_route(_response(agent_dispatch_model="opus"), attempt_rows=()),
            ("anthropic", "opus"),
        )
        self.assertEqual(
            executed_route(_response(agent_dispatch_model="glm-5.3"), attempt_rows=()),
            ("zai", "glm-5.3"),
        )

    def test_the_native_attempt_row_names_the_route(self) -> None:
        response = _response(
            agent_dispatch_model="gpt-5.2-codex",
            runtime_attempt_ledger_hash="sha256:attempt",
        )
        self.assertEqual(
            executed_route(response, attempt_rows=[_attempt()]),
            ("openai", "gpt-5.2-codex"),
        )

    def test_an_attempt_the_ledger_does_not_hold_is_no_route(self) -> None:
        response = _response(
            agent_dispatch_model="gpt-5.2-codex",
            runtime_attempt_ledger_hash="sha256:elsewhere",
        )
        self.assertIsNone(executed_route(response, attempt_rows=[_attempt()]))

    def test_an_attempt_bound_to_another_claim_is_no_route(self) -> None:
        response = _response(runtime_attempt_ledger_hash="sha256:attempt")
        self.assertIsNone(
            executed_route(response, attempt_rows=[_attempt(claim_id="claim-2")]),
        )
        self.assertIsNone(
            executed_route(response, attempt_rows=[_attempt(request_id="AIR-2")]),
        )

    def test_a_stamp_that_contradicts_the_attempt_is_no_route(self) -> None:
        response = _response(
            agent_dispatch_model="opus",
            runtime_attempt_ledger_hash="sha256:attempt",
        )
        self.assertIsNone(executed_route(response, attempt_rows=[_attempt()]))

    def test_no_stamp_is_no_route(self) -> None:
        self.assertIsNone(executed_route(_response(), attempt_rows=()))
        self.assertIsNone(executed_route({"details": "not-an-object"}, attempt_rows=()))


class PrincipalTests(unittest.TestCase):
    def test_a_principal_is_the_agent_and_its_route(self) -> None:
        principal = Principal(agent="aria-evidence-judge", provider="anthropic", model="opus")
        self.assertEqual(principal.route, ("anthropic", "opus"))
        self.assertEqual(str(principal), "aria-evidence-judge@anthropic/opus")


if __name__ == "__main__":
    unittest.main()
