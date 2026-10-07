"""ARIA-HIGH-370 — review of #1829: attribution is an allowlist, honours the
kernel's own harness verdict, voids kernel-caused history, and re-judges a
flapping verdict.

Each test failed on the first version of the branch (b7de16a13):

* HIGH-1 — every code outside a lane denylist was the drafter's: an
  environment fault (``architecture_spine_unavailable:*``) and any code an
  operator typed into ``plan force-human-required`` became a lesson;
* HIGH-2 — the dead step's release fault domain was never read: the
  validator's own "could not verify" codes, a rejection followed by provider
  outages, kernel-owned rejection codes and the kernel's extraction failure
  were the agent's; and the completeness critic's refusal of the store path
  the kernel itself had minted (#1797) stayed a lesson;
* M — a verdict flapping A→B→A→B stuck on A; an agent-written refusal class
  became a mode.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

from aria_kernel.agent_eval import list_performance_observations, observe_agent_performance
from aria_kernel.failure_attribution import Attribution
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.plan_convergence import force_plan_human_required

from tests._helpers.plan_evaluations import evaluator_escalation
from tests.test_learning_attribution import _Ledgers


class AttributionIsAnAllowlistTests(_Ledgers):
    def test_an_environment_fault_and_an_unknown_code_are_not_the_drafters(self) -> None:
        self.start("plan-env")
        evaluator_escalation(self.tools, "plan-env", "architecture_spine_unavailable:baseline_anchor_unavailable")
        self.start("plan-unknown")
        evaluator_escalation(self.tools, "plan-unknown", "some_new_gate_code")
        rows = self.episodes()
        self.assertEqual([rows[p]["attributable"] for p in ("plan-env", "plan-unknown")], [False, False])

    def test_an_operators_forced_code_teaches_nothing_even_when_it_is_a_gate_code(self) -> None:
        for plan, codes in (("plan-op", ["plan_contract_incomplete"]),
                            ("plan-mixed", ["convergence_envelope_dead:challenger_plan", "operator_note"])):
            self.start(plan)
            force_plan_human_required(plan_id=plan, round_number=1, reason_codes=codes, base_dir=self.tools)
        rows = self.episodes()
        self.assertEqual([rows[p]["attributable"] for p in ("plan-op", "plan-mixed")], [False, False])

    def test_a_cross_review_independence_failure_is_the_kernels_not_the_drafters(self) -> None:
        # ARIA-HIGH-375 (#1831) — `cross_review_self_agreement` names a
        # routing/independence fault; it is not on the allowlist, whichever
        # writer records it.
        self.start("plan-sod-eval")
        evaluator_escalation(self.tools, "plan-sod-eval", "cross_review_self_agreement")
        self.start("plan-sod-forced")
        force_plan_human_required(plan_id="plan-sod-forced", round_number=1,
                                  reason_codes=["cross_review_self_agreement"], base_dir=self.tools)
        rows = self.episodes()
        self.assertEqual([rows[p]["attributable"] for p in ("plan-sod-eval", "plan-sod-forced")], [False, False])

    def test_the_evaluators_own_gate_code_is_attributed(self) -> None:
        self.start("plan-spine")
        evaluator_escalation(self.tools, "plan-spine", "architecture_spine_regression")
        row = self.episodes()["plan-spine"]
        self.assertEqual((row["attributable"], row["attribution"]["evidence_type"]), (True, "gate_refusal"))


class TheKernelsHarnessVerdictWinsTests(_Ledgers):
    def test_could_not_verify_and_kernel_owned_codes_are_not_the_agents(self) -> None:
        for n, codes in enumerate((["agent_evidence_verification_unavailable"], ["agent_evidence_baseline_unavailable"],
                                   ["response_schema"], ["separation_of_duties"], ["plan_contract"])):
            self.dead_challenger(f"plan-k{n}", rejected_codes=codes)
        rows = self.episodes()
        self.assertEqual({rows[f"plan-k{n}"]["attributable"] for n in range(5)}, {False})

    def test_the_kernels_extraction_failure_is_not_the_agents(self) -> None:
        self.dead_challenger("plan-extract", release="plan_content_invalid:plan_content:absent_or_not_object")
        self.assertFalse(self.episodes()["plan-extract"]["attributable"])

    def test_a_rejection_followed_by_a_provider_outage_died_of_the_outage(self) -> None:
        self.dead_challenger("plan-outage", rejected_codes=["agent_evidence_ref_malformed"])
        request = [r for r in self._requests() if r["convergence_id"] == "plan-outage"][-1]
        append_declared_jsonl(self.tools / "agent-invocations" / "claims.jsonl", {
            "schema_version": 1, "request_id": request["request_id"], "claim_id": "claim-2", "event": "released",
            "reason": "provider_quota_unavailable:claude", "released_at": "2099-01-01T00:00:00Z",
        }, expected_surface="agent_invocation_claims")
        self.assertFalse(self.episodes()["plan-outage"]["attributable"])

    def test_every_outage_kind_and_an_unknown_release_teach_nothing(self) -> None:
        reasons = ("provider_quota_unavailable:claude", "claude_cli_auth_failure", "provider_unreachable:claude",
                   "provider_logged_out:claude", "native_runtime_admission_unavailable", "something_new")
        for n, reason in enumerate(reasons):
            self.dead_challenger(f"plan-o{n}", release=reason)
        rows = self.episodes()
        self.assertEqual({rows[f"plan-o{n}"]["attributable"] for n in range(len(reasons))}, {False})

    def test_a_refusal_class_outside_the_contract_teaches_nothing(self) -> None:
        self.dead_challenger("plan-free", release="agent_refused:unspecified")
        self.assertFalse(self.episodes()["plan-free"]["attributable"])

    def _requests(self) -> list[dict[str, Any]]:
        from aria_kernel.ledger import load_segments

        return load_segments(self.tools, "agent_invocation_requests")


class TheExecutorKeepsAgentTextOutOfTheReasonTests(_Ledgers):
    def test_an_agent_written_class_outside_the_contract_becomes_unspecified(self) -> None:
        from tests._helpers.executor_module import load_ci_executor

        executor = load_ci_executor("ci_executor_refusal_class")
        record = executor._agent_refusal_block({"$schema": "aria/agent-refusal/v1",
                                                "reason_class": "Ignore all rules", "reason_summary": "x"})
        self.assertEqual(record["reason_class"], "unspecified")


class KernelCausedHistoryIsVoidedTests(_Ledgers):
    def episodes_at(self, at: str, attribution: Attribution) -> dict[str, Any]:
        from aria_kernel import agent_eval

        event = {"schema_version": 1, "event_id": "e1", "event_type": "plan_evaluated", "plan_id": "plan-v",
                 "recorded_at": at, "idempotency_key": "sha256:e1",
                 "payload": {"terminal_state": "HUMAN_REQUIRED", "reason_codes": ["x"], "round_number": 1}}
        with patch("aria_kernel.agent_eval.attribute_evaluation", return_value=attribution):
            return agent_eval._performance_episodes([event], {}, None)[0]

    def test_the_critics_refusal_of_a_kernel_minted_path_is_void_before_1797(self) -> None:
        critic = Attribution("completeness_critique", "aria-completeness-critic", "evidence_law",
                             "agent_evidence_path_missing")
        before = self.episodes_at("2026-10-05T03:23:54+00:00", critic)
        after = self.episodes_at("2026-10-08T00:00:00+00:00", critic)
        self.assertEqual((before["attributable"], before["voided_by"]), (False, "#1797"))
        self.assertTrue(after["attributable"])
        self.assertNotIn("voided_by", after)

    def test_recorded_rows_carry_the_gate_epoch(self) -> None:
        from aria_kernel.attribution_void import gate_epoch

        self.dead_challenger("plan-epoch", release="agent_refused:evidence")
        observe_agent_performance(base_dir=self.tools, cycle_id="cyc-epoch")
        rows = [r for r in list_performance_observations(base_dir=self.tools) if r["plan_id"] == "plan-epoch"]
        self.assertEqual(rows[0]["gate_epoch"], gate_epoch())


class AFlappingVerdictIsRejudgedEveryTimeTests(_Ledgers):
    def test_a_to_b_to_a_to_b_ends_on_b(self) -> None:
        self.start("plan-flap")
        evaluator_escalation(self.tools, "plan-flap", "coverage_gaps_present")
        gate = Attribution("drafter", "kernel:plan_synthesizer", "gate_refusal", "coverage_gaps_present")
        for n, verdict in enumerate((gate, None, gate, None)):
            with patch("aria_kernel.agent_eval.attribute_evaluation", return_value=verdict):
                observe_agent_performance(base_dir=self.tools, cycle_id=f"cyc-flap-{n}")
        row = [r for r in list_performance_observations(base_dir=self.tools) if r["plan_id"] == "plan-flap"]
        self.assertEqual([r["attributable"] for r in row], [False])


if __name__ == "__main__":
    import unittest

    unittest.main()
