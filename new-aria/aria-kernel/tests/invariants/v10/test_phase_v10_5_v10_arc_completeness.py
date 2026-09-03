"""Plan ARIA-V10.5 — V10 arc invariant-coverage consolidation.

Pins the V10 phase test files + V10 kernel additions + V10 doc
artifacts so a refactor that silently drops a V10 phase fails CI
before merge.

Closes: F-015-V10-5 (V10 invariants ~15).
"""
from __future__ import annotations

import unittest
from pathlib import Path


_V10_INVARIANTS_DIR = Path(__file__).resolve().parents[1] / "v10"


CANONICAL_V10_TEST_FILES = frozenset({
    "test_phase_v10_2_skill_genesis_trigger.py",
    "test_phase_v10_4_cost_attribution.py",
    "test_phase_v10_4_phase_3_h_6_cross_reviewer_ssot.py",  # F-018 closure
    "test_phase_v10_4_phase_3_h_7_cross_review_risk_schema.py",  # F-019 closure
    "test_phase_v10_4_phase_3_h_9_evidence_refs_path_only.py",  # F-020 closure
    "test_phase_v10_4_phase_3_h_10_primary_revision_canonicalizer.py",  # F-021 closure
    "test_phase_v10_4_phase_3_h_11_revision_round_advance.py",  # F-022 closure
    # ORPHAN-LOW-772 — test_phase_v10_5_phase_3_api_backoff.py was deleted
    # with the dead api_backoff.py module (imported only by this test; the
    # live backoff vocabulary is the api_backoff_engaged event string the
    # watchdog reads).
    "test_phase_v10_5_aria_watchdog.py",  # V10.5 Phase 1 watchdog MVP
    "test_phase_v10_5_phase_4_drainer_kernel_max_rounds_ssot.py",  # F-024 closure
    "test_phase_v10_5_phase_5_poll_state_race.py",  # F-025 closure
    "test_phase_v10_5_phase_6_evaluate_plan_response_ssot.py",  # F-026 closure
    "test_phase_v10_5_phase_7_v9_runner_wired.py",  # F-027 closure
    "test_phase_v10_5_v10_arc_completeness.py",  # this file
})


class TestV10ArcCompleteness(unittest.TestCase):

    def test_v10_test_files_present(self):
        present = {
            p.name for p in _V10_INVARIANTS_DIR.glob("test_phase_v10_*.py")
        }
        missing = CANONICAL_V10_TEST_FILES - present
        self.assertEqual(
            missing, set(),
            f"V10 invariant test files missing: {missing}",
        )

    def test_v10_no_extra_test_files(self):
        present = {
            p.name for p in _V10_INVARIANTS_DIR.glob("test_phase_v10_*.py")
        }
        extra = present - CANONICAL_V10_TEST_FILES
        self.assertEqual(
            extra, set(),
            f"unexpected V10 test files: {extra}",
        )

    def test_v10_1_kg_policy_doc_exists(self):
        repo = Path(__file__).resolve().parents[4]
        doc = repo / "docs" / "aria" / "v3-v10-1-knowledge-graph-policy.md"
        self.assertTrue(doc.exists())

    def test_v10_6_one_way_door_doc_exists(self):
        repo = Path(__file__).resolve().parents[4]
        doc = repo / "docs" / "aria" / "v3-one-way-door-decisions.md"
        self.assertTrue(doc.exists())

    def test_v10_2_kernel_extension_present(self):
        """V10.2 check_pattern_signature_stability MUST be importable
        from skill_genesis_drainer."""
        from aria_kernel import skill_genesis_drainer
        self.assertTrue(
            hasattr(skill_genesis_drainer, "check_pattern_signature_stability"),
        )
        self.assertTrue(
            hasattr(skill_genesis_drainer, "PATTERN_SIGNATURE_TRIGGER_MIN_CYCLES"),
        )

    def test_v10_4_cost_attribution_present(self):
        """V10.4 record_cost_attribution + read_cost_attribution +
        aggregate_cost_attribution MUST be importable from budget."""
        from aria_kernel import budget
        for fn in ("record_cost_attribution",
                   "read_cost_attribution",
                   "aggregate_cost_attribution",
                   "COST_INVOCATION_ROLES"):
            self.assertTrue(
                hasattr(budget, fn),
                f"budget.{fn} missing — V10.4 surface drift",
            )


if __name__ == "__main__":
    unittest.main()
