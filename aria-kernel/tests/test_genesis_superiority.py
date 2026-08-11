"""Z3d — the ACTIVE promotion gate measures; it no longer believes.

`validate_transition` used to gate EVAL_WINDOW → ACTIVE on
`evidence["eval_window_passed"]`, a caller-supplied unverified bool.
These tests pin the repaired contract:

* the legacy bool alone can NEVER validate ACTIVE (deliberate-break);
* `record_transition` computes the proof from ledgers and OVERWRITES any
  caller-supplied proof object;
* an `improved` window promotes; `regressed`/`flat`/`insufficient_evidence`
  refuse; a thin duel ledger defers to the window; a duel ledger where the
  candidate is out-rated refuses.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.genesis_lifecycle import validate_transition
from aria_kernel.genesis_superiority import (
    compute_eval_window_superiority,
    duel_observations,
)
from aria_kernel.knowledge_graph import _append_row
from aria_kernel.tool_registry import ensure_tools_dir


def _window(verdict: str) -> dict:
    return {"schema_version": 1, "verdict": verdict, "reason": verdict}


class ValidateTransitionGateTests(unittest.TestCase):
    def _active_evidence(self, extra: dict | None = None) -> dict:
        return {
            "reviewers": ["r1", "r2"],
            **(extra or {}),
        }

    def test_legacy_bool_alone_is_refused(self) -> None:
        verdict = validate_transition(
            from_state="EVAL_WINDOW",
            to_state="ACTIVE",
            evidence=self._active_evidence({"eval_window_passed": True}),
        )
        self.assertFalse(verdict.valid)
        self.assertIn(
            "active_requires_kernel_computed_eval_superiority", verdict.reasons
        )

    def test_passed_proof_with_components_validates(self) -> None:
        verdict = validate_transition(
            from_state="EVAL_WINDOW",
            to_state="ACTIVE",
            evidence=self._active_evidence({
                "resolved_eval_window_superiority": {
                    "passed": True,
                    "window": _window("improved"),
                    "duel": {"status": "not_evaluated"},
                },
            }),
        )
        self.assertTrue(verdict.valid)

    def test_proof_without_components_is_refused(self) -> None:
        verdict = validate_transition(
            from_state="EVAL_WINDOW",
            to_state="ACTIVE",
            evidence=self._active_evidence({
                "resolved_eval_window_superiority": {"passed": True},
            }),
        )
        self.assertFalse(verdict.valid)
        self.assertIn(
            "active_superiority_proof_missing_components", verdict.reasons
        )


class ComputeSuperiorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools_dir)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _duel(self, p2c: str | None, c2p: str | None) -> None:
        _append_row(
            Path(self.tools_dir) / "knowledge-graph" / "duel-ratings.jsonl",
            {
                "schema_version": 1,
                "plan_id": "plan-x",
                "round": 1,
                "primary_agent": "cand",
                "challenger_agent": "inc",
                "verdicts_by_direction": {
                    "primary_to_challenger": p2c,
                    "challenger_to_primary": c2p,
                },
                "material_risk_count": 0,
                "resolved_risk_count": 0,
                "terminal_state": "CONVERGED",
            },
        )

    def _compute(self, verdict: str) -> dict:
        with patch(
            "aria_kernel.genesis_superiority.compare_eval_windows",
            return_value=_window(verdict),
        ):
            return compute_eval_window_superiority(
                entity_id="cand", base_dir=self.tools_dir
            )

    def test_improved_window_thin_duels_passes(self) -> None:
        proof = self._compute("improved")
        self.assertTrue(proof["passed"])
        self.assertEqual(proof["duel"]["status"], "not_evaluated")

    def test_non_improved_window_refuses(self) -> None:
        for verdict in ("regressed", "flat", "insufficient_evidence"):
            proof = self._compute(verdict)
            self.assertFalse(proof["passed"], verdict)
            self.assertIn(f"window_not_improved:{verdict}", proof["reasons"])

    def test_duel_superior_candidate_passes(self) -> None:
        for _ in range(3):
            self._duel("material_risks_present", None)  # cand out-reviews inc
        proof = self._compute("improved")
        self.assertEqual(proof["duel"]["status"], "evaluated")
        self.assertTrue(proof["passed"])

    def test_duel_outrated_candidate_refuses(self) -> None:
        for _ in range(3):
            self._duel(None, "material_risks_present")  # inc out-reviews cand
        proof = self._compute("improved")
        self.assertEqual(proof["duel"]["status"], "evaluated")
        self.assertFalse(proof["passed"])
        self.assertIn("duel_rating_not_superior", proof["reasons"])

    def test_duel_observation_folding_is_directional(self) -> None:
        self._duel("material_risks_present", "material_risks_present")
        observations = duel_observations(base_dir=self.tools_dir)
        self.assertEqual(
            observations,
            [
                {"winner": "cand", "loser": "inc"},
                {"winner": "inc", "loser": "cand"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
