"""Plan 026R §D.2 — emit_change_committed scope drift gate.

5 tests:

* equal: actual == intended → succeeds.
* subset: actual ⊂ intended → succeeds.
* superset: actual ⊃ intended (drift outside scope) → raise.
* disjoint: actual ∩ intended == ∅ → raise.
* empty intended: change_planned wrote no intended files → raise.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


def _plan_change(base: Path, *, intended: list[str], suffix: str = "") -> str:
    planned = emit_change_planned(
        plan_id=f"plan-d2{suffix}",
        finding_id=f"F-d2{suffix}",
        intended_affected_files=intended,
        intended_validation_refs=["nx affected --target=test"],
        architectural_tier=1,
        base_dir=base,
    )
    return planned["change_id"]


class ScopeDriftGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d2-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_equal_scope_accepts(self) -> None:
        change_id = _plan_change(self.base, intended=["docs/a.md", "docs/b.md"])
        row = emit_change_committed(
            change_id=change_id,
            commit_sha="0" * 40,
            actual_affected_files=["docs/a.md", "docs/b.md"],
            base_dir=self.base,
        )
        self.assertEqual(row["event"], "change_committed")

    def test_subset_scope_accepts_with_declared_dispositions(self) -> None:
        # ORPHAN-721 deliberately rewrote this pin: a subset commit is
        # accepted ONLY with a declared disposition per untouched intended
        # file — the bare-subset spelling this test used to bless was the
        # silent-under-implementation hole.
        change_id = _plan_change(
            self.base, intended=["docs/a.md", "docs/b.md", "docs/c.md"],
        )
        row = emit_change_committed(
            change_id=change_id,
            commit_sha="1" * 40,
            actual_affected_files=["docs/a.md"],
            uncovered_intended_dispositions={
                "docs/b.md": "reviewed; section already correct",
                "docs/c.md": "reviewed; superseded by docs/a.md edit",
            },
            base_dir=self.base,
        )
        self.assertEqual(row["event"], "change_committed")
        self.assertFalse(row["implementation_complete"])

    def test_superset_scope_drift_raises(self) -> None:
        change_id = _plan_change(self.base, intended=["docs/a.md"], suffix=f"-{self.id().split('.')[-1][:8]}")
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_committed(
                change_id=change_id,
                commit_sha="2" * 40,
                actual_affected_files=["docs/a.md", "src/x.ts"],
                base_dir=self.base,
            )
        self.assertIn("scope_drift_requires_human", str(ctx.exception))
        self.assertIn("src/x.ts", str(ctx.exception))

    def test_disjoint_scope_drift_raises(self) -> None:
        change_id = _plan_change(self.base, intended=["docs/a.md"], suffix=f"-{self.id().split('.')[-1][:8]}")
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_committed(
                change_id=change_id,
                commit_sha="3" * 40,
                actual_affected_files=["src/y.ts"],
                base_dir=self.base,
            )
        self.assertIn("scope_drift_requires_human", str(ctx.exception))

    def test_empty_intended_raises(self) -> None:
        # emit_change_planned with empty intended is rejected; we
        # construct the case manually by injecting a planned row that
        # bypasses the planner's own non-empty check.
        change_id = "manually-injected-empty-d2"
        path = self.base / "change-ledger" / "planned.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            path,
            {
                "$schema": "aria/change-record/v1",
                "schema_version": 1,
                "event": "change_planned",
                "change_id": change_id,
                "plan_id": "plan-d2-empty",
                "finding_id": "F-d2-empty",
                "intended_affected_files": [],
                "intended_validation_refs": [],
                "rationale": "test",
                "recorded_at": "2026-05-11T13:00:00+00:00",
            },
            expected_surface="change_planned",
        )
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_committed(
                change_id=change_id,
                commit_sha="4" * 40,
                actual_affected_files=["docs/x.md"],
                base_dir=self.base,
            )
        self.assertIn("scope_drift_requires_human", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
