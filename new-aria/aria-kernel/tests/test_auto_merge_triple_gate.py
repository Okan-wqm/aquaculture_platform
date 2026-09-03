"""Plan 026R §D.4 — auto-merge triple-gate.

6 tests:

* head_sha vs change.commit_sha mismatch → block.
* change_validated row missing → block.
* validation_runs unverified (tampered log) → block.
* happy path: all three gates pass → triple_gate passes.
* head freshness regression (the §D.4 gate runs BEFORE pre-merge
  re-evaluation; assert ordering).
* decision row records the change_id + structured reasons.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import _evaluate_triple_gate, record_pr_lifecycle
from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.validation_runs_ledger import record_validation_run


class AutoMergeTripleGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d4-"))
        self.base = self.tmp / "aria-tools"
        set_profile("strict", operator_approval_ref="t", base_dir=self.base)
        self.log = self.tmp / "log.txt"
        self.log.write_text("ok\n", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_change_chain(
        self,
        *,
        pr_number: int,
        commit_sha: str,
        validate: bool = True,
        record_run: bool = True,
        plan_id_suffix: str = "",
    ) -> str:
        planned = emit_change_planned(
            plan_id=f"plan-d4{plan_id_suffix}",
            finding_id=f"F-d4{plan_id_suffix}",
            intended_affected_files=["docs/a.md"],
            intended_validation_refs=["nx affected --target=test"],
            architectural_tier=1,
            base_dir=self.base,
        )
        change_id = planned["change_id"]
        emit_change_committed(
            change_id=change_id,
            commit_sha=commit_sha,
            actual_affected_files=["docs/a.md"],
            base_dir=self.base,
        )
        if validate:
            emit_change_validated(
                change_id=change_id,
                validation_run_refs=[
                    {
                        "cmd": "nx affected --target=test",
                        "exit_code": 0,
                        "log_path": str(self.log),
                        "ran_at": "2026-05-11T13:00:00+00:00",
                    },
                ],
                validation_mode="historical_attestation",  # bypass matrix gate
                enforce_validation_matrix=False,
                base_dir=self.base,
            )
        if record_run:
            # ORPHAN-717 Gate 4 — the happy path now carries the full
            # hygiene battery, deliberately: a chain with only a test run
            # is BLOCKED (see test_hygiene_battery_missing_blocks).
            for battery_cmd in (
                "npm run format:check",
                "npm run type-check",
                "nx affected --target=test",
            ):
                record_validation_run(
                    change_id=change_id,
                    cmd=battery_cmd,
                    exit_code=0,
                    duration_ms=1_500,
                    log_path=str(self.log),
                    commit_sha=commit_sha,
                    runner_identity="ci-executor:gha-d4",
                    change_author_identity="agent:planner-x",
                    started_at="2026-05-11T13:00:00+00:00",
                    completed_at="2026-05-11T13:01:00+00:00",
                    base_dir=self.base,
                )
        # Bind the PR ↔ change_id via pr-lifecycle row.
        record_pr_lifecycle(
            {"number": pr_number, "head_sha": commit_sha,
             "change_id": change_id, "base_branch": "main"},
            event="opened", base_dir=self.base,
        )
        return change_id

    def test_hygiene_battery_missing_blocks(self) -> None:
        # ORPHAN-717 Gate 4 — a chain whose only verified run is the test
        # command (the pre-directive happy path) no longer merges: format
        # and typecheck must each carry their own exit-0 validation_run.
        commit_sha = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"
        change_id = self._seed_change_chain(
            pr_number=141, commit_sha=commit_sha, record_run=False,
            plan_id_suffix="-hyg",
        )
        record_validation_run(
            change_id=change_id,
            cmd="nx affected --target=test",
            exit_code=0,
            duration_ms=1_500,
            log_path=str(self.log),
            commit_sha=commit_sha,
            runner_identity="ci-executor:gha-d4",
            change_author_identity="agent:planner-x",
            started_at="2026-05-11T13:00:00+00:00",
            completed_at="2026-05-11T13:01:00+00:00",
            base_dir=self.base,
        )
        result = _evaluate_triple_gate(
            pr_number=141, head_sha=commit_sha, base_dir=self.base,
        )
        self.assertFalse(result["passed"])
        self.assertIn("triple_gate_hygiene_run_missing:format", result["reasons"])
        self.assertIn("triple_gate_hygiene_run_missing:typecheck", result["reasons"])

    def test_happy_path_triple_gate_passes(self) -> None:
        commit_sha = "abc1234567890"
        self._seed_change_chain(pr_number=100, commit_sha=commit_sha)
        result = _evaluate_triple_gate(
            pr_number=100, head_sha=commit_sha, base_dir=self.base,
        )
        self.assertTrue(result["passed"], result)
        self.assertEqual(result["reasons"], [])

    def test_head_sha_vs_commit_sha_mismatch_blocks(self) -> None:
        self._seed_change_chain(
            pr_number=101, commit_sha="abc1234567890",
            plan_id_suffix="-mm",
        )
        result = _evaluate_triple_gate(
            pr_number=101, head_sha="deadbeef0000", base_dir=self.base,
        )
        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "head_sha_commit_sha_mismatch" in r for r in result["reasons"]
        ), result["reasons"])

    def test_change_validated_missing_blocks(self) -> None:
        commit_sha = "abc1234567891"
        self._seed_change_chain(
            pr_number=102, commit_sha=commit_sha, validate=False,
            plan_id_suffix="-nv",
        )
        result = _evaluate_triple_gate(
            pr_number=102, head_sha=commit_sha, base_dir=self.base,
        )
        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "change_validated_missing" in r for r in result["reasons"]
        ), result["reasons"])

    def test_validation_run_tampered_log_blocks(self) -> None:
        commit_sha = "abc1234567892"
        self._seed_change_chain(
            pr_number=103, commit_sha=commit_sha,
            plan_id_suffix="-tampered",
        )
        # Tamper the log file AFTER record_validation_run.
        self.log.write_text("TAMPERED\n", encoding="utf-8")
        result = _evaluate_triple_gate(
            pr_number=103, head_sha=commit_sha, base_dir=self.base,
        )
        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "validation_run_unverified" in r for r in result["reasons"]
        ), result["reasons"])

    def test_missing_change_id_binding_blocks(self) -> None:
        # No pr-lifecycle row for this PR → change_for_pr returns None.
        result = _evaluate_triple_gate(
            pr_number=999, head_sha="x" * 40, base_dir=self.base,
        )
        self.assertFalse(result["passed"])
        self.assertEqual(
            result["reasons"],
            ["triple_gate_missing_change_id_binding"],
        )
        self.assertIsNone(result["change_id"])

    def test_decision_records_change_id_and_reasons(self) -> None:
        commit_sha = "abc1234567893"
        change_id = self._seed_change_chain(
            pr_number=104, commit_sha=commit_sha, validate=False,
            plan_id_suffix="-rec",
        )
        result = _evaluate_triple_gate(
            pr_number=104, head_sha=commit_sha, base_dir=self.base,
        )
        self.assertEqual(result["change_id"], change_id)
        self.assertGreaterEqual(len(result["reasons"]), 1)


if __name__ == "__main__":
    unittest.main()
