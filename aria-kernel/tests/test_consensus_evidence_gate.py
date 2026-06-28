"""Plan 024 §C — evidence-gated arbiter.

The mechanical consensus gate averaged judge verdicts without ever checking
that the evidence they cited exists. This gate makes "Opus does not trust
Sonnet" real: a unanimous, high-confidence group still fails to reach consensus
if any judge cites evidence that does not resolve in the repo — it escalates to
a human instead of being rubber-stamped. Opt-in via workspace_root so legacy
callers keep the pure mechanical gate.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
from aria_kernel.tool_registry import ensure_tools_dir


class ConsensusEvidenceGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.tools = base / "aria-tools"
        self.repo = base / "repo"
        self.repo.mkdir()
        (self.repo / "real.py").write_text("x = 1\n", encoding="utf-8")
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge(self, judge_id: str, refs: list[str]) -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id="r1", finding_id="F1", verdict="true_positive",
            severity="medium", note="vote", source_type="ai_judge", judge_id=judge_id,
            confidence=0.9, evidence_refs=refs, judgment_group_id="g1", base_dir=self.tools,
        )

    def test_real_evidence_reaches_consensus(self) -> None:
        self._judge("judge-a", ["real.py:1"])
        self._judge("judge-b", ["real.py:1"])
        result = generate_ai_consensus(tool_id="tool-x", workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)
        self.assertEqual(result["uncertainty_count"], 0)

    def test_fabricated_evidence_escalates(self) -> None:
        self._judge("judge-a", ["real.py:1"])
        self._judge("judge-b", ["ghost.py:1"])  # file does not exist → fabrication
        result = generate_ai_consensus(tool_id="tool-x", workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 0)
        reasons = {u["reason"] for u in result["uncertainties"]}
        self.assertIn("evidence_not_repo_verified", reasons)

    def test_gate_is_opt_in(self) -> None:
        # Without workspace_root the gate is inactive — legacy behaviour: the
        # fabricated-evidence group still reaches consensus mechanically.
        self._judge("judge-a", ["real.py:1"])
        self._judge("judge-b", ["ghost.py:1"])
        result = generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(result["consensus_count"], 1)


if __name__ == "__main__":
    unittest.main()
