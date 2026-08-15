"""Plan 026R §D.5 — no-risk validation evidence (enforced mode).

5 tests:

* enforced + no-risk + verified evidence → passes.
* enforced + no-risk + no validation_run rows → raise.
* enforced + no-risk + unverified (tampered) log_hash → raise.
* risk-typed flow regression (D.5 must NOT change behavior when
  risk_types is non-empty — the existing layer chain runs).
* historical_attestation mode + no-risk → vacuous pass preserved.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_matrix_gate import enforce_validation_matrix
from aria_kernel.validation_runs_ledger import record_validation_run


class NoRiskEvidenceRequiredTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d5-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self.log = self.tmp / "log.txt"
        self.log.write_text("ok\n", encoding="utf-8")
        self.change_id = "ch-d5"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_run(self) -> dict:
        return record_validation_run(
            change_id=self.change_id,
            cmd="nx affected --target=test",
            exit_code=0,
            duration_ms=1_500,
            log_path=str(self.log),
            commit_sha="abc1234567890",
            runner_identity="ci-executor:gha-d5",
            change_author_identity="agent:planner-x",
            started_at="2026-05-11T13:00:00+00:00",
            completed_at="2026-05-11T13:01:00+00:00",
            base_dir=self.base,
        )

    def _enforce(self, mode: str = "enforced") -> dict:
        # Bypass the risk-type detection by patching the detector to
        # return an empty list (no risk types implicated).
        with patch(
            "aria_kernel.validation_matrix_gate.detect_risk_types_for_change",
            return_value=[],
        ):
            return enforce_validation_matrix(
                change_id=self.change_id,
                candidate_refs=[],
                base_dir=self.base,
                validation_mode=mode,
            )

    def test_enforced_no_risk_with_verified_evidence_passes(self) -> None:
        self._seed_run()
        result = self._enforce()
        self.assertTrue(result["passed"])
        self.assertEqual(result["risk_types"], [])
        self.assertEqual(len(result["verified_validation_run_ids"]), 1)

    def test_enforced_no_risk_empty_evidence_raises(self) -> None:
        # No validation_run rows seeded — the §D.5 gate raises.
        with self.assertRaises(GovernanceError) as ctx:
            self._enforce()
        self.assertIn("no_risk_evidence_required", str(ctx.exception))

    def test_enforced_no_risk_tampered_log_raises(self) -> None:
        self._seed_run()
        # Tamper the log file after recording — verify_validation_run
        # raises on hash mismatch, so zero runs are "verified" and
        # the no-risk path raises.
        self.log.write_text("TAMPERED\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            self._enforce()
        self.assertIn("no_risk_evidence_required", str(ctx.exception))

    def test_risk_typed_flow_regression_unchanged(self) -> None:
        # When risk_types is non-empty the §D.5 branch does NOT run;
        # the existing layer chain (existence / pattern / run-pass)
        # is the gate. We don't fully exercise it here (it requires
        # repo state), but we DO assert that the no-risk evidence
        # branch is bypassed.
        self._seed_run()
        with patch(
            "aria_kernel.validation_matrix_gate.detect_risk_types_for_change",
            return_value=["security"],
        ):
            # The layer chain may fail / pass depending on repo state;
            # we assert ONLY that the no-risk-evidence-required error
            # does NOT surface when risk_types is non-empty.
            try:
                result = enforce_validation_matrix(
                    change_id=self.change_id,
                    candidate_refs=[],
                    base_dir=self.base,
                    validation_mode="enforced",
                )
            except GovernanceError as exc:
                self.assertNotIn(
                    "no_risk_evidence_required", str(exc),
                    "§D.5 raise must not fire when risk_types is non-empty",
                )

    def test_historical_attestation_no_risk_vacuous_pass(self) -> None:
        # historical_attestation mode preserves the legacy vacuous
        # pass even without evidence.
        result = self._enforce(mode="historical_attestation")
        self.assertTrue(result["passed"])
        self.assertIn("historical_attestation", result.get("notice", ""))


if __name__ == "__main__":
    unittest.main()
