"""ARIA-HIGH-324 — a true positive needs every premise of its rule to hold.

The judge envelope now carries the rule's premises and the product-defect
claim as ``must_satisfy`` obligations (``judge_fanout``). An obligation the
kernel cannot hold the judge to is prose, and prose is how F-011 was
confirmed: the judges answered whether the rule fired. The bridge therefore
refuses a ``true_positive`` whose satisfaction matrix leaves any premise or
the defect obligation short of ``satisfied``; a ``false_positive`` that
contradicts a premise is exactly the answer the premises exist to allow.
"""
from __future__ import annotations

import unittest

from aria_kernel.judgment_bridge import validate_judge_response
from aria_kernel.must_satisfy import product_defect_obligation, rule_premise_obligation


def _request() -> dict:
    return {
        "tool_id": "bundle-budget-adapter", "run_id": "run-1", "finding_id": "F-1",
        "judgment_group_id": "judge:bundle-budget-adapter:fp1",
        "must_satisfy": [
            rule_premise_obligation(index=1, rule="bundle_budget_not_enforced", premise="A production Vite build exists."),
            rule_premise_obligation(index=2, rule="bundle_budget_not_enforced", premise="No CI step fails past a size."),
            product_defect_obligation(
                rule="bundle_budget_not_enforced", claim_type="absence_in_scope",
                defect_claim="The module ships without an enforced size budget.",
            ),
            {"id": "verdict", "description": "Return true_positive or false_positive with file:line evidence"},
        ],
    }


def _response(verdict: str, matrix: dict[str, str]) -> dict:
    return {
        "role": "evidence_judgment",
        "satisfaction_matrix": [{"id": key, "verdict": value} for key, value in matrix.items()],
        "details": {
            "agent_subagent_type": "aria-evidence-judge",
            "verdict": {"verdict": verdict, "rationale": "web/apps/aquamobil/vite.config.ts:1"},
        },
    }


_ALL_HOLD = {"premise:1": "satisfied", "premise:2": "satisfied", "defect": "satisfied", "verdict": "satisfied"}


class TruePositiveRequiresEveryPremise(unittest.TestCase):
    def test_a_true_positive_whose_premises_all_hold_is_accepted(self) -> None:
        self.assertEqual(validate_judge_response(request=_request(), response=_response("true_positive", _ALL_HOLD)), [])

    def test_a_true_positive_with_a_contradicted_premise_is_refused(self) -> None:
        matrix = dict(_ALL_HOLD, **{"premise:2": "contradicted"})
        errors = validate_judge_response(request=_request(), response=_response("true_positive", matrix))
        self.assertEqual(errors, ["judge_verdict.true_positive_premise_unmet:premise:2"])

    def test_a_true_positive_that_needs_no_change_is_refused(self) -> None:
        matrix = dict(_ALL_HOLD, defect="blocked")
        errors = validate_judge_response(request=_request(), response=_response("true_positive", matrix))
        self.assertEqual(errors, ["judge_verdict.true_positive_premise_unmet:defect"])

    def test_a_false_positive_may_contradict_a_premise(self) -> None:
        matrix = dict(_ALL_HOLD, **{"premise:2": "contradicted", "defect": "contradicted"})
        self.assertEqual(validate_judge_response(request=_request(), response=_response("false_positive", matrix)), [])

    def test_a_request_without_premise_obligations_is_not_held_to_them(self) -> None:
        # Envelopes minted before rule contracts (and every non-judge-fanout
        # request) carry no premise obligation; the bridge reads only the
        # obligations the request actually minted.
        request = dict(_request(), must_satisfy=[{"id": "verdict", "description": "Return a verdict"}])
        self.assertEqual(validate_judge_response(request=request, response=_response("true_positive", {"verdict": "satisfied"})), [])


if __name__ == "__main__":
    unittest.main()
