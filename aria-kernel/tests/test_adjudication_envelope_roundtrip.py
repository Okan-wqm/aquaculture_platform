"""ARIA-HIGH-097 — an adjudicator's answer survives the executor bridge.

On ``origin/aria/state`` 159 panel requests produced 80 accepted results and
215/215 folds stayed ``still_escalated``: the adjudicator wrote a top-level
``verdict``, ``_build_envelope_from_claude_output`` carries only ``details``
(and evidence_refs / notes / plan_content), and ``_load_opinion`` read the
missing top-level key. Every panel test wrote the file by hand in the shape
the live envelope never had, so all of them passed.

These tests drive raw agent text through the REAL builder and pin:
1. A contract-shaped answer passes the executor's pre-submit gate, is read by
   the fold, and a unanimous resolve clears the escalation.
2. The live defect shapes — a top-level verdict, and the judge contract's
   ``details.verdict`` object — are refused at the gate (released as a
   harness-class ``adjudication_contract_violation``) and are unreadable to
   the fold.
3. The mock envelope for the role satisfies the gate and never resolves.
4. The minted prompt names the contract block.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import human_required_adjudication as hra
from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASONS, list_agent_invocation_requests
from aria_kernel.human_required import record_human_required
from aria_kernel.release_reason import parse_release_reason
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.adjudication import (
    adjudicator_agent_text,
    sealed_envelope,
    seed_adjudicator_opinion,
)
from tests._helpers.executor_module import load_ci_executor

_EXECUTOR = load_ci_executor("ci_executor_adjudication_roundtrip")
_REQUEST = {"role": hra.ADJUDICATION_ROLE}


def _gate(envelope: dict) -> list[str]:
    return _EXECUTOR._pre_submit_validate_envelope(
        envelope, role=hra.ADJUDICATION_ROLE, request=dict(_REQUEST),
    )


class _Escalation(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-h097-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        self.escalation_id = "AIR-h097"
        record_human_required(
            request_id=self.escalation_id,
            reason="three claims released without delivering",
            context={"kind": "lease_lifecycle"},
            base_dir=self.tools,
        )
        row = hra.open_adjudication(
            escalation_request_id=self.escalation_id,
            record={"context": {"kind": "lease_lifecycle"}},
            base_dir=self.tools,
        )
        self.request_ids = [str(r) for r in row["request_ids"]]

    def tearDown(self) -> None:
        self._tmp.cleanup()


class ContractShapedAnswerRoundTrips(_Escalation):
    def test_contract_answer_passes_the_gate_and_folds_to_resolved(self) -> None:
        text = adjudicator_agent_text(
            verdict=hra.RESOLVE_VERDICT,
            rationale="the lease expired on a dead runner; the work is intact",
            disposition=hra.DISPOSITION_RE_MINT,
        )
        envelope = sealed_envelope(request_id=self.request_ids[0], agent_id="judge-a", agent_text=text)
        self.assertEqual(_gate(envelope), [])
        answer = hra.read_adjudication(envelope)
        self.assertIsNotNone(answer)
        self.assertEqual(answer.verdict, hra.RESOLVE_VERDICT)
        self.assertEqual(answer.disposition, hra.DISPOSITION_RE_MINT)

        for rid, agent in zip(self.request_ids, ("judge-a", "judge-b", "judge-c")):
            seed_adjudicator_opinion(
                self.tools, rid, agent_id=agent, agent_text=text, verdict=hra.RESOLVE_VERDICT,
            )
        verdict = hra.fold_adjudication(escalation_request_id=self.escalation_id, base_dir=self.tools)
        self.assertEqual(verdict.outcome, hra.OUTCOME_RESOLVED, verdict.reason)
        self.assertEqual(verdict.disposition, hra.DISPOSITION_RE_MINT)


class LiveDefectShapesAreRefused(_Escalation):
    def _assert_refused_and_unreadable(self, agent_text: str, code: str) -> None:
        envelope = sealed_envelope(request_id=self.request_ids[0], agent_id="judge-a", agent_text=agent_text)
        self.assertIn(code, _gate(envelope))
        self.assertIsNone(hra.read_adjudication(envelope))
        for rid, agent in zip(self.request_ids, ("judge-a", "judge-b", "judge-c")):
            seed_adjudicator_opinion(
                self.tools, rid, agent_id=agent, agent_text=agent_text, verdict=hra.RESOLVE_VERDICT,
            )
        verdict = hra.fold_adjudication(escalation_request_id=self.escalation_id, base_dir=self.tools)
        self.assertEqual(verdict.outcome, hra.OUTCOME_STILL_ESCALATED)

    def test_top_level_verdict_is_dropped_by_the_bridge(self) -> None:
        self._assert_refused_and_unreadable(
            json.dumps({"verdict": "resolve", "disposition": "re_mint", "rationale": "clears"}),
            "adjudication:absent_or_not_object",
        )

    def test_judge_verdict_object_is_not_an_adjudication(self) -> None:
        self._assert_refused_and_unreadable(
            json.dumps({"details": {"verdict": {"verdict": "resolve", "rationale": "clears"}}}),
            "adjudication:absent_or_not_object",
        )

    def test_empty_rationale_and_open_vocabulary_are_refused(self) -> None:
        envelope = sealed_envelope(
            request_id=self.request_ids[0], agent_id="judge-a",
            agent_text=json.dumps({"details": {hra.ADJUDICATION_DETAILS_KEY: {
                "verdict": "approve", "rationale": " ", "disposition": "reboot",
            }}}),
        )
        self.assertEqual(
            sorted(_gate(envelope)),
            sorted([
                "adjudication.verdict:not_in_closed_set",
                "adjudication.rationale:absent_or_empty",
                "adjudication.disposition:not_in_closed_set",
            ]),
        )

    def test_violation_is_released_as_harness_class(self) -> None:
        self.assertIn(hra.ADJUDICATION_CONTRACT_RELEASE_REASON, HARNESS_FAULT_RELEASE_REASONS)
        self.assertEqual(
            parse_release_reason(hra.ADJUDICATION_CONTRACT_RELEASE_REASON).fault_domain, "harness",
        )


class GateScopeAndMock(_Escalation):
    def test_other_roles_are_not_judged_by_this_contract(self) -> None:
        self.assertEqual(
            hra.validate_adjudication_response(request={"role": "verification"}, response={}),
            [],
        )

    def test_mock_envelope_satisfies_the_gate_and_never_resolves(self) -> None:
        output = Path(self._tmp.name) / "mock.json"
        prompt = Path(self._tmp.name) / "prompt.md"
        prompt.write_text("# prompt", encoding="utf-8")
        with patch.dict(os.environ, {_EXECUTOR.MOCK_MODE_ENV_VAR: "1"}):
            code = _EXECUTOR.invoke_claude_cli(
                request_id=self.request_ids[0],
                subagent_type="aria-evidence-judge",
                prompt_file=prompt,
                output_path=output,
                timeout_seconds=60,
                claim_id="claim_test_aaaaaaaa",
                agent_id="ci-executor:gha-test",
                role=hra.ADJUDICATION_ROLE,
                must_satisfy=[],
            )
        self.assertEqual(code, 0)
        envelope = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(_gate(envelope), [])
        self.assertEqual(hra.read_adjudication(envelope).verdict, hra.INSUFFICIENT_VERDICT)

    def test_minted_prompt_names_the_contract_block(self) -> None:
        requests = list_agent_invocation_requests(request_id=self.request_ids[0], base_dir=self.tools)
        prompt = str(requests[-1].get("suggested_prompt") or "")
        self.assertIn(f"details.{hra.ADJUDICATION_DETAILS_KEY}", prompt)
        for verdict in hra.ADJUDICATOR_VERDICTS:
            self.assertIn(verdict, prompt)


if __name__ == "__main__":
    unittest.main()
