"""Plan 020 Phase 9 — change ledger validated chain closure tests.

What this suite pins:
- aria_change_chain_validation_pct: enforced rows / committed rows × 100;
  historical_attestation rows EXCLUDED from numerator.
- detect_stale_change_chains: committed-but-not-validated past 7 days.
- emit_stale_chain_warnings: emits change_chain_stale governance event.
- backfill script: idempotent over historical commits; uses
  validation_mode='historical_attestation' so backfilled rows do NOT
  inflate the validation_pct numerator.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.change_ledger import (
    CHAIN_STALE_DAYS,
    detect_stale_change_chains,
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
    emit_stale_chain_warnings,
)
from aria_kernel.plan_016_metrics import compute_plan_016_metrics
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def _seed() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-chain-closure-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    return tools, repo


def _structured_ref() -> dict:
    return {
        "cmd": "nx test", "exit_code": 0,
        "log_path": "/tmp/log.txt", "ran_at": "2026-05-08T00:00:00+00:00",
    }


def _seed_chain(tools: Path, *, change_idx: int = 1) -> dict:
    planned = emit_change_planned(
        plan_id=f"plan-{change_idx}",
        finding_id="F-001",
        intended_affected_files=[f"docs/x{change_idx}.md"],
        intended_validation_refs=["nx test"],
        architectural_tier=1,
        base_dir=tools,
    )
    emit_change_committed(
        change_id=planned["change_id"],
        commit_sha=f"abc{change_idx:03d}",
        actual_affected_files=[f"docs/x{change_idx}.md"],
        base_dir=tools,
    )
    return planned


class ValidationPctMetricTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_pct_zero_when_no_committed_chains(self) -> None:
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_change_chain_validation_pct"], 0)

    def test_pct_zero_when_committed_but_no_enforced_validated(self) -> None:
        _seed_chain(self.tools, change_idx=1)
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_change_chain_validation_pct"], 0)

    def test_pct_50_when_one_of_two_enforced(self) -> None:
        c1 = _seed_chain(self.tools, change_idx=1)
        c2 = _seed_chain(self.tools, change_idx=2)
        # Only c1 validated in enforced mode.
        # Plan 026R §D.5 — bypass the matrix gate at test scope so
        # the metric test focuses on validation_mode semantics; the
        # gate behavior is tested in test_no_risk_evidence_required.
        emit_change_validated(
            change_id=c1["change_id"],
            validation_run_refs=[_structured_ref()],
            base_dir=self.tools, workspace_root=self.repo,
            enforce_validation_matrix=False,
        )
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_change_chain_validation_pct"], 50)

    def test_historical_attestation_excluded_from_numerator(self) -> None:
        c1 = _seed_chain(self.tools, change_idx=1)
        c2 = _seed_chain(self.tools, change_idx=2)
        # Both validated, but c2 in historical mode → only c1 counts.
        # Plan 026R §D.5 — bypass matrix gate at test scope.
        emit_change_validated(
            change_id=c1["change_id"],
            validation_run_refs=[_structured_ref()],
            base_dir=self.tools, workspace_root=self.repo,
            enforce_validation_matrix=False,
        )
        emit_change_validated(
            change_id=c2["change_id"],
            validation_run_refs=["legacy-string-ref"],
            base_dir=self.tools, workspace_root=self.repo,
            validation_mode="historical_attestation",
        )
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_change_chain_validation_pct"], 50)


class StaleDetectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_stale_default_days_constant(self) -> None:
        self.assertEqual(CHAIN_STALE_DAYS, 7)

    def test_freshly_committed_chain_not_stale(self) -> None:
        _seed_chain(self.tools, change_idx=1)
        stale = detect_stale_change_chains(base_dir=self.tools)
        self.assertEqual(stale, [])

    def test_old_unvalidated_chain_marked_stale(self) -> None:
        # Manually inject a committed row dated 10 days ago.
        committed_path = self.tools / "change-ledger" / "committed.jsonl"
        committed_path.parent.mkdir(parents=True, exist_ok=True)
        old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        # Need a planned row first for emit_change_validated to reference,
        # but for stale-detection alone we only read committed.jsonl, so
        # just append directly.
        append_declared_fixture(
            committed_path,
            {
                "schema_version": 1, "event": "change_committed",
                "change_id": "chg_stale_old", "commit_sha": "deadbeef",
                "plan_id": "plan-stale", "finding_id": "F-001",
                "actual_affected_files": ["docs/old.md"],
                "affected_files_hash": "sha256:fake",
                "recorded_at": old,
            },
            expected_surface="change_committed",
        )
        stale = detect_stale_change_chains(base_dir=self.tools, stale_days=7)
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0]["change_id"], "chg_stale_old")
        self.assertGreaterEqual(stale[0]["age_days"], 10)

    def test_emit_stale_chain_warnings_fires_governance_event(self) -> None:
        committed_path = self.tools / "change-ledger" / "committed.jsonl"
        committed_path.parent.mkdir(parents=True, exist_ok=True)
        old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
        append_declared_fixture(
            committed_path,
            {
                "schema_version": 1, "event": "change_committed",
                "change_id": "chg_stale_warn", "commit_sha": "1234",
                "plan_id": "plan-stale", "finding_id": "F-001",
                "actual_affected_files": ["docs/old.md"],
                "affected_files_hash": "sha256:fake",
                "recorded_at": old,
            },
            expected_surface="change_committed",
        )
        emitted = emit_stale_chain_warnings(base_dir=self.tools)
        self.assertEqual(len(emitted), 1)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("change_chain_stale", kinds)


class BackfillScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed()
        # Two committed chains, neither validated.
        self.c1 = _seed_chain(self.tools, change_idx=1)
        self.c2 = _seed_chain(self.tools, change_idx=2)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_backfill_dry_run_does_not_persist(self) -> None:
        result = subprocess.run(
            [sys.executable, "tools/aria-poc/backfill_validated_chains.py",
             "--tools-dir", str(self.tools), "--dry-run"],
            cwd=Path(__file__).resolve().parents[2],
            env={
                **__import__("os").environ,
                "PYTHONPATH": "aria-kernel",
                "ARIA_TEST_TMPDIR": "/tmp/aria-tests",
                "ARIA_WORKSPACE_BASE": "/tmp/aria-workspaces",
            },
            capture_output=True, text=True, check=True,
        )
        report = json.loads(result.stdout)
        self.assertTrue(report["dry_run"])
        self.assertEqual(report["unvalidated_count"], 2)
        # No validated rows should exist.
        validated_path = self.tools / "change-ledger" / "validated.jsonl"
        self.assertFalse(validated_path.exists() and validated_path.read_text(encoding="utf-8").strip())

    def test_backfill_emits_historical_attestation_rows(self) -> None:
        result = subprocess.run(
            [sys.executable, "tools/aria-poc/backfill_validated_chains.py",
             "--tools-dir", str(self.tools)],
            cwd=Path(__file__).resolve().parents[2],
            env={
                **__import__("os").environ,
                "PYTHONPATH": "aria-kernel",
                "ARIA_TEST_TMPDIR": "/tmp/aria-tests",
                "ARIA_WORKSPACE_BASE": "/tmp/aria-workspaces",
            },
            capture_output=True, text=True, check=True,
        )
        report = json.loads(result.stdout)
        self.assertEqual(report["backfilled_count"], 2)
        self.assertEqual(report["failed_count"], 0)
        # Validated rows should now exist with historical_attestation mode.
        validated_path = self.tools / "change-ledger" / "validated.jsonl"
        self.assertTrue(validated_path.exists())
        rows = [json.loads(line) for line in validated_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row["validation_mode"], "historical_attestation")
        # Plan 020 invariant: historical-attestation rows do NOT inflate
        # the validation_pct numerator.
        m = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(m["aria_change_chain_validation_pct"], 0)


if __name__ == "__main__":
    unittest.main()
