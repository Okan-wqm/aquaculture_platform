"""Tests for the Plan 016 Faz D5 / D8 helpers."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cycle_guard import (
    DEFAULT_PRESSURE_THRESHOLD,
    evaluate_cycle_emptiness,
)
from aria_kernel.suppression_scanner import scan_unified_diff_text
from aria_kernel.tool_registry import ensure_tools_dir


def _seed_repo() -> Path:
    return Path(tempfile.mkdtemp(prefix="aria-d-batch-"))


def _write_pressure(tools: Path, cycle_id: str, scores: list[float]) -> None:
    pressure_dir = tools / "pressure"
    pressure_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "cycle_id": cycle_id,
        "pressures": [
            {"pressure_id": f"p-{i}", "score": s, "reason": f"score {s}"}
            for i, s in enumerate(scores)
        ],
        "summary": {"contradiction": 0, "repetition": len(scores), "unknown": 0},
    }
    (pressure_dir / f"{cycle_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def _write_findings_index(repo: Path, statuses: list[str]) -> None:
    findings_dir = repo / "aria-findings"
    findings_dir.mkdir(exist_ok=True)
    payload = {
        "schema_version": 1,
        "generated_at": "2026-05-07T00:00:00Z",
        "findings": [
            {"finding_id": f"F-{i+1:03d}", "status": s, "severity": "LOW", "claim_type": "duplication", "claim_summary": f"f{i}"}
            for i, s in enumerate(statuses)
        ],
    }
    (findings_dir / "_index.json").write_text(json.dumps(payload), encoding="utf-8")


def _write_repo_identity(tools: Path, repo: Path) -> None:
    identity = {
        "aria_tools_contract_version": 2,
        "schema_version": 2,
        "bound_repo_hash": "test-hash",
        "bound_repo_root": str(repo),
    }
    (tools / "repo_identity.json").write_text(json.dumps(identity), encoding="utf-8")


class CycleEmptinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)
        _write_repo_identity(self.tools, self.repo)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_no_pressure_no_findings_yields_empty(self) -> None:
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-empty", base_dir=self.tools
        )
        self.assertTrue(verdict.is_empty, verdict)
        self.assertEqual(verdict.open_findings, 0)
        self.assertEqual(verdict.open_debts, 0)
        self.assertIn("no pressure", verdict.reason)

    def test_pressure_above_threshold_marks_non_empty(self) -> None:
        _write_pressure(self.tools, "cycle-pressure", [50.0, 10.0])
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-pressure", base_dir=self.tools
        )
        self.assertFalse(verdict.is_empty)
        self.assertEqual(verdict.pressure_count_above_threshold, 1)

    def test_pressure_below_threshold_still_empty(self) -> None:
        _write_pressure(self.tools, "cycle-low", [10.0, 5.0, 0.0])
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-low", base_dir=self.tools
        )
        self.assertTrue(verdict.is_empty)
        self.assertEqual(verdict.pressure_count_above_threshold, 0)

    def test_open_finding_marks_non_empty(self) -> None:
        _write_findings_index(self.repo, statuses=["OPEN"])
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-x", base_dir=self.tools
        )
        self.assertFalse(verdict.is_empty)
        self.assertEqual(verdict.open_findings, 1)

    def test_resolved_finding_does_not_block(self) -> None:
        _write_findings_index(self.repo, statuses=["RESOLVED"])
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-r", base_dir=self.tools
        )
        self.assertTrue(verdict.is_empty)

    def test_threshold_param_overrides_default(self) -> None:
        _write_pressure(self.tools, "cycle-mid", [25.0])
        # default 30 -> empty
        v1 = evaluate_cycle_emptiness(
            cycle_id="cycle-mid", base_dir=self.tools
        )
        self.assertTrue(v1.is_empty)
        # custom threshold 20 -> non-empty
        v2 = evaluate_cycle_emptiness(
            cycle_id="cycle-mid", base_dir=self.tools, pressure_threshold=20.0
        )
        self.assertFalse(v2.is_empty)

    def test_repo_root_override_used_when_provided(self) -> None:
        _write_findings_index(self.repo, statuses=["OPEN"])
        verdict = evaluate_cycle_emptiness(
            cycle_id="cycle-z", base_dir=self.tools, repo_root_override=self.repo
        )
        self.assertFalse(verdict.is_empty)


class ApplyScanDiffEndToEndTests(unittest.TestCase):
    """Verify scan_unified_diff_text output matches what the CLI exposes."""

    def test_clean_diff_yields_no_matches(self) -> None:
        diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+const y = 2;\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertEqual(matches, [])

    def test_diff_with_ts_ignore_yields_match(self) -> None:
        diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -1,1 +1,2 @@\n"
            " const x = 1;\n"
            "+// @ts-ignore\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "ts_masking")


if __name__ == "__main__":
    unittest.main()
