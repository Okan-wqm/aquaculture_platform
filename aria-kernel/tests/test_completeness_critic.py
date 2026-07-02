"""Completeness-critic role (plan-coverage gate PR-2) — kernel pins.

PR-1 machine-accepted any non-empty waiver reason (documented staged
loosening). This suite pins the tightening: waivers cover their closure
nodes ONLY when the critic explicitly accepts them; rejection, omission,
timeout, and malformed responses all fail closed to gaps with fresh
round-scoped synthetic risks.
"""
from __future__ import annotations

import inspect
import unittest

from aria_kernel import convergence_drainer
from aria_kernel.agent_surface import (
    DEFAULT_TARGET_AGENT_WHITELIST,
    DISPATCHABLE_ROLES,
    PLANNER_BRIDGE_ROLES,
    REQUEST_ROLES,
    ROLE_TARGET_PAIRING,
)
from aria_kernel.convergence_drainer import _CONVERGENCE_INLINE_DISPATCH_ROLES
from aria_kernel.cross_review_bridge import (
    COMPLETENESS_CRITIC_ROLE,
    _completeness_critic_suggested_prompt,
    issue_completeness_critic_envelope,
)
from aria_kernel.plan_convergence import _validate_cross_review_risk
from aria_kernel.plan_coverage import adjudicate_waivers, parse_critic_adjudication
from aria_kernel.tool_registry import GovernanceError

MANIFEST = "aria-tools/coverage/plan-1-r1.json"


def covered_with_waivers_payload():
    return {
        "round_number": 1,
        "target_revision_id": "rev-0",
        "target_plan_content_hash": "sha256:" + "0" * 64,
        "verdict": "covered_with_waivers",
        "closure_manifest_path": MANIFEST,
        "closure_manifest_hash": "sha256:" + "1" * 64,
        "closure_summary": {"projects": 2},
        "uncovered": [],
        "waived": [
            {"node_id": "project:notification-service", "reason": "type-only change"},
            {"node_id": "migration:farm-service", "reason": "no schema delta"},
        ],
        "synthetic_risks": [],
        "computed_at_sha": "0" * 40,
        "witness": {"tool": "tools/gates/plan-coverage-witness.ts", "exit_code": 0},
    }


class AdjudicateWaiversTests(unittest.TestCase):
    def test_all_accepted_keeps_covered_with_waivers(self):
        adjudication = {
            "accepted": ["project:notification-service", "migration:farm-service"],
            "rejected": [],
        }
        result = adjudicate_waivers(
            payload=covered_with_waivers_payload(), adjudication=adjudication,
            round_number=1, critic_request_id="AIR-critic-1",
        )
        self.assertEqual(result["verdict"], "covered_with_waivers")
        self.assertEqual(len(result["waived"]), 2)
        self.assertEqual(result["uncovered"], [])
        self.assertEqual(result["witness"]["waiver_adjudication"]["accepted"], 2)

    def test_rejected_waiver_flips_to_gaps_with_round_scoped_risk(self):
        adjudication = {
            "accepted": ["project:notification-service"],
            "rejected": [{"node_id": "migration:farm-service", "reason": "handler reads renamed field"}],
        }
        result = adjudicate_waivers(
            payload=covered_with_waivers_payload(), adjudication=adjudication, round_number=2,
        )
        self.assertEqual(result["verdict"], "gaps")
        self.assertEqual(len(result["uncovered"]), 1)
        self.assertIn("waiver_rejected_by_critic", result["uncovered"][0]["why"])
        self.assertEqual(len(result["synthetic_risks"]), 1)
        risk = result["synthetic_risks"][0]
        self.assertTrue(risk["risk_id"].startswith("COV-R2-"))
        _validate_cross_review_risk(risk)

    def test_omitted_node_is_unadjudicated_and_fails_closed(self):
        adjudication = {"accepted": ["project:notification-service"], "rejected": []}
        result = adjudicate_waivers(
            payload=covered_with_waivers_payload(), adjudication=adjudication, round_number=1,
        )
        self.assertEqual(result["verdict"], "gaps")
        self.assertEqual(result["uncovered"][0]["why"], "waiver_unadjudicated")
        self.assertEqual(result["witness"]["waiver_adjudication"]["unadjudicated"], 1)

    def test_none_adjudication_flips_every_waiver(self):
        result = adjudicate_waivers(
            payload=covered_with_waivers_payload(), adjudication=None, round_number=1,
        )
        self.assertEqual(result["verdict"], "gaps")
        self.assertEqual(len(result["uncovered"]), 2)
        self.assertEqual(len(result["synthetic_risks"]), 2)
        self.assertFalse(result["witness"]["waiver_adjudication"]["adjudicated"])

    def test_no_waivers_is_a_no_op(self):
        payload = covered_with_waivers_payload()
        payload["waived"] = []
        payload["verdict"] = "covered"
        self.assertEqual(
            adjudicate_waivers(payload=payload, adjudication=None, round_number=1), payload,
        )


