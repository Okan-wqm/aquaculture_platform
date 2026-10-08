"""ARIA-HIGH-388 — every implementation request ends on the plan ledger, with a verified fault.

Measured 2026-10-08: ``AIR-aria-implementer-e056f97fe09b`` was refused by its
agent; the executor wrote HUMAN_REQUIRED and a claim release and nothing else,
so its plan sat IMPLEMENTATION_REQUESTED until the orphan reaper relabelled it
unattributable, and ``memory/procedural`` never held one implementer episode.
That refusal (``safety``) was the HOST's missing git identity. Pinned here:

* a fault is ``request`` only where the kernel verifies the cause from the
  refusal's own reason; a stage alone, and an agent's word, are not enough;
* only a ``request`` fault cools the finding off; ``harness`` and
  ``unclassified`` never do, and only a verified class blames the implementer;
* settling is once, decided under the plan lock (a reaper or a second settle
  first is ``already_settled``); a lock or store fault is a row; a
  programming error raises;
* an implementation request is never handed out without the delivery's
  authority or after its plan ended (before any claim, mint or lease).
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel.implementation_rejections import (
    AGENT_GATE_BLOCKERS,
    IMPLEMENTATION_DELIVERY_UNCLASSIFIED,
    IMPLEMENTER_REFUSED,
    PRE_SPAWN_SETTLEMENT,
    VALID_IMPLEMENTATION_REJECTION_CLASSES,
    settlement_for_delivery,
)
from aria_kernel.implementation_settlement import (
    ALREADY_SETTLED,
    FAILED,
    NOT_AN_IMPLEMENTATION,
    SETTLED,
    SETTLEMENT_FAILED_KIND,
    settle_agent_refusal,
    settle_delivery_refusal,
    settle_pre_spawn_refusal,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.outage_attribution import failure_is_lane_fault
from aria_kernel.plan_convergence import events_path
from aria_kernel.release_reason import FAULT_DOMAINS
from tests.test_executor_event_driven_planning import _PlanCase

_VERIFY = "aria_kernel.round_independence.verify_independence"


class SettlementIsDecidedByTheVerifiedCause(unittest.TestCase):
    def test_a_stage_alone_never_makes_a_request_fault(self) -> None:
        # The causes the adversarial review found settled `request` by stage.
        for stage, reason in (
            ("branch_publication", "branch_has_no_commit"), ("branch_publication", "publication_missing"),
            ("change_ledger", "diff_unresolvable:fatal"), ("result_admissible", "judgment_refused:GovernanceError"),
            ("apply_gate", "gate_refused:ProfileActionRefused"), ("apply_gate", "gate_blocked:validation_room_unobserved"),
            ("change_validated", "change_validated_refused:profile_frozen"), ("commit_identity", "commit_unverified:x"),
            ("pre_pr_open", "pre_pr_open_refused:x"), ("result_admissible", "result_rejected:response_schema:reasons=1:x"),
            # Re-review N1: `candidate_validation_not_green` alone is set
            # whenever the candidate run is not ok, a red baseline included.
            ("apply_gate", "gate_blocked:candidate_validation_not_green"),
        ):
            settled = settlement_for_delivery(stage=stage, reason=reason, request_id="AIR-1")
            self.assertEqual((settled.rejection_class, settled.fault_domain),
                             (IMPLEMENTATION_DELIVERY_UNCLASSIFIED, "unclassified"), (stage, reason))

    def test_the_verified_causes(self) -> None:
        for stage, reason, expected in (
            ("change_ledger", "change_committed_refused:scope_drift_requires_human: x", ("forbidden_scope_violation", "request")),
            ("result_admissible", "diff_secret_shaped:x", ("secret_leak_detected", "request")),
            ("result_admissible", "result_rejected:agent_evidence_line_out_of_range:reasons=1:x",
             ("implementation_result_inadmissible", "request")),
            ("apply_gate", "gate_blocked:" + ",".join(sorted(AGENT_GATE_BLOCKERS)), ("validation_failed", "request")),
            ("apply_gate", "gate_blocked:candidate_validation_not_green,validation_regression",
             ("validation_failed", "request")),
            ("apply_gate", "gate_blocked:suppression_pattern", ("validation_failed", "request")),
            ("push", "push_failed:rc=128:x", ("push_refused", "harness")),
            ("pr_open", "pr_open_refused:x", ("pr_open_refused", "harness")),
        ):
            settled = settlement_for_delivery(stage=stage, reason=reason, request_id="AIR-1")
            self.assertEqual((settled.rejection_class, settled.fault_domain), expected, (stage, reason))
            self.assertIn(settled.rejection_class, VALID_IMPLEMENTATION_REJECTION_CLASSES)
            self.assertIn(settled.fault_domain, FAULT_DOMAINS)
        for rejection_class, domain in PRE_SPAWN_SETTLEMENT.values():
            self.assertIn(rejection_class, VALID_IMPLEMENTATION_REJECTION_CLASSES)
            self.assertIn(domain, FAULT_DOMAINS)

    def test_only_a_request_fault_cools_off(self) -> None:
        for domain, cools in (("request", True), ("harness", False), ("unclassified", False)):
            event = {"event_type": "implementation_rejected", "payload": {"rejection_class": "x", "fault_domain": domain}}
            self.assertEqual(failure_is_lane_fault(event, waited_since=None, at=None, clock=None), not cools, domain)


class _ImplementationRequested(_PlanCase):
    """Plan-1 CONVERGED and its implementation request minted (the state the
    executor's implementer child ends in)."""

    def setUp(self) -> None:
        super().setUp()
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from aria_kernel.request_admission import admit_request

        self.answer_challenger()
        cd.run_convergence_drainer(cycle_id="cyc-2", base_dir=self.tools, workspace_root=self.root,
                                   plan_id="plan-1", plan_seed=self.plan(), max_rounds=2)
        self.answer_cross_review()
        with mock.patch(_VERIFY, return_value=(True, [])):
            cd.run_convergence_drainer(cycle_id="cyc-3", base_dir=self.tools, workspace_root=self.root,
                                       plan_id="plan-1", plan_seed=self.plan(), max_rounds=2)
        self.assertEqual(self.state(), "CONVERGED")
        issue_implementation_envelope(
            plan_id="plan-1", cross_review_revision_id="cr-1", cross_review_summary_text="{}",
            proposal_id="prop-1", change_id="chg-1", branch="aria-impl-1", base_sha="0" * 40,
            cycle_id="cyc-3", base_dir=self.tools,
            admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
        )
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")
        self.request_id = self.requests("implementation")[0]["request_id"]

    def last_rejection(self) -> dict:
        rows = [row for row in load_jsonl(events_path(self.tools))
                if row.get("event_type") == "implementation_rejected"]
        return rows[-1]["payload"]

    def implementer_episodes(self) -> list[dict]:
        from aria_kernel.agent_eval import _performance_episodes
        from aria_kernel.failure_attribution import InvocationLedgersSource

        episodes = _performance_episodes(load_jsonl(events_path(self.tools)), {}, InvocationLedgersSource(self.tools))
        return [row for row in episodes if row["role"] == "implementer"]


class AgentRefusalSettles(_ImplementationRequested):
    def test_the_refusal_ends_the_plan_once_unclassified_and_cools_nothing_off(self) -> None:
        first = settle_agent_refusal(request_id=self.request_id, reason_class="safety", base_dir=self.tools)
        self.assertEqual(first["status"], SETTLED)
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        payload = self.last_rejection()
        self.assertEqual(
            {key: payload[key] for key in ("rejection_class", "stage", "fault_domain", "cause", "request_id")},
            {"rejection_class": IMPLEMENTER_REFUSED, "stage": "agent_refusal", "fault_domain": "unclassified",
             "cause": "safety", "request_id": self.request_id},
        )
        self.assertTrue(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                              waited_since=None, at=None, clock=None))
        self.assertEqual([(row["failure_mode"], row["attributable"]) for row in self.implementer_episodes()],
                         [(IMPLEMENTER_REFUSED, False)])
        again = settle_agent_refusal(request_id=self.request_id, reason_class="safety", base_dir=self.tools)
        self.assertEqual(again["status"], ALREADY_SETTLED)

    def test_a_request_of_another_role_is_not_settled(self) -> None:
        challenger = self.requests("challenger_plan")[0]["request_id"]
        self.assertEqual(settle_agent_refusal(request_id=challenger, reason_class="safety", base_dir=self.tools)["status"],
                         NOT_AN_IMPLEMENTATION)
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")


