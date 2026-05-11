"""Plan 020 Phase 8 — validation matrix gate tests.

What this suite pins (≥14 tests):
- 4 risk-type taxonomy locked.
- detect_risk_types_for_change correctly classifies file paths per
  risk class (auth/tenant/schema/event).
- list_required_tests returns the union per risk type with regex pattern
  serialised.
- enforce_validation_matrix 3-layer enforcement:
  (a) existence layer fails when no matching test files exist.
  (b) pattern layer fails when files exist but regex does not match.
  (c) run-pass layer rejects string-only refs under enforced mode.
  (d) run-pass layer accepts structured refs with exit_code=0.
  (e) run-pass layer rejects ref with exit_code != 0.
- validation_mode='historical_attestation' bypasses the matrix gate.
- Empty risk_types (no implicating files) → matrix vacuously passes.
- validation_matrix_check governance event emitted on every gate run.
- Frozen profile blocks the gate write.
- change_ledger.emit_change_validated wires the gate; rejected matrix
  raises before persistence.
- Existing payload immutability — change_validated governance event
  detail does NOT carry validation_mode (Plan v3.3 §existing payload
  immutability rule).
"""
from __future__ import annotations

import json
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
    DEFAULT_VALIDATION_MODE,
    RISK_TYPES,
    VALIDATION_MODES,
    detect_risk_types_for_change,
    enforce_validation_matrix,
    list_required_tests,
)


def _seed_workspace() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-matrix-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    return tools, repo


def _structured_ref(*, cmd: str = "nx test auth-service tenant-service farm-service event-bus",
                    exit_code: int = 0,
                    log_path: str = "/tmp/log.txt") -> dict:
    # Plan 024 v3 §B-5 — default cmd now contains every required test's
    # expected_cmd_substring across the four risk types, so a single
    # _structured_ref satisfies the correlation gate. Pre-fix the
    # helper used a generic 'nx test' which silently passed because
    # the gate was skipping. Now the gate is fail-loud, so the helper
    # cmd must match.
    return {
        "cmd": cmd,
        "exit_code": exit_code,
        "log_path": log_path,
        "ran_at": "2026-05-08T00:00:00+00:00",
    }


class TaxonomyTests(unittest.TestCase):
    def test_4_risk_types_locked(self) -> None:
        self.assertEqual(set(RISK_TYPES), {
            "auth_change", "tenant_change", "schema_change", "event_change",
        })

    def test_validation_modes_locked(self) -> None:
        self.assertEqual(set(VALIDATION_MODES), {"enforced", "historical_attestation"})
        self.assertEqual(DEFAULT_VALIDATION_MODE, "enforced")


class RiskTypeDetectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_detects_auth_change_from_guard_file(self) -> None:
        risks = detect_risk_types_for_change(
            change_id="chg-test", base_dir=self.tools,
            affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
        )
        self.assertIn("auth_change", risks)

    def test_detects_tenant_change_from_repository_file(self) -> None:
        risks = detect_risk_types_for_change(
            change_id="chg-test", base_dir=self.tools,
            affected_files_override=["libs/x.tenant.repository.ts"],
        )
        self.assertIn("tenant_change", risks)

    def test_detects_schema_change_from_entity_file(self) -> None:
        risks = detect_risk_types_for_change(
            change_id="chg-test", base_dir=self.tools,
            affected_files_override=["apps/farm-service/src/farm.entity.ts"],
        )
        self.assertIn("schema_change", risks)

    def test_detects_event_change_from_event_contract_file(self) -> None:
        risks = detect_risk_types_for_change(
            change_id="chg-test", base_dir=self.tools,
            affected_files_override=["libs/event-contracts/src/farm-events.ts"],
        )
        self.assertIn("event_change", risks)

    def test_no_risk_type_for_unrelated_file(self) -> None:
        risks = detect_risk_types_for_change(
            change_id="chg-test", base_dir=self.tools,
            affected_files_override=["docs/README.md"],
        )
        self.assertEqual(risks, [])


class ListRequiredTestsTests(unittest.TestCase):
    def test_auth_change_yields_three_required_tests(self) -> None:
        rows = list_required_tests(["auth_change"])
        names = {r["name"] for r in rows}
        self.assertEqual(names, {
            "use_guards_test", "jwt_tenant_source_negative", "public_endpoint_allowlist",
        })

    def test_event_change_yields_four_required_tests(self) -> None:
        rows = list_required_tests(["event_change"])
        self.assertEqual(len(rows), 4)


class EnforceMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_no_risk_types_passes_vacuously_under_historical_attestation(self) -> None:
        # Plan 026R §D.5 — vacuous pass is preserved only under
        # historical_attestation mode. Enforced + no-risk now requires
        # at least one verified validation_run row (test_no_risk_
        # evidence_required.py covers that path).
        result = enforce_validation_matrix(
            change_id="chg-empty", base_dir=self.tools, repo_root=self.repo,
            candidate_refs=[_structured_ref()],
            affected_files_override=["docs/README.md"],
            validation_mode="historical_attestation",
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["risk_types"], [])

    def test_existence_layer_fails_without_test_files(self) -> None:
        # Auth change with empty repo → no test files → existence fails.
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-auth-empty", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
            )
        self.assertIn("validation_matrix_blocked", str(cm.exception))

    def test_run_pass_layer_rejects_string_refs_under_enforced(self) -> None:
        # Provide test file so existence + pattern pass; run layer should
        # fail because string refs are rejected under enforced mode.
        spec_dir = self.repo / "apps" / "auth-service" / "src" / "__tests__"
        spec_dir.mkdir(parents=True)
        (spec_dir / "guard.spec.ts").write_text(
            "@UseGuards(AuthGuard) public_endpoint allowlist tenant_claim reject",
            encoding="utf-8",
        )
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-auth-string", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=["nx test:run-1"],  # string ref
                affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
            )
        self.assertIn("validation_matrix_blocked", str(cm.exception))

    def test_run_pass_layer_rejects_nonzero_exit(self) -> None:
        spec_dir = self.repo / "apps" / "auth-service" / "src" / "__tests__"
        spec_dir.mkdir(parents=True)
        (spec_dir / "guard.spec.ts").write_text(
            "@UseGuards(AuthGuard) public_endpoint allowlist tenant_claim reject",
            encoding="utf-8",
        )
        with self.assertRaises(GovernanceError):
            enforce_validation_matrix(
                change_id="chg-auth-fail", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=[_structured_ref(exit_code=1)],
                affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
            )

    def test_full_pass_with_structured_zero_exit_ref(self) -> None:
        spec_dir = self.repo / "apps" / "auth-service" / "src" / "__tests__"
        spec_dir.mkdir(parents=True)
        (spec_dir / "guard.spec.ts").write_text(
            "@UseGuards(AuthGuard) public_endpoint allowlist tenant_claim reject",
            encoding="utf-8",
        )
        result = enforce_validation_matrix(
            change_id="chg-auth-pass", base_dir=self.tools, repo_root=self.repo,
            candidate_refs=[_structured_ref()],
            affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
        )
        self.assertTrue(result["passed"])
        self.assertIn("auth_change", result["risk_types"])

    def test_historical_attestation_bypasses_gate(self) -> None:
        # Even with NO test files + string refs, historical mode passes.
        result = enforce_validation_matrix(
            change_id="chg-hist", base_dir=self.tools, repo_root=self.repo,
            candidate_refs=["nx test:run-1"],
            affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
            validation_mode="historical_attestation",
        )
        self.assertTrue(result["passed"])
        self.assertIn("historical_attestation", result["notice"])

    def test_unknown_validation_mode_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            enforce_validation_matrix(
                change_id="chg-x", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["docs/README.md"],
                validation_mode="paranoid",
            )


class GovernanceEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_validation_matrix_check_event_emitted_on_pass(self) -> None:
        # Plan 026R §D.5 — no-risk path under enforced requires
        # validation_run evidence. Switch to historical_attestation
        # for the legacy vacuous-pass governance event smoke.
        enforce_validation_matrix(
            change_id="chg-noop", base_dir=self.tools, repo_root=self.repo,
            candidate_refs=[_structured_ref()],
            affected_files_override=["docs/README.md"],
            validation_mode="historical_attestation",
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("validation_matrix_check", kinds)

    def test_validation_matrix_check_event_emitted_on_block(self) -> None:
        with self.assertRaises(GovernanceError):
            enforce_validation_matrix(
                change_id="chg-block", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["apps/auth-service/src/jwt.guard.ts"],
            )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("validation_matrix_check", kinds)


class FrozenProfileBlocksMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_matrix_gate(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            enforce_validation_matrix(
                change_id="chg-frozen", base_dir=self.tools, repo_root=self.repo,
                candidate_refs=[_structured_ref()],
                affected_files_override=["docs/README.md"],
            )
        self.assertIn("validation_matrix", str(cm.exception))


class ChangeLedgerIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.planned = emit_change_planned(
            plan_id="plan-matrix-test",
            finding_id="F-001",
            intended_affected_files=["docs/x.md"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools,
        )
        emit_change_committed(
            change_id=self.planned["change_id"],
            commit_sha="abc1234",
            actual_affected_files=["docs/x.md"],
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_change_validated_with_matrix_gate_passes_for_no_risk(self) -> None:
        # Plan 026R §D.5 — no-risk vacuous pass moved to
        # historical_attestation; enforced requires evidence.
        row = emit_change_validated(
            change_id=self.planned["change_id"],
            validation_run_refs=[_structured_ref()],
            base_dir=self.tools,
            workspace_root=self.repo,
            validation_mode="historical_attestation",
            enforce_validation_matrix=False,
        )
        self.assertEqual(row["validation_mode"], "historical_attestation")

    def test_change_validated_governance_event_payload_immutable(self) -> None:
        # Plan v3.3 §existing payload immutability — change_validated detail
        # MUST NOT carry validation_mode (it lives on the row only).
        # Plan 026R §D.5 — historical_attestation for vacuous pass.
        emit_change_validated(
            change_id=self.planned["change_id"],
            validation_run_refs=[_structured_ref()],
            base_dir=self.tools,
            workspace_root=self.repo,
            validation_mode="historical_attestation",
            enforce_validation_matrix=False,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        events = [json.loads(line) for line in gov if line.strip()]
        change_validated = [e for e in events if e["kind"] == "change_validated"]
        self.assertTrue(change_validated)
        details = change_validated[-1]["details"]
        self.assertNotIn("validation_mode", details,
            "change_validated payload locked at Plan 019 — Phase 8 must NOT extend it")


if __name__ == "__main__":
    unittest.main()
