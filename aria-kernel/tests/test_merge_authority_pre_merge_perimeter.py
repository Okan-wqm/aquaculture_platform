"""ORPHAN-HIGH-764 — the pre-merge perimeter, wired where ADR-041 promised it.

Static pin: merge_authority runs the hard-fail registry under GATE_PRE_MERGE.
Before the fix the gate was defined and default-gated but no production path
invoked it — the only perimeter callsites were pr_manager's GATE_PRE_PR_OPEN
pair, so ADR-041 decision 3's "fresh pre-merge re-check" existed in prose only.

Behavioral pin: a perimeter refusal stops the merge. Every GATE_PRE_MERGE
check currently binds _not_implemented (FAIL by design), so the refusal names
check_not_implemented; when a check gains an implementation this test keeps
holding the structural property — perimeter blocked means no merge side
effect, and the decision ledger records the block at stage
pre_merge_perimeter.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.tool_registry import ensure_tools_dir

_SHA = "a" * 40
_SOURCE = Path(__file__).resolve().parents[1] / "aria_kernel" / "merge_authority.py"


class _Adapter:
    """London-school fake: records the merge side effect, nothing else."""

    def __init__(self) -> None:
        self.merged: list[int] = []

    def get_pr(self, pr_number: int) -> dict:
        return {
            "number": pr_number,
            "repository": "okan/aqua",
            "base_branch": "main",
            "head_ref": "feat/x",
            "head_sha": _SHA,
            "changed_files": ["aria-kernel/aria_kernel/merge_authority.py"],
        }

    def merge_pr(self, pr_number: int, **kwargs) -> dict:
        self.merged.append(pr_number)
        return {"merged": True}


def _gate_patches():
    """Every gate before the perimeter passes; the perimeter is the test."""
    return [
        patch(
            "aria_kernel.merge_authority.enforce_profile_for_action",
            return_value="autonomous",
        ),
        patch(
            "aria_kernel.merge_authority.assert_merge_not_watchdog_frozen",
            return_value=None,
        ),
        patch(
            "aria_kernel.merge_authority.record_risk_decision_for_pr",
            return_value={"valid": True, "lane": "L1", "policy_hash": "ph"},
        ),
        patch(
            "aria_kernel.merge_authority.assert_autonomy_unlocked",
            return_value=SimpleNamespace(counts={}),
        ),
        patch(
            "aria_kernel.merge_authority.verify_enterprise_readiness",
            return_value=SimpleNamespace(valid=True, failure_classes=(), reasons=[]),
        ),
        patch(
            "aria_kernel.merge_authority.verify_runner_attestation",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.verify_rollback_bundle",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.ensure_pre_merge_incident_row",
            return_value={"ledger_hash": "x"},
        ),
        patch(
            "aria_kernel.merge_authority._merge_if_green_with_executor",
            return_value={"decision": "proceed", "eligible": True, "head_sha": _SHA},
        ),
        patch(
            "aria_kernel.merge_authority._evaluate_triple_gate",
            return_value={"passed": True, "change_id": "c1"},
        ),
        patch(
            "aria_kernel.merge_authority.collect_github_snapshot",
            return_value={},
        ),
        patch(
            "aria_kernel.merge_authority.evaluate_auto_merge",
            return_value={"eligible": True, "head_sha": _SHA},
        ),
    ]


class PreMergePerimeterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_merge_authority_runs_the_pre_merge_gate(self) -> None:
        source = _SOURCE.read_text(encoding="utf-8")
        self.assertIn("run_hard_fail_checks", source)
        self.assertIn("GATE_PRE_MERGE", source)

    def test_perimeter_refusal_blocks_the_merge_side_effect(self) -> None:
        adapter = _Adapter()
        patches = _gate_patches()
        for p in patches:
            p.start()
        try:
            result = merge_pr_if_ready(
                adapter=adapter,
                pr_number=77,
                base_dir=self.tools,
                readiness_claim_id="claim:77:aaaaaaaaaaaa",
            )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(result["stage"], "pre_merge_perimeter")
        reasons = list(result["reasons"])
        self.assertIn("pre_merge_perimeter_blocked", reasons)
        self.assertTrue(
            any("check_not_implemented" in reason for reason in reasons),
            reasons,
        )
        self.assertEqual(adapter.merged, [])

    def test_passing_perimeter_leaves_the_merge_path_unchanged(self) -> None:
        adapter = _Adapter()
        patches = _gate_patches() + [
            patch(
                "aria_kernel.merge_authority.run_hard_fail_checks",
                return_value=SimpleNamespace(passed=True, failures=()),
            ),
        ]
        for p in patches:
            p.start()
        try:
            result = merge_pr_if_ready(
                adapter=adapter,
                pr_number=77,
                base_dir=self.tools,
                readiness_claim_id="claim:77:aaaaaaaaaaaa",
            )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(adapter.merged, [77])


if __name__ == "__main__":
    unittest.main()