class DeliveryRefusalSettles(_ImplementationRequested):
    def test_a_verified_red_gate_is_the_implementers_and_cools_the_subject(self) -> None:
        settle_delivery_refusal(request_id=self.request_id, stage="apply_gate",
                                reason="gate_blocked:validation_regression", base_dir=self.tools)
        payload = self.last_rejection()
        self.assertEqual((payload["rejection_class"], payload["fault_domain"]), ("validation_failed", "request"))
        self.assertEqual([(row["failure_mode"], row["attributable"]) for row in self.implementer_episodes()],
                         [("validation_failed", True)])
        self.assertFalse(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                               waited_since=None, at=None, clock=None))

    def test_a_refused_push_is_the_lanes(self) -> None:
        settle_delivery_refusal(request_id=self.request_id, stage="push", reason="push_failed:rc=128:x",
                                base_dir=self.tools)
        payload = self.last_rejection()
        self.assertEqual((payload["rejection_class"], payload["fault_domain"]), ("push_refused", "harness"))
        self.assertEqual([row["attributable"] for row in self.implementer_episodes()], [False])

    def test_a_pre_spawn_collision_settles_unclassified(self) -> None:
        settle_pre_spawn_refusal(request_id=self.request_id, release_reason="implementation_branch_collision",
                                 base_dir=self.tools)
        payload = self.last_rejection()
        self.assertEqual((payload["rejection_class"], payload["fault_domain"], payload["stage"]),
                         ("branch_collision", "unclassified", "pre_spawn"))

    def test_a_reaper_that_got_there_first_is_already_settled_not_a_failure(self) -> None:
        from aria_kernel.plan_convergence import record_implementation_rejected

        record_implementation_rejected(plan_id="plan-1", rejection_class="orchestrator_restart_reaped_orphan",
                                       rejected_at="2026-10-08T00:00:00Z", base_dir=self.tools)
        outcome = settle_delivery_refusal(request_id=self.request_id, stage="push", reason="push_failed:x",
                                          base_dir=self.tools)
        self.assertEqual(outcome["status"], ALREADY_SETTLED)

    def test_a_lock_that_clears_within_the_bound_settles(self) -> None:
        from aria_kernel import plan_convergence
        from aria_kernel.plan_convergence import PlanLedgerLocked

        real = plan_convergence.settle_implementation_rejected
        calls: list[int] = []

        def locked_once(**kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise PlanLedgerLocked("plans/events.jsonl is locked")
            return real(**kwargs)

        with mock.patch("aria_kernel.implementation_settlement.SETTLE_LOCK_BACKOFF_SECONDS", 0), \
                mock.patch("aria_kernel.plan_convergence.settle_implementation_rejected", side_effect=locked_once):
            outcome = settle_delivery_refusal(request_id=self.request_id, stage="push", reason="push_failed:x",
                                              base_dir=self.tools)
        self.assertEqual((outcome["status"], len(calls)), (SETTLED, 2))
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")

    def test_a_held_lock_is_a_row_not_an_exception(self) -> None:
        from aria_kernel.plan_convergence import PlanLedgerLocked

        with mock.patch("aria_kernel.implementation_settlement.SETTLE_LOCK_BACKOFF_SECONDS", 0), \
                mock.patch("aria_kernel.plan_convergence.settle_implementation_rejected",
                           side_effect=PlanLedgerLocked("plans/events.jsonl is locked")):
            outcome = settle_delivery_refusal(request_id=self.request_id, stage="push", reason="push_failed:x",
                                              base_dir=self.tools)
        self.assertEqual(outcome["status"], FAILED)
        kinds = [json.loads(line).get("kind") for line in
                 (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertIn(SETTLEMENT_FAILED_KIND, kinds)
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")

    def test_a_programming_error_raises(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        with mock.patch("aria_kernel.plan_convergence.settle_implementation_rejected",
                        side_effect=GovernanceError("implementation_rejected rejection_class must be one of")):
            with self.assertRaises(GovernanceError):
                settle_delivery_refusal(request_id=self.request_id, stage="push", reason="push_failed:x",
                                        base_dir=self.tools)


class AnUndispatchableRequestIsNeverHandedOut(_ImplementationRequested):
    def _next(self):
        from aria_kernel.agent_invocations import next_pending_request

        return next_pending_request(role="implementation", base_dir=self.tools)

    def _undispatchable_rows(self) -> list[dict]:
        from aria_kernel.implementation_dispatch import UNDISPATCHABLE_KIND

        return [json.loads(line) for line in (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
                if json.loads(line).get("kind") == UNDISPATCHABLE_KIND]

    def test_without_the_delivery_authority_it_waits_unclaimed_and_is_disclosed_once(self) -> None:
        self.assertIsNone(self._next())
        self.assertIsNone(self._next())
        rows = self._undispatchable_rows()
        self.assertEqual([(row["details"]["request_id"], row["details"]["cause"]) for row in rows],
                         [(self.request_id, "authority_absent")])

    def test_with_the_authority_it_is_handed_out(self) -> None:
        from tests._helpers.operator_acts import operator_set_profile

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        self.assertEqual((self._next() or {}).get("request_id"), self.request_id)

    def test_after_its_plan_ended_it_is_never_handed_out(self) -> None:
        from aria_kernel.plan_convergence import record_implementation_rejected
        from tests._helpers.operator_acts import operator_set_profile

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        record_implementation_rejected(plan_id="plan-1", rejection_class="orchestrator_restart_reaped_orphan",
                                       rejected_at="2026-10-08T00:00:00Z", base_dir=self.tools)
        self.assertIsNone(self._next())
        self.assertEqual([row["details"]["cause"] for row in self._undispatchable_rows()],
                         ["plan_not_awaiting_implementation"])

    def test_under_a_frozen_profile_the_selection_never_raises(self) -> None:
        # Re-review N2: the disclosure's governance write under `frozen` took
        # `agent next-pending`, and the drain, down.
        from aria_kernel.runtime_profile import set_profile

        set_profile("frozen", operator_approval_ref="test:freeze", base_dir=self.tools)
        before = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIsNone(self._next())
        self.assertEqual(self._undispatchable_rows(), [])
        self.assertEqual((self.tools / "governance.jsonl").read_text(encoding="utf-8"), before)

    def test_under_a_frozen_profile_a_stale_anchor_is_skipped_unrecorded(self) -> None:
        from types import SimpleNamespace

        from aria_kernel.agent_invocations import next_pending_request
        from aria_kernel.runtime_profile import set_profile

        set_profile("frozen", operator_approval_ref="test:freeze", base_dir=self.tools)
        stale = SimpleNamespace(refusal="anchor_expired", undecided=None)
        with mock.patch("aria_kernel.agent_invocations._anchor_repo_root", return_value=self.root), \
                mock.patch("aria_kernel.agent_invocations._anchor_refusal_reason", return_value=stale):
            self.assertIsNone(next_pending_request(role="cross_review", base_dir=self.tools))
        claims = self.tools / "agent-invocations" / "claims.jsonl"
        events = [json.loads(line).get("event") for line in claims.read_text(encoding="utf-8").splitlines()] \
            if claims.exists() else []
        self.assertNotIn("anchor_stale", events)

    def test_a_settled_plan_closes_its_other_unheld_implementation_requests(self) -> None:
        # Re-review N4: a request whose plan ended is CANCELLED, not skipped by
        # every selection forever.
        from aria_kernel.agent_invocations import derive_request_state
        from aria_kernel.plan_request_closure import close_abandoned_plan_requests
        from aria_kernel.plan_convergence import record_implementation_rejected

        record_implementation_rejected(plan_id="plan-1", rejection_class="orchestrator_restart_reaped_orphan",
                                       rejected_at="2026-10-08T00:00:00Z", base_dir=self.tools)
        self.assertEqual(close_abandoned_plan_requests(self.tools), [self.request_id])
        self.assertEqual(derive_request_state(request_id=self.request_id, base_dir=self.tools), "CANCELLED")
