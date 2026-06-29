"""Plan 031 Gate A — regression-anchor requirement tests.

What this suite pins:
- has_regression_anchor recognises the TS/JS suite layout (__tests__,
  *.spec.*, *.test.*), the Python kernel suite (test_*.py, *_test.py,
  tests/ dirs) and fixture corpora, and rejects plain source/doc paths.
- enforce_validation_matrix(require_regression_anchor=True) BLOCKS a diff
  that touches no test/fixture file (the deterministic "every autonomous
  fix leaves a regression test" floor) under enforced mode.
- A diff that DOES carry an anchor passes the anchor precondition (control
  moves on to the existing risk/evidence layers — the anchor error is not
  raised).
- The default (require_regression_anchor=False) preserves the pre-031
  contract: a test-less diff is not blocked by the anchor gate.
- historical_attestation mode bypasses the anchor gate even when required
  (audit-only replay).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
    emit_change_validated,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.validation_matrix_gate import (
    enforce_validation_matrix,
    has_regression_anchor,
)


def _seed_workspace() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-anchor-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    return tools, repo


def _structured_ref() -> dict:
    return {
        "cmd": "nx affected --target=test",
        "exit_code": 0,
        "log_path": "/tmp/log.txt",
        "ran_at": "2026-06-27T00:00:00+00:00",
    }


class HasRegressionAnchorTests(unittest.TestCase):
    def test_recognises_anchor_paths(self) -> None:
        anchors = [
            "apps/farm-service/src/__tests__/farm.spec.ts",
            "apps/farm-service/src/farm.spec.ts",
            "web/modules/x/y.test.tsx",
            "aria-kernel/tests/test_foo.py",
            "aria-kernel/aria_kernel/foo_test.py",
            "fixture_set/cases/case1.json",
            "apps/x/__fixtures__/data.json",
            "apps/x/fixtures/data.json",
            "apps/x/seed.fixture.json",
            "e2e/tests/integration/schema.spec.ts",
        ]
        for path in anchors:
            self.assertTrue(
                has_regression_anchor([path]),
                msg=f"expected {path!r} to count as a regression anchor",
            )

    def test_rejects_non_anchor_paths(self) -> None:
        non_anchors = [
            "apps/auth-service/src/jwt.guard.ts",
            "apps/farm-service/src/farm.entity.ts",
            "docs/README.md",
            "aria-kernel/aria_kernel/cycle.py",
            # Plan 031-R R1 (B2): a production source whose name merely contains
            # "fixture" must NOT count as a regression anchor.
            "apps/x/fixture-loader.ts",
            "apps/x/src/fixtureService.ts",
        ]
        self.assertFalse(has_regression_anchor(non_anchors))

    def test_mixed_diff_with_one_anchor_passes(self) -> None:
        self.assertTrue(
            has_regression_anchor(
                ["apps/farm-service/src/farm.entity.ts",
                 "apps/farm-service/src/__tests__/farm.spec.ts"]
            )
        )

    def test_empty_diff_has_no_anchor(self) -> None:
        self.assertFalse(has_regression_anchor([]))


class EnforceAnchorGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_testless_diff_blocked_when_anchor_required(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-no-anchor",
                base_dir=self.tools,
                repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["apps/farm-service/src/farm.service.ts"],
                require_regression_anchor=True,
            )
        self.assertIn("regression_anchor_required", str(cm.exception))

    def test_anchor_present_passes_precondition(self) -> None:
        # The diff carries a test file but no risk-type-implicating file, and
        # no verified validation_run rows exist. The anchor gate must let it
        # through; the *next* gate (no_risk_evidence) is what raises — proving
        # the anchor precondition passed, not the anchor error.
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-anchored",
                base_dir=self.tools,
                repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["libs/util/__tests__/util.spec.ts"],
                require_regression_anchor=True,
            )
        msg = str(cm.exception)
        self.assertNotIn("regression_anchor_required", msg)
        self.assertIn("no_risk_evidence_required", msg)

    def test_default_does_not_enforce_anchor(self) -> None:
        # require_regression_anchor defaults False → a test-less diff is not
        # blocked by the anchor gate (pre-031 contract preserved). It still
        # falls through to the no_risk_evidence path, not the anchor error.
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-default",
                base_dir=self.tools,
                repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["apps/farm-service/src/farm.service.ts"],
            )
        self.assertNotIn("regression_anchor_required", str(cm.exception))

    def test_historical_attestation_bypasses_anchor(self) -> None:
        result = enforce_validation_matrix(
            change_id="chg-historical",
            base_dir=self.tools,
            repo_root=self.repo,
            candidate_refs=[_structured_ref()],
            affected_files_override=["apps/farm-service/src/farm.service.ts"],
            require_regression_anchor=True,
            validation_mode="historical_attestation",
        )
        self.assertTrue(result["passed"])


class ChangeValidatedChokepointTests(unittest.TestCase):
    """Plan 031-R R1 (B2) — emit_change_validated enforces the regression anchor
    for autonomous / ARIA-authored changes, derived from profile + claim_id."""

    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def _seed_chain(self, *, affected: list[str], claim_id: str | None) -> str:
        planned = emit_change_planned(
            plan_id="plan-1", finding_id="F-001",
            intended_affected_files=affected,
            intended_validation_refs=["nx test"],
            architectural_tier=1, base_dir=self.tools,
        )
        emit_change_committed(
            change_id=planned["change_id"], commit_sha="abc001",
            actual_affected_files=affected, base_dir=self.tools,
            claim_id=claim_id,
        )
        return planned["change_id"]

    def _validate(self, change_id: str):
        return emit_change_validated(
            change_id=change_id,
            validation_run_refs=[_structured_ref()],
            base_dir=self.tools, workspace_root=self.repo,
        )

    def test_claim_id_change_requires_anchor(self) -> None:
        # standard profile but an agent-issued change (claim_id) + test-less diff.
        cid = self._seed_chain(
            affected=["apps/farm-service/src/farm.service.ts"], claim_id="claim-xyz",
        )
        with self.assertRaises(GovernanceError) as cm:
            self._validate(cid)
        self.assertIn("regression_anchor_required", str(cm.exception))

    def test_human_standard_change_not_anchor_gated(self) -> None:
        # No claim_id + standard profile → derivation False → anchor not enforced
        # (it falls through to the no-risk-evidence path, not the anchor error).
        cid = self._seed_chain(
            affected=["apps/farm-service/src/farm.service.ts"], claim_id=None,
        )
        with self.assertRaises(GovernanceError) as cm:
            self._validate(cid)
        self.assertNotIn("regression_anchor_required", str(cm.exception))

    def test_strict_profile_requires_anchor(self) -> None:
        set_profile("strict", operator_approval_ref="op-ref-1", base_dir=self.tools)
        cid = self._seed_chain(
            affected=["apps/farm-service/src/farm.service.ts"], claim_id=None,
        )
        with self.assertRaises(GovernanceError) as cm:
            self._validate(cid)
        self.assertIn("regression_anchor_required", str(cm.exception))

    def test_anchored_autonomous_change_passes_precondition(self) -> None:
        # claim_id change WITH a test file → anchor satisfied; control moves to
        # the next layer (no_risk_evidence), not the anchor error.
        cid = self._seed_chain(
            affected=["apps/farm-service/src/__tests__/farm.spec.ts"], claim_id="claim-xyz",
        )
        with self.assertRaises(GovernanceError) as cm:
            self._validate(cid)
        self.assertNotIn("regression_anchor_required", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