class ParseCriticAdjudicationTests(unittest.TestCase):
    def test_valid_shape_parses(self):
        envelope = {
            "details": {
                "waiver_adjudication": {
                    "accepted": ["project:x"],
                    "rejected": [{"node_id": "project:y", "reason": "verified coupling"}],
                },
            },
        }
        parsed = parse_critic_adjudication(envelope)
        self.assertEqual(parsed["accepted"], ["project:x"])
        self.assertEqual(parsed["rejected"][0]["node_id"], "project:y")

    def test_malformed_shapes_return_none(self):
        for bad in (
            None,
            {},
            {"details": {}},
            {"details": {"waiver_adjudication": {"accepted": "not-a-list", "rejected": []}}},
            {"details": {"waiver_adjudication": {"accepted": [], "rejected": [{"node_id": "x"}]}}},
            {"details": {"waiver_adjudication": {"accepted": [], "rejected": [{"node_id": "", "reason": "r"}]}}},
        ):
            self.assertIsNone(parse_critic_adjudication(bad), bad)


class CriticEnvelopeTests(unittest.TestCase):
    def test_envelope_requires_waivers_and_hash(self):
        with self.assertRaisesRegex(GovernanceError, "waivers"):
            issue_completeness_critic_envelope(
                plan_id="plan-1", round_number=1, closure_manifest_text="{}",
                closure_manifest_hash="sha256:" + "1" * 64, waivers=[],
                evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["aria-tools/**"],
            )
        with self.assertRaisesRegex(GovernanceError, "closure_manifest_hash"):
            issue_completeness_critic_envelope(
                plan_id="plan-1", round_number=1, closure_manifest_text="{}",
                closure_manifest_hash="not-a-hash",
                waivers=[{"node_id": "project:x", "reason": "r"}],
                evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["aria-tools/**"],
            )

    def test_prompt_carries_untrusted_delimiters_and_fail_closed_warning(self):
        prompt = _completeness_critic_suggested_prompt(
            plan_id="plan-1", round_number=2,
            closure_manifest_text='{"closure": {}}',
            waivers_text='[{"node_id": "project:x"}]',
            closure_manifest_hash="sha256:" + "1" * 64,
        )
        self.assertIn("<untrusted_closure_manifest", prompt)
        self.assertIn("<untrusted_waivers>", prompt)
        self.assertIn("REJECTED by the kernel", prompt)
        self.assertIn("details.waiver_adjudication", prompt.replace("`", ""))


class RolePlumbingPins(unittest.TestCase):
    def test_role_registered_across_surfaces(self):
        self.assertIn("completeness_critique", REQUEST_ROLES)
        self.assertIn("completeness_critique", DISPATCHABLE_ROLES)
        self.assertIn("completeness_critique", _CONVERGENCE_INLINE_DISPATCH_ROLES)
        self.assertEqual(ROLE_TARGET_PAIRING["completeness_critique"], ("aria-completeness-critic",))
        self.assertIn("aria-completeness-critic", DEFAULT_TARGET_AGENT_WHITELIST)
        self.assertEqual(COMPLETENESS_CRITIC_ROLE, ("aria-completeness-critic", "completeness_critique"))

    def test_role_is_annotation_only_not_a_planner_bridge_role(self):
        # record_plan_result must return None for this role: the drainer
        # reads the verdict from the results ledger; no plan-state mutation
        # happens on submit.
        self.assertNotIn("completeness_critique", PLANNER_BRIDGE_ROLES)


class DrainerCriticGatePins(unittest.TestCase):
    def test_critic_gate_sits_between_compute_and_record(self):
        source = inspect.getsource(convergence_drainer.run_convergence_drainer)
        gate = source.index("resolved_critic_adjudicator(payload, current_round)")
        record = source.index("record_coverage(plan_id=plan_id, coverage=payload, base_dir=base_dir)")
        self.assertLess(gate, record)
        self.assertIn('payload.get("verdict") == "covered_with_waivers"', source)

    def test_critic_adjudicator_is_injectable_with_production_default(self):
        signature = inspect.signature(convergence_drainer.run_convergence_drainer)
        self.assertIn("critic_adjudicator", signature.parameters)
        self.assertIn("critic_timeout_seconds", signature.parameters)
        source = inspect.getsource(convergence_drainer.run_convergence_drainer)
        self.assertIn("critic_adjudicator or _dispatch_and_adjudicate", source)


if __name__ == "__main__":
    unittest.main()
