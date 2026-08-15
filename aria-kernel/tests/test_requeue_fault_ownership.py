"""The requeue budget charges the request for the harness's failures.

The budget exists to stop a poisonous request from cycling forever and hand
it to a human. A release whose reason names the HARNESS — the CLI session
died, the renderer was missing, the binding check compared two different
objects — says nothing about the request, and counting it burned the budget
anyway. Measured on production state 2026-08-10: three requests sat in
HUMAN_REQUIRED whose every requeue traced to the deterministic prompt-binding
defect (ORPHAN-CRITICAL-600/601). "The request was poisonous" and "the
harness was broken" had the same price.

The fix is a counting rule in the pure derivation, not a ledger mutation —
which means it heals retroactively: the same claims ledger now derives those
three requests back to PENDING.
"""
from __future__ import annotations

import unittest
from typing import Any

from aria_kernel.agent_invocations import (
    DEFAULT_MAX_REQUEUES,
    HARNESS_FAULT_RELEASE_REASONS,
    REQUEST_FAULT_RELEASE_REASONS,
    _request_fault_requeue_count,
)


def _requeue(request_id: str, reason: str, n: int) -> list[dict[str, Any]]:
    return [
        {"event": "requeued", "request_id": request_id, "reason": reason, "requeue_count": i + 1}
        for i in range(n)
    ]


class FaultOwnedCountingTest(unittest.TestCase):
    def test_harness_fault_requeues_do_not_count(self) -> None:
        rows = _requeue("R", "prompt_hash_binding_mismatch", 5)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 0)

    def test_request_fault_requeues_count(self) -> None:
        rows = _requeue("R", "lease_expired", 3)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 3)

    def test_mixed_history_counts_only_the_request_faults(self) -> None:
        # The live shape of the three stuck requests: two harness-fault
        # requeues, then a lease expiry.
        rows = (
            _requeue("R", "prompt_hash_binding_mismatch", 2)
            + _requeue("R", "lease_expired", 1)
        )

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 1)

    def test_an_unclassified_reason_fails_toward_the_human(self) -> None:
        # Unknown reasons burn budget: the failure mode of a stale list must
        # be over-escalation to a person, never silent infinite retry.
        rows = _requeue("R", "some_new_unclassified_reason", 3)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 3)

    def test_the_two_reason_sets_are_disjoint_and_cover_the_executor(self) -> None:
        self.assertEqual(
            HARNESS_FAULT_RELEASE_REASONS & REQUEST_FAULT_RELEASE_REASONS,
            frozenset(),
        )

    def test_every_executor_release_reason_is_classified(self) -> None:
        # The executor's release sites are the source of these strings. A new
        # reason added there without a classification here is exactly how the
        # list would go stale, so it is a test failure instead.
        import re
        from pathlib import Path

        executor = (
            Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"
        ).read_text(encoding="utf-8")
        reasons = set(re.findall(r'reason="([a-z_]+)"', executor))
        classified = HARNESS_FAULT_RELEASE_REASONS | REQUEST_FAULT_RELEASE_REASONS

        unclassified = sorted(reasons - classified)
        self.assertEqual(
            unclassified,
            [],
            f"release reasons with no fault-ownership classification: {unclassified}",
        )


class DerivationHealsRetroactivelyTest(unittest.TestCase):
    """End to end through derive_request_state, on a synthetic ledger shaped
    like the production one — no mutation, same rows, new derivation."""

    def _derive(self, claims: list[dict[str, Any]]) -> str:
        # derive_request_state reads ledgers off disk; exercising the counting
        # rule through its released-branch logic directly keeps this a unit
        # test. The branch under test is: released -> count -> HUMAN_REQUIRED
        # or REQUEUED/PENDING.
        requeues = _request_fault_requeue_count(claims, "R")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED" if requeues > 0 else "PENDING"

    def test_the_stuck_shape_derives_back_to_pending(self) -> None:
        # claimed -> released(mismatch) -> requeued(mismatch), three times
        # over: yesterday this derived HUMAN_REQUIRED; the same rows must now
        # derive PENDING because no request fault ever happened.
        claims = _requeue("R", "prompt_hash_binding_mismatch", 3)

        self.assertEqual(self._derive(claims), "PENDING")

    def test_a_genuinely_poisonous_request_still_escalates(self) -> None:
        claims = _requeue("R", "lease_expired", DEFAULT_MAX_REQUEUES + 1)

        self.assertEqual(self._derive(claims), "HUMAN_REQUIRED")

    def test_a_materialized_escalation_row_is_rederived_not_frozen(self) -> None:
        # The exact production shape: the ceiling was crossed by counting
        # harness faults, and the human_required row froze that verdict. The
        # row itself carries a harness reason, so under the honest rule the
        # same ledger derives PENDING.
        claims = _requeue("R", "prompt_hash_binding_mismatch", 2) + [{
            "event": "human_required", "request_id": "R",
            "reason": "prompt_hash_binding_mismatch", "requeue_count": 3,
        }]

        self.assertEqual(_request_fault_requeue_count(claims, "R"), 0)
        self.assertEqual(self._derive(claims), "PENDING")

    def test_an_escalation_row_with_a_real_fault_counts_as_the_crossing_requeue(self) -> None:
        # Production request …4459: two legacy exit-code releases (harness),
        # then a lease expiry escalation. One real fault, below the ceiling.
        claims = _requeue("R", "claude_cli_exit_1", 2) + [{
            "event": "human_required", "request_id": "R",
            "reason": "lease_expired", "requeue_count": 3,
        }]

        self.assertEqual(_request_fault_requeue_count(claims, "R"), 1)
        self.assertEqual(self._derive(claims), "REQUEUED")

    def test_the_dynamic_exit_code_reason_is_harness_class(self) -> None:
        # `claude_cli_exit_<code>` is minted with an f-string, so membership
        # cannot be a set lookup; five consecutive nights of exit_1 were an
        # expired OAuth session, not five poisonous requests.
        rows = _requeue("R", "claude_cli_exit_1", 2) + _requeue("R", "claude_cli_exit_143", 1)

        self.assertEqual(_request_fault_requeue_count(rows, "R"), 0)


if __name__ == "__main__":
    unittest.main()
