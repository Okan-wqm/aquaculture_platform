"""F4.1 — operator-approved weight overrides close the precision loop.

calibration computed per-source precision and recommended weight changes
that nothing consumed; and its private default table had silently drifted
from the live SOURCE_WEIGHTS (evidence_gone 65 vs 80). These tests pin the
closed loop: override ledger -> effective table -> _pressure score, plus
the ceremony refusals and the SSoT unification.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
import tempfile

from aria_kernel.pressure import (
    SOURCE_WEIGHTS,
    _pressure,
    effective_source_weights,
    load_weight_overrides,
    record_weight_override,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class WeightOverrideLoop(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.root = ensure_tools_dir(Path(self._td.name) / "aria-tools")

    def tearDown(self) -> None:
        self._td.cleanup()

    def _score(self, weights) -> float:
        return _pressure(
            cycle_id="c1", source="evidence_gone", pressure_type="X",
            severity="high", reason="r", evidence=[], occurrence_count=1,
            candidate_tools=[], recommended_action="a", weights=weights,
        )["score"]


    def _override(self, source: str, weight: int, *, reason: str = "precision follow-up test"):
        from tests._helpers.operator_acts import github_operator_acts

        with github_operator_acts() as github:
            return record_weight_override(
                source=source, weight=weight, reason=reason,
                operator_approval_ref=github.approve(
                    "pressure_weight_override", {"source": source, "weight": str(weight)},
                ),
                base_dir=self.root,
            )

    def test_override_changes_the_next_score(self) -> None:
        base = self._score(effective_source_weights(self.root))
        self._override("evidence_gone", 40)
        eff = effective_source_weights(self.root)
        self.assertEqual(eff["evidence_gone"], 40)
        self.assertLess(self._score(eff), base)
        # untouched sources keep the live table
        self.assertEqual(eff["tool_quarantine"], SOURCE_WEIGHTS["tool_quarantine"])

    def test_ledger_is_append_only_history_last_write_wins(self) -> None:
        for w in (40, 55):
            self._override("evidence_gone", w)
        self.assertEqual(load_weight_overrides(self.root)["evidence_gone"], 55)
        path = self.root / "calibration" / "weight-overrides.jsonl"
        self.assertEqual(len(path.read_text().splitlines()), 2)

    def test_ceremony_refusals(self) -> None:
        cases = [
            dict(source="not_a_source", weight=50, reason="long enough reason",
                 operator_approval_ref="r"),
            dict(source="evidence_gone", weight=0, reason="long enough reason",
                 operator_approval_ref="r"),
            dict(source="evidence_gone", weight=50, reason="short",
                 operator_approval_ref="r"),
            dict(source="evidence_gone", weight=50, reason="long enough reason",
                 operator_approval_ref="  "),
        ]
        for kw in cases:
            with self.assertRaises(GovernanceError):
                record_weight_override(base_dir=self.root, **kw)

    def _append_raw(self, row: dict) -> None:
        # A row that bypassed the ceremony (hand edit, older writer): the
        # reader must apply the same weight rule the writer enforces.
        path = self.root / "calibration" / "weight-overrides.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")

    def test_boolean_ledger_rows_are_not_weights(self) -> None:
        self._override("evidence_gone", 40)
        self._append_raw({"source": "evidence_gone", "weight": True})
        self.assertEqual(load_weight_overrides(self.root)["evidence_gone"], 40)

    def test_out_of_range_ledger_rows_are_not_weights(self) -> None:
        self._override("evidence_gone", 40)
        for weight in (0, 101):
            self._append_raw({"source": "evidence_gone", "weight": weight})
        self.assertEqual(load_weight_overrides(self.root)["evidence_gone"], 40)

    def test_ceremony_refuses_boolean_weight(self) -> None:
        for weight in (True, False):
            with self.subTest(weight=weight), self.assertRaises(GovernanceError):
                record_weight_override(
                    source="evidence_gone", weight=weight,
                    reason="long enough reason", operator_approval_ref="r",
                    base_dir=self.root,
                )
        self.assertEqual(load_weight_overrides(self.root), {})

    def test_every_live_weight_is_an_override_legal_int(self) -> None:
        # calibration recommends current ± step from this table and the
        # ceremony refuses a non-int, so a float base weight produces a
        # recommendation that can never be applied verbatim.
        for source, weight in SOURCE_WEIGHTS.items():
            with self.subTest(source=source):
                self.assertIs(type(weight), int, source)
                self.assertTrue(1 <= weight <= 100, source)

    def test_calibration_reads_the_live_table_not_a_copy(self) -> None:
        # SSoT unification regression: the drifted private default (65) must
        # be gone — calibration's "current" for evidence_gone is the live 80.
        import aria_kernel.calibration as cal
        self.assertFalse(hasattr(cal, "DEFAULT_PRESSURE_WEIGHTS"))
        self.assertEqual(effective_source_weights(self.root)["evidence_gone"], 80)


if __name__ == "__main__":
    unittest.main()
