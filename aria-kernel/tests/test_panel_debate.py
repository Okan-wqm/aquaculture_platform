"""WP-J B-2 (debate) — the arbiter weighs evidence, 'unverifiable' is a
lawful outcome, a dissenter gets ONE bounded rebuttal with the winner's
verified refs, and an N-ary Jaccard guard watches the panel's diversity.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import CONSENSUS_UNCERTAINTY_REASONS, generate_ai_consensus
from aria_kernel.independence_check import (
    DEFAULT_JACCARD_CEILING,
    compute_jaccard_similarity,
    verify_panel_diversity,
)
from aria_kernel.judge_fanout import (
    EVIDENCE_WEIGHING_MODE_MARKER,
    dispatch_judges_for_sample,
    dispatch_rebuttal_for_dissent,
    render_evidence_weighing_prompt,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

from tests._helpers.rule_contracts import register_contracted_tool


class _PanelCase(unittest.TestCase):
    """The debate cases run on the default read-only pair (no write-scope
    seat), so the host's providers are not their fact; the panel mint and
    its host live in test_panel_seats, the degraded host in
    test_panel_single_provider_night."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpjb2-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, "tool-x")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _sample(self) -> dict:
        return {
            "cycle_id": "c1",
            "items": [{
                "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": "F1",
                "rule": "rule-a", "severity": "high", "path": "src/f1.py:1",
                "message": "suspicious", "evidence": ["src/f1.py:1"],
                "finding_fingerprint": "fp1",
            }],
        }


