"""Plan 022 C-6 — executor self-review block.

Pre-Plan-022 review_executor_diff allowed the same agent that produced
a packet to also review it (so long as can_review=True in the registry).
Plan 016 separation-of-duties contract was advisory only; the kernel
boundary did not enforce it.

Fix: review_executor_diff now compares packet.source_agent ==
reviewer; matching agents -> GovernanceError('self_review_violation').

Tests reuse the test_executor_lane fixtures via direct imports.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

# Reuse the same helpers as test_executor_lane to keep fixtures aligned.
from tests.test_executor_lane import ExecutorLaneTests as _BaseLaneTests
from aria_kernel.executor import (
    record_executor_packet,
    register_executor,
    review_executor_diff,
)
from aria_kernel.tool_registry import GovernanceError


class SelfReviewBlockTests(_BaseLaneTests):
    """Inherit setUp / fixture helpers from ExecutorLaneTests so we can
    write a packet via the same path the lane tests use."""

    # Override the parent's tearDown invariants — we don't want the
    # parent test methods to execute against this subclass.
    def __init__(self, methodName: str = "runTest") -> None:  # type: ignore[override]
        super().__init__(methodName)

    def test_self_review_blocked(self) -> None:
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        # Register two executors: 'executor' (source_agent for the
        # packet) plus 'reviewer-a' (a different agent allowed to review).
        register_executor(self._executor(), base_dir=self.tools_dir)
        register_executor(
            self._executor(source_agent="reviewer-a", can_review=True),
            base_dir=self.tools_dir,
        )
        packet = record_executor_packet(
            self._packet(proposal["proposal_id"], failure["ci_failure_id"]),
            base_dir=self.tools_dir,
        )
        # source_agent on the default _packet helper is "codex-executor" (via
        # the default _executor() fixture). Plan 022 §C-6: the same
        # agent reviewing its own packet -> reject.
        self.assertEqual(packet["source_agent"], "codex-executor")
        with self.assertRaises(GovernanceError) as cm:
            review_executor_diff(
                packet_id=packet["packet_id"],
                reviewer="codex-executor",  # same as source_agent
                verdict="approved",
                evidence_refs=["src/app.ts"],
                base_dir=self.tools_dir,
            )
        self.assertIn("self_review_violation", str(cm.exception))

    def test_distinct_reviewer_accepted(self) -> None:
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        register_executor(
            self._executor(source_agent="reviewer-a", can_review=True),
            base_dir=self.tools_dir,
        )
        packet = record_executor_packet(
            self._packet(proposal["proposal_id"], failure["ci_failure_id"]),
            base_dir=self.tools_dir,
        )
        # Different agent reviewing -> accepted (existing semantics).
        result = review_executor_diff(
            packet_id=packet["packet_id"],
            reviewer="reviewer-a",
            verdict="approved",
            evidence_refs=["src/app.ts"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(result["verdict"], "approved")
        self.assertEqual(result["reviewer"], "reviewer-a")


# Skip parent test methods on this subclass — we only want our two
# self-review-specific tests to run, not the full ExecutorLaneTests
# suite duplicated.
def _skip_parent(name: str):
    def _skipped(self):
        self.skipTest(f"{name} runs in test_executor_lane.py; subclass focuses on self-review")
    return _skipped


for _name in dir(_BaseLaneTests):
    if _name.startswith("test_"):
        setattr(SelfReviewBlockTests, _name, _skip_parent(_name))


if __name__ == "__main__":
    unittest.main()
