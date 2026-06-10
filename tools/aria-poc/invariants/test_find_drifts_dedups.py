"""Plan ARIA-V2 §3.6 + I-20 — pre-Cartesian dedup invariant.

ARIA-V-003 reproduction: M re-exported TS enums with the same
normalized concept name and the same value set caused ``find_drifts``
to emit M copies of every drift entry. The architectural fix is a
pre-Cartesian dedup pass keyed on
``(normalize_concept_name(name), tuple(sorted(lower_values(values))))``.

This test feeds 4 identical TS rows + 1 mismatched SQL row and asserts
the surviving TS representative carries exactly ``M - 1 == 3``
collapsed refs, and the drift list contains exactly one entry (not 4).
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_POC_PATH = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
_SPEC = importlib.util.spec_from_file_location("aria_poc_for_test_i20", _POC_PATH)
assert _SPEC and _SPEC.loader
aria_poc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = aria_poc
_SPEC.loader.exec_module(aria_poc)


def _ts_row(ref: str, values: list[str]) -> dict:
    return {
        "kind": "ts_union",
        "name": "BatchStatus",
        "values": values,
        "ref": ref,
        "surface": "frontend_source",
    }


def _sql_row(ref: str, values: list[str]) -> dict:
    return {
        "kind": "sql_enum",
        "name": "batch_status",
        "values": values,
        "ref": ref,
        "surface": "migration",
    }


class FindDriftsDedups(unittest.TestCase):
    def test_m_identical_ts_rows_collapse_to_one_with_m_minus_one_refs(self) -> None:
        identical_values = ["active", "harvested", "stocking"]
        ts_rows = [
            _ts_row(f"web/modules/dashboard/src/types-{i}.ts:1", identical_values)
            for i in range(4)
        ]
        sql_rows = [_sql_row("apps/farm-service/.../001-init.sql:5", ["active", "harvested"])]

        drifts_above, _drifts_filtered = aria_poc.find_drifts(ts_rows, sql_rows)

        self.assertEqual(
            len(drifts_above),
            1,
            msg=f"Expected exactly 1 drift after dedup; got {len(drifts_above)}",
        )
        survivor_ts = drifts_above[0]["ts"]
        self.assertIn("dedup_collapsed_refs", survivor_ts)
        self.assertEqual(
            len(survivor_ts["dedup_collapsed_refs"]),
            3,
            msg=(
                f"Expected M-1=3 collapsed refs for M=4 identical inputs; "
                f"got {survivor_ts['dedup_collapsed_refs']}"
            ),
        )

    def test_non_identical_rows_do_not_collapse(self) -> None:
        ts_rows = [
            _ts_row("a.ts:1", ["active", "harvested"]),
            _ts_row("b.ts:1", ["active", "harvested", "extra"]),
        ]
        sql_rows = [_sql_row("init.sql:1", ["active"])]

        drifts_above, drifts_filtered = aria_poc.find_drifts(ts_rows, sql_rows)
        total = len(drifts_above) + len(drifts_filtered)
        self.assertEqual(
            total,
            2,
            msg=f"Distinct value-sets must produce 2 drift entries; got {total}",
        )

    def test_dedup_preserves_insertion_order_for_first_occurrence(self) -> None:
        identical_values = ["a", "b"]
        ts_rows = [
            _ts_row("FIRST.ts:1", identical_values),
            _ts_row("SECOND.ts:1", identical_values),
        ]
        sql_rows = [_sql_row("init.sql:1", ["a"])]

        drifts_above, _ = aria_poc.find_drifts(ts_rows, sql_rows)
        self.assertEqual(len(drifts_above), 1)
        self.assertEqual(drifts_above[0]["ts"]["ref"], "FIRST.ts:1")
        self.assertEqual(drifts_above[0]["ts"]["dedup_collapsed_refs"], ["SECOND.ts:1"])


if __name__ == "__main__":
    unittest.main()
