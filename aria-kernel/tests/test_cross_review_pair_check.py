"""Plan 026R §C.4 — bidirectional cross-review pair hash check.

4 tests:

* Pair with divergent content_hash → pair returned (no raise).
* Missing pair (zero rows) → GovernanceError with
  ``cross_review_pair_missing``.
* Single-role only (one direction filed) → GovernanceError with
  ``cross_review_pair_single_role_only``.
* Identical content_hash (collusion / single-agent signal) →
  GovernanceError with
  ``cross_review_pair_identical_content_hash``.

Depends on §C.2 (content_hash alias on result rows).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.plan_convergence import _results_pair_hash_check
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


def _seed_result(
    base: Path,
    *,
    plan_id: str,
    round_number: int,
    content_hash: str,
    role: str = "cross_review",
    status: str = "accepted",
) -> None:
    row = {
        "$schema": "aria/agent-claim-result/v1",
        "schema_version": 1,
        "claim_id": f"claim-{content_hash[-6:]}",
        "request_id": f"req-{content_hash[-6:]}",
        "agent_id": "test-reviewer",
        "role": role,
        "status": status,
        "convergence_id": plan_id,
        "plan_id": plan_id,
        "round_number": round_number,
        "output_path": "/tmp/x.json",
        "output_hash": content_hash,
        "content_hash": content_hash,
        "submitted_at": "2026-05-11T13:00:00+00:00",
    }
    append_declared_fixture(
        base / "agent-invocations" / "results.jsonl",
        row,
        expected_surface="agent_invocation_results",
    )


class CrossReviewPairCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c4-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self.plan_id = "plan-c4-test"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_pair_divergent_content_hash_ok(self) -> None:
        _seed_result(
            self.base, plan_id=self.plan_id, round_number=1,
            content_hash="sha256:" + "a" * 64,
        )
        _seed_result(
            self.base, plan_id=self.plan_id, round_number=1,
            content_hash="sha256:" + "b" * 64,
        )
        result = _results_pair_hash_check(
            plan_id=self.plan_id, round_number=1, base_dir=self.base,
        )
        self.assertEqual(result["plan_id"], self.plan_id)
        self.assertEqual(result["round_number"], 1)
        self.assertEqual(len(result["pair"]), 2)
        # Both rows present, with divergent content_hash.
        hashes = {row["content_hash"] for row in result["pair"]}
        self.assertEqual(len(hashes), 2)

    def test_missing_pair_raises(self) -> None:
        # No rows persisted at all.
        with self.assertRaises(GovernanceError) as ctx:
            _results_pair_hash_check(
                plan_id=self.plan_id, round_number=1, base_dir=self.base,
            )
        self.assertIn("cross_review_pair_missing", str(ctx.exception))

    def test_single_role_only_raises(self) -> None:
        # Only one direction filed.
        _seed_result(
            self.base, plan_id=self.plan_id, round_number=1,
            content_hash="sha256:" + "a" * 64,
        )
        with self.assertRaises(GovernanceError) as ctx:
            _results_pair_hash_check(
                plan_id=self.plan_id, round_number=1, base_dir=self.base,
            )
        self.assertIn("cross_review_pair_single_role_only", str(ctx.exception))

    def test_identical_content_hash_raises_collusion(self) -> None:
        # Both reviewers produced the SAME content_hash — collusion or
        # single-agent signal.
        identical_hash = "sha256:" + "c" * 64
        _seed_result(
            self.base, plan_id=self.plan_id, round_number=1,
            content_hash=identical_hash,
        )
        _seed_result(
            self.base, plan_id=self.plan_id, round_number=1,
            content_hash=identical_hash,
        )
        with self.assertRaises(GovernanceError) as ctx:
            _results_pair_hash_check(
                plan_id=self.plan_id, round_number=1, base_dir=self.base,
            )
        self.assertIn("cross_review_pair_identical_content_hash", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
