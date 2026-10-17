"""ARIA-HIGH-529 — under merge-class authority, a plan whose synthesis no
binding names is never staged or minted: it is parked before anything is spent.

The merge gate's ``operator_feedback_signature`` check walks
``plan_started.content_hash`` → a ``synthesis_bound`` row → the ingestion it
names (``operator_feedback_observation``). Only the provider writes that row
(``cycle_phases.plan_source`` → ``bind_plan_synthesis``); a plan started by
``plan start``, by skill authoring or by the V7 fallback carries none, so it
could never merge, and the refusal arrived only at merge, after staging (the
baseline suite), the implementer and the expert panel had run.

Pinned here, through the real runner, the real staging and the real mint:

* under merge-class authority (a profile holding ``pr_merge``), the delivery
  door parks an unbound plan CONVERGED →
  HUMAN_REQUIRED on its first offer, before staging and without a counted
  attempt, with the merge walk's own reason in its governance row and the
  plan's one operator item;
* the mint refuses it on its own (second line), naming the same reason;
* a plan the provider bound is staged and dispatched under merge-class
  authority;
* under a proposal-class profile the PR is a proposal for a person, who is not
  held to the binding: an unbound plan is staged and dispatched as before,
  with or without an operator's L1 merge-lane grant (the grant covers only
  the lane measured on the PR's diff, and ``plan_source`` sends its V7
  fallback down exactly this path under these profiles).
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aria_kernel import converged_delivery
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.bridge_exceptions import BridgeContractViolation
from aria_kernel.convergence_outcome import PARKED_PLAN_CONTEXT_KIND, parked_plan_request_id
from aria_kernel.cross_review_bridge import issue_implementation_envelope
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES, attribute_evaluation
from aria_kernel.operator_feedback_ingestion import bind_plan_synthesis, ingest_operator_feedback
from aria_kernel.plan_convergence import content_hash, counted_delivery_attempts
from aria_kernel.request_admission import admit_request
from aria_kernel.runtime_profile import merge_authority_available, set_merge_lane_grant
from tests._helpers.operator_acts import github_operator_acts, operator_set_profile
from tests.test_converged_delivery_scope_precheck import FARM, FORCER, _ScopeCase

# Persisted tokens, pinned by value: the reason code lands on the plan ledger,
# the withheld reason in the cycle summary, the kind on governance.
REASON = "implementation_envelope_unbound_plan"
WITHHELD = "unbound_plan"
KIND = "converged_delivery_unbound_plan"
# The merge walk's own name for a plan no synthesis_bound row names.
MERGE_REASON = "operator_feedback_synthesis_binding_unavailable"


class _MergeAuthorityCase(_ScopeCase):
    """The scope fixture's lane, holding merge-class authority (``autonomous``)."""

    def setUp(self) -> None:
        super().setUp()
        operator_set_profile("autonomous", base_dir=self.tools, scheduler_ceiling="autonomous")

    def bind(self, plan_id: str, *, cycle_id: str) -> None:
        """What the provider writes for the plan it selects: the cycle's
        ingestion scan, then the binding of the started content to it."""
        started = self.state(plan_id)["plan_started"]
        self.assertEqual(content_hash(started["plan_content"]), started["content_hash"])
        ingest_operator_feedback(base_dir=self.tools, cycle_id=cycle_id, repo_root=self.repo)
        bind_plan_synthesis(base_dir=self.tools, cycle_id=cycle_id, plan_content=started["plan_content"],
                            candidate={"source_type": "finding_pressure", "candidate_id": "cand-529"})


