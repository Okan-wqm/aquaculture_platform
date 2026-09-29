"""JJ-1 (ORPHAN-HIGH-731) — judges are judged by other judges.

Operator directive 2026-08-18: "a human must be nowhere required — judges
must be judged by other judges." A 2-judge consensus was two opinions that
happened to agree, and five readers treated it as repository ground truth
(suppression, rule_health, goldset, calibration, readiness). This pins the
ANCHOR class: ground truth requires the arbiter to have been minted AGAINST
a unanimous pair and to have failed to overturn it.

Deliberate-breakage pins:
- a consensus row carries judge_count AND judges_voted or it is unwritable;
- ground truth = operator verdict OR (>= 3 judges AGREED and none dissented),
  nowhere else — the judge minted to REFUTE a pair must never be counted as
  the third credential that promotes the pair's verdict to repository truth;
- the anchor arbiter is minted for AGREEING judges (this is the mint that
  did not exist — the split arm only ever fired on disagreement);
- the arbiter's anchor brief asks it to refute, not to ratify;
- a group settled at 2 judges is re-settleable at 3, otherwise the third
  verdict is paid for and discarded and the anchor class is unreachable;
- an FP verdict demands the arbiter unconditionally; once a tool holds
  enough anchors, agreeing TP pairs stop costing an arbiter call.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    _confirmed_false_positive_fingerprints,
    anchor_group_keys,
    consensus_judge_count,
    consensus_judges_voted,
    generate_ai_consensus,
    is_ground_truth_row,
    load_feedback,
    operator_group_keys,
    record_operator_feedback,
)
from aria_kernel.judge_fanout import (
    ANCHOR_MODE_MARKER,
    CONSENSUS_ARBITER_AGENT,
    _render_anchor_prompt,
    anchor_candidate_groups,
    dispatch_arbiter_for_anchor_groups,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class GroundTruthPredicateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj1-pred-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_operator_row_is_ground_truth_without_any_judge_count(self) -> None:
        """JJ-2's other half: the operator is ACCEPTED, never required."""
        self.assertTrue(is_ground_truth_row({"source_type": "human"}))
        self.assertTrue(is_ground_truth_row({}))  # legacy bootstrap label

    def test_two_judge_consensus_is_not_ground_truth(self) -> None:
        self.assertFalse(
            is_ground_truth_row({"source_type": "ai_consensus", "judge_count": 2}),
        )

    def test_anchor_consensus_is_ground_truth(self) -> None:
        self.assertTrue(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT,
                "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
            }),
        )

    def test_anchor_grade_counts_agreement_not_attendance(self) -> None:
        """Deliberate breakage. Three judges VOTED and three AGREED is an
        anchor; three voted and two agreed is a majority that outvoted a
        dissenter, and a contested question is not repository truth."""
        self.assertFalse(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT - 1,
                "judges_voted": ANCHOR_MIN_JUDGE_COUNT,
            }),
        )
        self.assertFalse(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT,
                "judges_voted": ANCHOR_MIN_JUDGE_COUNT + 1,
            }),
        )

    def test_a_row_that_cannot_say_who_dissented_fails_closed(self) -> None:
        """judges_voted absent means the row cannot prove nobody objected."""
        self.assertEqual(consensus_judges_voted({}), 0)
        self.assertEqual(consensus_judges_voted({"judges_voted": True}), 0)
        self.assertFalse(
            is_ground_truth_row({
                "source_type": "ai_consensus",
                "judge_count": ANCHOR_MIN_JUDGE_COUNT,
            }),
        )

    def test_a_consensus_row_without_both_counts_is_unwritable(self) -> None:
        with self.assertRaisesRegex(
            GovernanceError, "requires judge_count and judges_voted",
        ):
            record_operator_feedback(
                tool_id="t", run_id="r", finding_id="F", verdict="true_positive",
                severity="high", note="n", source_type="ai_consensus",
                judge_id="aria-consensus-arbiter", judge_count=3,
                base_dir=self.tools,
            )

    def test_agreement_may_never_exceed_attendance(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "judges_voted must be >="):
            record_operator_feedback(
                tool_id="t", run_id="r", finding_id="F", verdict="true_positive",
                severity="high", note="n", source_type="ai_consensus",
                judge_id="aria-consensus-arbiter", judge_count=3, judges_voted=2,
                base_dir=self.tools,
            )

    def test_missing_or_forged_count_fails_closed(self) -> None:
        """A pre-JJ-1 row (no field) and a bool masquerading as an int both
        count as zero. Ground-truth authority is never inferred."""
        self.assertEqual(consensus_judge_count({}), 0)
        self.assertEqual(consensus_judge_count({"judge_count": True}), 0)
        self.assertFalse(is_ground_truth_row({"source_type": "ai_consensus"}))

    def test_raw_judge_row_is_never_ground_truth(self) -> None:
        self.assertFalse(
            is_ground_truth_row({
                "source_type": "ai_judge", "judge_id": "j", "judge_count": 9,
            }),
        )


