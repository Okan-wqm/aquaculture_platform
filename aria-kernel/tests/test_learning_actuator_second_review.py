"""ARIA-HIGH-370 — second review of #1829: one HIGH and five MEDIUM.

Each test failed on the branch before this commit (a0e67fefc):

* H-A — an evaluator row carrying an environment fault next to an
  allowlisted gate code blamed the drafter for the gate code;
* M1 — the gate epoch hashed seven whole files (comments included) and none
  of the modules that produce the allowlisted codes;
* M2 — a lease expiry (fault domain ``request`` for the requeue budget) let a
  first-attempt rejection followed by a hung attempt stay the agent's;
* M3 — ``plan force-human-required`` could write the kernel's own row;
* M4 — a red run without job data collapsed to a workflow-only identity;
* M5 — the half-open probe was not counted.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

from aria_kernel.ledger import append_declared_jsonl, load_segments
from aria_kernel.plan_convergence import force_plan_human_required
from aria_kernel.tool_registry import GovernanceError

from tests._helpers.plan_evaluations import evaluator_escalation
from tests.test_candidate_admission_lessons import NOW, episode, history
from tests.test_learning_attribution import _Ledgers


class AnEnvironmentFaultOnTheRowIsTheWholeRowsTests(_Ledgers):
    def test_both_probe_rows_stay_unattributed_and_a_pure_gate_row_does_not(self) -> None:
        rows_codes = {
            "plan-cov-env": ["coverage_environment_unable", "material_cross_review_risks_present"],
            "plan-spine-env": ["architecture_spine_unavailable:git_timeout", "plan_contract_incomplete"],
            "plan-pure": ["coverage_gaps_present", "max_rounds_reached"],
        }
        for plan, codes in rows_codes.items():
            self.start(plan)
            evaluator_escalation(self.tools, plan, *codes)
        rows = self.episodes()
        self.assertEqual([rows[p]["attributable"] for p in rows_codes], [False, False, True])


class OnlyAKernelCallerForcesAKernelRowTests(_Ledgers):
    def test_the_operator_cannot_write_the_kernels_escalation(self) -> None:
        codes = ["max_rounds_reached", "unresolved_material_risk"]
        self.start("plan-op")
        force_plan_human_required(plan_id="plan-op", round_number=4, reason_codes=codes, base_dir=self.tools)
        self.start("plan-kernel")
        force_plan_human_required(plan_id="plan-kernel", round_number=4, reason_codes=codes, base_dir=self.tools,
                                  forced_by="kernel:plan_round_controller")
        rows = self.episodes()
        self.assertEqual((rows["plan-op"]["attributable"], rows["plan-kernel"]["attributable"]), (False, True))
        self.assertEqual(rows["plan-kernel"]["attribution"]["evidence_type"], "cross_review_rejection")

    def test_an_unknown_forcer_is_refused(self) -> None:
        self.start("plan-x")
        with self.assertRaises(GovernanceError):
            force_plan_human_required(plan_id="plan-x", round_number=1, reason_codes=["max_rounds_reached"],
                                      base_dir=self.tools, forced_by="kernel:made_up")


class ALeaseExpiryEndsTheAnalysisTests(_Ledgers):
    def claims(self, plan: str, *rows: dict[str, Any]) -> None:
        request = [r for r in load_segments(self.tools, "agent_invocation_requests") if r["convergence_id"] == plan][-1]
        for row in rows:
            append_declared_jsonl(self.tools / "agent-invocations" / "claims.jsonl",
                                  {"schema_version": 1, "request_id": request["request_id"], "claim_id": "c2", **row},
                                  expected_surface="agent_invocation_claims")

    def test_a_rejection_followed_by_a_hung_attempt_is_not_the_agents(self) -> None:
        self.dead_challenger("plan-hung", rejected_codes=["agent_evidence_ref_malformed"])
        self.claims("plan-hung", {"event": "stale", "stale_at": "2099-01-01T00:00:00Z"},
                    {"event": "requeued", "reason": "lease_expired", "at": "2099-01-01T00:00:00Z"})
        self.assertFalse(self.episodes()["plan-hung"]["attributable"])

    def test_a_terminal_lease_expiry_is_not_the_agents(self) -> None:
        self.dead_challenger("plan-lease", release="lease_expired")
        self.assertFalse(self.episodes()["plan-lease"]["attributable"])


class TheGateEpochIsGateSemanticsTests(unittest.TestCase):
    def test_a_comment_or_docstring_does_not_move_it_and_code_does(self) -> None:
        from aria_kernel.attribution_void import definition_digest

        base = 'def gate(x):\n    """Doc."""\n    return x > 1\n'
        commented = 'def gate(x):\n    """Other doc."""\n    # a comment\n    return x > 1\n'
        changed = 'def gate(x):\n    """Doc."""\n    return x > 2\n'
        self.assertEqual(definition_digest(base, "gate"), definition_digest(commented, "gate"))
        self.assertNotEqual(definition_digest(base, "gate"), definition_digest(changed, "gate"))

    def test_every_gate_definition_exists_including_the_code_producers(self) -> None:
        from aria_kernel.attribution_void import GATE_DEFINITIONS, gate_epoch

        modules = {module for module, _name in GATE_DEFINITIONS}
        self.assertLessEqual({"plan_convergence", "architecture_spine_gate", "must_satisfy", "plan_contract"}, modules)
        self.assertTrue(gate_epoch().startswith("sha256:"))


class AnUnknownFailingCiIdentityIsNotCountedTests(unittest.TestCase):
    def test_no_job_data_is_no_signature_and_no_identity(self) -> None:
        from aria_kernel.admission_lessons import candidate_identity
        from aria_kernel.plan_synthesizer import _failing_signature

        self.assertIsNone(_failing_signature(".github/workflows/ci.yml", []))
        red = {"evidence_refs": [".github/workflows/ci.yml"], "provenance_refs": ["gh-run-list:ci-run-9"]}
        self.assertIsNone(candidate_identity(red, None))


class OneProbeIsOneProbeTests(unittest.TestCase):
    def verdict(self, probes: tuple[dict[str, Any], ...], now: datetime = NOW) -> dict[str, Any]:
        from aria_kernel.admission_lessons import AdmissionHistory, admission_verdict

        base = history(episode("a", 10), episode("b", 9), episode("c", 8))
        with patch("aria_kernel.admission_lessons.candidate_identity", return_value="id-1"):
            return admission_verdict(AdmissionHistory(base.identities, base.episodes, None, now, probes),
                                     {"evidence_refs": ["x"]})

    def probe(self, days_ago: float, epoch: str | None = None) -> dict[str, Any]:
        from aria_kernel.attribution_void import gate_epoch

        return {"candidate_identity": "id-1", "admitted_at": (NOW - timedelta(days=days_ago)).isoformat(),
                "gate_epoch": epoch or gate_epoch()}

    def test_a_recorded_probe_is_spent_until_a_new_interval_or_epoch(self) -> None:
        self.assertEqual(self.verdict(())["breaker"], "probe_interval_elapsed")
        self.assertEqual(self.verdict((self.probe(1),))["breaker"], "probe_spent")
        self.assertEqual(self.verdict((self.probe(8),))["breaker"], "probe_interval_elapsed")
        self.assertEqual(self.verdict((self.probe(1, epoch="sha256:old"),))["breaker"], "probe_interval_elapsed")

    def test_the_provider_records_the_probe_it_grants(self) -> None:
        from aria_kernel.admission_lessons import PROBES_PATH, record_probe
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            tools = ensure_tools_dir(Path(tmp) / "aria-tools")
            record_probe(base_dir=tools, cycle_id="cyc-p", lesson={
                "candidate_identity": "id-1", "breaker": "probe_interval_elapsed", "plan_ids": ["a"]})
            rows = load_declared_jsonl(tools / PROBES_PATH, expected_surface="admission_probes")
        self.assertEqual([(r["candidate_identity"], r["cycle_id"]) for r in rows], [("id-1", "cyc-p")])


if __name__ == "__main__":
    unittest.main()
