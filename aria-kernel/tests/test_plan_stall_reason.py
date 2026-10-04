"""ARIA-MEDIUM-291 — a stalled plan records WHY it stalled.

Between 2026-09-21 and 2026-10-01 no lane consumed the planner's requests;
832 of them expired as `anchor_expired` and the 72 h stall rule abandoned
their plans as "stalled: no plan event since <stamp>". The cause of each
stall — the request's last release or refusal reason, or the fact that
nothing ever claimed it — was on the claim ledger and on no abandonment, so
the operator and every lane-failure reader saw "stalled" for every cause.

What this pins, one property per test (ledger fixtures, no executor):

* a plan whose newest request was never claimed is `stalled:no_consumer`;
* a plan whose newest request was released or expired carries that reason
  (`stalled:provider_quota_unavailable:anthropic`, `stalled:anchor_expired`),
  with the release envelope's code and fault domain;
* a plan with no request at all is `stalled:no_request`;
* the cause rides the `plan_abandoned` event and the folded plan state.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.plan_convergence import fold_plan_state, resume_candidate_plan_id, start_plan
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture


def _plan_content() -> dict:
    return {
        "schema_version": 1,
        "title": "stall-reason plan",
        "summary": "ARIA-MEDIUM-291 fixture plan.",
        "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
        "key_changes": ["change"],
        "validation_commands": [{"cmd": "true"}],
        "evidence_refs": ["docs/aria/SPEC.md"],
    }


class AStalledPlanNamesItsCause(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        start_plan(plan_id="plan-s", initial_revision_id="rev-0", plan_content=_plan_content(), base_dir=self.tools)

    def _request(self, request_id: str, *, plan_id: str = "plan-s", role: str = "challenger_plan") -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "requests.jsonl", {
            "schema_version": 1, "request_id": request_id, "role": role, "convergence_id": plan_id,
            "target_agent": "aria-challenger-planner", "state": "pending",
        }, expected_surface="agent_invocation_requests")

    def _claim_row(self, row: dict) -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {"schema_version": 1, **row},
                                expected_surface="agent_invocation_claims")

    def _abandon(self) -> dict:
        with patch("aria_kernel.plan_convergence.STALE_PLAN_MAX_AGE_HOURS", 0):
            self.assertIsNone(resume_candidate_plan_id(base_dir=self.tools))
        state = fold_plan_state(plan_id="plan-s", base_dir=self.tools)
        self.assertEqual(state["state"], "ABANDONED")
        return state["abandonment"]

    def test_a_request_nothing_claimed_is_no_consumer(self) -> None:
        self._request("AIR-1")
        abandonment = self._abandon()
        self.assertEqual(abandonment["reason"], "stalled:no_consumer")
        self.assertEqual((abandonment["stall"]["request_id"], abandonment["stall"]["role"]),
                         ("AIR-1", "challenger_plan"))

    def test_the_last_release_reason_of_the_newest_request_is_the_cause(self) -> None:
        self._request("AIR-old")
        self._claim_row({"event": "released", "claim_id": "CL-0", "request_id": "AIR-old", "reason": "lease_expired"})
        self._request("AIR-1")
        self._claim_row({"event": "claimed", "claim_id": "CL-1", "request_id": "AIR-1"})
        self._claim_row({"event": "released", "claim_id": "CL-1", "request_id": "AIR-1",
                         "reason": "provider_quota_unavailable:anthropic"})
        abandonment = self._abandon()
        self.assertEqual(abandonment["reason"], "stalled:provider_quota_unavailable:anthropic")
        self.assertEqual((abandonment["stall"]["reason_code"], abandonment["stall"]["fault_domain"]),
                         ("PROVIDER_QUOTA_UNAVAILABLE", "harness"))
        self.assertEqual(abandonment["stall"]["request_id"], "AIR-1")

    def test_an_expired_anchor_is_the_cause(self) -> None:
        self._request("AIR-1")
        self._claim_row({"event": "anchor_stale", "request_id": "AIR-1", "reason": "anchor_expired"})
        self.assertEqual(self._abandon()["reason"], "stalled:anchor_expired")

    def test_another_plans_requests_are_not_this_plans_cause(self) -> None:
        self._request("AIR-other", plan_id="plan-other")
        self._claim_row({"event": "anchor_stale", "request_id": "AIR-other", "reason": "anchor_expired"})
        self.assertEqual(self._abandon()["reason"], "stalled:no_request")

    def test_the_stall_clock_still_travels_with_the_cause(self) -> None:
        abandonment = self._abandon()
        self.assertRegex(abandonment["stall"]["last_event_at"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(abandonment["stall"]["max_age_hours"], 0)


if __name__ == "__main__":
    unittest.main()
