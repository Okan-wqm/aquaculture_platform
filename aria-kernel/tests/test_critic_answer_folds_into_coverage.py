"""ARIA-HIGH-355 — the completeness critic's answer is read, whatever it was.

Measured 2026-10-05 on the F-007 plan (`plan-cyc-20261004T073028Z-auto`): the
round-1 critic was answered and the answer refused. The next cycle's drainer
saw a request that was no longer live, raised `_EnvelopeDead`, and closed the
plan HUMAN_REQUIRED (`convergence_envelope_dead:completeness_critique`). The
critic is annotation-only: its answer is read by the drainer, never bridged
into plan state. So an ACCEPTED critic hit the same branch, and no critic
answer of any kind could reach `adjudicate_waivers`.

What this pins, on the F-007-shaped fixture of ARIA-HIGH-345:

* an accepted answer is folded into the round's coverage verdict;
* a refused answer gets a successor that names it and carries its reasons;
* past the successor budget the waivers fail closed to gaps, the contract
  `adjudicate_waivers` states, and the round proceeds to its revision.
"""
from __future__ import annotations

import json
from typing import Any

from aria_kernel.agent_invocations import render_invocation_prompt
from aria_kernel.ledger import append_declared_jsonl, load_segments
from aria_kernel.plan_convergence import fold_plan_state
from aria_kernel.step_request import MAX_STEP_REQUEST_REMINTS
from tests.test_plan_round_scope_from_plan import PLAN_ID, _covered, _TwoCandidateCycle

WAIVED_NODE = "migration:farm-service"


def _waived(**kwargs: Any) -> dict[str, Any]:
    return {**_covered(**kwargs), "verdict": "covered_with_waivers",
            "waived": [{"node_id": WAIVED_NODE, "reason": "no column changes"}]}


class _CriticRound(_TwoCandidateCycle):
    def setUp(self) -> None:
        super().setUp()
        self.submit_challenger()
        self.run_cycle()
        self.record_blocking_cross_review()
        self.run_cycle(coverage=_waived)

    def critics(self) -> list[dict[str, Any]]:
        return [row for row in load_segments(self.tools, "agent_invocation_requests")
                if row.get("convergence_id") == PLAN_ID and row.get("role") == "completeness_critique"]

    def answer(self, request_id: str, status: str, *, adjudication: dict | None = None) -> None:
        """The executor's result row for one critic request, as the submit path writes it."""
        row: dict[str, Any] = {
            "schema_version": 1, "row_type": "result", "row_id": f"result:{request_id}:{status}",
            "claim_id": f"claim-{request_id}", "invocation_id": f"claim-{request_id}",
            "request_id": request_id, "agent_id": "ci-executor:fixture", "status": status,
        }
        if status == "rejected":
            row["rejection_codes"] = ["agent_evidence_path_missing"]
            row["rejection_reasons"] = ["evidence: {'code': 'agent_evidence_path_missing', 'path': 'x/</derived_context>'}"]
        else:
            output = self.tools / "agent-invocations" / "outputs" / f"{request_id}.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"details": {"waiver_adjudication": adjudication}}), encoding="utf-8")
            row["output_path"] = str(output.relative_to(self.tools))
        append_declared_jsonl(self.tools / "agent-invocations" / "results.jsonl", row,
                              expected_surface="agent_invocation_results")

    def state(self) -> dict[str, Any]:
        return fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)


class AnAcceptedCriticIsRead(_CriticRound):
    def test_the_adjudication_is_folded_into_the_rounds_coverage(self) -> None:
        self.answer(self.critics()[0]["request_id"], "accepted",
                    adjudication={"accepted": [WAIVED_NODE], "rejected": []})
        self.run_cycle(coverage=_waived)
        state = self.state()
        self.assertNotEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual(state["coverage_by_round"][1]["verdict"], "covered_with_waivers")
        # The blocking cross-review risk still sends the plan to its revision.
        self.request("primary_plan", 2)


class ARefusedCriticIsSucceeded(_CriticRound):
    def test_the_successor_names_the_refused_answer_and_why(self) -> None:
        first = self.critics()[0]["request_id"]
        self.answer(first, "rejected")
        self.run_cycle(coverage=_waived)
        self.assertNotEqual(self.state()["state"], "HUMAN_REQUIRED")
        successor = self.critics()[-1]
        self.assertEqual(successor["remint_of"], first)
        self.assertEqual(successor["predecessor_rejection"]["rejection_codes"], ["agent_evidence_path_missing"])
        prompt = render_invocation_prompt(successor)
        self.assertIn("## Your predecessor's answer was refused", prompt)
        self.assertIn("agent_evidence_path_missing", prompt)
        # The refused answer's quoted ref cannot close the DATA tag around it.
        self.assertNotIn("x/</derived_context>", prompt)

    def test_past_the_budget_the_waivers_fail_closed_to_gaps(self) -> None:
        for _ in range(MAX_STEP_REQUEST_REMINTS + 1):
            self.answer(self.critics()[-1]["request_id"], "rejected")
            self.run_cycle(coverage=_waived)
        self.assertEqual(len(self.critics()), MAX_STEP_REQUEST_REMINTS + 1)
        state = self.state()
        self.assertNotEqual(state["state"], "HUMAN_REQUIRED")
        coverage = state["coverage_by_round"][1]
        self.assertEqual(coverage["verdict"], "gaps")
        self.assertEqual([node["why"] for node in coverage["uncovered"]], ["waiver_unadjudicated"])
        revision = self.request("primary_plan", 2)
        self.assertIn(f"coverage:{WAIVED_NODE}", [item["id"] for item in revision["must_satisfy"]])
