"""ARIA-HIGH-242 — a judge reads the verdict law the bridge enforces, never a copy of it.

The judge and arbiter contracts named their verdict values in hand-written
prose. The arbiter's told the model to "emit an `uncertainty` result" with
the reason at ``details.uncertainty_reason``: a value the bridge accepts
nowhere, at a path it never reads, from a list three reasons short of
``CONSENSUS_UNCERTAINTY_REASONS``. The live arbiter obeyed and every such
answer was refused ``judge_verdict.verdict:invalid:'uncertainty'`` (six per
drain, 2026-09-27 audit). The law is now rendered from the tuples the check
uses and delivered as the tail of every agent contract; these tests pin that
the delivered text carries all of it, that the answer it describes passes the
check, and that no agent file keeps a hand-written copy to drift from.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel import judgment_bridge as jb
from aria_kernel.agent_contract import render_response_validator_contract
from aria_kernel.agent_contract_delivery import render_agent_contract
from aria_kernel.agent_surface import JUDGE_ROLES
from aria_kernel.feedback_store import CONSENSUS_UNCERTAINTY_REASONS, FEEDBACK_VERDICTS

_REPO_ROOT = Path(__file__).resolve().parents[2]
_JUDGE_AGENTS = ("aria-evidence-judge", "aria-adversarial-judge", "aria-consensus-arbiter")


def _arbitration_request() -> dict:
    return {
        "role": "consensus_arbitration", "tool_id": "tenant-scoping-adapter", "run_id": "run-1",
        "finding_id": "f-1", "judgment_group_id": "grp-1", "cycle_id": "cyc-1",
    }


def _arbiter_response(consensus: dict) -> dict:
    return {
        "role": "consensus_arbitration",
        "details": {
            "agent_subagent_type": "aria-consensus-arbiter",
            "consensus": {"tool_id": "tenant-scoping-adapter", "run_id": "run-1", "finding_id": "f-1",
                          **consensus},
        },
    }


class TheDeliveredContractStatesTheWholeLaw(unittest.TestCase):
    def test_the_rendered_rules_name_every_role_verdict_and_reason(self) -> None:
        text = render_response_validator_contract()
        for token in (*JUDGE_ROLES, *FEEDBACK_VERDICTS, *CONSENSUS_UNCERTAINTY_REASONS,
                      "details.verdict", "details.consensus", "uncertainty_reason"):
            with self.subTest(token=token):
                self.assertIn(token, text)

    def test_every_judge_agent_receives_the_rules(self) -> None:
        rules = "\n".join(jb.render_judge_verdict_rules())
        for agent in _JUDGE_AGENTS:
            with self.subTest(agent=agent):
                self.assertIn(rules, render_agent_contract(agent, repo_root=_REPO_ROOT).text)


class TheAnswerTheContractDescribesIsAccepted(unittest.TestCase):
    def test_no_verdict_and_any_reason_from_the_vocabulary_is_accepted(self) -> None:
        for reason in CONSENSUS_UNCERTAINTY_REASONS:
            with self.subTest(reason=reason):
                errors = jb.validate_judge_response(
                    request=_arbitration_request(),
                    response=_arbiter_response({"uncertainty_reason": reason}),
                )
                self.assertEqual(errors, [])

    def test_the_answer_the_old_prose_described_is_refused(self) -> None:
        errors = jb.validate_judge_response(
            request=_arbitration_request(),
            response=_arbiter_response({"verdict": "uncertainty", "uncertainty_reason": "judge_disagreement"}),
        )
        self.assertIn("judge_verdict.verdict:invalid:'uncertainty'", errors)


class NoAgentFileKeepsAHandWrittenCopy(unittest.TestCase):
    def test_judge_agent_files_name_no_uncertainty_reason(self) -> None:
        # The vocabulary lives in the rendered contract alone: a subset
        # written into a .md is exactly how the arbiter's drifted.
        for agent in _JUDGE_AGENTS:
            body = (_REPO_ROOT / ".claude/agents" / f"{agent}.md").read_text(encoding="utf-8")
            for reason in CONSENSUS_UNCERTAINTY_REASONS:
                with self.subTest(agent=agent, reason=reason):
                    self.assertNotIn(reason, body)

    def test_the_arbiter_file_no_longer_prescribes_the_refused_shape(self) -> None:
        body = (_REPO_ROOT / ".claude/agents/aria-consensus-arbiter.md").read_text(encoding="utf-8")
        self.assertNotIn("emit an `uncertainty` result", body)
        self.assertNotIn("`details.uncertainty_reason`", body)


if __name__ == "__main__":
    unittest.main()
