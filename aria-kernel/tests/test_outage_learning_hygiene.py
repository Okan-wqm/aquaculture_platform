"""ARIA-HIGH-367 — outage-killed work teaches nothing, and a closed plan's queue closes.

Measured before the fix (origin/main 958eed5b7):

* (the drafter-scoring half of H3 is ARIA-HIGH-370's ``failure_attribution``,
  whose evidence allowlist leaves every harness-class outage release
  unattributed; not re-tested here)
* ``finding_grounding`` put every failed plan's finding on the 7-day
  re-planning cool-off, outage or not (H3);
* an ABANDONED plan's PENDING requests stayed claimable, so the recovered
  provider's first quota went to answers no plan could take (H4);
* ``derive_request_state`` returned HUMAN_REQUIRED for any ``human_required``
  row before the fault-domain re-derivation could run, so a request
  escalated on harness-class releases was stuck forever (M2:
  AIR-aria-autonomy-planner-eb17609b38b1, three ``claude_cli_exit_1``);
* a lease that ran out inside an outage was charged to the request (M1).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_invocations import derive_request_state
from aria_kernel.plan_convergence import abandon_plan, start_plan
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.declared_fixtures import append_declared_fixture

_T0 = datetime(2026, 10, 1, 3, 0, 0, tzinfo=timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outage-hygiene-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def outage(self, start: datetime, end: datetime | None) -> None:
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-out", claim_id="CL-out",
                                 detection={"signature": "claude_credit_error"}, now=start)
        if end is not None:
            from aria_kernel.provider_outage_ledger import record_provider_restored

            record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-ok", now=end)

    def request(self, request_id: str, *, plan_id: str = "plan-h", role: str = "primary_plan") -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "requests.jsonl", {
            "schema_version": 1, "request_id": request_id, "role": role, "convergence_id": plan_id,
            "target_agent": "aria-primary-planner", "state": "pending", "created_at": _iso(_T0),
        }, expected_surface="agent_invocation_requests")

    def claim_row(self, **row: object) -> None:
        append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {"schema_version": 1, **row},
                                expected_surface="agent_invocation_claims")


class H3TheFindingIsNotCooledOffForAnOutage(_Store):
    def test_an_unanswered_wait_an_outage_overlapped_is_the_lanes(self) -> None:
        from aria_kernel.outage_attribution import failure_is_lane_fault
        from aria_kernel.provider_clock import provider_clock

        event = {"event_type": "plan_evaluated",
                 "payload": {"terminal_state": "HUMAN_REQUIRED", "reason_codes": ["pending_tasks_present"]}}
        wait = {"waited_since": _T0, "at": _T0 + timedelta(days=3)}
        self.assertFalse(failure_is_lane_fault(event, clock=provider_clock(self.tools), **wait))
        self.outage(_T0 + timedelta(hours=1), _T0 + timedelta(days=2))
        self.assertTrue(failure_is_lane_fault(event, clock=provider_clock(self.tools), **wait))
        answered = {"event_type": "plan_evaluated", "payload": {
            "terminal_state": "HUMAN_REQUIRED", "reason_codes": ["material_cross_review_risks_present"]}}
        self.assertFalse(failure_is_lane_fault(answered, clock=provider_clock(self.tools), **wait))

    def _failed_at(self, *, stall_cause: str) -> datetime | None:
        from aria_kernel.finding_grounding import _fold_plans

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        from aria_kernel.release_reason import parse_release_reason

        abandon_plan(plan_id="plan-h", reason=f"stalled:{stall_cause}", base_dir=self.tools,
                     stall={"cause": stall_cause, **parse_release_reason(stall_cause).to_row_fields()})
        plan = next(p for p in _fold_plans(self.tools, datetime.now(timezone.utc)) if p.plan_id == "plan-h")
        return plan.failed_at

    def test_a_harness_class_stall_leaves_the_finding_plannable(self) -> None:
        self.assertIsNone(self._failed_at(stall_cause="provider_quota_unavailable:anthropic"))

    def test_a_request_class_stall_still_cools_the_finding(self) -> None:
        self.assertIsNotNone(self._failed_at(stall_cause="submit_rejected"))


class H4AnAbandonedPlansQueueClosesWithIt(_Store):
    def test_unclaimed_requests_cancel_and_a_held_claim_is_left_to_its_lease(self) -> None:
        from aria_kernel.agent_invocations import next_pending_request

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-queued")
        self.request("AIR-held")
        now = datetime.now(timezone.utc)
        self.claim_row(event="claimed", claim_id="CL-held", request_id="AIR-held", agent_id="a",
                       claimed_at=_iso(now), lease_expires_at=_iso(now + timedelta(hours=1)))
        abandon_plan(plan_id="plan-h", reason="stalled:no_consumer", base_dir=self.tools)
        self.assertEqual(derive_request_state(request_id="AIR-queued", base_dir=self.tools), "CANCELLED")
        self.assertEqual(derive_request_state(request_id="AIR-held", base_dir=self.tools), "CLAIMED")
        self.assertIsNone(next_pending_request(base_dir=self.tools))

    def test_the_sweep_closes_a_plan_abandoned_before_the_closure_existed(self) -> None:
        from aria_kernel.agent_invocations import sweep_expired_anchors
        from aria_kernel.plan_convergence import _append_event, _idempotency_key, _plan_lock

        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-legacy")
        payload = {"reason": "stalled:no_consumer", "abandoned_from_state": "STARTED"}
        with _plan_lock(self.tools):  # the abandonment as origin/main wrote it: no closure
            _append_event(root=self.tools, plan_id="plan-h", event_type="plan_abandoned", payload=payload,
                          idempotency_key=_idempotency_key("plan-h", "abandon", payload))
        self.assertEqual(derive_request_state(request_id="AIR-legacy", base_dir=self.tools), "PENDING")
        sweep_expired_anchors(base_dir=self.tools, now=datetime.now(timezone.utc))
        self.assertEqual(derive_request_state(request_id="AIR-legacy", base_dir=self.tools), "CANCELLED")


class H4AHealedEscalationInAnAbandonedPlanCloses(_Store):
    def test_review_medium_4(self) -> None:
        start_plan(plan_id="plan-h", initial_revision_id="rev-0", base_dir=self.tools, plan_content={
            "schema_version": 1, "title": "t", "summary": "s", "key_changes": ["c"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "validation_commands": [{"cmd": "true"}], "evidence_refs": ["docs/aria/SPEC.md"],
        })
        self.request("AIR-healed")
        for index in (1, 2, 3):
            at = _iso(_T0 + timedelta(days=index))
            self.claim_row(event="claimed", claim_id=f"CL-{index}", request_id="AIR-healed", agent_id="a",
                           claimed_at=at, lease_expires_at=_iso(_T0 + timedelta(days=index, hours=1)))
            self.claim_row(event="released", claim_id=f"CL-{index}", request_id="AIR-healed", agent_id="a",
                           reason="claude_cli_exit_1", released_at=at)
            self.claim_row(event="requeued" if index < 3 else "human_required", claim_id=f"CL-{index}",
                           request_id="AIR-healed", reason="claude_cli_exit_1", requeue_count=index, at=at)
        self.assertEqual(derive_request_state(request_id="AIR-healed", base_dir=self.tools), "PENDING")
        abandon_plan(plan_id="plan-h", reason="stalled:no_consumer", base_dir=self.tools)
        self.assertEqual(derive_request_state(request_id="AIR-healed", base_dir=self.tools), "CANCELLED")


class M2AHarnessOnlyEscalationIsReDerived(_Store):
    def _released(self, request_id: str, reason: str, last_event: str) -> None:
        for index, event in enumerate(("requeued", "requeued", last_event), start=1):
            at = _iso(_T0 + timedelta(days=index))
            self.claim_row(event="claimed", claim_id=f"CL-{index}", request_id=request_id, agent_id="a",
                           claimed_at=at, lease_expires_at=_iso(_T0 + timedelta(days=index, hours=1)))
            self.claim_row(event="released", claim_id=f"CL-{index}", request_id=request_id, agent_id="a",
                           reason=reason, released_at=at)
            self.claim_row(event=event, claim_id=f"CL-{index}", request_id=request_id, reason=reason,
                           requeue_count=index, at=at)

    def test_three_provider_class_releases_no_longer_pin_human_required(self) -> None:
        self.request("AIR-stuck")
        self._released("AIR-stuck", "claude_cli_exit_1", "human_required")
        self.assertEqual(derive_request_state(request_id="AIR-stuck", base_dir=self.tools), "PENDING")

    def test_a_deliberate_escalation_stands(self) -> None:
        self.request("AIR-refused")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-refused", agent_id="a",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))
        self.claim_row(event="human_required", claim_id="CL-1", request_id="AIR-refused",
                       reason="agent_refused:evidence", requeue_count=1, at=_iso(_T0))
        self.assertEqual(derive_request_state(request_id="AIR-refused", base_dir=self.tools), "HUMAN_REQUIRED")

    def test_three_charged_releases_still_escalate(self) -> None:
        self.request("AIR-poison")
        self._released("AIR-poison", "submit_rejected", "human_required")
        self.assertEqual(derive_request_state(request_id="AIR-poison", base_dir=self.tools), "HUMAN_REQUIRED")


class M1ALeaseAnOutageAteIsNotCharged(_Store):
    def _reap(self) -> dict:
        from aria_kernel.agent_invocations import reap_stale_claims

        self.request("AIR-1")
        self.claim_row(event="claimed", claim_id="CL-1", request_id="AIR-1", agent_id="a",
                       claimed_at=_iso(_T0), lease_expires_at=_iso(_T0 + timedelta(hours=1)))
        return reap_stale_claims(base_dir=self.tools, now=_T0 + timedelta(hours=2))

    def test_the_expiry_names_the_outage_and_charges_nothing(self) -> None:
        self.outage(_T0 + timedelta(minutes=10), None)
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]),
                         ("lease_expired_during_provider_outage:anthropic", 0))
        self.assertEqual(derive_request_state(request_id="AIR-1", base_dir=self.tools), "REQUEUED")

    def test_a_blip_that_ended_inside_the_lease_does_not_waive_the_charge(self) -> None:
        """Review MEDIUM-3: a 2-minute outage, over before the lease ran out, is not the provider's."""
        self.outage(_T0 + timedelta(minutes=10), _T0 + timedelta(minutes=12))
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))

    def test_an_outage_covering_most_of_the_lease_owns_it_even_if_over(self) -> None:
        self.outage(_T0 + timedelta(minutes=5), _T0 + timedelta(minutes=50))
        followup = self._reap()["requeued"][0]
        self.assertEqual(followup["requeue_count"], 0)

    def test_with_no_outage_the_lease_is_still_the_requests(self) -> None:
        followup = self._reap()["requeued"][0]
        self.assertEqual((followup["reason"], followup["requeue_count"]), ("lease_expired", 1))


if __name__ == "__main__":
    unittest.main()