class _LedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-jj1-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge(
        self,
        judge_id: str,
        *,
        verdict: str = "true_positive",
        finding: str = "F-1",
        confidence: float = 0.95,
        tool_id: str = "tool-a",
    ) -> None:
        record_operator_feedback(
            tool_id=tool_id,
            run_id=f"run-{finding}",
            finding_id=finding,
            verdict=verdict,
            severity="high",
            note="judge",
            source_type="ai_judge",
            judge_id=judge_id,
            confidence=confidence,
            judgment_group_id=f"judge:{tool_id}:{finding}",
            finding_fingerprint=f"fp-{finding}",
            base_dir=self.tools,
        )


class ConsensusAnchorUpgradeTests(_LedgerCase):
    def test_two_judges_settle_but_do_not_anchor(self) -> None:
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        result = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)
        row = result["consensus"][0]
        self.assertEqual(row["judge_count"], 2)
        self.assertFalse(is_ground_truth_row(row))
        self.assertEqual(anchor_group_keys(tool_id="tool-a", base_dir=self.tools), set())

    def test_third_judge_upgrades_the_same_group_to_an_anchor(self) -> None:
        """The pin that makes the anchor class REACHABLE. If the settled-group
        guard stayed keyed on existence alone, the arbiter's verdict would be
        minted, dispatched, paid for — and then silently dropped."""
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self._judge("aria-consensus-arbiter")
        upgraded = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(upgraded["consensus_count"], 1)
        self.assertEqual(upgraded["consensus"][0]["judge_count"], 3)
        self.assertTrue(is_ground_truth_row(upgraded["consensus"][0]))
        self.assertEqual(
            len(anchor_group_keys(tool_id="tool-a", base_dir=self.tools)), 1,
        )

    def test_re_running_with_no_new_judge_appends_nothing(self) -> None:
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        before = len(load_feedback(tool_id="tool-a", base_dir=self.tools))
        again = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(again["consensus_count"], 0)
        self.assertEqual(
            len(load_feedback(tool_id="tool-a", base_dir=self.tools)), before,
        )

    def test_anchor_counts_the_judgment_once_not_the_rows(self) -> None:
        """Two consensus rows for one question (2-judge then 3-judge) is ONE
        anchored judgment; counting rows would double-count the upgrade."""
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self._judge("aria-consensus-arbiter")
        generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(
            len(anchor_group_keys(tool_id="tool-a", base_dir=self.tools)), 1,
        )
        self.assertEqual(
            operator_group_keys(tool_id="tool-a", base_dir=self.tools), set(),
        )

    def test_arbiter_disagreement_blocks_the_anchor(self) -> None:
        """The whole point: the third judge can REFUSE. A 2-1 split leaves the
        finding settled at 2 judges and NOT ground truth."""
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self._judge("aria-consensus-arbiter", verdict="false_positive")
        after = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(after["consensus_count"], 0)
        self.assertEqual(
            [u["reason"] for u in after["uncertainties"]], ["judge_disagreement"],
        )
        self.assertEqual(anchor_group_keys(tool_id="tool-a", base_dir=self.tools), set())