class EvidenceWeighingArbiterTests(_PanelCase):
    """The arbiter weighs EVIDENCE, not votes — and 'unverifiable' is a
    lawful outcome it may return."""

    SPLIT = {
        "tool_id": "tool-x", "run_id": "r1", "finding_id": "F1",
        "judgment_group_id": "g1",
        "judges": [
            {
                "judge_id": "aria-evidence-judge", "verdict": "true_positive",
                "confidence": 0.9, "rationale": "the trace", "evidence_refs": ["src/a.py:1"],
                "evidence_selection": "index",
            },
            {
                "judge_id": "aria-test-writer-seat", "verdict": "false_positive",
                "confidence": 0.8, "rationale": "cannot reproduce", "evidence_refs": [],
                "reproduction": {"recipe_id": "rec-1", "expected": "red"},
            },
        ],
    }

    def test_unverifiable_is_a_member_of_the_closed_vocabulary(self) -> None:
        self.assertIn("unverifiable", CONSENSUS_UNCERTAINTY_REASONS)

    def test_the_brief_is_marked_ranks_evidence_and_strips_identity(self) -> None:
        prompt = render_evidence_weighing_prompt(self.SPLIT)
        self.assertTrue(prompt.splitlines()[0].startswith(EVIDENCE_WEIGHING_MODE_MARKER))
        # Identity-stripped: the arbiter may not know who said what.
        for judge in self.SPLIT["judges"]:
            self.assertNotIn(judge["judge_id"], prompt)
        # Class-ranked: the reproduction evidence outranks the quoted trace,
        # which outranks bare argument.
        self.assertLess(prompt.index("rec-1"), prompt.index("src/a.py:1"))
        self.assertIn("reproduction", prompt.lower())
        # And the weighing vocabulary, not a vote count, is the stated law.
        self.assertIn("unverifiable", prompt)

    def test_the_judge_contract_prose_names_the_unverifiable_reason(self) -> None:
        from aria_kernel.judgment_bridge import render_judge_verdict_rules

        self.assertTrue(any("unverifiable" in line for line in render_judge_verdict_rules()))

    def test_a_method_panel_split_is_weighed_not_aggregated(self) -> None:
        """The live split lane picks its brief by the receipts: a panel
        whose seats carry method receipts gets the identity-stripped,
        class-ranked weighing brief; a legacy split (no methods anywhere)
        keeps the aggregation brief byte for byte."""
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        from aria_kernel.judge_fanout import dispatch_arbiter_for_split_verdicts
        from aria_kernel.judgment_bridge import record_judge_verdict_from_response

        fanout = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools)
        requests = {row["request_id"]: row
                    for row in list_agent_invocation_requests(base_dir=self.tools)}
        # A split: the two seats disagree. Both envelopes carry method stamps
        # (minted post-EXPERT_METHODS), so this is a method panel split.
        verdicts = iter(("true_positive", "false_positive"))
        for minted in fanout["minted"]:
            record_judge_verdict_from_response(
                request=requests[minted["request_id"]],
                response={
                    "role": minted["role"], "request_id": minted["request_id"],
                    "satisfaction_matrix": [
                        {"id": item["id"], "verdict": "satisfied", "evidence_refs": ["src/a.py:1"]}
                        for item in requests[minted["request_id"]].get("must_satisfy") or []
                        if isinstance(item, dict)
                    ],
                    "details": {
                        "agent_subagent_type": minted["target_agent"],
                        "agent_dispatch_model": "opus",
                        "verdict": {"verdict": next(verdicts), "confidence": 0.9,
                                    "rationale": "n", "evidence_refs": ["src/a.py:1"]},
                    },
                },
                base_dir=self.tools,
            )
        result = dispatch_arbiter_for_split_verdicts(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(result["minted_count"], 1, result["skipped"])
        [brief] = [row for row in list_agent_invocation_requests(base_dir=self.tools)
                   if row["role"] == "consensus_arbitration"]
        self.assertTrue(
            brief["suggested_prompt"].splitlines()[0].startswith(EVIDENCE_WEIGHING_MODE_MARKER),
            brief["suggested_prompt"][:80],
        )
        self.assertNotIn("aria-evidence-judge", brief["suggested_prompt"])
        self.assertNotIn("aria-adversarial-judge", brief["suggested_prompt"])


class BoundedRebuttalTests(_PanelCase):
    """A dissenter gets ONE re-ask carrying the winner's verified refs.

    The flow is the production one: envelopes minted by the real fan-out and
    anchor arm, answers folded by the real bridge (so the dissenter's row
    carries the request_ids the rebuttal mint reads its seat identity from),
    a weighted settle that records the dissent, then the rebuttal lane.
    """

    WEIGHTS = {
        "aria-evidence-judge": 0.9,
        "aria-adversarial-judge": 0.9,
        "aria-consensus-arbiter": 0.9,
    }

    def _answer(self, request: dict, *, verdict: str, refs: list[str], model: str) -> None:
        from aria_kernel.judgment_bridge import record_judge_verdict_from_response

        record_judge_verdict_from_response(
            request=request,
            response={
                "role": request["role"],
                "request_id": request["request_id"],
                "satisfaction_matrix": [
                    {"id": item["id"], "verdict": "satisfied", "evidence_refs": refs[:1]}
                    for item in request.get("must_satisfy") or [] if isinstance(item, dict)
                ],
                "details": {
                    "agent_subagent_type": request["target_agent"],
                    "agent_dispatch_model": model,
                    "verdict": {
                        "verdict": verdict, "confidence": 0.95, "severity": "high",
                        "rationale": "the cited line performs the operation",
                        "evidence_refs": refs,
                    },
                },
            },
            base_dir=self.tools,
        )

    def _settle_with_dissent(self) -> None:
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        from aria_kernel.judge_fanout import dispatch_arbiter_for_anchor_groups

        fanout = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools)
        by_agent = {m["target_agent"]: m["request_id"] for m in fanout["minted"]}
        requests = {
            row["request_id"]: row
            for row in list_agent_invocation_requests(base_dir=self.tools)
        }
        self._answer(requests[by_agent["aria-evidence-judge"]], verdict="false_positive",
                     refs=["src/a.py:1"], model="opus")
        self._answer(requests[by_agent["aria-adversarial-judge"]], verdict="false_positive",
                     refs=["src/a.py:2"], model="glm-5.3")
        generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        # A unanimous false_positive pair demands the anchor arbiter; he
        # dissents, so the weighted settle records a 2-1 majority.
        dispatch_arbiter_for_anchor_groups(tool_id="tool-x", base_dir=self.tools)
        [arbiter] = [row for row in list_agent_invocation_requests(base_dir=self.tools)
                     if row["role"] == "consensus_arbitration"]
        self._answer(arbiter, verdict="true_positive", refs=["src/b.py:9"], model="fable")
        settled = generate_ai_consensus(
            tool_id="tool-x", base_dir=self.tools, judge_weights=self.WEIGHTS,
        )
        row = settled["consensus"][0]
        self.assertEqual((row["judge_count"], row["judges_voted"]), (2, 3))

    def test_the_dissenter_is_re_asked_once_with_the_winners_refs(self) -> None:
        self._settle_with_dissent()
        first = dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c1")
        self.assertEqual(first["minted_count"], 1, first["skipped"])
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        [row] = [r for r in list_agent_invocation_requests(base_dir=self.tools)
                 if "REBUTTAL" in r["suggested_prompt"]]
        self.assertEqual(row["target_agent"], "aria-consensus-arbiter")
        self.assertEqual(row["role"], "consensus_arbitration")
        self.assertIn("src/a.py:1", row["suggested_prompt"])
        self.assertIn("src/a.py:2", row["suggested_prompt"])
        self.assertNotIn(
            "- src/b.py:9", row["suggested_prompt"],
            "the dissenter's own ref is not handed back as winner evidence",
        )
        # Bounded: the second call mints nothing.
        second = dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c2")
        self.assertEqual(second["minted_count"], 0)

    def _rebuttals(self) -> list[tuple[str, str]]:
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        return [(r["judgment_group_id"], r["target_agent"])
                for r in list_agent_invocation_requests(base_dir=self.tools)
                if "REBUTTAL" in r["suggested_prompt"]]

    def test_a_defect_in_the_bound_read_propagates(self) -> None:
        # WPJ-FAILOPEN R1 (ARIA-HIGH-788 class): the "ONCE" bound is read
        # back from the request ledger. A defect in that read (a TypeError)
        # is a kernel bug, not "nothing was minted": it must surface, never
        # re-mint the dissenter.
        from unittest import mock

        self._settle_with_dissent()
        first = dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c1")
        self.assertEqual(first["minted_count"], 1, first["skipped"])
        with mock.patch("aria_kernel.judge_fanout.load_segments",
                        side_effect=TypeError("reader defect")):
            with self.assertRaises(TypeError):
                dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c2")
        self.assertEqual(len(self._rebuttals()), 1)

    def test_an_unreadable_request_ledger_refuses_the_round(self) -> None:
        # A store fault (ledger_read_faults) on the bound read refuses the
        # round with a named GovernanceError — the cycle records it as a
        # blocked 'rebuttal' step — and mints nothing: the dissenter keeps
        # exactly the one REBUTTAL envelope it already has.
        from unittest import mock

        from aria_kernel.ledger import LedgerReadLimitError

        self._settle_with_dissent()
        first = dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c1")
        self.assertEqual(first["minted_count"], 1, first["skipped"])
        [pair] = self._rebuttals()
        with mock.patch("aria_kernel.judge_fanout.load_segments",
                        side_effect=LedgerReadLimitError("past the evidence budget")):
            with self.assertRaises(GovernanceError) as raised:
                dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c2")
        self.assertTrue(
            str(raised.exception).startswith("judge_rebuttal_ledger_unreadable:LedgerReadLimitError"),
            str(raised.exception),
        )
        self.assertEqual(self._rebuttals(), [pair],
                         "exactly one REBUTTAL envelope for the (group, agent)")

    def test_a_unanimous_group_gets_no_rebuttal(self) -> None:
        from aria_kernel.agent_invocations import list_agent_invocation_requests
        from aria_kernel.judgment_bridge import record_judge_verdict_from_response

        fanout = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools)
        requests = {row["request_id"]: row
                    for row in list_agent_invocation_requests(base_dir=self.tools)}
        for minted in fanout["minted"]:
            record_judge_verdict_from_response(
                request=requests[minted["request_id"]],
                response={
                    "role": minted["role"], "request_id": minted["request_id"],
                    "satisfaction_matrix": [],
                    "details": {
                        "agent_subagent_type": minted["target_agent"],
                        "agent_dispatch_model": "opus",
                        "verdict": {"verdict": "false_positive", "confidence": 0.9,
                                    "rationale": "n", "evidence_refs": ["src/a.py:1"]},
                    },
                },
                base_dir=self.tools,
            )
        generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        result = dispatch_rebuttal_for_dissent(tool_id="tool-x", base_dir=self.tools, cycle_id="c1")
        self.assertEqual(result["minted_count"], 0)


