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
    settle_orphaned_plan,
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


class OrphanReapSettles(_ImplementationRequested):
    """The orchestrator's orphan reaper ends a plan through the same writer
    (ARIA-HIGH-388 after #1863): it never judged an answer, so its fault domain
    is the lane's (`harness`) while the request still waited on the lane and
    `unclassified` otherwise; neither cools the finding off."""

    def _rejections(self) -> list[dict]:
        return [row for row in load_jsonl(events_path(self.tools))
                if row.get("event_type") == "implementation_rejected"]

    def test_a_request_waiting_on_the_delivery_authority_is_reaped_as_the_lanes(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state

        reaped = settle_orphaned_plan(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(reaped["status"], SETTLED)
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        payload = self.last_rejection()
        self.assertEqual(
            {key: payload[key] for key in ("rejection_class", "stage", "fault_domain", "cause", "request_id")},
            {"rejection_class": "orchestrator_restart_reaped_orphan", "stage": "orphan_reap",
             "fault_domain": "harness", "cause": "authority_absent", "request_id": self.request_id},
        )
        self.assertTrue(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                              waited_since=None, at=None, clock=None))
        self.assertEqual(derive_request_state(request_id=self.request_id, base_dir=self.tools), "CANCELLED")

    def test_a_claimed_and_answered_request_is_reaped_unclassified(self) -> None:
        from tests._helpers.declared_fixtures import append_declared_fixture

        append_declared_fixture(self.tools / "agent-invocations" / "claims.jsonl", {
            "schema_version": 1, "event": "human_required", "claim_id": "CL-answered",
            "request_id": self.request_id, "reason": "agent_refused:evidence", "requeue_count": 1,
            "at": "2026-10-08T00:00:00Z",
        }, expected_surface="agent_invocation_claims")
        self.assertEqual(settle_orphaned_plan(plan_id="plan-1", base_dir=self.tools)["status"], SETTLED)
        payload = self.last_rejection()
        self.assertEqual((payload["fault_domain"], payload["cause"]), ("unclassified", "agent_refused"))
        self.assertTrue(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                              waited_since=None, at=None, clock=None))

    def test_a_request_claimed_at_the_reap_is_named_in_flight_not_unclaimed(self) -> None:
        # Final review R2 — a claim row carries no reason; the reap of a held
        # request was labelled `unclaimed`.
        from aria_kernel.agent_invocations import claim_request
        from tests._helpers.operator_acts import operator_set_profile

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        claim_request(request_id=self.request_id, agent_id="executor-test", base_dir=self.tools)
        self.assertEqual(settle_orphaned_plan(plan_id="plan-1", base_dir=self.tools)["status"], SETTLED)
        payload = self.last_rejection()
        self.assertEqual((payload["fault_domain"], payload["cause"]), ("unclassified", "claimed_in_flight"))

    def test_an_executor_that_settled_first_leaves_the_reap_already_settled(self) -> None:
        settle_agent_refusal(request_id=self.request_id, reason_class="safety", base_dir=self.tools)
        self.assertEqual(settle_orphaned_plan(plan_id="plan-1", base_dir=self.tools)["status"], ALREADY_SETTLED)
        self.assertEqual([row["payload"]["rejection_class"] for row in self._rejections()], [IMPLEMENTER_REFUSED])