class UnboundPlanUnderMergeClassAuthority(_MergeAuthorityCase):
    def test_the_door_parks_it_on_the_first_offer_and_stages_nothing(self) -> None:
        plan_id = self.converge("plan-cli-started", [FARM])

        first = self.deliver(plan_id, cycle_id="cyc-1")
        later = self.sweep(cycle_id="cyc-2")

        state = self.state(plan_id)
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(state))), (0, 0, 0, 0))
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual(first["delivery"]["withheld"], WITHHELD)
        self.assertIsNone(first["delivery"]["attempt"])
        self.assertEqual(first["rejection_class"], f"delivery_withheld:{WITHHELD}")
        self.assertEqual((later["stranded"], later["offered"], later["escalated"]), ([], [], []))
        self.assertEqual(list_agent_invocation_requests(base_dir=self.tools), [])

    def test_the_plan_row_governance_row_and_operator_item_name_the_merge_walk(self) -> None:
        plan_id = self.converge("plan-cli-started", [FARM])
        self.deliver(plan_id, cycle_id="cyc-1")

        [row] = self.human_required_evaluations(plan_id)
        self.assertEqual((row["reason_codes"], row["forced_by"]), ([REASON], FORCER))
        self.assertIsNone(attribute_evaluation(row, plan_id=plan_id, drafter="agent:drafter", ledgers=None))
        [governance] = self.governance(KIND)
        self.assertEqual(governance["plan_id"], plan_id)
        self.assertEqual(governance["refusal"], f"{REASON}:{MERGE_REASON}")
        item = self.operator_items()[parked_plan_request_id(plan_id)]
        self.assertEqual(
            {key: item["context"][key] for key in ("kind", "plan_id", "verdict", "reason_codes", "origin")},
            {"kind": PARKED_PLAN_CONTEXT_KIND, "plan_id": plan_id, "verdict": WITHHELD,
             "reason_codes": [REASON], "origin": "converged_delivery"},
        )

    def test_the_mint_refuses_it_on_its_own(self) -> None:
        plan_id = self.converge("plan-cli-started", [FARM])
        with self.assertRaisesRegex(BridgeContractViolation, f"{REASON}:{MERGE_REASON}"):
            issue_implementation_envelope(
                plan_id=plan_id, cross_review_revision_id="cr-529", cross_review_summary_text="{}",
                proposal_id="prop-529", change_id="chg-529", branch="aria/impl-529", base_sha="0" * 40,
                cycle_id="cyc-1", base_dir=self.tools,
                admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools,
                                        cycle_id="cyc-1"),
            )
        self.assertEqual(self.state(plan_id)["state"], "CONVERGED")
        self.assertEqual(list_agent_invocation_requests(base_dir=self.tools), [])

    def test_a_plan_the_provider_bound_is_staged_and_dispatched(self) -> None:
        plan_id = self.converge("plan-provider-started", [FARM])
        self.bind(plan_id, cycle_id="cyc-1")

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED", summary)
        self.assertEqual(self.state(plan_id)["state"], "IMPLEMENTATION_REQUESTED")
        self.assertEqual(self.governance(KIND), [])

    def test_the_reason_is_a_kernel_forced_code(self) -> None:
        self.assertEqual(converged_delivery.UNBOUND_PLAN_KIND, KIND)
        self.assertIn(REASON, KERNEL_FORCED_CODES)


class UnboundPlanUnderProposalClassAuthority(_ScopeCase):
    def test_it_is_still_a_proposal_for_a_person(self) -> None:
        plan_id = self.converge("plan-cli-started", [FARM])

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED", summary)
        self.assertEqual(self.governance(KIND), [])

    def test_an_l1_merge_lane_grant_does_not_make_it_merge_class(self) -> None:
        expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        with github_operator_acts() as github:
            set_merge_lane_grant(
                lane="L1", expires_at=expires_at, base_dir=self.tools,
                operator_approval_ref=github.approve("merge_lane_grant", {"lane": "L1", "expires": expires_at}),
            )
        self.assertTrue(merge_authority_available(base_dir=self.tools))
        plan_id = self.converge("plan-v7-fallback", [FARM])

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED", summary)
        self.assertEqual(self.governance(KIND), [])


if __name__ == "__main__":
    unittest.main()