class AnchorMintTests(_LedgerCase):
    def test_agreeing_pair_is_an_anchor_candidate(self) -> None:
        """The mint that did not exist before JJ-1 — the split arm only ever
        fired on disagreement, so agreement was never examined."""
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        candidates = anchor_candidate_groups(
            tool_id="tool-a", base_dir=self.tools, demand=1,
        )
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["verdict"], "true_positive")

    def test_split_pair_is_not_an_anchor_candidate(self) -> None:
        """One authority per question: a split belongs to the split arm."""
        self._judge("aria-evidence-judge", verdict="true_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        self.assertEqual(
            anchor_candidate_groups(tool_id="tool-a", base_dir=self.tools, demand=5),
            [],
        )

    def test_false_positive_pair_is_demanded_with_zero_budget(self) -> None:
        """Suppression is irreversible, so the FP pair is examined even when
        the tool already has all the anchors readiness needs."""
        self._judge("aria-evidence-judge", verdict="false_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        candidates = anchor_candidate_groups(
            tool_id="tool-a", base_dir=self.tools, demand=0,
        )
        self.assertEqual(len(candidates), 1)

    def test_true_positive_pair_costs_nothing_once_demand_is_met(self) -> None:
        """The cost bound: routine consensus stays 2-judge."""
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        self.assertEqual(
            anchor_candidate_groups(tool_id="tool-a", base_dir=self.tools, demand=0),
            [],
        )

    def test_dispatch_mints_one_arbiter_and_is_idempotent(self) -> None:
        self._judge("aria-evidence-judge")
        self._judge("aria-adversarial-judge")
        first = dispatch_arbiter_for_anchor_groups(
            tool_id="tool-a", base_dir=self.tools, cycle_id="cyc-1",
        )
        self.assertEqual(first["minted_count"], 1)
        self.assertEqual(first["minted"][0]["target_agent"], CONSENSUS_ARBITER_AGENT)
        self.assertEqual(first["anchor_demand"], ANCHOR_PROMOTION_MIN_JUDGMENTS)
        second = dispatch_arbiter_for_anchor_groups(
            tool_id="tool-a", base_dir=self.tools, cycle_id="cyc-2",
        )
        self.assertEqual(second["minted_count"], 0)
        self.assertEqual(second["skipped"][0]["reason"], "already_dispatched")

    def test_anchor_brief_demands_refutation_not_ratification(self) -> None:
        """A third judge asked to 'aggregate two agreeing verdicts' is a
        rubber stamp, and a rubber stamp promoted to ground truth launders
        the pair's blind spot. The brief text is the mechanism here."""
        prompt = _render_anchor_prompt({
            "tool_id": "tool-a", "run_id": "r", "finding_id": "F-1",
            "judgment_group_id": "g",
            "judges": [{"judge_id": "aria-evidence-judge", "verdict": "true_positive"}],
        })
        self.assertEqual(prompt.splitlines()[0], ANCHOR_MODE_MARKER)
        self.assertIn("AGREE", prompt)
        self.assertIn("Judge the finding YOURSELF", prompt)
        self.assertIn("Disagreeing is a correct answer", prompt)
        self.assertNotIn("Do not re-judge the finding from scratch", prompt)

    def test_the_agent_contract_permits_what_the_anchor_brief_demands(self) -> None:
        """The prompt is half the mechanism; the agent's own SSoT is the
        other half. The arbiter contract says "you are an aggregator, not a
        fresh judge" and "never re-judge the underlying finding" — under
        which the anchor is contractually a rubber stamp no matter how the
        prompt is worded. This pin fails if the mode marker, or the clause
        that lifts those limits under it, leaves the agent file."""
        contract = (
            Path(__file__).resolve().parents[2]
            / ".claude" / "agents" / "aria-consensus-arbiter.md"
        ).read_text(encoding="utf-8")
        self.assertIn(ANCHOR_MODE_MARKER, contract)
        self.assertIn("Anchor Arbitration Mode", contract)
        self.assertIn("lifted ONLY under", contract)
        self.assertIn("judge the finding yourself", contract.lower())


