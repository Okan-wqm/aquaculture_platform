"""Plan S3 (ORPHAN-MEDIUM-297) — seed_drift_findings pure-function tests.

The scan itself is exercised by the operator invocation (subprocess of
poc.py); these tests pin the selection ordering, finding shape, index
shape (the exact contract aria_kernel.cycle_guard reads), determinism,
and the honest-zero path.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))

import seed_drift_findings as seeder  # noqa: E402

from aria_kernel.cycle_guard import _open_finding_count  # noqa: E402


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


class RenderTests(unittest.TestCase):
    def test_finding_shape_and_determinism(self) -> None:
        drift = {"drift_class": "enum_drift", "candidate_tool": "typeorm-entity-schema-adapter",
                 **_drift("equipment", cross=True, gates=[], jaccard=0.875)}
        one = seeder.render_finding(drift, finding_id="F-101", head_sha="abc123")
        two = seeder.render_finding(drift, finding_id="F-101", head_sha="abc123")
        self.assertEqual(one, two)
        self.assertEqual(one["status"], "OPEN")
        self.assertEqual(one["candidate_tools"], ["typeorm-entity-schema-adapter"])
        self.assertEqual(one["seeded_from_commit"], "abc123")
        self.assertEqual(len(one["evidence_chain"]), 2)
        for ref in one["evidence_chain"]:
            self.assertIn(":", ref["reference"])

    def test_index_is_cycle_guard_readable(self) -> None:
        drift = {"drift_class": "enum_drift", "candidate_tool": "t",
                 **_drift("goal", cross=True, gates=[], jaccard=0.8)}
        finding = seeder.render_finding(drift, finding_id="F-101", head_sha="abc")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            seeder.write_findings(repo / "aria-findings", [finding])
            self.assertEqual(_open_finding_count(repo), 1)
            payload = json.loads((repo / "aria-findings" / "_index.json").read_text())
            self.assertEqual(payload["findings"][0]["file"], "F-101.json")

    def test_honest_zero_writes_empty_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            seeder.write_findings(repo / "aria-findings", [])
            self.assertEqual(_open_finding_count(repo), 0)


if __name__ == "__main__":
    unittest.main()
