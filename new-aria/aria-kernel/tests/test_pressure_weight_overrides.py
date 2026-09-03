"""F4.1 — operator-approved weight overrides close the precision loop.

calibration computed per-source precision and recommended weight changes
that nothing consumed; and its private default table had silently drifted
from the live SOURCE_WEIGHTS (evidence_gone 65 vs 80). These tests pin the
closed loop: override ledger -> effective table -> _pressure score, plus
the ceremony refusals and the SSoT unification.
"""
from __future__ import annotations

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

    def test_override_changes_the_next_score(self) -> None:
        base = self._score(effective_source_weights(self.root))
        record_weight_override(
            source="evidence_gone", weight=40,
            reason="precision follow-up test",
            operator_approval_ref="tranquil-sniffing-pancake#F4.1",
            base_dir=self.root,
        )
        eff = effective_source_weights(self.root)
        self.assertEqual(eff["evidence_gone"], 40)
        self.assertLess(self._score(eff), base)
        # untouched sources keep the live table
        self.assertEqual(eff["tool_quarantine"], SOURCE_WEIGHTS["tool_quarantine"])

    def test_ledger_is_append_only_history_last_write_wins(self) -> None:
        for w in (40, 55):
            record_weight_override(
                source="evidence_gone", weight=w,
                reason="precision follow-up test",
                operator_approval_ref="ref#1", base_dir=self.root,
            )
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

    def test_calibration_reads_the_live_table_not_a_copy(self) -> None:
        # SSoT unification regression: the drifted private default (65) must
        # be gone — calibration's "current" for evidence_gone is the live 80.
        import aria_kernel.calibration as cal
        self.assertFalse(hasattr(cal, "DEFAULT_PRESSURE_WEIGHTS"))
        self.assertEqual(effective_source_weights(self.root)["evidence_gone"], 80)


if __name__ == "__main__":
    unittest.main()