class PanelDiversitySettleTests(_PanelCase):
    """WP-J review — the shipped guard RUNS at the settle path.

    verify_panel_diversity existed with zero production callers: no panel
    was ever diversity-checked at runtime, so a panel whose seats echo each
    other settled with no objection and could anchor. The settle path — the
    same place the anchor legs read the seats' answers — now asks the one
    law; an echo panel escalates under its own name and never anchors.
    """

    ECHO = "the tenant predicate is skipped for batch requests in the handler"
    DISTINCT = (
        "the tenant predicate is skipped for batch requests in the handler",
        "an unrelated rationale about the same handler and its guard clause",
        "a third reading focusing on the missing scope check entirely",
    )

    def _seat(
        self, judge_id: str, method: str, rationale: str, *, note: str = "seat verdict",
    ) -> None:
        from aria_kernel.feedback_store import record_operator_feedback

        record_operator_feedback(
            tool_id="tool-x", run_id="run-1", finding_id="F-1",
            verdict="true_positive", severity="high", note=note,
            source_type="ai_judge", judge_id=judge_id,
            model="glm-5.3", method=method, confidence=0.95,
            evidence_refs=["src/f1.py:1"], rationale=rationale,
            judgment_group_id="judge:tool-x:F-1", finding_fingerprint="fp1",
            base_dir=self.tools,
        )

    def _seats(self, rationales: tuple[str, ...]) -> None:
        methods = ("static_trace", "devils_advocate", "evidence_weighing")
        for index, (judge_id, method) in enumerate((
            ("aria-evidence-judge", methods[0]),
            ("aria-adversarial-judgment-seat", methods[1]),
            ("aria-consensus-arbiter", methods[2]),
        )):
            self._seat(judge_id, method, rationales[index])

    def test_an_echo_panel_never_settles_as_truth(self) -> None:
        self._seats((self.ECHO, self.ECHO, self.ECHO))
        result = generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 0, result.get("consensus"))
        self.assertIn(
            "panel_echo",
            [str(u.get("reason")) for u in result.get("uncertainties") or []],
            result.get("uncertainties"),
        )

    def test_a_panel_of_distinct_readings_still_anchors(self) -> None:
        from aria_kernel.feedback_store import is_ground_truth_row

        self._seats(self.DISTINCT)
        result = generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1, result.get("uncertainties"))
        self.assertTrue(is_ground_truth_row(result["consensus"][0]))


