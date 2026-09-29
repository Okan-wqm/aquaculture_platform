"""Plan 023 v3 §F-1 — AI judge false_positive suppression must require
ai_consensus row, not raw ai_judge.

Pre-Plan-023 _confirmed_false_positive_fingerprints filtered ONLY on
verdict=='false_positive'. source_type was captured but never checked.
A single raw ai_judge verdict suppressed identical findings forever
— no human review, no consensus, no audit trail. The pre-existing
compute_ai_consensus_for_tool aggregator already produces ai_consensus
rows from ≥2 raw ai_judge verdicts with verdict agreement +
avg_confidence threshold, but the suppression filter never required
them.

Plan 023 v3 §F-1 fix: source_type filter on the suppression read.
Only `human` and `ai_consensus` source_types are eligible. Raw
`ai_judge` rows alone never suppress directly — they flow through
compute_ai_consensus_for_tool first; if they coalesce into an
ai_consensus row, the suppression takes effect via that synthesized
row.

JJ-1 (ORPHAN-HIGH-731) NARROWS PLAN 023 AGAIN, AND REWRITES ITS PINS.
Plan 023 stopped ONE judge from suppressing a finding class forever; it
still let TWO do it, and nothing ever examined whether those two agreed
for the same wrong reason. Suppression is the one verdict consequence no
later evidence can undo — the finding class stops being produced, so the
contradiction can never arrive. Eligibility is now `is_ground_truth_row`:
an operator verdict, or an ANCHOR consensus (>= 3 judges, the third minted
specifically to attack the pair).

The assertions below that used to read "an ai_consensus row suppresses"
now read "an ANCHOR suppresses, a 2-judge consensus does not". They were
rewritten to the successor truth rather than deleted: the Plan 023
guarantee (raw ai_judge never suppresses) is still asserted alongside.

Tests:
1. 1 human FP → suppression effective.
2. 1 raw ai_judge FP → NO suppression.
3. ANCHOR ai_consensus FP (>= 3 judges) → suppression effective.
4. 2-judge ai_consensus FP → NO suppression (JJ-1 deliberate breakage).
5. A consensus row that cannot state its judge_count AND its judges_voted
   is unwritable — "three agreed" and "three agreed over one dissent" are
   different facts and only one of them is ground truth.
6. Mixed history — only human + anchor rows suppress.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    _confirmed_false_positive_fingerprints,
    record_operator_feedback,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class ConsensusGateFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-f1-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_human_fp_suppresses(self) -> None:
        """1 human false_positive → suppression effective immediately."""
        record_operator_feedback(
            tool_id="alpha",
            run_id="run-001",
            finding_id="finding-001",
            verdict="false_positive",
            severity="medium",
            note="False alarm — checked manually",
            source_type="human",
            finding_fingerprint="fp-fingerprint-001",
            base_dir=self.tools,
        )
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertIn("fp-fingerprint-001", confirmed)
        self.assertEqual(confirmed["fp-fingerprint-001"]["source_type"], "human")

    def test_raw_ai_judge_does_not_suppress(self) -> None:
        """Plan 023 v3 §F-1: raw ai_judge FP alone does NOT suppress.
        Pre-fix this slipped through — single AI verdict was enough."""
        record_operator_feedback(
            tool_id="alpha",
            run_id="run-001",
            finding_id="finding-001",
            verdict="false_positive",
            severity="medium",
            note="LLM judge reasoning",
            source_type="ai_judge",
            judge_id="aria-evidence-judge",
            model="claude-opus-4-7",
            confidence=0.8,
            finding_fingerprint="fp-fingerprint-002",
            base_dir=self.tools,
        )
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertNotIn("fp-fingerprint-002", confirmed)

    def _consensus_fp(
        self, fingerprint: str, judges: int, *, voted: int | None = None,
    ) -> None:
        record_operator_feedback(
            tool_id="alpha",
            run_id=f"run-{fingerprint}",
            finding_id=f"finding-{fingerprint}",
            verdict="false_positive",
            severity="medium",
            note=f"AI consensus from {judges} independent judges",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            model="consensus",
            confidence=0.85,
            finding_fingerprint=fingerprint,
            judge_count=judges,
            judges_voted=judges if voted is None else voted,
            base_dir=self.tools,
        )

    def test_anchor_consensus_suppresses(self) -> None:
        """JJ-1 successor of test_ai_consensus_suppresses: only an ANCHOR
        (evidence + adversarial + arbiter) may suppress."""
        self._consensus_fp("fp-fingerprint-003", ANCHOR_MIN_JUDGE_COUNT)
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertIn("fp-fingerprint-003", confirmed)
        self.assertEqual(confirmed["fp-fingerprint-003"]["source_type"], "ai_consensus")
        self.assertEqual(
            confirmed["fp-fingerprint-003"]["judge_count"], ANCHOR_MIN_JUDGE_COUNT,
        )

    def test_two_judge_consensus_does_not_suppress(self) -> None:
        """THE deliberate breakage. Pre-JJ-1 this row suppressed its
        finding class forever on two unexamined opinions."""
        self._consensus_fp("fp-pair", 2)
        self.assertNotIn("fp-pair", _confirmed_false_positive_fingerprints(self.tools))

    def test_an_outvoted_dissent_does_not_suppress_either(self) -> None:
        """The successor of the pin above, one level up: three judges VOTED
        and only two AGREED. Attendance is not agreement, and suppression is
        the one consequence no later evidence can undo."""
        self._consensus_fp("fp-outvoted", ANCHOR_MIN_JUDGE_COUNT - 1,
                           voted=ANCHOR_MIN_JUDGE_COUNT)
        self.assertNotIn(
            "fp-outvoted", _confirmed_false_positive_fingerprints(self.tools),
        )

    def test_countless_consensus_row_is_unwritable(self) -> None:
        """Tier 1 rather than Tier 3: a consensus that cannot say how many
        judges backed it never reaches the ledger, so no reader can be
        tempted to guess on its behalf."""
        with self.assertRaisesRegex(
            GovernanceError, "requires judge_count and judges_voted",
        ):
            record_operator_feedback(
                tool_id="alpha", run_id="r-x", finding_id="f-x",
                verdict="false_positive", severity="medium", note="no count",
                source_type="ai_consensus", judge_id="aria-consensus-arbiter",
                finding_fingerprint="fp-countless", base_dir=self.tools,
            )

    def test_mixed_history_only_eligible_sources_suppress(self) -> None:
        """Plan 023 §F-1 + JJ-1: in a mixed history only the operator row
        and the ANCHOR make it through; a raw ai_judge row and a 2-judge
        consensus are both filtered out."""
        # Raw ai_judge — must be filtered out.
        record_operator_feedback(
            tool_id="alpha", run_id="r-1", finding_id="f-1",
            verdict="false_positive", severity="medium",
            source_type="ai_judge", judge_id="judge-A", model="m1",
            confidence=0.9, note="ai_judge FP",
            finding_fingerprint="fp-aj",
            base_dir=self.tools,
        )
        # Human — eligible.
        record_operator_feedback(
            tool_id="alpha", run_id="r-2", finding_id="f-2",
            verdict="false_positive", severity="medium",
            source_type="human", note="confirmed FP",
            finding_fingerprint="fp-human",
            base_dir=self.tools,
        )
        # anchor consensus — eligible.
        record_operator_feedback(
            tool_id="alpha", run_id="r-3", finding_id="f-3",
            verdict="false_positive", severity="medium",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            model="consensus", confidence=0.85,
            note="consensus from 3 judges",
            finding_fingerprint="fp-consensus",
            judge_count=ANCHOR_MIN_JUDGE_COUNT,
            judges_voted=ANCHOR_MIN_JUDGE_COUNT,
            base_dir=self.tools,
        )
        # 2-judge consensus — NOT eligible (JJ-1).
        record_operator_feedback(
            tool_id="alpha", run_id="r-4", finding_id="f-4",
            verdict="false_positive", severity="medium",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            model="consensus", confidence=0.85,
            note="consensus from 2 judges",
            finding_fingerprint="fp-pair-mixed",
            judge_count=2,
            judges_voted=2,
            base_dir=self.tools,
        )
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertNotIn("fp-aj", confirmed)
        self.assertNotIn("fp-pair-mixed", confirmed)
        self.assertIn("fp-human", confirmed)
        self.assertIn("fp-consensus", confirmed)


if __name__ == "__main__":
    unittest.main()
