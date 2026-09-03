"""Convergence-drainer coverage phase — ordering + helper pins.

Follows the v8 drainer-test idiom (tests/invariants/v8/test_phase_v8_1):
the drainer's ROUND ORDERING is pinned via source structure (executing the
full drainer needs live agent dispatch), while the pure helpers
(_structured_revision_content, _derive_arbiter_verdict) are pinned
behaviorally. The kernel-side gate behavior itself is covered end-to-end in
test_plan_coverage_gate.py.
"""
from __future__ import annotations

import inspect
import unittest

from aria_kernel import convergence_drainer
from aria_kernel.convergence_drainer import (
    _LAST_VERDICT_PROVENANCE,
    _derive_arbiter_verdict,
    _structured_revision_content,
    run_convergence_drainer,
)


def _drainer_source() -> str:
    return inspect.getsource(convergence_drainer.run_convergence_drainer)


class CoveragePhaseOrderingPins(unittest.TestCase):
    def test_coverage_phase_runs_after_cross_review_and_before_evaluate(self):
        # CL-1 (ORPHAN-725) — same ordering property, resumable spelling:
        # the coverage step is entered only from the CROSS_REVIEWED (or
        # legacy CRITIQUED) state branch and must precede evaluate_plan.
        source = _drainer_source()
        branch = source.index('if plan_state in {"CROSS_REVIEWED", "CRITIQUED"}:')
        phase_call = source.index("_coverage_step(current_round)")
        evaluate_call = source.index("eval_result = evaluate_plan(")
        self.assertLess(branch, phase_call)
        self.assertLess(phase_call, evaluate_call)

    def test_coverage_phase_skips_non_coverage_plans(self):
        source = _drainer_source()
        self.assertIn("if not _plan_requires_coverage(cur):", source)

    def test_coverage_gaps_ride_persistence_into_next_round_must_satisfy(self):
        source = _drainer_source()
        self.assertIn('"coverage_must_satisfy": coverage_carry', source)
        # Both envelope mints receive the merged obligations.
        self.assertIn("must_satisfy=effective_must_satisfy", source)
        self.assertNotIn(
            "must_satisfy=must_satisfy,",
            source,
            "an envelope mint bypasses the coverage feed-forward merge",
        )

    def test_coverage_computer_is_injectable_with_production_default(self):
        signature = inspect.signature(run_convergence_drainer)
        self.assertIn("coverage_computer", signature.parameters)
        self.assertIn("coverage_computer or compute_plan_coverage", _drainer_source())

    def test_recording_failure_is_fail_closed_not_raised(self):
        # A GovernanceError during record must produce a governance audit row
        # and fall through to the evaluator's coverage_missing escalation.
        source = _drainer_source()
        self.assertIn("except GovernanceError", source)
        self.assertIn('"coverage_phase_failed"', source)


class StructuredRevisionContentTests(unittest.TestCase):
    def state_with_content(self, content):
        return {
            "events": [
                {"event_type": "plan_started", "payload": {}},
                {"event_type": "revision_recorded", "payload": {"content": content}},
            ],
        }

    def test_json_object_string_parses(self):
        state = self.state_with_content('{"affected_surfaces": [{"paths": ["a.ts"]}]}')
        self.assertEqual(_structured_revision_content(state), {"affected_surfaces": [{"paths": ["a.ts"]}]})

    def test_dict_content_passes_through(self):
        state = self.state_with_content({"affected_surfaces": []})
        self.assertEqual(_structured_revision_content(state), {"affected_surfaces": []})

    def test_opaque_text_returns_none(self):
        self.assertIsNone(_structured_revision_content(self.state_with_content("round one revision")))

    def test_json_non_object_returns_none(self):
        self.assertIsNone(_structured_revision_content(self.state_with_content('["not", "an", "object"]')))

    def test_no_revision_returns_none(self):
        self.assertIsNone(_structured_revision_content({"events": [{"event_type": "plan_started", "payload": {}}]}))

    def test_latest_revision_wins(self):
        state = {
            "events": [
                {"event_type": "revision_recorded", "payload": {"content": '{"v": 1}'}},
                {"event_type": "revision_recorded", "payload": {"content": '{"v": 2}'}},
            ],
        }
        self.assertEqual(_structured_revision_content(state), {"v": 2})


class CoverageVerdictProvenanceTests(unittest.TestCase):
    def test_coverage_reasons_map_to_split_with_dedicated_branch(self):
        for reason in ("coverage_missing", "coverage_environment_unable"):
            verdict = _derive_arbiter_verdict("HUMAN_REQUIRED", [reason])
            self.assertEqual(verdict, "split")
            self.assertEqual(_LAST_VERDICT_PROVENANCE["branch"], "HUMAN_REQUIRED+coverage_gate")

    def test_max_rounds_still_wins_over_coverage_reason(self):
        # max_rounds_reached + coverage_gaps_present: the max_rounds branch
        # is earlier in the cascade and stays authoritative.
        verdict = _derive_arbiter_verdict("HUMAN_REQUIRED", ["max_rounds_reached", "coverage_gaps_present"])
        self.assertEqual(verdict, "max_rounds")
        self.assertEqual(_LAST_VERDICT_PROVENANCE["branch"], "HUMAN_REQUIRED+max_rounds")

    def test_converged_unaffected(self):
        self.assertEqual(_derive_arbiter_verdict("CONVERGED", []), "converged")


if __name__ == "__main__":
    unittest.main()
