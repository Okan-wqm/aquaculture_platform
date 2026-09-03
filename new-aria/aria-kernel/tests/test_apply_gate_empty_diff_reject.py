"""Plan 026R §D.6 — apply gate rejects None / empty / whitespace-only diff.

4 tests:

* ``diff_text=None`` without recoverable diff → raise
  (existing §H-1 behavior preserved).
* ``diff_text=""`` → raise (new §D.6 check).
* ``diff_text="\\n\\t  "`` whitespace-only → raise (new §D.6 check).
* Non-empty diff → no diff-content raise (the gate may still raise
  for other reasons but NOT for "empty diff").

The action + validation-gate lookups are mocked because the §D.6
check fires after both pass. Bridge-specific assertions live in
test_validation_gate_runs.py (D.1) and pair-check tests.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.apply_engine import gate_apply_action
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError


class ApplyGateEmptyDiffRejectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d6-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mocks(self):
        """Mock the action lookup + validation gate so we reach §D.6
        diff-content check."""
        action_patch = patch(
            "aria_kernel.apply_engine._latest_action_for_proposal",
            return_value={
                "action_id": "act-d6",
                "proposal_id": "prop-d6",
                "scope": ["docs/"],
            },
        )
        gate_patch = patch(
            "aria_kernel.apply_engine.evaluate_validation_gate",
            return_value={"status": "ready_for_pr", "blocked_by": []},
        )
        return action_patch, gate_patch

    def test_empty_string_diff_raises(self) -> None:
        a, g = self._mocks()
        with a, g:
            with self.assertRaises(GovernanceError) as ctx:
                gate_apply_action(
                    proposal_id="prop-d6",
                    validation_comparison_ref="cmp-d6",
                    base_dir=self.base,
                    diff_text="",
                )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_whitespace_only_diff_raises(self) -> None:
        a, g = self._mocks()
        with a, g:
            with self.assertRaises(GovernanceError) as ctx:
                gate_apply_action(
                    proposal_id="prop-d6",
                    validation_comparison_ref="cmp-d6",
                    base_dir=self.base,
                    diff_text="\n\t  \n\n",
                )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_diff_text_none_without_action_branch_still_raises(self) -> None:
        # Pre-§D.6 behavior preserved: diff_text=None without recoverable
        # diff from action raises the existing §H-1 error message.
        a, g = self._mocks()
        with a, g:
            with self.assertRaises(GovernanceError) as ctx:
                gate_apply_action(
                    proposal_id="prop-d6",
                    validation_comparison_ref="cmp-d6",
                    base_dir=self.base,
                    diff_text=None,
                )
        self.assertIn("suppression_scan_requires_diff_content", str(ctx.exception))

    def test_non_empty_diff_passes_diff_content_check(self) -> None:
        a, g = self._mocks()
        diff = (
            "--- a/docs/x.md\n+++ b/docs/x.md\n"
            "@@ -1,1 +1,1 @@\n-old\n+new\n"
        )
        with a, g:
            # The gate may still raise for OTHER reasons (mock returns
            # an incomplete gate dict; downstream code accesses fields
            # the mock doesn't provide). Assert ONLY that the §D.6
            # diff-content check does NOT trigger.
            try:
                gate_apply_action(
                    proposal_id="prop-d6",
                    validation_comparison_ref="cmp-d6",
                    base_dir=self.base,
                    diff_text=diff,
                )
            except (GovernanceError, KeyError, TypeError) as exc:
                self.assertNotIn(
                    "suppression_scan_requires_diff_content", str(exc),
                    f"non-empty diff should not trigger the §D.6 raise; got {exc}",
                )
                self.assertNotIn(
                    "empty", str(exc).lower(),
                    f"non-empty diff should not trigger empty raise; got {exc}",
                )


if __name__ == "__main__":
    unittest.main()
