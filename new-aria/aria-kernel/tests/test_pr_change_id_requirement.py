"""Plan 026R §D.3 — PR change_id requirement + reverse lookup.

4 tests:

* open_pr_for_action(dry_run=False, change_id=None) → raise.
* change_id persists on pr-lifecycle row when provided.
* change_for_pr(pr_number) reverse-lookup resolves.
* cycle pr_lifecycle phase forward (dry_run=True, no change_id, OK
  — the dry-run preview path does not require change_id).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.auto_merge import change_for_pr, record_pr_lifecycle
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError


class PRChangeIdRequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d3-"))
        self.base = self.tmp / "aria-tools"
        set_profile("strict", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_change_id_required_for_non_dry_run(self) -> None:
        from aria_kernel.pr_manager import open_pr_for_action
        # The function checks change_id BEFORE other validations when
        # dry_run is False. Use mock so we don't need the full proposal
        # state machine.
        with patch(
            "aria_kernel.pr_manager.get_proposal",
            return_value={"proposal_id": "p-d3", "title": "t"},
        ):
            with self.assertRaises(GovernanceError) as ctx:
                open_pr_for_action(
                    proposal_id="p-d3",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    dry_run=False,
                    change_id=None,
                )
            self.assertIn("open_pr_change_id_required", str(ctx.exception))

    def test_change_id_persists_on_pr_lifecycle_row(self) -> None:
        # Test record_pr_lifecycle's change_id passthrough directly so
        # we don't need the full open_pr_for_action gh-subprocess path.
        pr_payload = {
            "number": 42,
            "head_sha": "abc1234",
            "base_branch": "main",
            "change_id": "ch-d3",
            "proposal_id": "p-d3",
        }
        row = record_pr_lifecycle(
            pr_payload, event="opened", base_dir=self.base,
        )
        self.assertEqual(row["change_id"], "ch-d3")

    def test_change_for_pr_reverse_lookup_resolves(self) -> None:
        pr_payload = {
            "number": 99,
            "head_sha": "deadbeef",
            "base_branch": "main",
            "change_id": "ch-reverse-99",
            "proposal_id": "p-d3",
        }
        record_pr_lifecycle(pr_payload, event="opened", base_dir=self.base)
        resolved = change_for_pr(99, base_dir=self.base)
        self.assertEqual(resolved, "ch-reverse-99")
        # Missing PR returns None.
        self.assertIsNone(change_for_pr(1000, base_dir=self.base))

    def test_dry_run_preview_no_change_id_ok(self) -> None:
        # Dry-run preview path does not require change_id. The cycle
        # pr_lifecycle phase (cycle.py:638) uses this path to build
        # PR bodies without committing to a specific change anchor.
        from aria_kernel.pr_manager import open_pr_for_action
        # We expect the change_id guard NOT to raise; downstream
        # state (proposal lookup, action validation) may still fail
        # but the §D.3 guard does not.
        with patch(
            "aria_kernel.pr_manager.get_proposal",
            return_value={"proposal_id": "p-d3", "title": "t"},
        ):
            try:
                open_pr_for_action(
                    proposal_id="p-d3",
                    workspace_root=self.tmp,
                    base_dir=self.base,
                    dry_run=True,
                    change_id=None,
                )
            except GovernanceError as exc:
                self.assertNotIn(
                    "open_pr_change_id_required", str(exc),
                    "dry-run preview should NOT require change_id",
                )


if __name__ == "__main__":
    unittest.main()
