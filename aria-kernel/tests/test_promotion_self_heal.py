"""ORPHAN-HIGH-765 — the self-heal property of the promotion circuit.

Live state carried 2-judge consensus rows settled from verdicts whose mint
carried no fingerprint (the pre-threading shape): an empty-fingerprint
consensus row can never promote, and the idempotency guard would seem to
freeze it. The healing path: the anchor arm (JJ-1) mints a third verdict —
fingerprint-bearing since the threading fix — attendance (2 < 3) re-opens
the group, and the re-settled consensus row carries the fingerprint, making
the finding promotable after all.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    generate_ai_consensus,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.tool_registry import ensure_tools_dir

_GROUP = "judge:alpha:run-heal:finding-heal"


def _verdict(
    tools: Path,
    *,
    judge_id: str,
    fingerprint: str,
    confidence: float = 0.9,
) -> None:
    record_operator_feedback(
        tool_id="alpha",
        run_id="run-heal",
        finding_id="finding-heal",
        verdict="true_positive",
        severity="high",
        note="heal fixture",
        source_type="ai_judge",
        judge_id=judge_id,
        model="test",
        confidence=confidence,
        judgment_group_id=_GROUP,
        finding_fingerprint=fingerprint,
        base_dir=tools,
    )


class PromotionSelfHealTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-heal-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fingerprint_bearing_third_verdict_re_settles_the_group(self) -> None:
        # The pre-threading shape: two agreeing judges, empty fingerprints.
        _verdict(self.tools, judge_id="aria-evidence-judge", fingerprint="")
        _verdict(self.tools, judge_id="aria-adversarial-judge", fingerprint="")
        first = generate_ai_consensus(tool_id="alpha", base_dir=self.tools)
        self.assertEqual(first["consensus_count"], 1)
        settled = [
            row for row in load_feedback(base_dir=self.tools)
            if row.get("source_type") == "ai_consensus"
        ]
        self.assertEqual(len(settled), 1)
        self.assertEqual(settled[0]["finding_fingerprint"], "")

        # The healing event: a third, fingerprint-bearing verdict (the anchor
        # arm's arbiter, post-threading mint). Attendance 2 < 3 re-opens the
        # group; the re-settled row carries the fingerprint.
        _verdict(self.tools, judge_id="aria-consensus-arbiter", fingerprint="fp-heal-1")
        second = generate_ai_consensus(tool_id="alpha", base_dir=self.tools)
        self.assertEqual(second["consensus_count"], 1)
        healed = [
            row for row in load_feedback(base_dir=self.tools)
            if row.get("source_type") == "ai_consensus"
        ]
        self.assertEqual(len(healed), 2)
        self.assertEqual(healed[-1]["finding_fingerprint"], "fp-heal-1")
        self.assertEqual(healed[-1]["judges_voted"], 3)


if __name__ == "__main__":
    unittest.main()