class WeightedLaneAnchorTests(_LedgerCase):
    """The reviewer's CRITICAL #1, as an executed pin.

    Under the weighted lane (live as soon as the judge-calibration ledger
    has any row) a 2-1 majority used to settle with judge_count=3, because
    the writer counted judges who VOTED. The arbiter minted SPECIFICALLY to
    refute the pair therefore became the third credential that turned the
    pair's verdict into ground truth and suppressed the finding class
    forever — the thesis inverted.
    """

    WEIGHTS = {
        "aria-evidence-judge": 0.9,
        "aria-adversarial-judge": 0.9,
        "aria-consensus-arbiter": 0.9,
    }

    def _settle(self) -> dict:
        return generate_ai_consensus(
            tool_id="tool-a", base_dir=self.tools, judge_weights=self.WEIGHTS,
        )

    def test_the_refuting_arbiter_never_becomes_the_third_credential(self) -> None:
        self._judge("aria-evidence-judge", verdict="false_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        self._settle()
        self._judge("aria-consensus-arbiter", verdict="true_positive")
        result = self._settle()
        row = result["consensus"][0]
        self.assertEqual(row["judge_count"], 2, "only the agreeing judges back it")
        self.assertEqual(row["judges_voted"], 3, "the dissent is recorded, not erased")
        self.assertFalse(is_ground_truth_row(row))
        self.assertEqual(anchor_group_keys(tool_id="tool-a", base_dir=self.tools), set())
        self.assertEqual(
            list(_confirmed_false_positive_fingerprints(self.tools)), [],
            "a refuted pair must never suppress the finding class",
        )

    def test_a_weighted_majority_still_settles_the_precision_lane(self) -> None:
        """Not a regression of Z2a: the row exists and carries the winning
        verdict — it simply is not ground truth."""
        self._judge("aria-evidence-judge", verdict="false_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        self._settle()
        self._judge("aria-consensus-arbiter", verdict="true_positive")
        row = self._settle()["consensus"][0]
        self.assertEqual(row["verdict"], "false_positive")
        self.assertIn("dissenting", row["note"])

    def test_a_dissent_does_not_re_settle_the_group_every_cycle(self) -> None:
        """The dedup key is ATTENDANCE, so the 2-1 group settles once. Keyed
        on agreement it would re-settle forever and grow the ledger without
        bound."""
        self._judge("aria-evidence-judge", verdict="false_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        self._settle()
        self._judge("aria-consensus-arbiter", verdict="true_positive")
        self._settle()
        before = len(load_feedback(tool_id="tool-a", base_dir=self.tools))
        for _ in range(3):
            self.assertEqual(self._settle()["consensus_count"], 0)
        self.assertEqual(
            len(load_feedback(tool_id="tool-a", base_dir=self.tools)), before,
        )

    def test_a_unanimous_third_judge_still_anchors_under_weights(self) -> None:
        self._judge("aria-evidence-judge", verdict="false_positive")
        self._judge("aria-adversarial-judge", verdict="false_positive")
        self._settle()
        self._judge("aria-consensus-arbiter", verdict="false_positive")
        row = self._settle()["consensus"][0]
        self.assertEqual((row["judge_count"], row["judges_voted"]), (3, 3))
        self.assertTrue(is_ground_truth_row(row))
        self.assertEqual(
            list(_confirmed_false_positive_fingerprints(self.tools)), ["fp-F-1"],
        )


if __name__ == "__main__":
    unittest.main()
