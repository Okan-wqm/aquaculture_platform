"""Plan ARIA-V8.14 — plan_synthesizer evidence_refs from git diff hunks.

Closes the systemic refusal cascade observed across 11 live runs:
when plan_synthesizer mined a single-file commit, it emitted ONE
evidence_ref pointing at line 1 (the first non-blank non-comment
line, typically `from __future__ import annotations` or `import
React`). The aria-challenger-planner agent rightly refused with
`reason_class=insufficient_evidence` — a line-1 import directive
provides no substantive ground for an independent competing plan.

V8.14 changes the evidence-extraction strategy: for each affected
path, query `git diff <base>..HEAD --unified=0 -- <path>` and parse
hunk headers to emit one ref per ADDED line, up to the canonical
limit. The challenger now sees the actual changed lines (function
bodies, schema mutations, control-flow edits) and can compose a
real competing plan from them. Auto-cycle plans become substantive.

Fallback: when git diff returns empty (binary file, deleted path,
no hunks), the function falls back to the pre-V8.14 first-non-blank
strategy so plans never have an empty evidence_refs list (which
would fail kernel `_validate_plan_content`).

3 invariants pin the V8.14 architectural anchors:

- I-V8.14-HUNK-01 — `_evidence_refs_from_hunks` helper exists
- I-V8.14-HUNK-02 — `_collect_evidence_refs` accepts `git_diff_base`
  parameter + forwards it to the hunks helper
- I-V8.14-HUNK-03 — caller `synthesize_plan_content_from_cycle`
  passes git_diff_base to _collect_evidence_refs (no parameter loss)
"""
from __future__ import annotations

import inspect
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import plan_synthesizer


class TestV8EvidenceHunks(unittest.TestCase):

    def test_i_v8_14_hunk_01_helper_exists(self):
        """plan_synthesizer MUST define _evidence_refs_from_hunks."""
        self.assertTrue(
            hasattr(plan_synthesizer, "_evidence_refs_from_hunks"),
            "plan_synthesizer._evidence_refs_from_hunks helper missing",
        )
        helper = plan_synthesizer._evidence_refs_from_hunks
        sig = inspect.signature(helper)
        # Must accept the V8.14 contract parameters
        for kwarg in ("workspace_root", "path", "git_diff_base", "remaining"):
            self.assertIn(
                kwarg, sig.parameters,
                f"_evidence_refs_from_hunks MUST accept {kwarg} kwarg",
            )

    def test_i_v8_14_hunk_02_collect_accepts_diff_base(self):
        """_collect_evidence_refs MUST accept git_diff_base + forward
        to the hunks helper (source-substring pin to catch regressions
        that drop the parameter)."""
        sig = inspect.signature(plan_synthesizer._collect_evidence_refs)
        self.assertIn(
            "git_diff_base", sig.parameters,
            "_collect_evidence_refs MUST accept git_diff_base kwarg",
        )
        src = inspect.getsource(plan_synthesizer._collect_evidence_refs)
        self.assertIn(
            "_evidence_refs_from_hunks", src,
            "_collect_evidence_refs MUST invoke the V8.14 hunks helper",
        )
        self.assertIn(
            "git_diff_base=git_diff_base", src,
            "_collect_evidence_refs MUST forward git_diff_base to the helper",
        )

    def test_i_v8_14_hunk_03_caller_passes_diff_base(self):
        """The orchestrator-side caller `synthesize_plan_content_from_-
        cycle` MUST forward its git_diff_base parameter to
        `_collect_evidence_refs` so the hunks helper sees the real
        commit base, not the function default."""
        src = inspect.getsource(plan_synthesizer.synthesize_plan_content_from_cycle)
        # Look for the call site that passes git_diff_base through.
        # The argument name on the call is `git_diff_base=git_diff_base`
        # (matches the outer function's parameter).
        self.assertIn(
            "git_diff_base=git_diff_base", src,
            "synthesize_plan_content_from_cycle MUST forward its "
            "git_diff_base to _collect_evidence_refs",
        )


if __name__ == "__main__":
    unittest.main()