class PostDeliveryHandOver(_ImplementationRequested):
    """ARIA-HIGH-389 — a result refused AFTER the kernel's delivery opened its PR
    ends the plan once, with the PR on the event, and hands the live PR to a
    person as its GitHub-observable human-merge record."""

    PR = 4242

    def _hand_over(self, cause: str) -> dict:
        from aria_kernel.implementation_settlement import hand_over_delivered_implementation

        return hand_over_delivered_implementation(
            request_id=self.request_id, cause=cause, pr_number=self.PR,
            pr_url=f"https://github.com/o/r/pull/{self.PR}", branch="aria-impl-1", branch_tip_sha="a" * 40,
            base_dir=self.tools,
        )

    def _records(self) -> list[dict]:
        from aria_kernel.human_required import list_human_required

        return [row for row in list_human_required(base_dir=self.tools, include_resolved=True)
                if (row.get("context") or {}).get("kind") == "human_merge_pr"]

    def _change_id(self) -> str:
        return str(self.requests("implementation")[0]["implementation_ids"]["change_id"])

    def test_a_submit_that_timed_out_after_delivery_settles_the_lanes_and_hands_the_pr_over(self) -> None:
        from aria_kernel.agent_invocations import derive_request_state

        outcome = self._hand_over("submit_timeout")
        self.assertEqual(outcome["status"], SETTLED)
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        payload = self.last_rejection()
        self.assertEqual(
            {key: payload[key] for key in ("rejection_class", "stage", "fault_domain", "cause", "request_id",
                                           "pr_number")},
            {"rejection_class": "implementation_result_refused_after_delivery", "stage": "post_delivery",
             "fault_domain": "harness", "cause": "submit_timeout", "request_id": self.request_id,
             "pr_number": self.PR},
        )
        self.assertTrue(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                              waited_since=None, at=None, clock=None))
        [record] = self._records()
        self.assertEqual(outcome["handed_over"], record["request_id"])
        self.assertEqual(record["request_id"], f"human-merge-pr-{self.PR}")
        self.assertEqual((record["context"]["pr_number"], record["context"]["change_id"],
                          record["context"]["self_mergeable_now"]), (self.PR, self._change_id(), False))
        self.assertEqual(record["context"]["not_self_mergeable_because"],
                         ["implementation_settled_after_delivery:implementation_result_refused_after_delivery:"
                          "submit_timeout"])
        # The settlement closed the (released, unheld) request: no retry
        # collides with the published branch.
        self.assertEqual(derive_request_state(request_id=self.request_id, base_dir=self.tools), "CANCELLED")

    def test_a_rejection_the_kernel_recorded_after_admitting_it_is_unclassified(self) -> None:
        self._hand_over("agent_result_rejected")
        self.assertEqual(self.last_rejection()["fault_domain"], "unclassified")

    def test_a_second_hand_over_keeps_one_settlement_and_one_record(self) -> None:
        first = self._hand_over("submit_rejected")
        second = self._hand_over("submit_rejected")
        self.assertEqual((first["status"], second["status"]), (SETTLED, ALREADY_SETTLED))
        self.assertEqual(first["handed_over"], second["handed_over"])
        self.assertEqual(len(self._records()), 1)
        self.assertEqual(len([row for row in load_jsonl(events_path(self.tools))
                              if row.get("event_type") == "implementation_rejected"]), 1)

    def test_the_record_is_resolved_by_github_observing_the_merge(self) -> None:
        from aria_kernel.human_required import RESOLVED_BY_GITHUB_OBSERVATION, resolve_human_required

        record_id = self._hand_over("submit_timeout")["handed_over"]
        resolved = resolve_human_required(request_id=record_id, resolved_by=RESOLVED_BY_GITHUB_OBSERVATION,
                                          resolution_note="pr_merged_observed_on_github", base_dir=self.tools)
        self.assertEqual(resolved["status"], "resolved")

    def test_the_surface_keeps_a_pr_whose_plan_ended_with_a_person(self) -> None:
        from aria_kernel.human_merge_surface import self_merge_refusals

        opened = {"pr_number": self.PR, "change_id": self._change_id(),
                  "merge_route": {"lane": "L0", "human_merge": False, "reason_codes": []}}
        live = {"number": self.PR, "headRefOid": "a" * 40, "mergeStateStatus": "CLEAN", "labels": []}
        before = self_merge_refusals(opened, live, base_dir=self.tools)
        self.assertFalse([reason for reason in before if reason.startswith("implementation_settled_after_delivery")])
        self._hand_over("submit_timeout")
        self.assertIn("implementation_settled_after_delivery:implementation_result_refused_after_delivery:"
                      "submit_timeout", self_merge_refusals(opened, live, base_dir=self.tools))

    def test_a_pr_whose_plan_the_reaper_ended_is_kept_with_a_person_too(self) -> None:
        # A run killed past its push never reaches the hand-over; the reaper's
        # settlement ends the plan, and the surface reads the plan state.
        from aria_kernel.human_merge_surface import self_merge_refusals

        settle_orphaned_plan(plan_id="plan-1", base_dir=self.tools)
        opened = {"pr_number": self.PR, "change_id": self._change_id(), "merge_route": {}}
        live = {"number": self.PR, "headRefOid": "a" * 40, "mergeStateStatus": "CLEAN", "labels": []}
        self.assertIn("implementation_settled_after_delivery:orchestrator_restart_reaped_orphan:authority_absent",
                      self_merge_refusals(opened, live, base_dir=self.tools))


class ExecutorHandsOverEveryRefusalAfterItsDelivery(unittest.TestCase):
    """ARIA-HIGH-389 — every refusal exit the executor takes after the kernel's
    delivery succeeded calls the hand-over; the guard is the delivery result."""

    def test_every_exit_after_the_delivery_but_success_hands_the_pr_over(self) -> None:
        import ast

        from tests._helpers.executor_module import EXECUTOR_PATH

        tree = ast.parse(EXECUTOR_PATH.read_text(encoding="utf-8"))
        main = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "_main")
        delivered_at = next(node.lineno for node in ast.walk(main) if isinstance(node, ast.Assign)
                            and any(isinstance(target, ast.Name) and target.id == "_delivered"
                                    for target in node.targets)
                            and isinstance(node.value, ast.Name) and node.value.id == "_delivery")

        def hands_over(statement: ast.stmt) -> bool:
            return (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
                    and getattr(statement.value.func, "id", None) == "_hand_over_after_delivery")

        unguarded: list[int] = []
        bodies = [getattr(node, field) for node in ast.walk(main) for field in ("body", "orelse", "handlers")
                  if isinstance(getattr(node, field, None), list)]
        for body in bodies:
            for index, statement in enumerate(body):
                if not isinstance(statement, ast.Return) or statement.lineno <= delivered_at:
                    continue
                if isinstance(statement.value, ast.Constant) and statement.value.value == 0:
                    continue  # the success exit
                if index == 0 or not hands_over(body[index - 1]):
                    unguarded.append(statement.lineno)
        self.assertEqual(unguarded, [])

    def test_a_run_that_delivered_nothing_hands_nothing_over(self) -> None:
        from tests._helpers.executor_module import load_ci_executor

        executor = load_ci_executor("ci_executor_hand_over_guard")
        with mock.patch("aria_kernel.implementation_settlement.hand_over_delivered_implementation") as hand_over:
            executor._hand_over_after_delivery(tools_dir=None, request_id="AIR-x", delivered=None,
                                               cause="submit_timeout")
        hand_over.assert_not_called()
