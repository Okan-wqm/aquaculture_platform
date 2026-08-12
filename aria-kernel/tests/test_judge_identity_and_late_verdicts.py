"""Kapalı Döngü D1+D2 — judge identity, group authority, late-verdict window.

The first live drain night proved the chain: every verdict carried the CI
executor's identity as judge_id (two judges collapsed into one voter), the
judge's own payload could override the canonical judgment group (one
finding's two verdicts split into two groups-of-one — a real disagreement
on anthropic.provider.ts never met itself), and the consensus engine only
looked at the CURRENT cycle's runs while executor verdicts land days later.
Net effect: zero ai_consensus rows could ever exist, which starved
precision, promotion, FP suppression, calibration, and the goldset.

These tests pin the repaired contracts:
* an executor-shaped judge identity is REFUSED, never silently repaired;
* `details.agent_subagent_type` is the identity; `verdict.judge_id` is the
  legacy/mock fallback; the judge's payload cannot override the request's
  canonical judgment_group_id;
* two real judges on one group produce an ai_consensus row even when their
  run belongs to an OLD cycle (cycle_id=None pending-set semantics);
* a permanently stuck group appends its uncertainty ONCE, not per cycle.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    generate_ai_consensus,
    load_jsonl,
    record_operator_feedback,
)
from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _response(judge: str, *, subagent: str | None = None, group: str = "echo-group") -> dict:
    details: dict = {
        "verdict": {
            "verdict": "true_positive",
            "confidence": 0.9,
            "judge_id": judge,
            "rationale": "fixture rationale",
            "judgment_group_id": group,
            "severity": "medium",
        }
    }
    if subagent is not None:
        details["agent_subagent_type"] = subagent
    return {
        "$schema": "aria/agent-response/v1",
        "request_id": "AIR-x",
        "agent_id": "ci-executor:gha-12345",
        "role": "evidence_judgment",
        "status": "submitted",
        "details": details,
    }


def _request(group: str = "judge:tool-a:run-1:f-1") -> dict:
    return {
        "tool_id": "tool-a",
        "run_id": "run-1",
        "finding_id": "f-1",
        "judgment_group_id": group,
    }


class JudgeIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_subagent_type_is_the_identity_and_mint_owns_the_group(self) -> None:
        row = record_judge_verdict_from_response(
            request=_request(),
            response=_response("spoofed-judge", subagent="aria-evidence-judge"),
            base_dir=self.tools,
        )
        self.assertEqual(row["judge_id"], "aria-evidence-judge")
        # The judge's payload said "echo-group"; the mint's canonical id wins.
        self.assertEqual(row["judgment_group_id"], "judge:tool-a:run-1:f-1")

    def test_legacy_mock_envelope_falls_back_to_verdict_judge_id(self) -> None:
        row = record_judge_verdict_from_response(
            request=_request(),
            response=_response("aria-adversarial-judge", subagent=None),
            base_dir=self.tools,
        )
        self.assertEqual(row["judge_id"], "aria-adversarial-judge")

    def test_executor_shaped_identity_is_refused(self) -> None:
        # Deliberate-break: the pre-D1 defect (executor id as judge id) must
        # be a loud refusal, not a silently repaired row.
        with self.assertRaises(GovernanceError):
            record_judge_verdict_from_response(
                request=_request(),
                response=_response("ci-executor:gha-99", subagent=None),
                base_dir=self.tools,
            )


class LateVerdictConsensusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _verdict(self, judge: str, verdict: str = "true_positive") -> None:
        record_operator_feedback(
            tool_id="tool-a",
            run_id="run-old",
            finding_id="f-9",
            verdict=verdict,
            severity="medium",
            note="fixture",
            source_type="ai_judge",
            judge_id=judge,
            confidence=0.9,
            judgment_group_id="judge:tool-a:run-old:f-9",
            base_dir=self.tools,
        )

    def test_two_judges_on_an_old_run_reach_consensus(self) -> None:
        # The run belongs to no registered cycle at all — exactly the shape
        # of an executor verdict landing days late. cycle_id=None must see it.
        self._verdict("aria-evidence-judge")
        self._verdict("aria-adversarial-judge")
        result = generate_ai_consensus(
            tool_id="tool-a", cycle_id=None, base_dir=self.tools
        )
        self.assertEqual(result["consensus_count"], 1)
        # Idempotency: reprocessing the ledger appends nothing new.
        again = generate_ai_consensus(
            tool_id="tool-a", cycle_id=None, base_dir=self.tools
        )
        self.assertEqual(again["consensus_count"], 0)

    def test_stuck_group_appends_its_uncertainty_once(self) -> None:
        self._verdict("aria-evidence-judge")  # single judge → stuck forever
        for _ in range(3):
            generate_ai_consensus(tool_id="tool-a", cycle_id=None, base_dir=self.tools)
        rows = load_jsonl(self.tools / "feedback-consensus-uncertainties.jsonl")
        escalations = [
            item.get("escalation_id")
            for row in rows
            for item in row.get("uncertainties") or []
        ]
        self.assertEqual(len(escalations), len(set(escalations)))
        self.assertEqual(len(escalations), 1)


if __name__ == "__main__":
    unittest.main()
