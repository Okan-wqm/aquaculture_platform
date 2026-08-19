"""ORPHAN-CRITICAL-735 — uncertainty is a valid arbitration outcome.

Measured live (bridge ledger, 2026-08-19 07:22): the consensus arbiter
followed its contract — "the two judges disagree → uncertainty, reason
judge_disagreement" — and the Y5 bridge contract burned the claim as
`judge_verdict.verdict:invalid:None`. Fourth instance of the kernel
minting an outcome its own law refuses (ORPHAN-708, -719, -734 are the
siblings). The law now admits the arbiter's non-verdict outcome and
folds it through the SAME producer, ledger and idempotent escalation_id
as the deterministic engine.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import judgment_bridge as jb
from aria_kernel.feedback_store import (
    CONSENSUS_UNCERTAINTY_REASONS,
    record_consensus_uncertainty,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _request() -> dict:
    return {
        "role": "consensus_arbitration",
        "tool_id": "tenant-scoping-adapter",
        "run_id": "run-1",
        "finding_id": "f-1",
        "judgment_group_id": "grp-1",
        "cycle_id": "cyc-1",
    }


def _uncertain_response(reason: str = "judge_disagreement") -> dict:
    return {
        "role": "consensus_arbitration",
        "details": {
            "agent_subagent_type": "aria-consensus-arbiter",
            "consensus": {
                "uncertainty_reason": reason,
                "tool_id": "tenant-scoping-adapter",
                "run_id": "run-1",
                "finding_id": "f-1",
            },
        },
    }


class ArbiterUncertaintyIsAValidOutcome(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-735-")
        self.base = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.base)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_contract_admits_the_arbiters_uncertainty(self) -> None:
        errors = jb.validate_judge_response(
            request=_request(), response=_uncertain_response()
        )
        self.assertEqual(errors, [])

    def test_binary_judges_stay_bound_to_binary_verdicts(self) -> None:
        response = _uncertain_response()
        response["role"] = "evidence_judgment"
        response["details"]["verdict"] = response["details"].pop("consensus")
        errors = jb.validate_judge_response(request=_request(), response=response)
        self.assertTrue(any("invalid" in e for e in errors), errors)

    def test_fold_writes_the_shared_uncertainty_row_not_feedback(self) -> None:
        row = jb.record_judge_verdict_from_response(
            request=_request(),
            response=_uncertain_response(),
            base_dir=self.base,
        )
        self.assertEqual(row["kind"], "consensus_uncertainty")
        self.assertEqual(row["reason"], "judge_disagreement")
        self.assertTrue(row.get("escalation_id"))
        ledger = self.base / "feedback-consensus-uncertainties.jsonl"
        self.assertTrue(ledger.exists())
        rows = [json.loads(l) for l in ledger.read_text().splitlines() if l.strip()]
        self.assertEqual(len(rows[0]["uncertainties"]), 1)
        # No ai_judge feedback row — an uncertain arbitration is not a verdict.
        feedback = self.base / "operator-feedback.jsonl"
        self.assertFalse(feedback.exists())

    def test_the_row_is_idempotent_per_distinct_failure(self) -> None:
        for _ in range(3):
            jb.record_judge_verdict_from_response(
                request=_request(),
                response=_uncertain_response(),
                base_dir=self.base,
            )
        ledger = self.base / "feedback-consensus-uncertainties.jsonl"
        rows = [json.loads(l) for l in ledger.read_text().splitlines() if l.strip()]
        total = sum(len(r["uncertainties"]) for r in rows)
        self.assertEqual(total, 1)

    def test_unregistered_reason_is_refused_by_name(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            record_consensus_uncertainty(
                tool_id="t", run_id="r", finding_id="f", group_id="g",
                reason="i_made_this_up", base_dir=self.base,
            )
        self.assertIn("unregistered_consensus_uncertainty_reason", str(ctx.exception))
        # And through the bridge: an unknown reason is NOT admitted by the
        # contract either — the claim still fails loudly.
        errors = jb.validate_judge_response(
            request=_request(), response=_uncertain_response("i_made_this_up")
        )
        self.assertTrue(errors)

    def test_vocabulary_is_closed_and_shared(self) -> None:
        self.assertEqual(
            set(CONSENSUS_UNCERTAINTY_REASONS),
            {
                "conformal_abstain", "evidence_not_repo_verified",
                "judge_disagreement", "low_confidence",
                "missing_confidence", "single_judge",
            },
        )


if __name__ == "__main__":
    unittest.main()
