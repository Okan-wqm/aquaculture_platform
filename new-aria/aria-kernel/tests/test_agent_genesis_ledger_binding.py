"""Plan 023 v3 §A-1 + §A-7 — genesis ledger binding + empty fixture lanes.

§A-1 — fixture provenance verifiable against ledger
====================================================
Pre-Plan-023 _fixture_result_has_real_execution_provenance checked
SHAPE only: provenance dict exists, has executed_at + execution_run_id
strings. A caller could fabricate provenance = {execution_run_id:
"fake-123", executed_at: "2026-05-09T00:00:00Z"} and pass.

Plan 023 v3 §A-1: the check must query the actual fixture-runs.jsonl
ledger and validate suite-level identity:
  * Row exists.
  * tool_id matches.
  * fixture_set_hash matches.
  * cycle_id matches.
  * case_count > 0 (defense-in-depth with §A-7).
  * actual_status matches the genesis claim.
  * evidence_hash matches.

§A-7 — empty fixture suite + required lanes
============================================
Pre-Plan-023 fixture_runner.run_fixture_suite computed `passed = all(
case["passed"] for case in case_results)`. Python's `all([]) is True`,
so an empty suite reported passed=True. Plus agent_genesis.py only
enforced len(fixture_results) >= 3 — three empty-case results from
three different lanes still passed.

Plan 023 v3 §A-7:
  * passed = bool(case_results) and all(case["passed"] for case in
    case_results). Empty cases → passed=False, actual_status=
    "error_no_cases".
  * Per-result case_count > 0 check in evaluate_genesis_sandbox.
  * REQUIRED_LANES = ("real_repo_baseline", "semantic_regression").

Tests (5 cases combined, marked §A-1 / §A-7 in body):
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_genesis import evaluate_genesis_sandbox
from aria_kernel.fixture_runner import fixture_runs_path
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def _seed_draft(base_dir: Path, *, draft_id: str = "DRAFT-A1-01") -> str:
    drafts_dir = base_dir / "agent-genesis"
    drafts_dir.mkdir(parents=True, exist_ok=True)
    draft = {
        "schema_version": 1,
        "recorded_at": "2026-05-09T00:00:00+00:00",
        "gap_id": "gap-1",
        "draft_id": draft_id,
        "status": "draft_shadow",
        "draft": {
            "name": "test-agent",
            "purpose": "Test fixture",
            "scope_globs": ["apps/**"],
            "forbidden_globs": ["secrets/**"],
            "evidence_contract": "cite repo paths",
            "output_schema": {"required": ["findings", "read_paths"]},
            "validation_fixtures": [
                {"name": "a", "expected": "pass"},
                {"name": "b", "expected": "pass"},
                {"name": "c", "expected": "pass"},
            ],
            "related_existing_agents": [],
        },
        "target_path": ".claude/agents/test-agent.md",
    }
    append_declared_fixture(
        base_dir / "agent-genesis" / "drafts.jsonl",
        draft,
        expected_surface="agent_genesis_drafts",
    )
    return draft_id


def _seed_fixture_run(
    base_dir: Path,
    *,
    execution_run_id: str = "exec-real-001",
    tool_id: str = "test-agent",
    fixture_set_hash: str = "sha256:fixture-fake-hash",
    cycle_id: str = "cycle-genesis-001",
    case_count: int = 3,
    actual_status: str = "pass",
    evidence_hash: str = "sha256:evidence-fake-hash",
    row_type: str = "fixture_run_suite",
) -> None:
    row = {
        "schema_version": 1,
        "row_type": row_type,
        "at": "2026-05-09T00:00:00+00:00",
        "tool_id": tool_id,
        "tool_version": "0.1.0",
        "tool_manifest_hash": "sha256:tool-manifest",
        "fixture_set_hash": fixture_set_hash,
        "cycle_id": cycle_id,
        "fixture_set": "tools/aria-poc/fixtures/test-agent",
        "passed": True,
        "case_count": case_count,
        "fixture_lanes": {"real_repo_baseline": 2, "semantic_regression": 1},
        "fixture_baseline_passed": True,
        "semantic_fixture_passed": True,
        "failed_cases": [],
        "cases": [],
        "execution_run_id": execution_run_id,
        "actual_status": actual_status,
        "error_code": None,
        "evidence_hash": evidence_hash,
    }
    append_declared_fixture(
        fixture_runs_path(base_dir),
        row,
        expected_surface="agent_eval_fixture_runs",
    )


class GenesisLedgerBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a1-"))
        self.base = self.tmp / "aria-tools"
        ensure_tools_dir(self.base)
        # Disable test-mode escape so the binding check fires.
        os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)
        self.draft_id = _seed_draft(self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_fixture_result(
        self,
        *,
        execution_run_id: str = "exec-real-001",
        actual_status: str = "pass",
        evidence_hash: str = "sha256:evidence-fake-hash",
        case_count: int = 3,
    ) -> dict:
        return {
            "status": "pass",
            "actual_status": actual_status,
            "case_count": case_count,
            "lane": "real_repo_baseline",
            "tool_id": "test-agent",
            "fixture_set_hash": "sha256:fixture-fake-hash",
            "cycle_id": "cycle-genesis-001",
            "evidence_hash": evidence_hash,
            "provenance": {
                "executed_at": "2026-05-09T00:00:00+00:00",
                "execution_run_id": execution_run_id,
            },
        }

    def test_real_run_id_with_matching_ledger_passes(self) -> None:
        """§A-1: fixture_result.execution_run_id resolves to a real
        ledger row whose tool_id / fixture_set_hash / cycle_id /
        actual_status / evidence_hash all match."""
        _seed_fixture_run(self.base)
        results = [
            self._make_fixture_result(),
            self._make_fixture_result(),
            self._make_fixture_result(),
        ]
        sandbox = evaluate_genesis_sandbox(
            draft_id=self.draft_id,
            fixture_results=results,
            base_dir=self.base,
        )
        self.assertEqual(sandbox["decision"], "pass")

    def test_fake_run_id_no_ledger_row_rejects(self) -> None:
        """§A-1: a fabricated execution_run_id with no matching ledger
        row → genesis_fixture_provenance_unverifiable."""
        # Note: NO _seed_fixture_run call — ledger is empty.
        results = [
            self._make_fixture_result(execution_run_id="fake-no-ledger-row"),
            self._make_fixture_result(execution_run_id="fake-no-ledger-row"),
            self._make_fixture_result(execution_run_id="fake-no-ledger-row"),
        ]
        with self.assertRaises(GovernanceError) as ctx:
            evaluate_genesis_sandbox(
                draft_id=self.draft_id,
                fixture_results=results,
                base_dir=self.base,
            )
        self.assertIn("genesis_fixture_provenance_unverifiable", str(ctx.exception))

    def test_actual_status_mismatch_rejects(self) -> None:
        """§A-1: ledger row has actual_status='pass' but fixture_result
        claims actual_status='fail' — provenance unverifiable."""
        _seed_fixture_run(self.base, actual_status="pass")
        results = [
            self._make_fixture_result(actual_status="fail"),
            self._make_fixture_result(actual_status="fail"),
            self._make_fixture_result(actual_status="fail"),
        ]
        with self.assertRaises(GovernanceError) as ctx:
            evaluate_genesis_sandbox(
                draft_id=self.draft_id,
                fixture_results=results,
                base_dir=self.base,
            )
        self.assertIn("genesis_fixture_provenance_unverifiable", str(ctx.exception))


class EmptyFixtureSuiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a7-"))
        self.base = self.tmp / "aria-tools"
        ensure_tools_dir(self.base)
        os.environ.pop("ARIA_GENESIS_TEST_SYNTHETIC", None)
        self.draft_id = _seed_draft(self.base)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_fixture_result(
        self,
        *,
        execution_run_id: str = "exec-real-001",
        case_count: int = 3,
    ) -> dict:
        return {
            "status": "pass",
            "actual_status": "pass",
            "case_count": case_count,
            "lane": "real_repo_baseline",
            "tool_id": "test-agent",
            "fixture_set_hash": "sha256:fixture-fake-hash",
            "cycle_id": "cycle-genesis-001",
            "evidence_hash": "sha256:evidence-fake-hash",
            "provenance": {
                "executed_at": "2026-05-09T00:00:00+00:00",
                "execution_run_id": execution_run_id,
            },
        }

    def test_per_result_case_count_zero_rejects(self) -> None:
        """§A-7: per-result case_count == 0 must reject (3 results from
        3 different lanes with case_count=0 each is still empty)."""
        _seed_fixture_run(self.base, case_count=0)
        results = [
            self._make_fixture_result(case_count=0),
            self._make_fixture_result(case_count=0),
            self._make_fixture_result(case_count=0),
        ]
        with self.assertRaises(GovernanceError) as ctx:
            evaluate_genesis_sandbox(
                draft_id=self.draft_id,
                fixture_results=results,
                base_dir=self.base,
            )
        # Either case_count_zero or genesis_fixture_provenance_unverifiable
        # (case_count zero on the ledger row). Both are correct rejections.
        msg = str(ctx.exception)
        self.assertTrue(
            "case_count_zero" in msg or "genesis_fixture_provenance_unverifiable" in msg,
            f"unexpected error: {msg!r}",
        )


if __name__ == "__main__":
    unittest.main()
