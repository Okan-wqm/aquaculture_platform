"""WP-J B-1 — method diversity is the single-provider anchor leg.

Operator decision 2026-10-18: diversity comes from PERSPECTIVE and METHOD,
not from the provider; ``ANCHOR_MIN_DISTINCT_MODELS`` must not block ground
truth when only one provider exists. G-2 (ORPHAN-HIGH-760) survives the swap
unchanged: a receipt that can answer NEITHER the method question NOR the
model question is never green.

The leg is HYBRID because the ledger already holds truth:

* the 16 live anchors (aria/state 2026-10-16) carry model-only observer
  receipts — they keep the model leg and stay ground truth, replayed here
  from a fixture captured read-only off ``origin/aria/state``;
* rows minted after this change carry the seat's METHOD on the receipt
  (stamped mint-first, the ORPHAN-HIGH-781 doctrine), and their diversity
  is counted in methods — three unanimous judges on ONE model spanning two
  methods IS ground truth, which the model leg can never express;
* a receipt set that spans neither leg (mixed, or judge_id-only) fails
  closed.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    CALIBRATED_QUORUM_MIN_JUDGES,
    generate_ai_consensus,
    is_ground_truth_row,
    record_operator_feedback,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

from tests._helpers.rule_contracts import register_contracted_tool


_LIVE_ANCHORS = (
    Path(__file__).resolve().parent / "fixtures" / "live-anchor-rows-aria-state-2026-10-16.json"
)

# The single-provider fleet the operator named: every seat on ONE model,
# separated only by method.
_ONE_PROVIDER_MODEL = "glm-5.3"
_METHOD_SEATS = {
    "aria-evidence-judge": "static_trace",
    "aria-adversarial-judgment-seat": "devils_advocate",
    "aria-consensus-arbiter": "evidence_weighing",
}


class _LedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpjb1-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge(
        self,
        judge_id: str,
        *,
        method: str | None = None,
        model: str | None = _ONE_PROVIDER_MODEL,
        verdict: str = "true_positive",
    ) -> None:
        record_operator_feedback(
            tool_id="tool-a",
            run_id="run-1",
            finding_id="F-1",
            verdict=verdict,
            severity="high",
            note=f"{judge_id} verdict",
            source_type="ai_judge",
            judge_id=judge_id,
            model=model,
            method=method,
            confidence=0.95,
            judgment_group_id="judge:tool-a:F-1",
            finding_fingerprint="fp-F-1",
            base_dir=self.tools,
        )


class SingleProviderAnchorTests(_LedgerCase):
    """The red test of the whole slice: a unanimous single-model panel whose
    seats span >= 2 methods anchors. Today the mint cannot even write the
    method receipt, and the read counts models only."""

    def test_three_unanimous_judges_on_one_model_spanning_methods_anchor(self) -> None:
        for judge_id, method in _METHOD_SEATS.items():
            self._judge(judge_id, method=method)
        result = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)
        row = result["consensus"][0]
        self.assertEqual((row["judge_count"], row["judges_voted"]), (ANCHOR_MIN_JUDGE_COUNT,) * 2)
        self.assertTrue(
            is_ground_truth_row(row),
            "one provider spanning three methods is anchor grade",
        )

    def test_the_observers_receipt_carries_the_method_beside_the_model(self) -> None:
        for judge_id, method in _METHOD_SEATS.items():
            self._judge(judge_id, method=method)
        row = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)["consensus"][0]
        self.assertEqual(
            sorted((o["judge_id"], o["method"]) for o in row["observers"]),
            sorted((judge_id, method) for judge_id, method in _METHOD_SEATS.items()),
        )

    def test_one_method_wearing_three_names_is_not_an_anchor(self) -> None:
        """Method diversity is not a spelling trick: three seats of ONE
        method on one model remain one observation with two receipts."""
        for index, judge_id in enumerate(_METHOD_SEATS):
            self._judge(f"{judge_id}-{index}", method="static_trace")
        row = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)["consensus"][0]
        self.assertFalse(is_ground_truth_row(row))

    def test_a_judge_row_refuses_an_unknown_method(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "unknown feedback method"):
            self._judge("aria-evidence-judge", method="vibes")


class HybridLegPredicateTests(unittest.TestCase):
    """The read leg, pinned at the predicate the whole kernel asks."""

    def test_method_receipts_on_one_model_are_ground_truth(self) -> None:
        self.assertTrue(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT,
                "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
                "observers": [
                    {"judge_id": "a", "model": "glm-5.3", "method": "static_trace"},
                    {"judge_id": "b", "model": "glm-5.3", "method": "bug_hunt"},
                    {"judge_id": "c", "model": "glm-5.3", "method": "reproduction_test"},
                ],
            }),
        )

    def test_method_receipts_of_one_method_are_not_ground_truth(self) -> None:
        self.assertFalse(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT,
                "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
                "observers": [
                    {"judge_id": name, "model": "glm-5.3", "method": "static_trace"}
                    for name in "abc"
                ],
            }),
        )

    def test_a_receipt_set_that_answers_neither_leg_fails_closed(self) -> None:
        """G-2 preserved: mixed legs and judge_id-only receipts are unknown,
        and unknown is never green."""
        mixed = {
            "source_type": "ai_consensus",
            "judge_count": ANCHOR_MIN_JUDGE_COUNT,
            "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
            "observers": [
                {"judge_id": "a", "model": "glm-5.3", "method": "static_trace"},
                {"judge_id": "b", "model": "glm-5.3", "method": "bug_hunt"},
                {"judge_id": "c", "model": "fable"},
            ],
        }
        self.assertFalse(is_ground_truth_row(mixed))
        anonymous = {
            "source_type": "ai_consensus",
            "judge_count": ANCHOR_MIN_JUDGE_COUNT,
            "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
            "observers": [{"judge_id": name} for name in "abc"],
        }
        self.assertFalse(is_ground_truth_row(anonymous))

    def test_the_live_anchors_replay_as_ground_truth(self) -> None:
        """Truth readability: the 16 anchors on aria/state carry model-only
        receipts and keep the model leg under the hybrid predicate."""
        captured = json.loads(_LIVE_ANCHORS.read_text(encoding="utf-8"))
        self.assertEqual(captured["count"], 16)
        for row in captured["rows"]:
            self.assertTrue(
                is_ground_truth_row(row),
                f"live anchor {row.get('finding_id')} must stay ground truth",
            )


class CalibratedQuorumMethodLegTests(_LedgerCase):
    """The closing authority's twin swap: under ``enforce`` the calibrated
    quorum is two calibrated judges of distinct METHODS (the model leg
    remains for legacy calibration rows that cannot name a method).

    The consensus engine takes the caller's flat status mapping — the exact
    shape the cycle builds at its ``_gate_for_consensus`` — so the METHOD
    data the quorum leg reads comes from the judge rows themselves, which is
    the mint-first receipt, not from the calibration mapping.
    """

    CALIBRATED = {judge_id: "calibrated" for judge_id in _METHOD_SEATS}

    def test_enforce_closes_on_distinct_methods_on_one_model(self) -> None:
        for judge_id, method in _METHOD_SEATS.items():
            self._judge(judge_id, method=method)
        result = generate_ai_consensus(
            tool_id="tool-a",
            base_dir=self.tools,
            judge_calibration=self.CALIBRATED,
            calibration_gate="enforce",
        )
        self.assertEqual(result["consensus_count"], 1)
        self.assertTrue(is_ground_truth_row(result["consensus"][0]))

    def test_enforce_refuses_a_quorum_of_one_method(self) -> None:
        calibrated = {"a": "calibrated", "b": "calibrated"}
        for judge_id, method in (("a", "static_trace"), ("b", "static_trace")):
            self._judge(judge_id, method=method)
        result = generate_ai_consensus(
            tool_id="tool-a",
            base_dir=self.tools,
            judge_calibration=calibrated,
            calibration_gate="enforce",
        )
        self.assertEqual(result["consensus_count"], 0)
        self.assertEqual(
            [u["reason"] for u in result["uncertainties"]], ["confidence_uncalibrated"],
        )

    def test_the_enforce_quorum_still_requires_the_judge_count(self) -> None:
        """The method leg widens DIVERSITY, not ATTENDANCE: one calibrated
        judge of one method still cannot close alone."""
        calibrated = {"a": "calibrated"}
        self._judge("a", method="static_trace")
        self._judge("b", method="static_trace")
        result = generate_ai_consensus(
            tool_id="tool-a",
            base_dir=self.tools,
            judge_calibration=calibrated,
            calibration_gate="enforce",
        )
        self.assertEqual(
            [u["reason"] for u in result["uncertainties"]], ["confidence_uncalibrated"],
        )

    def test_enforce_keeps_the_legacy_model_leg(self) -> None:
        """Calibration rows that predate method receipts still close on the
        model leg: two calibrated judges, two models, no methods."""
        calibrated = {"a": "calibrated", "b": "calibrated"}
        self._judge("a", model="opus", method=None)
        self._judge("b", model="glm-5.3", method=None)
        result = generate_ai_consensus(
            tool_id="tool-a",
            base_dir=self.tools,
            judge_calibration=calibrated,
            calibration_gate="enforce",
        )
        self.assertEqual(result["consensus_count"], 1)


class EffectiveGateMethodLegTests(unittest.TestCase):
    """genesis_policy.effective_calibration_gate keeps the enforce gate
    reachable on one provider: the downgrade test asks the same hybrid
    question the consensus gate asks."""

    def test_the_gate_upgrades_on_two_calibrated_methods_of_one_model(self) -> None:
        from aria_kernel.genesis_policy import effective_calibration_gate

        gate = effective_calibration_gate("enforce", {
            "a": {"calibration_status": "calibrated", "model": "glm-5.3", "method": "static_trace"},
            "b": {"calibration_status": "calibrated", "model": "glm-5.3", "method": "bug_hunt"},
        })
        self.assertEqual((gate["effective"], gate["reason"]), ("enforce", "calibrated_quorum_available"))

    def test_the_gate_downgrades_on_one_method(self) -> None:
        from aria_kernel.genesis_policy import effective_calibration_gate

        gate = effective_calibration_gate("enforce", {
            "a": {"calibration_status": "calibrated", "model": "glm-5.3", "method": "static_trace"},
            "b": {"calibration_status": "calibrated", "model": "fable", "method": "static_trace"},
        })
        self.assertEqual(gate["effective"], "measure_only")

    def test_the_gate_keeps_the_legacy_model_leg(self) -> None:
        from aria_kernel.genesis_policy import effective_calibration_gate

        gate = effective_calibration_gate("enforce", {
            "a": {"calibration_status": "calibrated", "model": "opus"},
            "b": {"calibration_status": "calibrated", "model": "glm-5.3"},
        })
        self.assertEqual(gate["effective"], "enforce")


class MintFirstMethodStampTests(_LedgerCase):
    """ORPHAN-HIGH-781 doctrine for the method: the seat's method is stamped
    at the MINT (the kernel chose the seat), folded by the bridge from the
    request, and the observers receipt is built from it."""

    def _dispatched_requests(self) -> list[dict]:
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        from aria_kernel.judge_fanout import dispatch_judges_for_sample

        with tempfile.TemporaryDirectory(prefix="aria-wpjb1-mint-") as tmp:
            tools = Path(tmp) / "aria-tools"
            ensure_tools_dir(tools)
            register_contracted_tool(tools, "tool-a")
            dispatch_judges_for_sample(
                sample={
                    "items": [{
                        "tool_id": "tool-a", "run_id": "run-1", "finding_id": "F-1",
                        "finding_fingerprint": "fp-F-1", "rule": "rule-a", "severity": "high",
                        "path": "apps/hr-service/x.ts", "message": "m",
                    }],
                    "cycle_id": "cyc-1",
                },
                base_dir=tools,
                target_sha="a" * 40,
            )
            return list_agent_invocation_requests(base_dir=tools)

    def test_the_mint_stamps_the_seats_method_on_the_envelope(self) -> None:
        requests = self._dispatched_requests()
        self.assertTrue(requests)
        by_role = {row["role"]: row for row in requests}
        self.assertEqual(by_role["evidence_judgment"]["agent_method"], "static_trace")
        self.assertEqual(by_role["adversarial_judgment"]["agent_method"], "devils_advocate")

    def test_the_bridge_folds_the_method_from_the_mint(self) -> None:
        from aria_kernel.judgment_bridge import record_judge_verdict_from_response

        request = {
            "request_id": "req-1",
            "tool_id": "tool-a",
            "run_id": "run-1",
            "finding_id": "F-1",
            "judgment_group_id": "judge:tool-a:F-1",
            "agent_method": "static_trace",
        }
        response = {
            "role": "evidence_judgment",
            "details": {
                "agent_subagent_type": "aria-evidence-judge",
                "agent_dispatch_model": _ONE_PROVIDER_MODEL,
                "verdict": {"verdict": "true_positive", "rationale": "traced the calls"},
            },
        }
        row = record_judge_verdict_from_response(request=request, response=response, base_dir=self.tools)
        self.assertEqual(row["method"], "static_trace")

    def test_the_bridge_takes_the_dispatch_stamp_over_a_self_report(self) -> None:
        from aria_kernel.judgment_bridge import record_judge_verdict_from_response

        request = {
            "request_id": "req-2",
            "tool_id": "tool-a",
            "run_id": "run-1",
            "finding_id": "F-2",
            "judgment_group_id": "judge:tool-a:F-2",
        }
        response = {
            "role": "adversarial_judgment",
            "details": {
                "agent_subagent_type": "aria-adversarial-judge",
                "agent_dispatch_model": _ONE_PROVIDER_MODEL,
                "agent_dispatch_method": "devils_advocate",
                "verdict": {"verdict": "false_positive", "rationale": "counter-evidence", "method": "vibes"},
            },
        }
        row = record_judge_verdict_from_response(request=request, response=response, base_dir=self.tools)
        self.assertEqual(row["method"], "devils_advocate")


if __name__ == "__main__":
    unittest.main()
