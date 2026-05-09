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

Tests:
1. 1 human FP → suppression effective.
2. 1 raw ai_judge FP → NO suppression.
3. ai_consensus FP (synthesized from ≥2 ai_judge) → suppression
   effective.
4. Mixed history — only human + ai_consensus rows suppress; raw
   ai_judge ignored.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    _confirmed_false_positive_fingerprints,
    record_operator_feedback,
)
from aria_kernel.tool_registry import ensure_tools_dir


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

    def test_ai_consensus_suppresses(self) -> None:
        """ai_consensus FP (synthesized from multiple ai_judge rows)
        → suppression effective. The aggregator already enforces
        ≥2 distinct judges + verdict agreement; the consensus row is
        therefore a stronger signal than raw ai_judge."""
        record_operator_feedback(
            tool_id="alpha",
            run_id="run-001",
            finding_id="finding-001",
            verdict="false_positive",
            severity="medium",
            note="AI consensus from 2 independent judges",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            model="consensus",
            confidence=0.85,
            finding_fingerprint="fp-fingerprint-003",
            base_dir=self.tools,
        )
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertIn("fp-fingerprint-003", confirmed)
        self.assertEqual(confirmed["fp-fingerprint-003"]["source_type"], "ai_consensus")

    def test_mixed_history_only_eligible_sources_suppress(self) -> None:
        """Plan 023 v3 §F-1: in a mixed feedback history, only the
        human + ai_consensus rows make it through; raw ai_judge rows
        are filtered out."""
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
        # ai_consensus — eligible.
        record_operator_feedback(
            tool_id="alpha", run_id="r-3", finding_id="f-3",
            verdict="false_positive", severity="medium",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            model="consensus", confidence=0.85,
            note="consensus from 2 judges",
            finding_fingerprint="fp-consensus",
            base_dir=self.tools,
        )
        confirmed = _confirmed_false_positive_fingerprints(self.tools)
        self.assertNotIn("fp-aj", confirmed)
        self.assertIn("fp-human", confirmed)
        self.assertIn("fp-consensus", confirmed)


if __name__ == "__main__":
    unittest.main()
