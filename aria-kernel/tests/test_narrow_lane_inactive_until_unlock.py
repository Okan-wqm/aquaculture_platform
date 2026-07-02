"""ADR-041 (ORPHAN-MEDIUM-300) — executable proof that the narrow
autonomous-merge lane (risk-L1 docs/tests) CANNOT fire today.

Each test pins one gate of the merge chain in its shipped state. Widening
any gate — enabling the master switch in DEFAULT_POLICY, adding a
non-L1 auto-merge candidate lane, weakening risk precedence, or counting
mock burn-in evidence toward the real ladder — turns this suite red, so
the ADR's "inactive until the ceremony" claim is a contract, not prose.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import DEFAULT_POLICY
from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock
from aria_kernel.risk_policy import classify_change


def _repo_risk_policy() -> dict:
    path = Path(__file__).resolve().parents[2] / "docs" / "aria" / "policy" / "risk-policy.json"
    return json.loads(path.read_text(encoding="utf-8"))


class RiskLaneRoutingTests(unittest.TestCase):
    def test_docs_and_tests_classify_l1(self) -> None:
        verdict = classify_change(
            ["docs/runbooks/example.md", "aria-kernel/tests/test_example.py"],
            policy=_repo_risk_policy(),
        )
        self.assertTrue(verdict.valid)
        self.assertEqual(verdict.lane, "L1")

    def test_policy_files_classify_l3_despite_docs_glob(self) -> None:
        # ADR-041 terminology-hazard pin: docs/aria/policy/** must hit the
        # L3 (control-plane) lane via L3->L2->L1 precedence even though
        # docs/** is an L1 glob.
        verdict = classify_change(
            ["docs/aria/policy/risk-policy.json"], policy=_repo_risk_policy(),
        )
        self.assertEqual(verdict.lane, "L3")

    def test_mixed_docs_plus_runtime_blocks(self) -> None:
        verdict = classify_change(
            ["docs/runbooks/example.md", "apps/farm-service/src/main.ts"],
            policy=_repo_risk_policy(),
        )
        self.assertFalse(verdict.valid)
        self.assertEqual(verdict.lane, "blocked")
        self.assertIn("risk_mixed_lanes", verdict.reason_codes)

    def test_secrets_block_before_any_lane(self) -> None:
        verdict = classify_change(
            ["docs/example.env.secret"], policy=_repo_risk_policy(),
        )
        self.assertEqual(verdict.lane, "blocked")
        self.assertIn("risk_blocked_path", verdict.reason_codes)

    def test_only_l1_is_an_auto_merge_candidate(self) -> None:
        self.assertEqual(_repo_risk_policy()["auto_merge_candidate_lanes"], ["L1"])


class LadderGateTests(unittest.TestCase):
    def test_empty_enterprise_ledger_fails_every_ladder_lane(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for lane in ("L1", "L2", "L3"):
                verdict = evaluate_autonomy_unlock(lane=lane, base_dir=tmp)
                self.assertFalse(
                    verdict.valid,
                    f"ladder {lane} must not unlock on an empty ledger",
                )


class MasterSwitchTests(unittest.TestCase):
    def test_shipped_auto_merge_policy_is_disabled(self) -> None:
        self.assertIs(DEFAULT_POLICY["enabled"], False)

    def test_shipped_low_risk_globs_never_include_runtime_paths(self) -> None:
        runtime_markers = ("apps/**/src/**", "libs/**/src/**", "web/**/src/**")
        for marker in runtime_markers:
            self.assertNotIn(marker, DEFAULT_POLICY["allowed_low_risk_globs"])


if __name__ == "__main__":
    unittest.main()
