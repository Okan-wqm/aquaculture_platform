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



class CycleGuardCannotReportAnUnseenBacklogEmpty(unittest.TestCase):
    """ARIA-MEDIUM-230 — with ARIA_REPO_STATE_ROOT set, the backlog lives in
    the store; a tools root whose repo_identity.json is unbound or names a
    checkout that no longer exists made the guard count 0 open findings and
    advise an EMPTY cycle (exit 2, "caller may skip") over a backlog it never
    read. Driven through the real CLI, `python -m aria_kernel cycle-guard
    evaluate`, the command the nightly runs.
    """

    def setUp(self) -> None:
        import os

        self._tmp = tempfile.TemporaryDirectory(prefix="aria-m230-guard-")
        base = Path(self._tmp.name)
        self.store_root = base / "store-repo-state"
        self.store_root.mkdir()
        _write_findings_index(self.store_root, ["OPEN", "OPEN", "RESOLVED"])
        self.tools = base / "aria-tools"
        ensure_tools_dir(self.tools)
        self.env = {
            key: value for key, value in os.environ.items()
            if key not in {"ARIA_TOOLS_DIR", "ARIA_WORKSPACE_BASE"}
        }
        self.env["ARIA_REPO_STATE_ROOT"] = str(self.store_root)
        self.env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _cli(self, *extra: str):
        import subprocess
        import sys

        return subprocess.run(
            [sys.executable, "-m", "aria_kernel", "cycle-guard", "evaluate",
             "--cycle-id", "cyc-m230", "--tools-dir", str(self.tools), *extra],
            capture_output=True, text=True, env=self.env, timeout=120, check=False,
        )

    def _bind(self, bound_root: str | None) -> None:
        identity = json.loads((self.tools / "repo_identity.json").read_text(encoding="utf-8"))
        identity["bound_repo_root"] = bound_root
        (self.tools / "repo_identity.json").write_text(json.dumps(identity), encoding="utf-8")

    def _assert_refused(self, completed, reason: str) -> None:
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["refusal"].startswith(reason), payload)
        self.assertNotIn("is_empty", payload)

    def test_an_unbound_identity_is_refused_by_name_not_reported_empty(self) -> None:
        self._bind(None)
        self._assert_refused(self._cli(), "cycle_guard_repo_identity_unbound")

    def test_a_stale_identity_is_refused_by_name_not_reported_empty(self) -> None:
        self._bind(str(Path(self._tmp.name) / "checkout-that-moved"))
        self._assert_refused(self._cli(), "cycle_guard_repo_identity_stale:")

    def test_a_missing_workspace_root_is_refused_by_name(self) -> None:
        self._bind(None)
        self._assert_refused(
            self._cli("--workspace-root", str(Path(self._tmp.name) / "no-such-checkout")),
            "cycle_guard_workspace_root_missing:",
        )

    def test_an_unreadable_index_is_refused_by_name(self) -> None:
        checkout = Path(self._tmp.name) / "checkout"
        checkout.mkdir()
        self._bind(str(checkout))
        (self.store_root / "aria-findings" / "_index.json").write_text("{not json", encoding="utf-8")
        self._assert_refused(self._cli(), "cycle_guard_index_unreadable:")

    def test_a_bound_identity_reads_the_store_backlog(self) -> None:
        checkout = Path(self._tmp.name) / "checkout"
        checkout.mkdir()
        self._bind(str(checkout))
        completed = self._cli()
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["open_findings"], 2)
        self.assertFalse(payload["is_empty"])

if __name__ == "__main__":
    unittest.main()
