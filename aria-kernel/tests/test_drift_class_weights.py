"""Plan S4 (ORPHAN-MEDIUM-298) — drift_class_weights targeting lever tests.

Pins: (1) neutral weights leave scores bit-identical (default behaviour
unchanged), (2) a non-neutral weight rescales + re-caps at 100 + records
the applied multiplier, (3) every pressure source has a drift class so a
new source cannot silently escape the operator lever, (4) the policy
loader ships neutral defaults and accepts operator overrides.
"""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.genesis_policy import default_policy, load_policy
from aria_kernel.pressure import (
    DRIFT_CLASS_BY_SOURCE,
    SOURCE_WEIGHTS,
    _apply_drift_class_weights,
)


def _pressures() -> list[dict]:
    return [
        {"source": "migration_surface_repeat", "score": 40.0},
        {"source": "shadow_raw_delta", "score": 50.0},
        {"source": "tool_quarantine", "score": 90.0},
    ]


class MappingTests(unittest.TestCase):
    def test_every_source_has_a_drift_class(self) -> None:
        self.assertEqual(set(DRIFT_CLASS_BY_SOURCE), set(SOURCE_WEIGHTS))

    def test_default_policy_ships_neutral_weight_per_class(self) -> None:
        weights = default_policy()["drift_class_weights"]
        classes = {v for v in DRIFT_CLASS_BY_SOURCE.values()}
        for cls in classes:
            self.assertEqual(weights.get(cls), 1.0)


class ApplicationTests(unittest.TestCase):
    def test_neutral_weights_leave_scores_bit_identical(self) -> None:
        rows = _pressures()
        baseline = copy.deepcopy(rows)
        _apply_drift_class_weights(rows, default_policy()["drift_class_weights"])
        for row, base in zip(rows, baseline):
            self.assertEqual(row["score"], base["score"])
            self.assertNotIn("drift_class_weight_applied", row)
            self.assertEqual(row["drift_class"], DRIFT_CLASS_BY_SOURCE[base["source"]])

    def test_none_weights_are_neutral(self) -> None:
        rows = _pressures()
        _apply_drift_class_weights(rows, None)
        self.assertEqual(rows[0]["score"], 40.0)
        self.assertEqual(rows[0]["drift_class"], "schema_drift")

    def test_multiplier_rescales_and_records(self) -> None:
        rows = _pressures()
        _apply_drift_class_weights(rows, {"schema_drift": 2.0})
        self.assertEqual(rows[0]["score"], 80.0)
        self.assertEqual(rows[0]["drift_class_weight_applied"], 2.0)
        self.assertEqual(rows[1]["score"], 50.0)

    def test_rescale_recaps_at_100(self) -> None:
        rows = _pressures()
        _apply_drift_class_weights(rows, {"tool_governance": 5.0})
        self.assertEqual(rows[2]["score"], 100.0)

    def test_invalid_zero_or_doc_values_are_ignored(self) -> None:
        rows = _pressures()
        _apply_drift_class_weights(
            rows, {"schema_drift": "not-a-number", "adapter_shadow": 0, "_doc": "x"},
        )
        self.assertEqual(rows[0]["score"], 40.0)
        self.assertEqual(rows[1]["score"], 50.0)

    def test_unknown_source_is_left_untouched(self) -> None:
        rows = [{"source": "future_source", "score": 10.0}]
        _apply_drift_class_weights(rows, {"schema_drift": 3.0})
        self.assertEqual(rows[0]["score"], 10.0)
        self.assertNotIn("drift_class", rows[0])


class OverrideTests(unittest.TestCase):
    def test_operator_override_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "aria-config").mkdir()
            (repo / "aria-config" / "genesis_policy.json").write_text(
                json.dumps({"drift_class_weights": {"schema_drift": 2.5}}),
            )
            weights = load_policy(repo)["drift_class_weights"]
            self.assertEqual(weights["schema_drift"], 2.5)


if __name__ == "__main__":
    unittest.main()