class PanelDiversityGuardTests(unittest.TestCase):
    """One Jaccard law, two callers: the plan triple and an N-ary panel."""

    TEXTS = [
        "the handler skips the tenant predicate when the batch flag is set on the request",
        "the handler skips the tenant predicate when the batch flag is set on the request",
        "an entirely different reading of the same finding with other words",
    ]

    def test_two_seats_answering_identically_are_flagged(self) -> None:
        ok, reasons = verify_panel_diversity(
            [self.TEXTS[0], self.TEXTS[1], self.TEXTS[2]],
        )
        self.assertFalse(ok)
        self.assertTrue(any("jaccard" in r and "above_ceiling" in r for r in reasons), reasons)

    def test_distinct_answers_pass(self) -> None:
        ok, reasons = verify_panel_diversity([
            "the tenant predicate is skipped for batch requests",
            "an unrelated rationale about the same handler",
            "a third reading focusing on the guard clause",
        ])
        self.assertTrue(ok, reasons)

    def test_a_seat_whose_text_is_missing_fails_closed(self) -> None:
        ok, reasons = verify_panel_diversity(["reading one", None, "reading two"])
        self.assertFalse(ok)
        self.assertTrue(any("text_unavailable" in r for r in reasons), reasons)

    def test_the_guard_reuses_the_plan_law_and_ceiling(self) -> None:
        # The same similarity the plan-side verifier computes, the same
        # ceiling: a second similarity law would drift from the first.
        score = compute_jaccard_similarity(self.TEXTS[0], self.TEXTS[1])
        _ok, reasons = verify_panel_diversity(self.TEXTS)
        self.assertTrue(
            any(f"{score:.3f}" in r for r in reasons),
            (score, reasons),
        )
        self.assertEqual(DEFAULT_JACCARD_CEILING, 0.85)


if __name__ == "__main__":
    unittest.main()
