"""Plan ARIA-V4 Phase C — inter-agent question envelope invariants.

Four cases (I-V4-09..12):

  * I-V4-09 — envelope construction REQUIRES required fields
    (question_kind in closed enum, hypothesised_tier in {1,2,3},
    non-empty rule_text, ≥1 evidence_ref).
  * I-V4-10 — response MUST cite evidence OR refuse; non-refused
    verdicts require answered_tier + rationale + ≥1
    counter_evidence_ref.
  * I-V4-11 — anti-coupling: ≤1 OPEN question per target per cycle.
  * I-V4-12 — asker plan cites question_id (this is documentation-
    surface; the kernel can't enforce it directly, but the envelope
    schema includes ``question_id`` so the asker's downstream
    artifact can reference it).
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _setup_tools(tmp: Path) -> Path:
    tools = tmp / "aria-tools"
    tools.mkdir(parents=True)
    return tools


class PhaseV4CAgentQuestionEnvelope(unittest.TestCase):
    # I-V4-09 — envelope construction validates required fields.
    def test_i_v4_09_envelope_construction_requires_required_fields(
        self,
    ) -> None:
        from aria_kernel.agent_question import ask

        with tempfile.TemporaryDirectory(prefix="aria-v4c-09-") as tmp:
            tools = _setup_tools(Path(tmp))

            # Unknown question_kind → ValueError.
            with self.assertRaises(ValueError) as ctx:
                ask(
                    base_dir=tools,
                    asker_agent_id="aria-primary-planner",
                    target_agent_id="aria-challenger-planner",
                    question_kind="bogus_kind",
                    rule_text="canonical rule text",
                    hypothesised_tier=2,
                    evidence_refs=["SPEC.md§2 L3"],
                    cycle_id="cyc-test-09",
                )
            self.assertIn("agent_question_unknown_kind", str(ctx.exception))

            # hypothesised_tier out of range → ValueError.
            with self.assertRaises(ValueError) as ctx:
                ask(
                    base_dir=tools,
                    asker_agent_id="aria-primary-planner",
                    target_agent_id="aria-challenger-planner",
                    question_kind="tier_classification",
                    rule_text="canonical rule text",
                    hypothesised_tier=5,
                    evidence_refs=["SPEC.md§2"],
                    cycle_id="cyc-test-09",
                )
            self.assertIn("hypothesised_tier_out_of_range", str(ctx.exception))

            # Empty rule_text → ValueError.
            with self.assertRaises(ValueError) as ctx:
                ask(
                    base_dir=tools,
                    asker_agent_id="aria-primary-planner",
                    target_agent_id="aria-challenger-planner",
                    question_kind="tier_classification",
                    rule_text="",
                    hypothesised_tier=2,
                    evidence_refs=["SPEC.md§2"],
                    cycle_id="cyc-test-09",
                )
            self.assertIn("empty_rule_text", str(ctx.exception))

            # No evidence_refs → ValueError.
            with self.assertRaises(ValueError) as ctx:
                ask(
                    base_dir=tools,
                    asker_agent_id="aria-primary-planner",
                    target_agent_id="aria-challenger-planner",
                    question_kind="tier_classification",
                    rule_text="canonical rule",
                    hypothesised_tier=2,
                    evidence_refs=[],
                    cycle_id="cyc-test-09",
                )
            self.assertIn("requires_at_least_one_evidence_ref", str(ctx.exception))

            # Happy path — all required fields → row written.
            q = ask(
                base_dir=tools,
                asker_agent_id="aria-primary-planner",
                target_agent_id="aria-challenger-planner",
                question_kind="tier_classification",
                rule_text="never modify aria-kernel/** outside Plan 009 PR lane",
                hypothesised_tier=1,
                evidence_refs=["SPEC.md§2 L3 line 122"],
                cycle_id="cyc-test-09-ok",
            )
            self.assertEqual(q.question_kind, "tier_classification")
            self.assertEqual(q.hypothesised_tier, 1)
            self.assertEqual(len(q.evidence_refs), 1)

    # I-V4-10 — response must cite evidence or refuse.
    def test_i_v4_10_response_must_cite_evidence_or_refuse(self) -> None:
        from aria_kernel.agent_question import answer, ask

        with tempfile.TemporaryDirectory(prefix="aria-v4c-10-") as tmp:
            tools = _setup_tools(Path(tmp))
            q = ask(
                base_dir=tools,
                asker_agent_id="aria-primary-planner",
                target_agent_id="aria-challenger-planner",
                question_kind="tier_classification",
                rule_text="never auto-merge except L3 snowball lane",
                hypothesised_tier=1,
                evidence_refs=["SPEC.md§8.1"],
                cycle_id="cyc-test-10",
            )

            # Verdict=agreed but missing answered_tier → ValueError.
            with self.assertRaises(ValueError) as ctx:
                answer(
                    base_dir=tools,
                    question_id=q.question_id,
                    answerer_agent_id="aria-challenger-planner",
                    answered_tier=None,
                    rationale="agreement rationale",
                    counter_evidence_refs=["SPEC.md§8.1"],
                    verdict="agreed",
                    cycle_id="cyc-test-10",
                )
            self.assertIn("tier_out_of_range", str(ctx.exception))

            # Verdict=disagreed without evidence → ValueError.
            with self.assertRaises(ValueError) as ctx:
                answer(
                    base_dir=tools,
                    question_id=q.question_id,
                    answerer_agent_id="aria-challenger-planner",
                    answered_tier=2,
                    rationale="disagreement rationale",
                    counter_evidence_refs=[],
                    verdict="disagreed",
                    cycle_id="cyc-test-10",
                )
            self.assertIn(
                "requires_evidence_or_refuse",
                str(ctx.exception),
            )

            # Verdict=refused but missing refusal_reason → ValueError.
            with self.assertRaises(ValueError) as ctx:
                answer(
                    base_dir=tools,
                    question_id=q.question_id,
                    answerer_agent_id="aria-challenger-planner",
                    answered_tier=None,
                    rationale="",
                    counter_evidence_refs=[],
                    verdict="refused",
                    cycle_id="cyc-test-10",
                )
            self.assertIn("requires_reason_class", str(ctx.exception))

            # Happy path — refused with reason_class.
            r = answer(
                base_dir=tools,
                question_id=q.question_id,
                answerer_agent_id="aria-challenger-planner",
                answered_tier=None,
                rationale="cannot ground in SPEC alone",
                counter_evidence_refs=[],
                verdict="refused",
                refusal_reason="evidence",
                cycle_id="cyc-test-10",
            )
            self.assertEqual(r.verdict, "refused")
            self.assertEqual(r.refusal_reason, "evidence")
            self.assertIsNone(r.answered_tier)

    # I-V4-11 — anti-coupling: 1 open question per target per cycle.
    def test_i_v4_11_one_open_question_per_target_per_cycle(self) -> None:
        from aria_kernel.agent_question import (
            answer,
            ask,
            count_open_questions_for_target,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-v4c-11-") as tmp:
            tools = _setup_tools(Path(tmp))
            # First question to target — OK.
            q1 = ask(
                base_dir=tools,
                asker_agent_id="aria-primary-planner",
                target_agent_id="aria-challenger-planner",
                question_kind="tier_classification",
                rule_text="rule A",
                hypothesised_tier=1,
                evidence_refs=["SPEC.md§1"],
                cycle_id="cyc-test-11",
            )
            self.assertEqual(
                count_open_questions_for_target(
                    base_dir=tools,
                    target_agent_id="aria-challenger-planner",
                    cycle_id="cyc-test-11",
                ),
                1,
            )

            # Second question SAME target SAME cycle — refused.
            with self.assertRaises(GovernanceError) as ctx:
                ask(
                    base_dir=tools,
                    asker_agent_id="aria-primary-planner",
                    target_agent_id="aria-challenger-planner",
                    question_kind="extrapolation_check",
                    rule_text="rule B",
                    hypothesised_tier=2,
                    evidence_refs=["SPEC.md§2"],
                    cycle_id="cyc-test-11",
                )
            self.assertIn("target_busy", str(ctx.exception))

            # After answering q1, a new question is permitted.
            answer(
                base_dir=tools,
                question_id=q1.question_id,
                answerer_agent_id="aria-challenger-planner",
                answered_tier=1,
                rationale="grounded in SPEC §1",
                counter_evidence_refs=["SPEC.md§1"],
                verdict="agreed",
                cycle_id="cyc-test-11",
            )
            self.assertEqual(
                count_open_questions_for_target(
                    base_dir=tools,
                    target_agent_id="aria-challenger-planner",
                    cycle_id="cyc-test-11",
                ),
                0,
            )
            q2 = ask(
                base_dir=tools,
                asker_agent_id="aria-primary-planner",
                target_agent_id="aria-challenger-planner",
                question_kind="extrapolation_check",
                rule_text="rule B",
                hypothesised_tier=2,
                evidence_refs=["SPEC.md§2"],
                cycle_id="cyc-test-11",
            )
            self.assertNotEqual(q1.question_id, q2.question_id)

            # Different cycle ALWAYS permits a fresh question.
            q3 = ask(
                base_dir=tools,
                asker_agent_id="aria-primary-planner",
                target_agent_id="aria-challenger-planner",
                question_kind="invariant_grounding",
                rule_text="rule C",
                hypothesised_tier=3,
                evidence_refs=["SPEC.md§3"],
                cycle_id="cyc-test-11-other",
            )
            self.assertIsNotNone(q3.question_id)

    # I-V4-12 — envelope schema includes question_id (citation surface).
    def test_i_v4_12_envelope_carries_question_id_for_citation(self) -> None:
        from aria_kernel.agent_question import (
            AgentQuestion,
            AgentQuestionResponse,
        )
        import dataclasses

        # Both dataclasses must expose ``question_id`` as a field —
        # this is the citation surface the asker references in its
        # plan's satisfaction matrix (Plan ARIA-V4 §2e).
        question_fields = {f.name for f in dataclasses.fields(AgentQuestion)}
        response_fields = {f.name for f in dataclasses.fields(AgentQuestionResponse)}
        self.assertIn("question_id", question_fields)
        self.assertIn("question_id", response_fields)
        # Both also expose schema_uri so consumers can routing-
        # filter rows in the shared agent-questions.jsonl ledger.
        self.assertIn("schema_uri", question_fields)
        self.assertIn("schema_uri", response_fields)


if __name__ == "__main__":
    unittest.main()
