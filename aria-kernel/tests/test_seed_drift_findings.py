"""Plan S3 (ORPHAN-MEDIUM-297) — seed_drift_findings selection tests.

The scan itself is exercised by the operator invocation (subprocess of
poc.py); these tests pin the selection ordering. Minting goes through the
kernel (test_seed_mint_migration); the seeder's own F-NNN.json writer and
its tests are gone (ARIA-MEDIUM-330): it wrote findings no event named.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))

import seed_drift_findings as seeder  # noqa: E402


def _drift(concept: str, *, cross: bool, gates: list[str], jaccard: float) -> dict:
    return {
        "concept": concept,
        "cross_service": cross,
        "existing_gate_refs": gates,
        "value_jaccard_similarity": jaccard,
        "missing_in_ts": [],
        "missing_in_sql": ["x"],
        "ts": {"name": concept.upper(), "values": ["A", "B"], "ref": f"apps/x/{concept}.ts:1"},
        "sql": {"name": concept, "values": ["a"], "ref": f"apps/x/migrations/{concept}.sql:1"},
    }


class SelectionTests(unittest.TestCase):
    def test_ordering_prefers_cross_service_then_gate_free_then_similarity(self) -> None:
        doc = {
            "drifts_above_threshold": [
                _drift("low", cross=False, gates=[], jaccard=0.9),
                _drift("gated", cross=True, gates=["spec.ts:1"], jaccard=0.9),
                _drift("best", cross=True, gates=[], jaccard=0.5),
            ],
            "frontend_dropdown_drifts": [],
        }
        picked = seeder.select_candidates(doc, limit=10)
        self.assertEqual([d["concept"] for d in picked], ["best", "gated", "low"])

    def test_limit_and_ui_drifts_ranked_after_sql_drifts(self) -> None:
        doc = {
            "drifts_above_threshold": [_drift("sql1", cross=False, gates=[], jaccard=0.4)],
            "frontend_dropdown_drifts": [_drift("ui1", cross=True, gates=[], jaccard=0.9)],
        }
        picked = seeder.select_candidates(doc, limit=10)
        self.assertEqual([d["drift_class"] for d in picked], ["enum_drift", "ui_option_drift"])
        self.assertEqual(len(seeder.select_candidates(doc, limit=1)), 1)


if __name__ == "__main__":
    unittest.main()
